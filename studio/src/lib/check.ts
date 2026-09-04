// The connection check: a phone pushes random bytes to the producer over a
// WebRTC data channel for a few seconds, the producer measures, and both
// sides get a verdict written in cameras rather than megabits.
//
// Data channel protocol: JSON strings are control messages, ArrayBuffers are
// test payload.
import type { HostCaps, PhoneCaps } from './capabilities';
import type { PathInfo } from './peer';

export const CHUNK_BYTES = 16 * 1024; // safe cross-browser message size
const HIGH_WATER = 1024 * 1024;
export const TEST_SECONDS = 5;

// What one camera needs, with headroom for WiFi being WiFi.
const MBPS_PER_1080 = 15; // "High" = 10 Mbps video + audio, ×1.5
const MBPS_PER_720 = 9; // "Medium" = 6 Mbps, ×1.5

export type Control =
  | { type: 'caps'; phone: PhoneCaps }
  | { type: 'start'; seconds: number }
  | { type: 'progress'; bytes: number }
  | { type: 'done'; bytes: number }
  | { type: 'rtt'; t: number }
  | { type: 'rtt-echo'; t: number }
  | { type: 'result'; report: CheckReport };

export interface ThroughputResult {
  mbps: number;
  bytes: number;
  seconds: number;
}

export type Verdict = 'green' | 'yellow' | 'red';

export interface CheckReport {
  verdict: Verdict;
  headline: string;
  lines: string[];
  connection: PathInfo['connection'];
  mbps: number;
  rttMs: number;
  cameras1080: number;
  cameras720: number;
  host: HostCaps | null;
  phone: PhoneCaps | null;
  path: PathInfo | null;
  at: string;
}

export function sendControl(dc: RTCDataChannel, msg: Control) {
  if (dc.readyState === 'open') dc.send(JSON.stringify(msg));
}

export function onControl(dc: RTCDataChannel, fn: (msg: Control) => void): () => void {
  const handler = (ev: MessageEvent) => {
    if (typeof ev.data !== 'string') return;
    try {
      fn(JSON.parse(ev.data) as Control);
    } catch {
      // not ours
    }
  };
  dc.addEventListener('message', handler);
  return () => dc.removeEventListener('message', handler);
}

export function waitControl<T extends Control['type']>(
  dc: RTCDataChannel,
  type: T,
  timeoutMs = 10_000
): Promise<Extract<Control, { type: T }>> {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      off();
      reject(
        new Error(
          type === 'caps'
            ? 'the phone connected but did not start the check — scan the code again and choose “Test connection”'
            : `the phone stopped responding (waiting for "${type}")`
        )
      );
    }, timeoutMs);
    const off = onControl(dc, (msg) => {
      if (msg.type === type) {
        window.clearTimeout(timer);
        off();
        resolve(msg as Extract<Control, { type: T }>);
      }
    });
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// --- host side ---------------------------------------------------------------

export async function measureRtt(dc: RTCDataChannel, samples = 8): Promise<number> {
  const rtts: number[] = [];
  for (let i = 0; i < samples; i++) {
    const t = performance.now();
    const echoed = waitControl(dc, 'rtt-echo', 2000).catch(() => null);
    sendControl(dc, { type: 'rtt', t });
    const echo = await echoed;
    if (echo && echo.t === t) rtts.push(performance.now() - t);
  }
  if (!rtts.length) return 2000;
  rtts.sort((a, b) => a - b);
  return rtts[Math.floor(rtts.length / 2)];
}

export function measureUpload(
  dc: RTCDataChannel,
  seconds: number,
  onProgress?: (bytes: number) => void
): Promise<ThroughputResult> {
  return new Promise((resolve, reject) => {
    let bytes = 0;
    let first = 0;
    let last = 0;
    const onMessage = (ev: MessageEvent) => {
      if (typeof ev.data === 'string') {
        const msg = JSON.parse(ev.data) as Control;
        if (msg.type !== 'done') return;
        cleanup();
        const secs = Math.max((last - first) / 1000, 0.5);
        resolve({ bytes, seconds: secs, mbps: (bytes * 8) / secs / 1e6 });
        return;
      }
      const size = (ev.data as ArrayBuffer).byteLength ?? 0;
      const now = performance.now();
      if (!bytes) first = now;
      bytes += size;
      last = now;
      onProgress?.(bytes);
    };
    const timer = window.setTimeout(() => {
      cleanup();
      reject(new Error('the speed test never finished'));
    }, (seconds + 15) * 1000);
    const cleanup = () => {
      window.clearTimeout(timer);
      dc.removeEventListener('message', onMessage);
    };
    dc.addEventListener('message', onMessage);
    sendControl(dc, { type: 'start', seconds });
  });
}

// --- phone side --------------------------------------------------------------

// Waits for the channel's send buffer to drain below its threshold. Event
// driven: a plain timer would be throttled to one tick per second in a
// background tab and cap the test at a few megabits.
function drained(dc: RTCDataChannel): Promise<unknown> {
  return Promise.race([
    new Promise((r) => dc.addEventListener('bufferedamountlow', r, { once: true })),
    sleep(250),
  ]);
}

// Answers RTT probes and, on "start", pushes random payload for the
// requested duration with backpressure, then reports the byte count.
export function serveCheck(dc: RTCDataChannel, onStage?: (stage: 'testing' | 'sent') => void) {
  const payload = new Uint8Array(CHUNK_BYTES);
  crypto.getRandomValues(payload);
  dc.bufferedAmountLowThreshold = HIGH_WATER / 4;
  return onControl(dc, async (msg) => {
    if (msg.type === 'rtt') {
      sendControl(dc, { type: 'rtt-echo', t: msg.t });
      return;
    }
    if (msg.type !== 'start') return;
    onStage?.('testing');
    const end = performance.now() + msg.seconds * 1000;
    let sent = 0;
    while (performance.now() < end && dc.readyState === 'open') {
      if (dc.bufferedAmount > HIGH_WATER) {
        await drained(dc);
        continue;
      }
      dc.send(payload);
      sent += payload.byteLength;
    }
    while (dc.bufferedAmount > 0 && dc.readyState === 'open') await drained(dc);
    sendControl(dc, { type: 'done', bytes: sent });
    onStage?.('sent');
  });
}

// --- verdict -----------------------------------------------------------------

export function buildReport(input: {
  host: HostCaps;
  phone: PhoneCaps;
  path: PathInfo;
  upload: ThroughputResult;
  rttMs: number;
}): CheckReport {
  const { host, phone, path, upload, rttMs } = input;
  const mbps = upload.mbps;
  const cameras1080 = Math.floor(mbps / MBPS_PER_1080);
  const cameras720 = Math.floor(mbps / MBPS_PER_720);
  const lines: string[] = [];
  let verdict: Verdict = 'green';
  const downgrade = (to: Verdict) => {
    if (to === 'red' || verdict === 'green') verdict = to;
  };
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

  if (path.connection === 'direct') {
    lines.push('Phone and Mac talk directly over your WiFi.');
  } else if (path.connection === 'reflexive') {
    lines.push(
      'Traffic loops through your router instead of going device to device. It works, but slower and less reliably.'
    );
    downgrade('yellow');
  } else if (path.connection === 'relay') {
    lines.push('Connected through a relay server: this network blocks direct connections.');
    downgrade('yellow');
  } else {
    lines.push('Could not tell which path the connection took.');
    downgrade('yellow');
  }

  if (cameras1080 >= 2) {
    lines.push(`Bandwidth for ${plural(cameras1080, 'camera')} at 1080p, or ${cameras720} at 720p.`);
  } else if (cameras1080 === 1) {
    lines.push(`Bandwidth for one camera at 1080p, or ${plural(cameras720, 'camera')} at 720p.`);
    downgrade('yellow');
  } else if (cameras720 >= 1) {
    lines.push(`Bandwidth for ${plural(cameras720, 'camera')} at 720p only.`);
    downgrade('yellow');
  } else {
    lines.push('Not enough bandwidth for even one camera.');
    downgrade('red');
  }

  if (rttMs > 150) {
    lines.push(
      `Round trip of ${Math.round(rttMs)} ms: camera sync may be off by a frame or two.`
    );
    downgrade('yellow');
  }

  if (!host.folderAccess) {
    lines.push('This browser can’t save recordings to a folder. On the Mac, use Chrome, Edge, Brave or Arc.');
    downgrade('red');
  }
  if (!host.webCodecs) {
    lines.push('This browser has no WebCodecs, so it can’t render. Use Chrome, Edge, Brave or Arc.');
    downgrade('red');
  } else {
    if (!host.h264) {
      lines.push('This browser can’t encode h264 video, so it can’t render. Use Chrome, Edge, Brave or Arc.');
      downgrade('red');
    } else if (host.encodeFps > 0 && host.encodeFps < 60) {
      lines.push(
        `The video encoder manages ${host.encodeFps} fps at 1080p, so renders take longer than the recording itself. A newer Mac or an updated Chrome usually brings hardware encoding.`
      );
      downgrade('yellow');
    } else if (host.encodeFps >= 60) {
      lines.push(`Renders about ${Math.round(host.encodeFps / 30)}× faster than realtime.`);
    }
    if (!host.aac) {
      lines.push('No AAC audio encoder: rendered files would use Opus audio, which Instagram may reject.');
      downgrade('yellow');
    }
  }
  if (!host.wakeLock) lines.push('No wake lock in this browser: keep the Mac awake by hand while recording.');

  if (!phone.mediaRecorder || !phone.mimeType) {
    lines.push('The phone’s browser can’t record video. Use Safari on iPhone or Chrome on Android.');
    downgrade('red');
  } else if (!phone.cameraOpened) {
    lines.push('The phone didn’t grant camera access. Allow it in Settings and test again.');
    downgrade('yellow');
  } else if (phone.height && Math.min(phone.width, phone.height) < 1080) {
    lines.push(`The phone camera opened at ${phone.width}×${phone.height}, below 1080p.`);
  }
  if (!phone.wakeLock) lines.push('The phone can’t hold a wake lock: keep its screen on while recording.');

  const headline =
    verdict === 'green' ? 'Works here.' : verdict === 'yellow' ? 'Works here, with limits.' : 'Won’t work here yet.';

  return {
    verdict,
    headline,
    lines,
    connection: path.connection,
    mbps: Math.round(mbps * 10) / 10,
    rttMs: Math.round(rttMs),
    cameras1080,
    cameras720,
    host,
    phone,
    path,
    at: new Date().toISOString(),
  };
}

export function failedReport(reason: string, host: HostCaps | null, phone: PhoneCaps | null): CheckReport {
  const lines = [
    `Phone and Mac could not connect to each other (${reason}).`,
    'This usually means the WiFi keeps devices apart, which is common on guest, hotel and office networks. Put both devices on a phone hotspot or a home network and test again.',
  ];
  return {
    verdict: 'red',
    headline: 'Won’t work on this network.',
    lines,
    connection: 'unknown',
    mbps: 0,
    rttMs: 0,
    cameras1080: 0,
    cameras720: 0,
    host,
    phone,
    path: null,
    at: new Date().toISOString(),
  };
}

// Anonymous tally for the product decision "is a paid relay worth it?".
export function postVerdict(origin: string, report: CheckReport) {
  const body = {
    verdict: report.verdict,
    connection: report.connection,
    mbps: report.mbps,
    rttMs: report.rttMs,
    host: report.host?.browser ?? '',
    phone: report.phone?.browser ?? '',
  };
  fetch(`${origin}/api/verdict`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    keepalive: true,
  }).catch(() => {});
}
