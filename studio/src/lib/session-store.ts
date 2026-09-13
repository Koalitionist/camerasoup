// Where the editor gets its sessions from. Two backends, one interface:
// the hosted site reads the folder the user picked (File System Access),
// the local app talks to the Node server. The editor itself doesn't care.
import type { Grade } from '../../../video/src/types';
import {
  Manifest,
  loadRootFolder,
  listSessions as listFolderSessions,
  opfsRequested,
  opfsRoot,
  readJson,
  writeJson,
} from './folder';
import { isHosted } from './platform';

export type { Manifest };

export interface EditPatch {
  cuts?: { atFrame: number; sourceId: string }[];
  audioSource?: string | null;
  rotations?: Record<string, number>;
  grades?: Record<string, Grade>;
}

export interface SessionStore {
  readonly kind: 'folder' | 'server';
  list(): Promise<Manifest[]>;
  load(id: string): Promise<Manifest | null>;
  saveEdit(id: string, patch: EditPatch): Promise<void>;
  /** A URL the <video> element can play. Revoke with releaseUrls when done. */
  urlFor(id: string, file: string): Promise<string>;
  /** The raw file, for the in-browser renderer to demux. */
  fileFor(id: string, file: string): Promise<Blob>;
  releaseUrls(): void;
  /** Writes a finished render next to the footage. */
  writeOutput(id: string, name: string, data: Blob): Promise<void>;
  /**
   * Swaps one source's file for a repaired one and points the manifest at it.
   * The old file goes only once the new one is written and recorded.
   */
  replaceSourceFile(id: string, sourceId: string, name: string, data: Blob): Promise<void>;
  reveal(id: string): Promise<void>;
  /** Permanent: the File System Access API has no route to the OS trash. */
  remove(id: string): Promise<void>;
}

class ServerStore implements SessionStore {
  readonly kind = 'server';

  async list() {
    const res = await fetch('/api/sessions');
    return res.ok ? ((await res.json()) as Manifest[]) : [];
  }

  async load(id: string) {
    const res = await fetch(`/api/sessions/${id}`);
    return res.ok ? ((await res.json()) as Manifest) : null;
  }

  async remove(id: string) {
    const res = await fetch(`/api/sessions/${id}`, { method: 'DELETE' });
    if (!res.ok) throw new Error(`could not delete ${id} (${res.status})`);
  }

  async saveEdit(id: string, patch: EditPatch) {
    await fetch(`/api/sessions/${id}/edit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
  }

  async urlFor(id: string, file: string) {
    return `/sessions/${id}/${file}`;
  }

  async fileFor(id: string, file: string) {
    return (await fetch(`/sessions/${id}/${file}`)).blob();
  }

  releaseUrls() {
    // nothing to revoke: these are plain paths
  }

  async writeOutput() {
    throw new Error('the local app renders through the server');
  }

  async replaceSourceFile() {
    // Nothing to repair: the server remuxes every source as it finalizes it.
  }

  async reveal(id: string) {
    await fetch('/api/reveal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: id }),
    });
  }
}

class FolderStore implements SessionStore {
  readonly kind = 'folder';
  private urls: string[] = [];

  constructor(private readonly root: FileSystemDirectoryHandle) {}

  get folderName() {
    return this.root.name;
  }

  list() {
    return listFolderSessions(this.root);
  }

  private dir(id: string) {
    return this.root.getDirectoryHandle(id);
  }

  async load(id: string) {
    try {
      return await readJson<Manifest>(await this.dir(id), 'session.json');
    } catch {
      return null;
    }
  }

  // The manifest on disk is the source of truth; an edit is merged into it
  // so a concurrent field (durations, file names) is never clobbered.
  async remove(id: string) {
    await this.root.removeEntry(id, { recursive: true });
  }

  async saveEdit(id: string, patch: EditPatch) {
    const dir = await this.dir(id);
    const manifest = await readJson<Manifest>(dir, 'session.json');
    if (!manifest) return;
    if (patch.cuts) manifest.cuts = patch.cuts;
    if (patch.audioSource !== undefined) manifest.audioSource = patch.audioSource;
    if (patch.rotations) {
      for (const src of manifest.sources) {
        const r = patch.rotations[src.id];
        if (typeof r === 'number') src.rotation = r;
      }
    }
    if (patch.grades) {
      for (const src of manifest.sources) {
        const g = patch.grades[src.id];
        if (g) src.grade = g;
        else delete src.grade;
      }
    }
    await writeJson(dir, 'session.json', manifest);
  }

  async urlFor(id: string, file: string) {
    const url = URL.createObjectURL(await this.fileFor(id, file));
    this.urls.push(url);
    return url;
  }

  async fileFor(id: string, file: string) {
    const handle = await (await this.dir(id)).getFileHandle(file);
    return handle.getFile();
  }

  releaseUrls() {
    for (const url of this.urls) URL.revokeObjectURL(url);
    this.urls = [];
  }

  async writeOutput(id: string, name: string, data: Blob) {
    const dir = await this.dir(id);
    const handle = await dir.getFileHandle(name, { create: true });
    const w = await handle.createWritable();
    await w.write(data);
    await w.close();
  }

  async replaceSourceFile(id: string, sourceId: string, name: string, data: Blob) {
    const dir = await this.dir(id);
    const manifest = await readJson<Manifest>(dir, 'session.json');
    const source = manifest?.sources.find((s) => s.id === sourceId);
    if (!manifest || !source) throw new Error(`no source ${sourceId} in ${id}`);
    const old = source.file;
    const handle = await dir.getFileHandle(name, { create: true });
    const w = await handle.createWritable();
    await w.write(data);
    await w.close();
    source.file = name;
    source.mimeType = data.type || 'video/mp4';
    source.bytes = data.size;
    await writeJson(dir, 'session.json', manifest);
    // Only now: until the manifest points at the new file, the old one is
    // still the only copy of the take.
    if (old && old !== name) await dir.removeEntry(old).catch(() => {});
  }

  async reveal() {
    // The browser can't open Finder; the studio page names the folder.
  }
}

export async function getStore(): Promise<SessionStore | null> {
  if (!isHosted()) return new ServerStore();
  if (opfsRequested()) return new FolderStore(await opfsRoot()); // test hook
  const root = await loadRootFolder();
  return root ? new FolderStore(root) : null;
}

export function isFolderStore(store: SessionStore): store is FolderStore {
  return store.kind === 'folder';
}
