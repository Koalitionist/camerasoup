// The phone side of a studio session: joins the room, answers the hub's
// offer with its camera track (low bitrate, for the live grid), and on
// record-start runs MediaRecorder at full quality, streaming the chunks
// over the media channel with byte-count acks so a WiFi drop buffers
// locally and resumes.
import { CaptureSource } from './capture';
import { SignalledPeer, iceServers } from './peer';
import { Signal } from './signal';
import {
  CameraCaps,
  CameraToHub,
  HubToCamera,
  MEDIA_FRAME_BYTES,
  drained,
  onJson,
  sendJson,
} from './rtc-protocol';

export type CameraState = 'connecting' | 'live' | 'recording' | 'flushing' | 'interrupted';

export interface CameraEvents {
  state: CameraState;
  connected: boolean;
  sourceId: string | null;
  keyNumber: number;
  error: string | null;
  pendingBytes: number;
  recordingSince: number | null; // local ms
}

const TIMESLICE_MS = 1000;
const MEDIA_HIGH_WATER = 4 * 1024 * 1024;
// A roaming camera buffers unacked chunks while off WiFi. Past this cap the
// recorder is stopped cleanly instead of letting iOS kill the tab.
const MAX_PENDING_BYTES = 350 * 1024 * 1024;
const PREVIEW_MAX_BITRATE = 700_000;
const PREVIEW_SCALE_DOWN = 2;
const PING_EVERY_MS = 10_000;

interface PendingChunk {
  offset: number;
  // Explicitly ArrayBuffer-backed: the data-channel send overloads reject a
  // Uint8Array that might sit on a SharedArrayBuffer.
  data: Uint8Array<ArrayBuffer>;
}

export class CameraClient {
  state: CameraState = 'connecting';
  connected = false;
  sourceId: string | null = null;
  keyNumber = 1;
  error: string | null = null;
  pendingBytes = 0;
  rotation: number;
  caps: CameraCaps | null;
  recordingSince: number | null = null;

  private readonly code: string;
  private readonly name: string;
  private readonly stream: MediaStream;
  private readonly videoBitsPerSecond: number;
  private readonly videoTrack: MediaStreamTrack | null;
  private signal: Signal | null = null;
  private peer: SignalledPeer | null = null;
  private control: RTCDataChannel | null = null;
  private media: RTCDataChannel | null = null;
  private previewSender: RTCRtpSender | null = null;
  private clockOffset = 0; // hubTime - localTime
  private pongSamples: number[] = [];
  private pingTimer: number | undefined;
  private recorder: MediaRecorder | null = null;
  private sessionId: string | null = null;
  private mimeType: string | undefined;
  private pending: PendingChunk[] = [];
  private nextOffset = 0;
  private stopping = false;
  private chunkChain: Promise<void> = Promise.resolve();
  private startedAt = 0;
  private listeners = new Set<(ev: CameraEvents) => void>();
  private disposed = false;

  constructor(opts: {
    code: string;
    name: string;
    stream: MediaStream;
    rotation?: number;
    videoBitsPerSecond?: number;
  }) {
    this.code = opts.code;
    this.name = opts.name;
    this.stream = opts.stream;
    this.rotation = opts.rotation ?? 0;
    this.videoBitsPerSecond = opts.videoBitsPerSecond ?? 10_000_000;
    this.videoTrack = this.stream.getVideoTracks()[0] ?? null;
    this.caps = this.readCaps();
    for (const track of this.stream.getVideoTracks()) {
      track.addEventListener('mute', () => this.setInterrupted('camera muted by the system'));
      track.addEventListener('ended', () => this.setInterrupted('camera track ended'));
    }
  }

  onChange(fn: (ev: CameraEvents) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit() {
    const ev: CameraEvents = {
      state: this.state,
      connected: this.connected,
      sourceId: this.sourceId,
      keyNumber: this.keyNumber,
      error: this.error,
      pendingBytes: this.pendingBytes,
      recordingSince: this.recordingSince,
    };
    this.listeners.forEach((fn) => fn(ev));
  }

  private setState(state: CameraState) {
    this.state = state;
    this.emit();
  }

  private setInterrupted(reason: string) {
    this.error = reason;
    this.setState('interrupted');
    sendJson(this.control, { type: 'status', interrupted: reason } satisfies CameraToHub);
  }

  async start() {
    const servers = await iceServers();
    this.signal = await Signal.connect(this.code, 'camera', this.name);
    this.signal.on((msg) => {
      if (msg.type === 'signal') this.onSignal(msg.from, msg.data, servers);
      else if (msg.type === 'closed') this.setInterrupted('Lost the signaling connection');
      else if (msg.type === 'peer-left' && msg.role === 'host') {
        this.connected = false;
        this.emit();
      }
    });
    this.emit();
  }

  private onSignal(from: string, data: Parameters<SignalledPeer['handle']>[0], servers: RTCIceServer[]) {
    if (!this.peer || this.peer.peerId !== from) {
      // First offer, or a reloaded hub: fresh peer connection.
      this.peer?.close();
      const peer = new SignalledPeer(this.signal!, from, servers, (pc) => this.attachPreview(pc));
      this.peer = peer;
      peer.pc.ondatachannel = (ev) => this.onChannel(ev.channel);
      peer.pc.onconnectionstatechange = () => {
        const s = peer.pc.connectionState;
        if (s === 'connected') {
          this.connected = true;
          void this.tunePreview();
        } else if (s === 'failed' || s === 'disconnected' || s === 'closed') {
          this.connected = false;
        }
        this.emit();
      };
    }
    void this.peer.handle(data);
  }

  // The hub's offer carries a receive-only video transceiver; answer it with
  // the camera track.
  private async attachPreview(pc: RTCPeerConnection) {
    if (!this.videoTrack) return;
    const transceiver = pc.getTransceivers().find((t) => t.receiver.track?.kind === 'video');
    if (!transceiver || transceiver.sender.track) return;
    transceiver.direction = 'sendonly';
    await transceiver.sender.replaceTrack(this.videoTrack);
    this.previewSender = transceiver.sender;
  }

  // The preview is for framing, not for the recording: keep it cheap so
  // MediaRecorder and the WiFi have the headroom.
  private async tunePreview() {
    const sender = this.previewSender;
    if (!sender) return;
    try {
      const params = sender.getParameters();
      if (!params.encodings?.length) params.encodings = [{}];
      params.encodings[0].maxBitrate = PREVIEW_MAX_BITRATE;
      params.encodings[0].scaleResolutionDownBy = PREVIEW_SCALE_DOWN;
      await sender.setParameters(params);
    } catch {
      // some browsers reject scaleResolutionDownBy; the default is fine
    }
  }

  private onChannel(dc: RTCDataChannel) {
    dc.binaryType = 'arraybuffer';
    if (dc.label === 'control') {
      this.control = dc;
      onJson<HubToCamera>(dc, (m) => this.onHub(m));
      if (dc.readyState === 'open') this.hello();
      else dc.onopen = () => this.hello();
    } else if (dc.label === 'media') {
      this.media = dc;
      dc.bufferedAmountLowThreshold = MEDIA_HIGH_WATER / 4;
    }
  }

  private hello() {
    sendJson(this.control, {
      type: 'hello',
      name: this.name,
      kind: 'remote',
      rotation: this.rotation,
      caps: this.caps,
    } satisfies CameraToHub);
    window.clearInterval(this.pingTimer);
    this.pingTimer = window.setInterval(() => this.ping(), PING_EVERY_MS);
  }

  private onHub(m: HubToCamera) {
    switch (m.type) {
      case 'hello-ack':
        this.sourceId = m.sourceId;
        if (m.keyNumber) this.keyNumber = m.keyNumber;
        if (this.state === 'connecting') this.setState('live');
        void this.syncClock();
        if (this.recorder && this.sessionId) {
          // reconnected mid-recording
          sendJson(this.control, { type: 'recording-resume', sessionId: this.sessionId } satisfies CameraToHub);
        }
        break;
      case 'pong':
        this.onPong(m.t0, m.t1);
        break;
      case 'record-start':
        this.onRecordStart(m.sessionId);
        break;
      case 'record-stop':
        this.stopRecorder();
        break;
      case 'ingest-ack':
        this.dropAcked(m.bytes);
        break;
      case 'resume-ok':
        this.onResumeOk(m.bytesReceived);
        break;
      case 'camera-control':
        void this.applyCameraControl(m);
        break;
      case 'kicked':
        this.error = 'Removed by the producer. Reload the page to rejoin.';
        this.setState('interrupted');
        this.dispose();
        break;
    }
  }

  // --- clock ---------------------------------------------------------------

  private ping() {
    sendJson(this.control, { type: 'ping', t0: Date.now() } satisfies CameraToHub);
  }

  private async syncClock() {
    this.pongSamples = [];
    for (let i = 0; i < 5; i++) {
      this.ping();
      await new Promise((r) => setTimeout(r, 60));
    }
  }

  private onPong(t0: number, t1: number) {
    const t2 = Date.now();
    this.pongSamples.push(t1 - (t0 + t2) / 2);
    if (this.pongSamples.length > 9) this.pongSamples.shift();
    if (this.pongSamples.length >= 3) {
      const sorted = [...this.pongSamples].sort((a, b) => a - b);
      this.clockOffset = sorted[Math.floor(sorted.length / 2)];
    }
  }

  // --- recording -----------------------------------------------------------

  private onRecordStart(sessionId: string) {
    if (this.recorder) {
      if (this.sessionId === sessionId) {
        sendJson(this.control, { type: 'recording-resume', sessionId } satisfies CameraToHub);
      }
      return;
    }
    this.sessionId = sessionId;
    this.pending = [];
    this.pendingBytes = 0;
    this.nextOffset = 0;
    this.stopping = false;
    this.mimeType = CaptureSource.pickMimeType();
    try {
      this.recorder = new MediaRecorder(this.stream, {
        mimeType: this.mimeType,
        videoBitsPerSecond: this.videoBitsPerSecond,
        audioBitsPerSecond: 128_000,
      });
    } catch (err) {
      this.setInterrupted(`MediaRecorder failed: ${(err as Error).message}`);
      return;
    }
    const recorder = this.recorder;
    recorder.onerror = (ev) => {
      this.setInterrupted(`Recorder error: ${(ev as ErrorEvent).error?.message ?? 'unknown'}`);
    };
    recorder.onstart = () => {
      this.startedAt = performance.now();
      this.recordingSince = Date.now();
      sendJson(this.control, {
        type: 'recording-started',
        sessionId,
        hubStart: Date.now() + this.clockOffset,
        clockOffset: this.clockOffset,
        mimeType: this.mimeType ?? null,
      } satisfies CameraToHub);
      this.setState('recording');
    };
    // Chunks are serialized through a promise chain: blob reads are async
    // and must never reorder, and the eof must trail the final chunk.
    recorder.ondataavailable = (ev) => {
      if (!ev.data.size) return;
      const blob = ev.data;
      this.chunkChain = this.chunkChain.then(async () => {
        const data = new Uint8Array(await blob.arrayBuffer());
        const chunk = { offset: this.nextOffset, data };
        this.nextOffset += data.byteLength;
        this.pending.push(chunk);
        this.pendingBytes += data.byteLength;
        await this.sendChunk(chunk);
        if (this.pendingBytes > MAX_PENDING_BYTES && recorder.state === 'recording') {
          this.error = 'Offline too long: recording stopped to protect memory; footage so far is safe';
          recorder.stop();
        }
        this.emit();
        await this.maybeEof();
      });
    };
    recorder.onstop = () => {
      this.stopping = true;
      this.chunkChain = this.chunkChain.then(() => this.maybeEof());
    };
    recorder.start(TIMESLICE_MS);
  }

  private async sendChunk(chunk: PendingChunk) {
    const dc = this.media;
    if (!dc || dc.readyState !== 'open' || !this.sourceId) return;
    for (let i = 0; i < chunk.data.byteLength; i += MEDIA_FRAME_BYTES) {
      while (dc.bufferedAmount > MEDIA_HIGH_WATER && dc.readyState === 'open') await drained(dc);
      if (dc.readyState !== 'open') return;
      dc.send(chunk.data.subarray(i, i + MEDIA_FRAME_BYTES));
    }
  }

  private onResumeOk(bytesReceived: number) {
    this.dropAcked(bytesReceived);
    const toResend = [...this.pending];
    this.chunkChain = this.chunkChain.then(async () => {
      for (const chunk of toResend) await this.sendChunk(chunk);
      await this.maybeEof();
    });
  }

  private dropAcked(bytes: number) {
    this.pending = this.pending.filter((c) => c.offset + c.data.byteLength > bytes);
    this.pendingBytes = this.pending.reduce((n, c) => n + c.data.byteLength, 0);
    this.emit();
  }

  private async maybeEof() {
    if (!this.stopping || !this.control || this.control.readyState !== 'open') return;
    if (this.recorder && this.recorder.state !== 'inactive') return;
    const dc = this.media;
    if (dc) while (dc.bufferedAmount > 0 && dc.readyState === 'open') await drained(dc);
    sendJson(this.control, {
      type: 'source-eof',
      sessionId: this.sessionId ?? '',
      durationMs: Math.round(performance.now() - this.startedAt),
    } satisfies CameraToHub);
    this.stopping = false;
    this.recorder = null;
    this.sessionId = null;
    this.recordingSince = null;
    this.setState('live');
  }

  private stopRecorder() {
    if (this.recorder && this.recorder.state !== 'inactive') {
      this.setState('flushing');
      this.recorder.stop();
    }
  }

  // --- camera controls -----------------------------------------------------

  setRotation(deg: number) {
    this.rotation = deg;
    sendJson(this.control, { type: 'status', rotation: deg } satisfies CameraToHub);
  }

  private readCaps(): CameraCaps | null {
    const track = this.videoTrack;
    const caps = track?.getCapabilities?.() as Record<string, unknown> | undefined;
    if (!caps) return null;
    const settings = (track?.getSettings?.() ?? {}) as Record<string, unknown>;
    const out: CameraCaps = {};
    const zoom = caps.zoom as { min?: number; max?: number; step?: number } | undefined;
    if (zoom && typeof zoom.min === 'number' && typeof zoom.max === 'number' && zoom.max > zoom.min) {
      out.zoom = {
        min: zoom.min,
        max: zoom.max,
        step: zoom.step || 0.1,
        value: (settings.zoom as number) ?? zoom.min,
      };
    }
    const torch = caps.torch as boolean | boolean[] | undefined;
    if (torch === true || (Array.isArray(torch) && torch.includes(true))) out.torch = true;
    // A camera can hold its look only if it offers something other than
    // continuous for both white balance and exposure.
    const holds = (modes: unknown) =>
      Array.isArray(modes) && modes.some((m) => m === 'manual' || m === 'single-shot');
    if (holds(caps.whiteBalanceMode) && holds(caps.exposureMode)) out.lock = true;
    return Object.keys(out).length ? out : null;
  }

  // The mode that freezes what the camera has already settled on. Prefer
  // single-shot, which means "measure once and hold"; manual holds the current
  // value too but is the more strictly interpreted of the two.
  private lockMode(): string {
    const caps = this.videoTrack?.getCapabilities?.() as Record<string, unknown> | undefined;
    const modes = (caps?.whiteBalanceMode as string[] | undefined) ?? [];
    return modes.includes('single-shot') ? 'single-shot' : 'manual';
  }

  async applyCameraControl(control: { zoom?: number; torch?: boolean; lock?: boolean }) {
    const track = this.videoTrack;
    if (!track?.applyConstraints) return;
    const advanced: Record<string, unknown> = {};
    if (typeof control.zoom === 'number') advanced.zoom = control.zoom;
    if (typeof control.torch === 'boolean') advanced.torch = control.torch;
    if (typeof control.lock === 'boolean') {
      const mode = control.lock ? this.lockMode() : 'continuous';
      advanced.whiteBalanceMode = mode;
      advanced.exposureMode = mode;
    }
    if (!Object.keys(advanced).length) return;
    try {
      await track.applyConstraints({ advanced: [advanced] } as MediaTrackConstraints);
    } catch {
      // unsupported combination; the settings below say what applied
    }
    const settings = (track.getSettings?.() ?? {}) as {
      zoom?: number;
      torch?: boolean;
      whiteBalanceMode?: string;
      exposureMode?: string;
    };
    if (this.caps?.zoom && typeof settings.zoom === 'number') this.caps.zoom.value = settings.zoom;
    // Report what the camera actually did, not what was asked of it.
    const lock =
      settings.whiteBalanceMode === undefined
        ? undefined
        : settings.whiteBalanceMode !== 'continuous' && settings.exposureMode !== 'continuous';
    sendJson(this.control, {
      type: 'status',
      zoom: settings.zoom,
      torch: settings.torch,
      lock,
    } satisfies CameraToHub);
    this.emit();
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    window.clearInterval(this.pingTimer);
    this.peer?.close();
    this.signal?.close();
    for (const track of this.stream.getTracks()) track.stop();
  }
}
