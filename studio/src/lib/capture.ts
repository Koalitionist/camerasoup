import { FRAME_MEDIA, FRAME_PREVIEW, StudioSocket, encodeFrame } from './ws';

export type CaptureKind = 'remote' | 'local-webcam' | 'local-screen';
export type CaptureState = 'connecting' | 'live' | 'recording' | 'flushing' | 'interrupted';

// webm/h264 first: Chrome's mp4 muxer claims support but can silently produce
// zero data; its webm path is battle-tested and remuxes losslessly to mp4
// server-side. Safari doesn't do webm/h264 and falls through to native mp4.
const MIME_CANDIDATES = [
  'video/webm;codecs=h264', // Chrome/Edge
  'video/mp4;codecs=avc1', // iOS/macOS Safari
  'video/mp4',
  'video/webm;codecs=vp9',
  'video/webm',
];

const PREVIEW_INTERVAL_MS = 200;
// Big enough to look decent on the producer's program monitor.
const PREVIEW_MAX_DIM = 960;
const PREVIEW_SKIP_BUFFERED = 1 * 1024 * 1024;
const TIMESLICE_MS = 1000;
// A roaming camera buffers unacked chunks while off WiFi. Past this cap the
// recorder is stopped cleanly instead of letting iOS kill the tab (which
// would lose everything) — buffered footage still uploads on reconnect.
const MAX_PENDING_BYTES = 350 * 1024 * 1024;

interface PendingChunk {
  offset: number;
  data: Uint8Array;
}

export interface CaptureEvents {
  state: CaptureState;
  sourceId: string | null;
  error: string | null;
  pendingBytes: number;
}

export interface CameraCaps {
  zoom?: { min: number; max: number; step: number; value: number };
  torch?: boolean;
}

// One camera angle: owns a MediaStream and its own socket to the hub.
// Used identically by the phone /camera page and producer-local sources.
// Media chunks are kept in a pending buffer until the server acks the byte
// count, so a WiFi drop mid-recording buffers locally and resumes.
export class CaptureSource {
  readonly socket: StudioSocket;
  readonly stream: MediaStream;
  readonly name: string;
  readonly kind: CaptureKind;

  sourceId: string | null = null;
  state: CaptureState = 'connecting';
  error: string | null = null;
  rotation = 0;
  videoBitsPerSecond = 10_000_000;
  pendingBytes = 0;
  caps: CameraCaps | null = null;
  private videoTrack: MediaStreamTrack | null = null;

  private clockOffset = 0; // serverTime - localTime
  private recorder: MediaRecorder | null = null;
  private sessionId: string | null = null;
  private pending: PendingChunk[] = [];
  private nextOffset = 0;
  private stopping = false;
  private chunkChain: Promise<void> = Promise.resolve();
  private previewTimer: number | undefined;
  private previewVideo: HTMLVideoElement;
  private previewCanvas = document.createElement('canvas');
  private listeners = new Set<(ev: CaptureEvents) => void>();

  constructor(opts: {
    name: string;
    kind: CaptureKind;
    stream: MediaStream;
    rotation?: number;
    videoBitsPerSecond?: number;
  }) {
    this.name = opts.name;
    this.kind = opts.kind;
    this.stream = opts.stream;
    this.rotation = opts.rotation ?? 0;
    this.videoBitsPerSecond = opts.videoBitsPerSecond ?? 10_000_000;

    this.previewVideo = document.createElement('video');
    this.previewVideo.muted = true;
    this.previewVideo.playsInline = true;
    this.previewVideo.srcObject = this.stream;
    void this.previewVideo.play().catch(() => {});

    for (const track of this.stream.getVideoTracks()) {
      track.addEventListener('mute', () => this.setInterrupted('camera muted by the system'));
      track.addEventListener('ended', () => this.setInterrupted('camera track ended'));
    }
    this.videoTrack = this.stream.getVideoTracks()[0] ?? null;
    this.caps = this.readCaps();

    this.socket = new StudioSocket();
    this.socket.onOpen(() => {
      this.socket.send({
        type: 'hello',
        role: 'camera',
        name: this.name,
        kind: this.kind,
        rotation: this.rotation,
        caps: this.caps as unknown as Record<string, unknown>,
      });
    });
    this.socket.on('camera-control', (msg) => {
      void this.applyCameraControl(msg as { zoom?: number; torch?: boolean });
    });
    this.socket.on('kicked', () => {
      this.socket.close(); // stop auto-reconnect
      this.error = 'Removed by the producer — reload the page to rejoin';
      this.setState('interrupted');
    });
    this.socket.on('hello-ack', (msg) => {
      this.sourceId = msg.sourceId as string;
      if (this.state === 'connecting') this.setState('live');
      void this.syncClock();
      if (this.recorder && this.sessionId) {
        // reconnected mid-recording
        this.socket.send({ type: 'recording-resume', sessionId: this.sessionId });
      }
    });
    this.socket.on('pong', (msg) => this.onPong(msg.t0 as number, msg.t1 as number));
    this.socket.on('record-start', (msg) => this.onRecordStart(msg.sessionId as string));
    this.socket.on('record-stop', () => this.stopRecorder());
    this.socket.on('resume-ok', (msg) => this.onResumeOk(msg.bytesReceived as number));
    this.socket.on('ingest-ack', (msg) => this.dropAcked(msg.bytes as number));
    this.socket.connect();

    this.previewTimer = window.setInterval(() => this.sendPreviewFrame(), PREVIEW_INTERVAL_MS);
  }

  setRotation(deg: number) {
    this.rotation = deg;
    this.socket.send({ type: 'status', rotation: deg });
  }

  // Zoom/torch capabilities, where the platform exposes them (iOS 17+ Safari,
  // Chrome with capable cameras). Feature-detected — absent means no control.
  private readCaps(): CameraCaps | null {
    const track = this.videoTrack;
    // zoom/torch are beyond the TS lib's MediaTrackCapabilities
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
    return Object.keys(out).length ? out : null;
  }

  async applyCameraControl(control: { zoom?: number; torch?: boolean }) {
    const track = this.videoTrack;
    if (!track?.applyConstraints) return;
    const advanced: Record<string, unknown> = {};
    if (typeof control.zoom === 'number') advanced.zoom = control.zoom;
    if (typeof control.torch === 'boolean') advanced.torch = control.torch;
    if (!Object.keys(advanced).length) return;
    try {
      await track.applyConstraints({ advanced: [advanced] } as MediaTrackConstraints);
    } catch {
      // unsupported combination — settings below report what actually applied
    }
    const settings = (track.getSettings?.() ?? {}) as { zoom?: number; torch?: boolean };
    if (this.caps?.zoom && typeof settings.zoom === 'number') this.caps.zoom.value = settings.zoom;
    this.socket.send({ type: 'status', zoom: settings.zoom, torch: settings.torch });
    this.emit();
  }

  onChange(fn: (ev: CaptureEvents) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit() {
    const ev = {
      state: this.state,
      sourceId: this.sourceId,
      error: this.error,
      pendingBytes: this.pendingBytes,
    };
    this.listeners.forEach((fn) => fn(ev));
  }

  private setState(state: CaptureState) {
    this.state = state;
    this.emit();
  }

  private setInterrupted(reason: string) {
    this.error = reason;
    this.setState('interrupted');
    this.socket.send({ type: 'status', interrupted: reason });
  }

  // --- clock sync -----------------------------------------------------------

  private pongSamples: number[] = [];

  private async syncClock() {
    this.pongSamples = [];
    for (let i = 0; i < 5; i++) {
      this.socket.send({ type: 'ping', t0: Date.now() });
      await new Promise((r) => setTimeout(r, 60));
    }
  }

  private onPong(t0: number, t1: number) {
    const t2 = Date.now();
    this.pongSamples.push(t1 - (t0 + t2) / 2);
    if (this.pongSamples.length >= 3) {
      const sorted = [...this.pongSamples].sort((a, b) => a - b);
      this.clockOffset = sorted[Math.floor(sorted.length / 2)];
    }
  }

  // --- preview --------------------------------------------------------------

  private sendPreviewFrame() {
    if (!this.socket.isOpen || !this.sourceId) return;
    if (this.socket.bufferedAmount > PREVIEW_SKIP_BUFFERED) return;
    const v = this.previewVideo;
    if (!v.videoWidth) return;
    const scale = Math.min(1, PREVIEW_MAX_DIM / Math.max(v.videoWidth, v.videoHeight));
    const w = Math.round(v.videoWidth * scale);
    const h = Math.round(v.videoHeight * scale);
    this.previewCanvas.width = w;
    this.previewCanvas.height = h;
    const ctx = this.previewCanvas.getContext('2d');
    if (!ctx) return;
    ctx.drawImage(v, 0, 0, w, h);
    this.previewCanvas.toBlob(
      async (blob) => {
        if (!blob || !this.socket.isOpen || !this.sourceId) return;
        const buf = new Uint8Array(await blob.arrayBuffer());
        this.socket.sendBinary(encodeFrame(FRAME_PREVIEW, this.sourceId, buf));
      },
      'image/jpeg',
      0.6
    );
  }

  // --- recording ------------------------------------------------------------

  static pickMimeType(): string | undefined {
    if (typeof MediaRecorder === 'undefined') return undefined;
    return MIME_CANDIDATES.find((m) => MediaRecorder.isTypeSupported(m));
  }

  private onRecordStart(sessionId: string) {
    if (this.recorder) {
      if (this.sessionId === sessionId) {
        this.socket.send({ type: 'recording-resume', sessionId });
      }
      return;
    }
    this.sessionId = sessionId;
    this.pending = [];
    this.pendingBytes = 0;
    this.nextOffset = 0;
    this.stopping = false;
    const mimeType = CaptureSource.pickMimeType();
    try {
      this.recorder = new MediaRecorder(this.stream, {
        mimeType,
        videoBitsPerSecond: this.videoBitsPerSecond,
        audioBitsPerSecond: 128_000,
      });
    } catch (err) {
      this.setInterrupted(`MediaRecorder failed: ${(err as Error).message}`);
      return;
    }
    this.recorder.onerror = (ev) => {
      this.setInterrupted(`Recorder error: ${(ev as ErrorEvent).error?.message ?? 'unknown'}`);
    };
    this.recorder.onstart = () => {
      this.socket.send({
        type: 'recording-started',
        serverStart: Date.now() + this.clockOffset,
        clockOffset: this.clockOffset,
        mimeType,
      });
      this.setState('recording');
    };
    // Chunks are serialized through a promise chain: blob reads are async and
    // must never reorder, and source-eof must trail the final chunk.
    this.recorder.ondataavailable = (ev) => {
      if (!ev.data.size) return;
      const blob = ev.data;
      this.chunkChain = this.chunkChain.then(async () => {
        const data = new Uint8Array(await blob.arrayBuffer());
        const chunk = { offset: this.nextOffset, data };
        this.nextOffset += data.byteLength;
        this.pending.push(chunk);
        this.pendingBytes += data.byteLength;
        this.sendChunk(chunk);
        // Off WiFi too long: stop cleanly before iOS kills the tab for memory.
        // Everything buffered so far still uploads on reconnect.
        if (this.pendingBytes > MAX_PENDING_BYTES && this.recorder?.state === 'recording') {
          this.error = 'Offline too long — recording stopped to protect memory; footage so far is safe';
          this.recorder.stop();
        }
        this.emit();
        this.maybeEof();
      });
    };
    this.recorder.onstop = () => {
      this.stopping = true;
      this.chunkChain = this.chunkChain.then(() => this.maybeEof());
    };
    this.recorder.start(TIMESLICE_MS);
  }

  private sendChunk(chunk: PendingChunk) {
    if (this.socket.isOpen && this.sourceId) {
      this.socket.sendBinary(encodeFrame(FRAME_MEDIA, this.sourceId, chunk.data));
    }
  }

  private onResumeOk(bytesReceived: number) {
    this.dropAcked(bytesReceived);
    for (const chunk of this.pending) this.sendChunk(chunk);
    if (this.stopping) this.maybeEof();
  }

  private dropAcked(bytes: number) {
    this.pending = this.pending.filter((c) => c.offset + c.data.byteLength > bytes);
    this.pendingBytes = this.pending.reduce((n, c) => n + c.data.byteLength, 0);
    this.emit();
  }

  private maybeEof() {
    if (!this.stopping || !this.socket.isOpen) return;
    if (this.recorder && this.recorder.state !== 'inactive') return;
    this.socket.send({ type: 'source-eof', sessionId: this.sessionId });
    this.stopping = false;
    this.recorder = null;
    this.sessionId = null;
    this.setState('live');
  }

  private stopRecorder() {
    if (this.recorder && this.recorder.state !== 'inactive') {
      this.setState('flushing');
      this.recorder.stop();
    }
  }

  dispose() {
    window.clearInterval(this.previewTimer);
    this.socket.close();
    for (const track of this.stream.getTracks()) track.stop();
  }
}

// Test hook (?fake=1): a moving canvas stands in for a camera, so an
// automated browser can drive a whole session with no permission prompts.
export function fakeRequested(): boolean {
  return new URLSearchParams(location.search).get('fake') === '1';
}

export function fakeStream(label = 'test', width = 1280, height = 720): MediaStream {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d')!;
  let i = 0;
  // setInterval, not requestAnimationFrame: a background tab stops painting
  // frames entirely with rAF, which would make a test recording empty.
  const draw = () => {
    i += 1;
    ctx.fillStyle = `hsl(${(i * 2) % 360}, 60%, 40%)`;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 96px sans-serif';
    ctx.fillText(`${label} ${i}`, 80, 360);
  };
  draw();
  setInterval(draw, 33);
  return canvas.captureStream(30);
}

export async function openCamera(facing: 'user' | 'environment'): Promise<MediaStream> {
  if (fakeRequested()) return fakeStream('cam');
  return navigator.mediaDevices.getUserMedia({
    video: {
      facingMode: facing,
      width: { ideal: 1920 },
      height: { ideal: 1080 },
      frameRate: { ideal: 30 },
    },
    audio: true,
  });
}

export async function openWebcam(deviceId?: string): Promise<MediaStream> {
  return navigator.mediaDevices.getUserMedia({
    video: {
      deviceId: deviceId ? { exact: deviceId } : undefined,
      width: { ideal: 1920 },
      height: { ideal: 1080 },
      frameRate: { ideal: 30 },
    },
    audio: true,
  });
}

export async function openScreen(): Promise<MediaStream> {
  return navigator.mediaDevices.getDisplayMedia({
    video: { frameRate: { ideal: 30 } },
    audio: false,
  });
}

// Longest side of a normalized screen capture. The finished video is
// 1080×1350 or 1080×1920, so a 4K desktop buys nothing and costs a lot.
const SCREEN_MAX_DIM = 1920;

export interface NormalizedStream {
  stream: MediaStream;
  stop(): void;
}

// Screen capture is not safe to hand straight to MediaRecorder:
//
//  - a shared window or tab has whatever pixel size the window happens to
//    be, and H.264 requires even width and height — an odd one makes the
//    encoder emit nothing at all;
//  - the capture is change-driven, so a still page produces almost no
//    frames and the recording comes out empty.
//
// Drawing it into a canvas on a steady timer fixes both: even dimensions by
// construction, and a real frame every tick no matter how still the screen
// is. setInterval rather than requestAnimationFrame, because a background
// tab stops painting with rAF.
export function normalizeForRecording(source: MediaStream, fps = 30): NormalizedStream {
  const track = source.getVideoTracks()[0];
  const settings = track?.getSettings() ?? {};
  const srcW = settings.width ?? 1280;
  const srcH = settings.height ?? 720;
  const scale = Math.min(1, SCREEN_MAX_DIM / Math.max(srcW, srcH));
  const even = (n: number) => Math.max(2, Math.floor(n / 2) * 2);
  const canvas = document.createElement('canvas');
  canvas.width = even(srcW * scale);
  canvas.height = even(srcH * scale);
  const ctx = canvas.getContext('2d', { alpha: false })!;

  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.srcObject = source;
  void video.play().catch(() => {});

  const timer = window.setInterval(() => {
    if (video.videoWidth) ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  }, Math.round(1000 / fps));

  const out = canvas.captureStream(fps);
  for (const audio of source.getAudioTracks()) out.addTrack(audio);
  return {
    stream: out,
    stop() {
      window.clearInterval(timer);
      video.srcObject = null;
      for (const t of source.getTracks()) t.stop();
      for (const t of out.getTracks()) t.stop();
    },
  };
}
