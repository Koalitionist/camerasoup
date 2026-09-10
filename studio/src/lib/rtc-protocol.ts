// Messages over the WebRTC data channels of a studio session.
//
// Every camera and every control view has a "control" channel (JSON) to the
// hub; cameras also have a "media" channel carrying raw MediaRecorder bytes
// in order, split into frames of MEDIA_FRAME_BYTES so no message exceeds
// what every browser's SCTP stack accepts.

export const MEDIA_FRAME_BYTES = 16 * 1024;

export interface CameraCaps {
  zoom?: { min: number; max: number; step: number; value: number };
  torch?: boolean;
  // Whether this camera will hold its white balance and exposure. Half of what
  // looks like a mismatch between angles is one camera changing its mind
  // mid-take, and no amount of grading afterwards can undo that.
  lock?: boolean;
}

export type SourceKind = 'remote' | 'local-webcam' | 'local-screen';
export type SourceState = 'live' | 'recording' | 'flushing' | 'interrupted';
// Auto-switching: 'loading' covers the one-time fetch of the face detector.
export type AutoStatus = 'off' | 'loading' | 'on' | 'error';
// What the program monitor is framing for. Social wants the narrow crops and
// can be judged on a cropped monitor; landscape is wider than the monitor's
// own cell, so the whole frame has to be shown to be framed at all.
export type Framing = 'social' | 'landscape';

export type CameraToHub =
  | {
      type: 'hello';
      name: string;
      kind: 'remote';
      rotation: number;
      // Optional: a camera page on an older bundle doesn't send it, and
      // absent has to mean "unknown" rather than "silent".
      hasAudio?: boolean;
      caps: CameraCaps | null;
    }
  | { type: 'ping'; t0: number }
  | {
      type: 'recording-started';
      sessionId: string;
      hubStart: number; // recorder start mapped onto the hub clock
      clockOffset: number;
      mimeType: string | null;
    }
  | { type: 'recording-resume'; sessionId: string }
  | { type: 'source-eof'; sessionId: string; durationMs: number }
  | {
      type: 'status';
      rotation?: number;
      interrupted?: string;
      pendingBytes?: number;
      zoom?: number;
      torch?: boolean;
      lock?: boolean;
    };

export type HubToCamera =
  | { type: 'hello-ack'; sourceId: string; hubTime: number; keyNumber: number }
  | { type: 'pong'; t0: number; t1: number }
  | { type: 'record-start'; sessionId: string; hubTime: number; resumed?: boolean }
  | { type: 'record-stop'; sessionId: string }
  | { type: 'ingest-ack'; bytes: number }
  | { type: 'resume-ok'; bytesReceived: number }
  | { type: 'camera-control'; zoom?: number; torch?: boolean; lock?: boolean }
  | { type: 'kicked' };

// What a control view (the Mac's own screen or an iPad) sees.
export interface SnapshotCamera {
  id: string;
  name: string;
  kind: SourceKind;
  rotation: number;
  online: boolean;
  state: SourceState;
  keyNumber: number;
  pendingBytes: number;
  bytes: number;
  rttMs: number | null;
  streamId: string | null; // MediaStream id of the forwarded preview on this control view
  caps: CameraCaps | null;
  zoom?: number;
  torch?: boolean;
  lock?: boolean;
}

export interface SessionSummary {
  id: string;
  sources: { id: string; file: string | null; duration?: number; status: string; error?: string }[];
}

export interface HubSnapshot {
  code: string;
  joinUrl: string;
  folder: string | null;
  cameras: SnapshotCamera[];
  recording: { sessionId: string; startedAt: number } | null;
  finalizing: string | null;
  program: string | null;
  auto: AutoStatus;
  framing: Framing;
  sessions: SessionSummary[];
  toast: string | null;
}

export type HubToControl = { type: 'state'; state: HubSnapshot };
export type ControlToHub =
  | { type: 'command'; cmd: 'record-start' | 'record-stop' }
  | { type: 'command'; cmd: 'cut' | 'remove'; sourceId: string }
  | {
      type: 'command';
      cmd: 'camera-control';
      sourceId: string;
      zoom?: number;
      torch?: boolean;
      lock?: boolean;
    }
  | { type: 'command'; cmd: 'auto'; on: boolean }
  | { type: 'command'; cmd: 'rename'; sourceId: string; name: string }
  | { type: 'command'; cmd: 'framing'; value: Framing };

export function sendJson(dc: RTCDataChannel | null, msg: unknown) {
  if (dc && dc.readyState === 'open') dc.send(JSON.stringify(msg));
}

export function onJson<T>(dc: RTCDataChannel, fn: (msg: T) => void): () => void {
  const handler = (ev: MessageEvent) => {
    if (typeof ev.data !== 'string') return;
    let msg: T;
    try {
      msg = JSON.parse(ev.data) as T;
    } catch {
      return;
    }
    fn(msg);
  };
  dc.addEventListener('message', handler);
  return () => dc.removeEventListener('message', handler);
}

// Resolves once the channel's send buffer has drained below its threshold.
// Event driven: timers are throttled in background tabs.
export function drained(dc: RTCDataChannel): Promise<unknown> {
  return Promise.race([
    new Promise((r) => dc.addEventListener('bufferedamountlow', r, { once: true })),
    new Promise((r) => setTimeout(r, 250)),
  ]);
}

export function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'camera'
  );
}
