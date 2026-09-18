// The studio hub, running in the Mac's browser tab: owns the room, receives
// every camera's footage over WebRTC and writes it into the session folder,
// records the Mac's own screen/webcam, keeps the clock, logs live cuts, and
// serves the same picture to any control view (its own page or an iPad).
import { AutoSwitcher } from './autoswitch';
import { CaptureSource } from './capture';
import {
  Manifest,
  ManifestSource,
  SegmentWriter,
  extensionFor,
  listSessions,
  newSessionId,
  writeJson,
} from './folder';
import { SignalledPeer, iceServers } from './peer';
import { forgetSource, loadRig, nameFor, rememberFraming, rememberName } from './rig';
import { Signal, SignalData, joinUrl } from './signal';
import {
  AutoStatus,
  CameraCaps,
  Framing,
  CameraToHub,
  ControlToHub,
  HubSnapshot,
  HubToCamera,
  HubToControl,
  SnapshotCamera,
  SourceKind,
  SourceState,
  onJson,
  sendJson,
  slugify,
} from './rtc-protocol';

const EOF_TIMEOUT_MS = 20_000;
const ACK_EVERY_MS = 1000;
const FPS = 30;

interface Source {
  id: string;
  name: string;
  kind: SourceKind;
  rotation: number;
  // Whether this source's recording will carry sound. A screen share only
  // does when the user ticked the picker's audio box, so it is per-source
  // and not implied by the kind. Undefined where the source hasn't said —
  // an older camera bundle — which is not the same as silent.
  hasAudio?: boolean;
  caps: CameraCaps | null;
  zoom?: number;
  torch?: boolean;
  lock?: boolean;
  online: boolean;
  state: SourceState;
  pendingBytes: number;
  rttMs: number | null;
  // preview for this tab and for control views
  stream: MediaStream | null;
  track: MediaStreamTrack | null;
  forward: MediaStream | null;
  // remote camera
  peerId: string | null;
  peer: SignalledPeer | null;
  control: RTCDataChannel | null;
  media: RTCDataChannel | null;
  // local source
  local: { stream: MediaStream; recorder: MediaRecorder | null; cleanup?: () => void } | null;
  // Serializes a local recorder's chunks: reading a Blob is async, so the
  // writes must be enqueued in order and drained before the source reports
  // end of file, or the last chunks race the writer's close.
  chunkChain: Promise<void>;
  // recording
  writer: SegmentWriter | null;
  eof: boolean;
  bytes: number;
  lastAck: number;
  mimeType: string | null;
  recordStart: number | null;
  clockOffset: number | null;
  durationMs: number | null;
  localStartedAt: number;
  recorderError: string | null;
  dataWatchdog: number | undefined;
}

interface ControlView {
  peerId: string;
  peer: SignalledPeer;
  dc: RTCDataChannel | null;
  forwarded: Set<string>;
}

// How long a source may write nothing before the hub says so. A phone is
// given longer than the Mac: it has a page to load, a recorder to start and
// a first chunk to push over the network before anything can land.
const LOCAL_SILENCE_MS = 5000;
const REMOTE_SILENCE_MS = 8000;

interface Recording {
  sessionId: string;
  dir: FileSystemDirectoryHandle;
  manifest: Manifest;
  startedAt: number;
  stoppedAt: number | null;
  ids: string[];
  liveCuts: { atMs: number; sourceId: string }[];
  stopping: boolean;
  stopTimer: number | undefined;
  finalizing: boolean;
}

export class Hub {
  readonly code: string;
  readonly joinUrl: string;
  private readonly root: FileSystemDirectoryHandle;
  private signal: Signal | null = null;
  private servers: RTCIceServer[] = [];
  private sources = new Map<string, Source>();
  private peerToSource = new Map<string, string>();
  private pendingTracks = new Map<string, MediaStreamTrack>();
  private cameraPeers = new Map<string, SignalledPeer>();
  private controls = new Map<string, ControlView>();
  private recording: Recording | null = null;
  private finalizingId: string | null = null;
  private program: string | null = null;
  private autoSwitcher: AutoSwitcher | null = null;
  private autoStatus: AutoStatus = 'off';
  private framing: Framing = loadRig().framing;
  private sessions: Manifest[] = [];
  private toast: string | null = null;
  private toastTimer: number | undefined;
  private listeners = new Set<(s: HubSnapshot, streams: Record<string, MediaStream>) => void>();

  constructor(code: string, root: FileSystemDirectoryHandle) {
    this.code = code;
    this.joinUrl = joinUrl(code);
    this.root = root;
  }

  onChange(fn: (s: HubSnapshot, streams: Record<string, MediaStream>) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  async start() {
    this.servers = await iceServers();
    this.sessions = await listSessions(this.root).catch(() => []);
    const signal = await Signal.connect(this.code, 'host', 'studio');
    this.signal = signal;
    signal.on((msg) => {
      if (msg.type === 'peer-joined') this.onPeer(msg.id, msg.role);
      else if (msg.type === 'reconnected') {
        for (const p of msg.peers) this.onPeer(p.id, p.role);
      } else if (msg.type === 'signal') this.onSignal(msg.from, msg.data);
      else if (msg.type === 'peer-left') this.onPeerLeft(msg.id);
      else if (msg.type === 'closed') this.showToast('Lost the signaling connection. Reload to start over.');
    });
    for (const p of signal.peers) this.onPeer(p.id, p.role);
    this.emit();
  }

  // --- peers -----------------------------------------------------------------

  private onPeer(peerId: string, role: string) {
    if (role === 'camera' && !this.cameraPeers.has(peerId)) void this.connectCamera(peerId);
    if (role === 'control' && !this.controls.has(peerId)) void this.connectControl(peerId);
  }

  private onSignal(from: string, data: SignalData) {
    const peer = this.cameraPeers.get(from) ?? this.controls.get(from)?.peer;
    void peer?.handle(data);
  }

  private onPeerLeft(peerId: string) {
    const control = this.controls.get(peerId);
    if (control) {
      control.peer.close();
      this.controls.delete(peerId);
      return;
    }
    const peer = this.cameraPeers.get(peerId);
    if (peer) {
      peer.close();
      this.cameraPeers.delete(peerId);
    }
    const id = this.peerToSource.get(peerId);
    if (id) {
      this.peerToSource.delete(peerId);
      const src = this.sources.get(id);
      if (src && src.peerId === peerId) {
        src.online = false;
        src.peer = null;
        src.control = null;
        src.media = null;
        // Keep it (and any open writer) so the same phone can resume; prune when idle.
        if (!this.recording) this.dropSource(src);
      }
    }
    this.emit();
  }

  private async connectCamera(peerId: string) {
    if (!this.signal) return;
    const peer = new SignalledPeer(this.signal, peerId, this.servers);
    this.cameraPeers.set(peerId, peer);
    const control = peer.pc.createDataChannel('control', { ordered: true });
    const media = peer.pc.createDataChannel('media', { ordered: true });
    media.binaryType = 'arraybuffer';
    peer.pc.addTransceiver('video', { direction: 'recvonly' });
    peer.pc.ontrack = (ev) => {
      const id = this.peerToSource.get(peerId);
      const src = id ? this.sources.get(id) : null;
      if (src) this.attachTrack(src, ev.track);
      else this.pendingTracks.set(peerId, ev.track);
    };
    peer.pc.onconnectionstatechange = () => {
      const s = peer.pc.connectionState;
      if (s === 'failed' || s === 'closed') this.onPeerLeft(peerId);
    };
    onJson<CameraToHub>(control, (m) => this.onCamera(peerId, m, control, media));
    media.onmessage = (ev) => this.onMedia(peerId, ev.data as ArrayBuffer);
    await peer.offer();
  }

  private attachTrack(src: Source, track: MediaStreamTrack) {
    src.track = track;
    src.stream = new MediaStream([track]);
    src.forward = new MediaStream([track]);
    for (const control of this.controls.values()) this.forwardTo(control, src);
    this.emit();
  }

  private onCamera(peerId: string, m: CameraToHub, control: RTCDataChannel, media: RTCDataChannel) {
    if (m.type === 'hello') {
      let id = slugify(m.name);
      const existing = this.sources.get(id);
      if (existing && existing.online && existing.peerId !== peerId) {
        let n = 2;
        while (this.sources.get(`${id}-${n}`)?.online) n++;
        id = `${id}-${n}`;
      }
      const src: Source = this.sources.get(id) ?? this.blankSource(id, m.name, 'remote');
      // A name given in the studio outlives the session that gave it: the
      // phone still calls itself "side", but you called it something else.
      src.name = nameFor(id) ?? m.name ?? id;
      src.rotation = Number(m.rotation) || 0;
      src.hasAudio = m.hasAudio;
      src.caps = m.caps ?? null;
      src.online = true;
      src.peerId = peerId;
      src.peer = this.cameraPeers.get(peerId) ?? null;
      src.control = control;
      src.media = media;
      if (src.state === 'interrupted') src.state = 'live';
      this.sources.set(id, src);
      this.peerToSource.set(peerId, id);
      const track = this.pendingTracks.get(peerId);
      if (track) {
        this.pendingTracks.delete(peerId);
        this.attachTrack(src, track);
      }
      const keyNumber = [...this.sources.keys()].indexOf(id) + 1;
      sendJson(control, {
        type: 'hello-ack',
        sourceId: id,
        hubTime: Date.now(),
        keyNumber,
      } satisfies HubToCamera);
      if (this.recording && this.recording.ids.includes(id) && !src.eof) {
        sendJson(control, {
          type: 'record-start',
          sessionId: this.recording.sessionId,
          hubTime: Date.now(),
          resumed: true,
        } satisfies HubToCamera);
      }
      if (!this.program) this.program = id;
      this.emit();
      return;
    }
    const id = this.peerToSource.get(peerId);
    const src = id ? this.sources.get(id) : null;
    if (!src) return;
    switch (m.type) {
      case 'ping':
        sendJson(control, { type: 'pong', t0: m.t0, t1: Date.now() } satisfies HubToCamera);
        src.rttMs = null;
        break;
      case 'recording-started':
        if (this.recording?.sessionId === m.sessionId) {
          src.recordStart = m.hubStart;
          src.clockOffset = m.clockOffset;
          src.mimeType = m.mimeType;
          src.state = 'recording';
          this.updateManifestSource(src);
          this.emit();
        }
        break;
      case 'recording-resume':
        if (this.recording?.sessionId === m.sessionId) {
          sendJson(control, { type: 'resume-ok', bytesReceived: src.bytes } satisfies HubToCamera);
        }
        break;
      case 'source-eof':
        this.onSourceEof(src, m.durationMs);
        break;
      case 'status':
        if (typeof m.rotation === 'number') src.rotation = m.rotation;
        if (typeof m.pendingBytes === 'number') src.pendingBytes = m.pendingBytes;
        if (typeof m.zoom === 'number') src.zoom = m.zoom;
        if (typeof m.torch === 'boolean') src.torch = m.torch;
        if (typeof m.lock === 'boolean') src.lock = m.lock;
        if (m.interrupted) {
          src.state = 'interrupted';
          this.showToast(`${src.name}: ${m.interrupted}`);
        }
        this.emit();
        break;
    }
  }

  private onMedia(peerId: string, buf: ArrayBuffer) {
    const id = this.peerToSource.get(peerId);
    const src = id ? this.sources.get(id) : null;
    if (!src || !src.writer || src.eof) return;
    const bytes = new Uint8Array(buf);
    void src.writer.write(bytes);
    src.bytes += bytes.byteLength;
    const now = Date.now();
    if (now - src.lastAck > ACK_EVERY_MS) {
      src.lastAck = now;
      sendJson(src.control, { type: 'ingest-ack', bytes: src.bytes } satisfies HubToCamera);
    }
  }

  private blankSource(id: string, name: string, kind: SourceKind): Source {
    return {
      id,
      name,
      kind,
      rotation: 0,
      hasAudio: undefined,
      caps: null,
      online: true,
      state: 'live',
      pendingBytes: 0,
      rttMs: null,
      stream: null,
      track: null,
      forward: null,
      peerId: null,
      peer: null,
      control: null,
      media: null,
      local: null,
      chunkChain: Promise.resolve(),
      writer: null,
      eof: false,
      bytes: 0,
      lastAck: 0,
      mimeType: null,
      recordStart: null,
      clockOffset: null,
      durationMs: null,
      localStartedAt: 0,
      recorderError: null,
      dataWatchdog: undefined,
    };
  }

  // --- local sources (the Mac's screen and webcam) -----------------------------

  addLocal(
    kind: 'local-webcam' | 'local-screen',
    stream: MediaStream,
    name: string,
    cleanup?: () => void
  ): string {
    let id = slugify(name);
    while (this.sources.has(id)) id = `${id}-2`;
    const src = this.blankSource(id, name, kind);
    src.hasAudio = stream.getAudioTracks().length > 0;
    src.local = { stream, recorder: null, cleanup };
    src.stream = stream;
    src.track = stream.getVideoTracks()[0] ?? null;
    src.forward = src.track ? new MediaStream([src.track]) : null;
    for (const track of stream.getVideoTracks()) {
      track.addEventListener('ended', () => {
        if (this.recording && this.recording.ids.includes(id)) {
          src.state = 'interrupted';
          this.showToast(`${name} stopped sharing`);
          this.emit();
        } else this.removeSource(id);
      });
    }
    this.sources.set(id, src);
    // Sound is the one thing about a screen share you cannot see on the
    // monitor, and finding out in the editor is finding out too late.
    if (kind === 'local-screen' && src.hasAudio === false) {
      this.showToast(`${name} has no audio — re-share and tick “Share tab audio” for sound`);
    }
    for (const control of this.controls.values()) this.forwardTo(control, src);
    if (!this.program) this.program = id;
    this.emit();
    return id;
  }

  private startLocalRecorder(src: Source, sessionId: string) {
    if (!src.local) return;
    const mimeType = CaptureSource.pickMimeType();
    let recorder: MediaRecorder;
    try {
      recorder = new MediaRecorder(src.local.stream, {
        mimeType,
        videoBitsPerSecond: src.kind === 'local-screen' ? 8_000_000 : 10_000_000,
        audioBitsPerSecond: 128_000,
      });
    } catch (err) {
      src.state = 'interrupted';
      this.showToast(`${src.name}: recorder failed (${(err as Error).message})`);
      src.eof = true;
      return;
    }
    src.local.recorder = recorder;
    src.mimeType = mimeType ?? null;
    recorder.onstart = () => {
      src.recordStart = Date.now();
      src.clockOffset = 0;
      src.localStartedAt = performance.now();
      src.state = 'recording';
      this.updateManifestSource(src);
      this.emit();
    };
    recorder.ondataavailable = (ev) => {
      if (!ev.data.size) return;
      const blob = ev.data;
      src.chunkChain = src.chunkChain.then(async () => {
        const buf = await blob.arrayBuffer();
        if (!src.writer) return;
        await src.writer.write(new Uint8Array(buf));
        src.bytes += buf.byteLength;
      });
    };
    recorder.onstop = () => {
      // The final chunk's ondataavailable fires before onstop, but reading it
      // is async — wait for the chain before reporting end of file so every
      // byte is on disk before the writer is finalized.
      const ms = Math.round(performance.now() - src.localStartedAt);
      src.chunkChain = src.chunkChain.then(() => {
        this.onSourceEof(src, ms);
      });
    };
    recorder.onerror = (ev) => {
      const message = (ev as ErrorEvent).error?.message ?? 'recorder error';
      src.recorderError = message;
      src.state = 'interrupted';
      this.showToast(`${src.name}: ${message}`);
      this.emit();
    };
    recorder.start(1000);
    this.armSilenceWatch(src, sessionId, LOCAL_SILENCE_MS);
  }

  // A source that has written nothing this far into a take never will: the
  // encoder rejected the stream, the screen produces no frames, or a phone
  // has gone to sleep behind its own lock screen. Say so while the take can
  // still be restarted, rather than after it.
  private armSilenceWatch(src: Source, sessionId: string, after: number) {
    window.clearTimeout(src.dataWatchdog);
    src.dataWatchdog = window.setTimeout(() => {
      if (src.bytes > 0 || this.recording?.sessionId !== sessionId) return;
      src.recorderError = 'no video came out of this source';
      src.state = 'interrupted';
      this.showToast(
        src.local
          ? `${src.name} is recording nothing — remove it and add it again`
          : `${src.name} is recording nothing — wake the device and rejoin it`
      );
      this.emit();
    }, after);
  }

  // --- recording ---------------------------------------------------------------

  async startRecording() {
    if (this.recording || this.finalizingId) return;
    const online = [...this.sources.values()].filter((s) => s.online && s.state !== 'interrupted');
    if (!online.length) {
      this.showToast('No cameras connected');
      return;
    }
    const sessionId = newSessionId();
    let dir: FileSystemDirectoryHandle;
    try {
      dir = await this.root.getDirectoryHandle(sessionId, { create: true });
    } catch (err) {
      this.showToast(`Can’t write to the folder: ${(err as Error).message}`);
      return;
    }
    const manifest: Manifest = {
      id: sessionId,
      createdAt: new Date().toISOString(),
      fps: FPS,
      width: 1080,
      height: 1350,
      sources: [],
      cuts: [],
      audioSource: null,
      recorder: 'browser',
    };
    for (const src of online) {
      src.writer = new SegmentWriter(dir, src.id);
      src.eof = false;
      src.bytes = 0;
      src.chunkChain = Promise.resolve();
      src.lastAck = 0;
      src.recordStart = null;
      src.durationMs = null;
      src.recorderError = null;
      manifest.sources.push({
        id: src.id,
        name: src.name,
        kind: src.kind,
        rotation: src.rotation,
        hasAudio: src.hasAudio,
        file: null,
        status: 'recording',
        recordStart: null,
      });
    }
    this.recording = {
      sessionId,
      dir,
      manifest,
      startedAt: Date.now(),
      stoppedAt: null,
      ids: online.map((s) => s.id),
      liveCuts: [],
      stopping: false,
      stopTimer: undefined,
      finalizing: false,
    };
    await writeJson(dir, 'session.json', manifest).catch(() => {});
    for (const src of online) {
      if (src.local) this.startLocalRecorder(src, sessionId);
      else {
        sendJson(src.control, { type: 'record-start', sessionId, hubTime: Date.now() } satisfies HubToCamera);
        // A phone has its own recorder, its own tab and its own screen lock,
        // and none of them tell us when they let go. Without this the hub
        // takes a camera's silence for footage and only finds out at save
        // time, which is the one moment the take cannot be redone.
        this.armSilenceWatch(src, sessionId, REMOTE_SILENCE_MS);
      }
    }
    if (!this.program || !this.recording.ids.includes(this.program)) this.program = online[0].id;
    this.emit();
  }

  cut(sourceId: string, origin: 'manual' | 'auto' = 'manual', atMs = Date.now()) {
    const src = this.sources.get(sourceId);
    if (!src) return;
    if (origin === 'manual' && this.autoStatus === 'on') {
      this.autoSwitcher?.noteManualCut();
      this.showToast('Auto-switch paused for 10s');
    }
    const rec = this.recording;
    if (rec && !rec.stopping && rec.ids.includes(sourceId)) {
      // An auto cut is dated where the head started turning, which is earlier
      // than now. Clamp it inside the take and after the cut before it so the
      // timeline math still sees an ordered list.
      const floor = rec.liveCuts.length ? rec.liveCuts[rec.liveCuts.length - 1].atMs : rec.startedAt;
      rec.liveCuts.push({ atMs: Math.min(Date.now(), Math.max(atMs, floor)), sourceId });
    }
    this.program = sourceId;
    this.emit();
  }

  // Auto-switching reads which camera the subject's face is square to and
  // cuts to it, so turning your head is the switch. Off by default; the face
  // detector is fetched the first time it is turned on.
  setAuto(on: boolean) {
    if (!on) {
      this.autoSwitcher?.disable();
      return;
    }
    this.autoSwitcher ??= new AutoSwitcher(
      () =>
        [...this.sources.values()]
          // A shared screen has no head to read, and cutting to one because a
          // face turned up inside it is never what was meant.
          .filter((s) => s.online && s.kind !== 'local-screen' && s.state !== 'interrupted')
          .map((s) => ({ id: s.id, stream: s.stream })),
      () => this.program,
      (sourceId, atMs) => this.cut(sourceId, 'auto', atMs),
      (status, error) => {
        this.autoStatus = status;
        if (error) this.showToast(`Auto-switch unavailable: ${error}`);
        else this.emit();
      }
    );
    void this.autoSwitcher.enable();
  }

  stopRecording() {
    const rec = this.recording;
    if (!rec || rec.stopping) return;
    rec.stopping = true;
    rec.stoppedAt = Date.now();
    this.finalizingId = rec.sessionId;
    for (const id of rec.ids) {
      const src = this.sources.get(id);
      if (!src) continue;
      if (src.local) {
        const r = src.local.recorder;
        if (r && r.state !== 'inactive') {
          src.state = 'flushing';
          r.stop();
        } else if (!src.eof) this.onSourceEof(src, 0);
      } else if (src.online) {
        src.state = 'flushing';
        sendJson(src.control, { type: 'record-stop', sessionId: rec.sessionId } satisfies HubToCamera);
      } else if (!src.eof) {
        // Offline camera: whatever arrived is what we have.
        src.eof = true;
      }
    }
    rec.stopTimer = window.setTimeout(() => void this.finalizeAll('timeout'), EOF_TIMEOUT_MS);
    this.emit();
    this.checkAllEof();
  }

  private onSourceEof(src: Source, durationMs: number) {
    if (!this.recording || src.eof) return;
    src.eof = true;
    src.durationMs = durationMs;
    src.state = 'live';
    this.checkAllEof();
  }

  private checkAllEof() {
    const rec = this.recording;
    if (!rec || !rec.stopping) return;
    const all = rec.ids.every((id) => this.sources.get(id)?.eof ?? true);
    if (all) {
      window.clearTimeout(rec.stopTimer);
      void this.finalizeAll('complete');
    }
  }

  private updateManifestSource(src: Source) {
    const rec = this.recording;
    if (!rec) return;
    const entry = rec.manifest.sources.find((s) => s.id === src.id);
    if (!entry) return;
    entry.recordStart = src.recordStart;
    entry.clockOffset = src.clockOffset;
    entry.mimeType = src.mimeType;
    void writeJson(rec.dir, 'session.json', rec.manifest).catch(() => {});
  }

  private async finalizeAll(reason: 'complete' | 'timeout') {
    const rec = this.recording;
    if (!rec || rec.finalizing) return;
    rec.finalizing = true;
    this.recording = null;
    for (const id of rec.ids) {
      const src = this.sources.get(id);
      const entry = rec.manifest.sources.find((s) => s.id === id) as ManifestSource;
      if (!src?.writer) {
        entry.status = 'failed';
        entry.error = 'no writer';
        continue;
      }
      try {
        const { file, bytes, warning } = await src.writer.finalize(extensionFor(src.mimeType));
        entry.file = file;
        entry.bytes = bytes;
        entry.duration = (src.durationMs ?? 0) / 1000;
        entry.recordStart = src.recordStart;
        entry.mimeType = src.mimeType;
        entry.status = 'finalized';
        if (warning) entry.error = `saved with a gap: ${warning}`;
      } catch (err) {
        entry.status = 'failed';
        // The recorder's own complaint is the useful one; the writer only
        // reports the symptom (nothing arrived to write).
        entry.error = src.recorderError ?? (err as Error).message;
      }
      window.clearTimeout(src.dataWatchdog);
      src.recorderError = null;
      src.writer = null;
      src.state = src.online ? 'live' : src.state;
      if (src.local?.recorder) src.local.recorder = null;
    }
    // Live switch presses (hub-clock ms) become timeline frames: timeline
    // zero is the moment every finalized camera was rolling.
    const finalized = rec.manifest.sources.filter((s) => s.status === 'finalized' && s.recordStart);
    if (rec.liveCuts.length && finalized.length) {
      const t0 = Math.max(...finalized.map((s) => s.recordStart as number));
      rec.manifest.cuts = rec.liveCuts
        .filter((c) => finalized.some((s) => s.id === c.sourceId))
        .map((c) => ({
          atFrame: Math.max(0, Math.round(((c.atMs - t0) / 1000) * FPS)),
          sourceId: c.sourceId,
        }));
    }
    await writeJson(rec.dir, 'session.json', rec.manifest).catch(() => {});
    // Cameras that dropped mid-recording were kept for resume; prune now.
    for (const src of [...this.sources.values()]) if (!src.online) this.dropSource(src);
    this.finalizingId = null;
    this.sessions = await listSessions(this.root).catch(() => this.sessions);
    const failed = rec.manifest.sources.filter((s) => s.status === 'failed').length;
    this.showToast(
      failed
        ? `Session ${rec.sessionId} saved, ${failed} source${failed === 1 ? '' : 's'} failed`
        : `Session ${rec.sessionId} saved${reason === 'timeout' ? ' (some cameras never flushed)' : ''}`
    );
    this.emit();
  }

  // --- source management -----------------------------------------------------

  removeSource(id: string) {
    const src = this.sources.get(id);
    if (!src) return;
    if (this.recording?.ids.includes(id)) {
      this.showToast(`Can’t remove ${src.name} while recording`);
      return;
    }
    if (src.control) sendJson(src.control, { type: 'kicked' } satisfies HubToCamera);
    forgetSource(id);
    this.dropSource(src);
    this.emit();
  }

  private dropSource(src: Source) {
    src.peer?.close();
    if (src.peerId) {
      this.cameraPeers.delete(src.peerId);
      this.peerToSource.delete(src.peerId);
    }
    if (src.local?.cleanup) src.local.cleanup();
    else src.local?.stream.getTracks().forEach((t) => t.stop());
    this.sources.delete(src.id);
    if (this.program === src.id) this.program = this.sources.keys().next().value ?? null;
  }

  // Only what the angle is called. The id is already in file names, in the
  // manifest and in every cut, so it stays exactly as it was — renaming an
  // angle mid-session must not orphan the footage it has already written.
  renameSource(id: string, name: string) {
    const src = this.sources.get(id);
    if (!src) return;
    const clean = name.trim().slice(0, 40);
    if (!clean || clean === src.name) return;
    src.name = clean;
    rememberName(id, clean);
    const entry = this.recording?.manifest.sources.find((s) => s.id === id);
    if (entry) entry.name = clean;
    this.emit();
  }

  setFraming(framing: Framing) {
    if (framing === this.framing) return;
    this.framing = framing;
    rememberFraming(framing);
    this.emit();
  }

  cameraControl(id: string, control: { zoom?: number; torch?: boolean; lock?: boolean }) {
    const src = this.sources.get(id);
    if (!src?.control) return;
    if (typeof control.zoom === 'number') src.zoom = control.zoom;
    if (typeof control.torch === 'boolean') src.torch = control.torch;
    if (typeof control.lock === 'boolean') src.lock = control.lock;
    sendJson(src.control, { type: 'camera-control', ...control } satisfies HubToCamera);
    this.emit();
  }

  // --- control views (this page, or an iPad) -------------------------------------

  private async connectControl(peerId: string) {
    if (!this.signal) return;
    const peer = new SignalledPeer(this.signal, peerId, this.servers);
    const view: ControlView = { peerId, peer, dc: null, forwarded: new Set() };
    this.controls.set(peerId, view);
    const dc = peer.pc.createDataChannel('control', { ordered: true });
    view.dc = dc;
    dc.onopen = () => this.pushState(view);
    onJson<ControlToHub>(dc, (m) => this.onCommand(m));
    peer.pc.onconnectionstatechange = () => {
      const s = peer.pc.connectionState;
      if (s === 'failed' || s === 'closed') this.onPeerLeft(peerId);
    };
    for (const src of this.sources.values()) this.forwardTo(view, src, false);
    await peer.offer();
  }

  // Forwarding a camera's received track to another peer is plain addTrack;
  // the control view matches streams to cameras by stream id.
  private forwardTo(view: ControlView, src: Source, renegotiate = true) {
    if (!src.track || !src.forward || view.forwarded.has(src.id)) return;
    view.forwarded.add(src.id);
    view.peer.pc.addTrack(src.track, src.forward);
    if (renegotiate) void view.peer.offer().then(() => this.pushState(view));
  }

  private onCommand(m: ControlToHub) {
    if (m.type !== 'command') return;
    switch (m.cmd) {
      case 'record-start':
        void this.startRecording();
        break;
      case 'record-stop':
        this.stopRecording();
        break;
      case 'cut':
        this.cut(m.sourceId);
        break;
      case 'remove':
        this.removeSource(m.sourceId);
        break;
      case 'camera-control':
        this.cameraControl(m.sourceId, { zoom: m.zoom, torch: m.torch, lock: m.lock });
        break;
      case 'auto':
        this.setAuto(m.on);
        break;
      case 'rename':
        this.renameSource(m.sourceId, m.name);
        break;
      case 'framing':
        this.setFraming(m.value);
        break;
    }
  }

  private pushState(view: ControlView) {
    sendJson(view.dc, { type: 'state', state: this.snapshot() } satisfies HubToControl);
  }

  // --- state -------------------------------------------------------------------

  private showToast(text: string) {
    this.toast = text;
    window.clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => {
      this.toast = null;
      this.emit();
    }, 5000);
    this.emit();
  }

  snapshot(): HubSnapshot {
    const cameras: SnapshotCamera[] = [...this.sources.values()].map((s, i) => ({
      id: s.id,
      name: s.name,
      kind: s.kind,
      rotation: s.rotation,
      online: s.online,
      state: s.state,
      keyNumber: i + 1,
      pendingBytes: s.pendingBytes,
      bytes: s.bytes,
      rttMs: s.rttMs,
      streamId: s.forward?.id ?? null,
      caps: s.caps,
      zoom: s.zoom,
      torch: s.torch,
      lock: s.lock,
    }));
    return {
      code: this.code,
      joinUrl: this.joinUrl,
      folder: this.root.name,
      cameras,
      recording: this.recording
        ? {
            sessionId: this.recording.sessionId,
            startedAt: this.recording.startedAt,
            stoppedAt: this.recording.stoppedAt,
          }
        : null,
      finalizing: this.finalizingId,
      program: this.program,
      auto: this.autoStatus,
      framing: this.framing,
      sessions: this.sessions.slice(0, 30).map((m) => ({
        id: m.id,
        sources: m.sources.map((s) => ({
          id: s.id,
          file: s.file,
          duration: s.duration,
          status: s.status,
          error: s.error,
        })),
      })),
      toast: this.toast,
    };
  }

  private emit() {
    const snap = this.snapshot();
    const streams: Record<string, MediaStream> = {};
    for (const s of this.sources.values()) if (s.stream) streams[s.id] = s.stream;
    this.listeners.forEach((fn) => fn(snap, streams));
    for (const view of this.controls.values()) this.pushState(view);
  }

  dispose() {
    this.autoSwitcher?.disable();
    for (const src of [...this.sources.values()]) this.dropSource(src);
    for (const view of this.controls.values()) view.peer.close();
    this.controls.clear();
    this.signal?.close();
  }
}
