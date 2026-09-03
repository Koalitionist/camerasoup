// Feature probes for the two ends of a session. Everything here is a
// capability check, not a measurement — the network side lives in check.ts.
import { CaptureSource } from './capture';

export interface HostCaps {
  secure: boolean;
  folderAccess: boolean; // File System Access API: recordings go straight to disk
  webCodecs: boolean;
  h264: boolean;
  encodeFps: number; // measured: 1080×1350 frames per second, 0 if not measured
  aac: boolean;
  wakeLock: boolean;
  browser: string;
}

const H264_HIGH_40 = 'avc1.640028'; // High profile, level 4.0: 1080×1350 at 30 fps fits
const BENCH_W = 1080;
const BENCH_H = 1350;

// Encodes synthetic 1080×1350 frames and reports frames per second. Chrome
// no longer says whether an encoder is hardware, but the number does: Apple
// silicon manages hundreds, software lands around fifty.
export async function benchmarkEncoder(frames = 120): Promise<number> {
  const g = globalThis as unknown as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  const canvas = new OffscreenCanvas(BENCH_W, BENCH_H);
  const ctx = canvas.getContext('2d');
  if (!ctx || !g.VideoEncoder || !g.VideoFrame) return 0;
  let error: string | null = null;
  const enc = new g.VideoEncoder({
    output: () => {},
    error: (e: Error) => {
      error = e.message;
    },
  });
  enc.configure({
    codec: H264_HIGH_40,
    width: BENCH_W,
    height: BENCH_H,
    bitrate: 12_000_000,
    framerate: 30,
    hardwareAcceleration: 'prefer-hardware',
  });
  const t0 = performance.now();
  for (let i = 0; i < frames && !error; i++) {
    ctx.fillStyle = `hsl(${i * 3}, 70%, 45%)`;
    ctx.fillRect(0, 0, BENCH_W, BENCH_H);
    ctx.fillStyle = '#fff';
    ctx.fillRect((i * 9) % BENCH_W, (i * 5) % BENCH_H, 300, 300);
    const frame = new g.VideoFrame(canvas, { timestamp: i * 33_333 });
    enc.encode(frame, { keyFrame: i % 60 === 0 });
    frame.close();
    // Event-driven backpressure: timers are throttled in background tabs.
    while (enc.encodeQueueSize > 6 && !error) {
      await Promise.race([
        new Promise((r) => enc.addEventListener('dequeue', r, { once: true })),
        new Promise((r) => setTimeout(r, 2000)),
      ]);
    }
  }
  try {
    await enc.flush();
  } catch (err) {
    error = (err as Error).message;
  }
  const seconds = (performance.now() - t0) / 1000;
  enc.close();
  return error ? 0 : Math.round(frames / seconds);
}

export interface PhoneCaps {
  secure: boolean;
  getUserMedia: boolean;
  mediaRecorder: boolean;
  mimeType: string | null;
  wakeLock: boolean;
  cameraOpened: boolean;
  width: number;
  height: number;
  browser: string;
}

export function browserName(): string {
  const ua = navigator.userAgent;
  const m = (re: RegExp) => ua.match(re)?.[1];
  const os = /iPhone/.test(ua)
    ? 'iPhone'
    : /iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)
      ? 'iPad'
      : /Android/.test(ua)
        ? 'Android'
        : /Mac OS X/.test(ua)
          ? 'macOS'
          : /Windows/.test(ua)
            ? 'Windows'
            : /Linux/.test(ua)
              ? 'Linux'
              : 'unknown OS';
  if (/Edg\//.test(ua)) return `Edge ${m(/Edg\/(\d+)/)} on ${os}`;
  if (/OPR\//.test(ua)) return `Opera ${m(/OPR\/(\d+)/)} on ${os}`;
  if (/Firefox\//.test(ua)) return `Firefox ${m(/Firefox\/(\d+)/)} on ${os}`;
  if (/CriOS\//.test(ua)) return `Chrome ${m(/CriOS\/(\d+)/)} on ${os}`;
  if (/Chrome\//.test(ua)) return `Chrome ${m(/Chrome\/(\d+)/)} on ${os}`;
  if (/Safari\//.test(ua)) return `Safari ${m(/Version\/(\d+(?:\.\d+)?)/) ?? ''} on ${os}`.trim();
  return `unknown browser on ${os}`;
}

export async function hostCapabilities(): Promise<HostCaps> {
  const w = window as unknown as Record<string, unknown>;
  const folderAccess = typeof w.showDirectoryPicker === 'function';
  const VideoEncoder = w.VideoEncoder as
    | { isConfigSupported(c: unknown): Promise<{ supported?: boolean }> }
    | undefined;
  const AudioEncoder = w.AudioEncoder as
    | { isConfigSupported(c: unknown): Promise<{ supported?: boolean }> }
    | undefined;
  const webCodecs = !!VideoEncoder;
  let h264 = false;
  let encodeFps = 0;
  let aac = false;
  if (VideoEncoder) {
    try {
      const r = await VideoEncoder.isConfigSupported({
        codec: H264_HIGH_40,
        width: BENCH_W,
        height: BENCH_H,
        bitrate: 12_000_000,
        framerate: 30,
        hardwareAcceleration: 'prefer-hardware',
      });
      h264 = !!r.supported;
    } catch {
      h264 = false;
    }
    if (h264) encodeFps = await benchmarkEncoder().catch(() => 0);
  }
  if (AudioEncoder) {
    try {
      const r = await AudioEncoder.isConfigSupported({
        codec: 'mp4a.40.2',
        sampleRate: 48_000,
        numberOfChannels: 2,
        bitrate: 128_000,
      });
      aac = !!r.supported;
    } catch {
      aac = false;
    }
  }
  return {
    secure: window.isSecureContext,
    folderAccess,
    webCodecs,
    h264,
    encodeFps,
    aac,
    wakeLock: 'wakeLock' in navigator,
    browser: browserName(),
  };
}

export function phoneCapabilities(): PhoneCaps {
  return {
    secure: window.isSecureContext,
    getUserMedia: !!navigator.mediaDevices?.getUserMedia,
    mediaRecorder: typeof MediaRecorder !== 'undefined',
    mimeType: CaptureSource.pickMimeType() ?? null,
    wakeLock: 'wakeLock' in navigator,
    cameraOpened: false,
    width: 0,
    height: 0,
    browser: browserName(),
  };
}
