// Recordings go straight into a folder the user picked once (File System
// Access API, Chromium only). The handle is remembered in IndexedDB; after a
// reload the browser only asks for a permission click, not a new pick.
//
// Chrome writes a FileSystemWritableFileStream to a swap file and commits it
// on close(), so a tab that dies mid-take would lose everything. Footage is
// therefore written as closed segments of a few megabytes and stitched into
// one file at stop: a crash costs seconds, not the take.

import type { Grade } from '../../../video/src/types';

const DB_NAME = 'camerasoup';
const STORE = 'handles';
const ROOT_KEY = 'root';

export const SEGMENT_BYTES = 16 * 1024 * 1024;

type Picker = (opts: {
  mode: 'readwrite';
  id?: string;
  startIn?: string;
}) => Promise<FileSystemDirectoryHandle>;

export function hasFolderAccess(): boolean {
  return typeof (window as unknown as { showDirectoryPicker?: unknown }).showDirectoryPicker === 'function';
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbGet<T>(key: string): Promise<T | undefined> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const req = db.transaction(STORE).objectStore(STORE).get(key);
    req.onsuccess = () => resolve(req.result as T | undefined);
    req.onerror = () => reject(req.error);
  });
}

async function idbSet(key: string, value: unknown): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function loadRootFolder(): Promise<FileSystemDirectoryHandle | null> {
  try {
    return (await idbGet<FileSystemDirectoryHandle>(ROOT_KEY)) ?? null;
  } catch {
    return null;
  }
}

// Test hook (?fs=opfs): the origin-private file system needs no picker
// dialog, so an automated browser can exercise the whole recording path.
// Never a shipping option — the files are invisible to the user.
export function opfsRequested(): boolean {
  return new URLSearchParams(location.search).get('fs') === 'opfs';
}

export async function opfsRoot(): Promise<FileSystemDirectoryHandle> {
  return navigator.storage.getDirectory();
}

export async function pickRootFolder(): Promise<FileSystemDirectoryHandle> {
  const picker = (window as unknown as { showDirectoryPicker: Picker }).showDirectoryPicker;
  const handle = await picker({ mode: 'readwrite', id: 'camerasoup-sessions', startIn: 'videos' });
  await idbSet(ROOT_KEY, handle);
  return handle;
}

type PermissionHandle = FileSystemDirectoryHandle & {
  queryPermission(d: { mode: 'readwrite' }): Promise<PermissionState>;
  requestPermission(d: { mode: 'readwrite' }): Promise<PermissionState>;
};

export async function folderPermission(handle: FileSystemDirectoryHandle): Promise<PermissionState> {
  return (handle as PermissionHandle).queryPermission({ mode: 'readwrite' });
}

// Needs a user gesture.
export async function requestFolderPermission(handle: FileSystemDirectoryHandle): Promise<boolean> {
  return (await (handle as PermissionHandle).requestPermission({ mode: 'readwrite' })) === 'granted';
}

export function newSessionId(now = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return (
    `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}` +
    `-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`
  );
}

export interface ManifestSource {
  id: string;
  name: string;
  kind: string;
  rotation: number;
  // Undefined on sessions recorded before this was tracked: unknown, which
  // the editor reads as "assume there is sound" rather than as silence.
  hasAudio?: boolean;
  grade?: Grade; // color correction; the footage itself is never touched
  file: string | null;
  status: 'recording' | 'finalized' | 'failed';
  recordStart: number | null; // hub-clock ms when the recorder started
  clockOffset?: number | null;
  mimeType?: string | null;
  duration?: number; // seconds
  bytes?: number;
  error?: string;
}

export interface Manifest {
  id: string;
  createdAt: string;
  fps: number;
  width: number;
  height: number;
  sources: ManifestSource[];
  cuts: { atFrame: number; sourceId: string }[];
  audioSource: string | null;
  recorder?: 'browser';
}

export async function writeJson(dir: FileSystemDirectoryHandle, name: string, value: unknown) {
  const handle = await dir.getFileHandle(name, { create: true });
  const w = await handle.createWritable();
  await w.write(JSON.stringify(value, null, 2));
  await w.close();
}

export async function readJson<T>(dir: FileSystemDirectoryHandle, name: string): Promise<T | null> {
  try {
    const handle = await dir.getFileHandle(name);
    return JSON.parse(await (await handle.getFile()).text()) as T;
  } catch {
    return null;
  }
}

export async function listSessions(root: FileSystemDirectoryHandle): Promise<Manifest[]> {
  const out: Manifest[] = [];
  const iter = (root as unknown as { values(): AsyncIterable<FileSystemHandle> }).values();
  for await (const entry of iter) {
    if (entry.kind !== 'directory') continue;
    const m = await readJson<Manifest>(entry as FileSystemDirectoryHandle, 'session.json');
    if (m?.id) out.push(m);
  }
  return out.sort((a, b) => (a.id < b.id ? 1 : -1));
}

export function extensionFor(mimeType: string | null | undefined): string {
  if (!mimeType) return 'bin';
  if (mimeType.startsWith('video/mp4')) return 'mp4';
  if (mimeType.startsWith('video/webm')) return 'webm';
  return 'bin';
}

// Ordered byte sink for one source of one session. Chunks are appended to
// the current segment file; a segment closes (and is thereby committed to
// disk) once it passes SEGMENT_BYTES. finalize() stitches the segments into
// the final file and deletes them.
export class SegmentWriter {
  bytes = 0;
  private parts: string[] = [];
  private current: { name: string; stream: FileSystemWritableFileStream; bytes: number } | null = null;
  private chain: Promise<void> = Promise.resolve();
  private failed: Error | null = null;
  private closing = false;

  constructor(
    private readonly dir: FileSystemDirectoryHandle,
    private readonly baseName: string
  ) {}

  get error() {
    return this.failed;
  }

  // BufferSource, not Uint8Array: a Uint8Array may be backed by a
  // SharedArrayBuffer, which the file-system write API doesn't accept.
  write(chunk: BufferSource): Promise<void> {
    // A chunk that arrives after finalize() started is dropped rather than
    // thrown: the stream is already closing, and losing a trailing chunk
    // must never cost the whole take.
    if (this.closing) return this.chain;
    this.chain = this.chain.then(() => this.append(chunk)).catch((err) => {
      this.failed = err as Error;
    });
    return this.chain;
  }

  private async append(chunk: BufferSource) {
    if (this.failed) return;
    if (!this.current) {
      const name = `${this.baseName}.part${String(this.parts.length).padStart(3, '0')}`;
      const handle = await this.dir.getFileHandle(name, { create: true });
      this.current = { name, stream: await handle.createWritable(), bytes: 0 };
      this.parts.push(name);
    }
    await this.current.stream.write(chunk);
    this.current.bytes += chunk.byteLength;
    this.bytes += chunk.byteLength;
    if (this.current.bytes >= SEGMENT_BYTES) {
      await this.current.stream.close();
      this.current = null;
    }
  }

  // Stitches the segments into one file. A write that failed earlier is
  // reported as a warning, not an exception: whatever reached disk is still
  // worth keeping, so a hiccup costs the tail of a take rather than all of it.
  async finalize(ext: string): Promise<{ file: string; bytes: number; warning: string | null }> {
    this.closing = true;
    await this.chain;
    if (this.current) {
      await this.current.stream.close().catch((err) => {
        this.failed = err as Error;
      });
      this.current = null;
    }
    const file = `${this.baseName}.${ext}`;
    const out = await this.dir.getFileHandle(file, { create: true });
    const w = await out.createWritable();
    let bytes = 0;
    for (const name of this.parts) {
      try {
        const part = await this.dir.getFileHandle(name);
        const f = await part.getFile();
        await w.write(f);
        bytes += f.size;
      } catch (err) {
        this.failed = (err as Error) ?? this.failed;
      }
    }
    await w.close();
    for (const name of this.parts) {
      await this.dir.removeEntry(name).catch(() => {});
    }
    this.parts = [];
    if (bytes === 0) {
      await this.dir.removeEntry(file).catch(() => {});
      throw this.failed ?? new Error('the recorder produced no data');
    }
    return { file, bytes, warning: this.failed?.message ?? null };
  }
}
