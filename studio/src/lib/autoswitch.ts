// Auto-switching by head pose. With cameras ringed around one person every
// angle hears the same voice, so audio says nothing about which camera is
// being talked to — but the pictures differ completely: one sees a face
// square to the lens, two see profiles, one sees the back of a head. A face
// detector scores that frontality per angle and the switcher cuts to the
// winner, which makes turning your head the switching gesture.
//
// The detector only becomes confident a few hundred milliseconds after a turn
// begins, so a live cut always lands late. The saved edit does not have to:
// each angle keeps a short score history, and a cut is dated where the turn
// started rather than where the detector caught up. The program monitor lags;
// session.json does not.
import type { FaceDetector } from '@mediapipe/tasks-vision';
import type { AutoStatus } from './rtc-protocol';

// Fetched on demand: a WASM runtime this size has no business in the main
// bundle for a feature that is off by default. Versioned URLs, so a vendored
// copy can replace them without touching the logic below.
const WASM_BASE = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1/wasm';
const MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite';

const TICK_MS = 60; // one angle scored per tick, round-robin
const STALE_MS = 1500; // a score older than this counts as no face
const MIN_FACE = 0.045; // face box height as a share of the frame
const HISTORY_MS = 2500;
const LOOKBACK_MS = 900; // how far back a cut may be dated
const MANUAL_HOLD_MS = 10_000; // a human switch parks the switcher

export interface SwitchRules {
  minShotMs: number; // nothing is on air for less time than this
  holdMs: number; // a winner still in motion must lead this long
  settledHoldMs: number; // ...one that has stopped turning, only this long
  settledDelta: number; // how still a score has to be to count as settled
  margin: number; // the winner must beat the program by this much
  breatheAfterMs: number; // a long static shot lets the other angles in
}

export const RULES: SwitchRules = {
  minShotMs: 2500,
  holdMs: 400,
  settledHoldMs: 180,
  settledDelta: 0.06,
  margin: 0.12,
  breatheAfterMs: 25_000,
};

export interface Sample {
  t: number;
  score: number;
}

export interface SwitchState {
  candidateId: string | null;
  candidateSince: number;
  lastCutAt: number;
  manualUntil: number;
}

export function newSwitchState(now: number): SwitchState {
  return { candidateId: null, candidateSince: 0, lastCutAt: now, manualUntil: 0 };
}

// The cutting rules, with no detector, clock or DOM in sight: given what each
// angle scores right now, the id to take, or null to stay put. Kept pure and
// separate from the machinery because this — not the model — is what decides
// whether an auto-cut feels human, and it is the part worth tuning.
export function chooseCut(
  state: SwitchState,
  scores: Map<string, number>,
  program: string | null,
  now: number,
  rules: SwitchRules = RULES,
  trends?: Map<string, number>
): string | null {
  if (now < state.manualUntil) return null;
  if (now - state.lastCutAt < rules.minShotMs) return null;

  const onAir = program ? scores.get(program) ?? 0 : 0;
  let winner: string | null = null;
  let top = 0;
  for (const [id, score] of scores) {
    if (score > top) {
      top = score;
      winner = id;
    }
  }

  if (winner && winner !== program && top >= onAir + rules.margin) {
    // Turning from one camera to another sweeps through the angles in
    // between, and each of those is briefly frontal. Only a winner that holds
    // is a winner.
    if (state.candidateId !== winner) {
      state.candidateId = winner;
      state.candidateSince = now;
      return null;
    }
    // A face still swinging through the frame and a face that has arrived
    // both lead by a margin; only the second one is worth cutting to early.
    // A missing trend means the caller cannot tell, so it waits the full hold.
    const moving = trends?.get(winner) ?? Infinity;
    const needed = moving <= rules.settledDelta ? rules.settledHoldMs : rules.holdMs;
    return now - state.candidateSince >= needed ? winner : null;
  }
  state.candidateId = null;

  // Nobody has moved for a long time. A ring of cameras where three are never
  // cut to is a wasted ring, so take a side angle. This needs no state of its
  // own: the margin rule pulls the program straight back to whichever camera
  // the subject is actually facing once the minimum shot is up.
  if (now - state.lastCutAt <= rules.breatheAfterMs) return null;
  let alt: string | null = null;
  let best = 0;
  for (const [id, score] of scores) {
    if (id !== program && score > best) {
      best = score;
      alt = id;
    }
  }
  return alt;
}

// Date a cut where the head started turning rather than where the detector
// caught up: walk back while the winner was already climbing, and stop at the
// last sample taken before it began to win. The lookback is shorter than the
// minimum shot, so this can never reach back past the cut before it.
export function backdate(history: Sample[], now: number): number {
  const top = history[history.length - 1]?.score ?? 0;
  const floor = now - LOOKBACK_MS;
  let at = now;
  for (let i = history.length - 1; i >= 0; i--) {
    const sample = history[i];
    if (sample.t < floor || sample.score < top * 0.5) break;
    at = sample.t;
  }
  return at;
}

// How far an angle's score has moved over the recent past. Near zero means
// the subject has settled on that camera; a large value means they are still
// turning — and mid-turn every camera swept past looks briefly frontal.
export function trend(history: Sample[], now: number, windowMs = 250): number {
  const last = history[history.length - 1];
  if (!last) return Infinity;
  let earliest = last;
  for (let i = history.length - 1; i >= 0; i--) {
    if (now - history[i].t > windowMs) break;
    earliest = history[i];
  }
  return earliest === last ? Infinity : Math.abs(last.score - earliest.score);
}

// Frontality from the detector's six keypoints. A face square to the lens
// puts the nose midway between the ears and holds the eyes far apart; a
// profile hides one ear and collapses the eyes onto each other. Both terms
// are ratios taken inside the face box, so neither cares how far away the
// subject is standing.
//
// Pitch is deliberately not scored: it cannot be read honestly from six
// points. Looking down at notes lowers the score through the ratios
// themselves rather than through a term that pretends to measure it.
export function frontality(
  detections: { boundingBox?: { width: number; height: number }; keypoints: { x: number }[]; categories: { score: number }[] }[],
  frameWidth: number,
  frameHeight: number
): number {
  let best = 0;
  for (const d of detections) {
    const box = d.boundingBox;
    if (!box || d.keypoints.length < 6) continue;
    if (box.height / frameHeight < MIN_FACE) continue;
    // Keypoints are normalized; the box is in pixels. The measure is
    // symmetric in the two ears, so which one is the left ear does not matter.
    const [eyeA, eyeB, nose, , earA, earB] = d.keypoints;
    // Signed on purpose. Head-on, the nose sits between the ears and the two
    // offsets cancel; in profile both ears fall on the same side of it and
    // they add up instead. Taking each distance absolutely would rate a
    // profile as symmetric as a face square to the lens.
    const a = earA.x - nose.x;
    const b = earB.x - nose.x;
    const span = Math.abs(a) + Math.abs(b);
    const symmetry = span > 0 ? clamp(1 - Math.abs(a + b) / span) : 0;
    // Eye separation as a share of the box: about 0.40 head-on, 0.12 in profile.
    const boxWidth = box.width / frameWidth;
    const eyes = boxWidth > 0 ? Math.abs(eyeB.x - eyeA.x) / boxWidth : 0;
    const spread = clamp((eyes - 0.12) / 0.28);
    const confidence = d.categories[0]?.score ?? 1;
    best = Math.max(best, (0.65 * symmetry + 0.35 * spread) * confidence);
  }
  return best;
}

const clamp = (n: number) => (n < 0 ? 0 : n > 1 ? 1 : n);

export interface AutoCandidate {
  id: string;
  stream: MediaStream | null;
}

interface Watched {
  video: HTMLVideoElement;
  stream: MediaStream;
  history: Sample[];
}

export class AutoSwitcher {
  status: AutoStatus = 'off';
  private detector: FaceDetector | null = null;
  private watched = new Map<string, Watched>();
  private timer: number | undefined;
  private cursor = 0;
  private state = newSwitchState(0);

  constructor(
    private readonly sources: () => AutoCandidate[],
    private readonly program: () => string | null,
    private readonly cut: (sourceId: string, atMs: number) => void,
    private readonly onStatus: (status: AutoStatus, error?: string) => void
  ) {}

  async enable() {
    if (this.status === 'on' || this.status === 'loading') return;
    this.setStatus('loading');
    try {
      const vision = await import('@mediapipe/tasks-vision');
      const fileset = await vision.FilesetResolver.forVisionTasks(WASM_BASE);
      const make = (delegate: 'GPU' | 'CPU') =>
        vision.FaceDetector.createFromOptions(fileset, {
          baseOptions: { modelAssetPath: MODEL_URL, delegate },
          // IMAGE, not VIDEO: one detector is shared round-robin across every
          // angle, and VIDEO mode carries per-frame state that assumes a
          // single continuous stream.
          runningMode: 'IMAGE',
          minDetectionConfidence: 0.4,
        });
      this.detector = await make('GPU').catch(() => make('CPU'));
    } catch (err) {
      this.detector = null;
      this.setStatus('error', (err as Error).message);
      return;
    }
    this.state = newSwitchState(Date.now());
    this.timer = window.setInterval(() => this.tick(), TICK_MS);
    this.setStatus('on');
  }

  disable() {
    window.clearInterval(this.timer);
    this.timer = undefined;
    for (const w of this.watched.values()) release(w);
    this.watched.clear();
    this.detector?.close();
    this.detector = null;
    this.setStatus('off');
  }

  // Any human switch parks the switcher: an operator reaching for the keys is
  // overruling it, and it should not argue back for a while.
  noteManualCut() {
    const now = Date.now();
    this.state.manualUntil = now + MANUAL_HOLD_MS;
    this.state.lastCutAt = now;
    this.state.candidateId = null;
  }

  private tick() {
    if (!this.detector) return;
    this.sync(this.sources());
    const ids = [...this.watched.keys()];
    if (!ids.length) return;
    const w = this.watched.get(ids[this.cursor++ % ids.length]);
    if (!w) return;
    let score = 0;
    try {
      score = this.score(w);
    } catch {
      // a frame the detector could not read; the next pass tries again
    }
    const now = Date.now();
    w.history.push({ t: now, score });
    while (w.history.length > 1 && w.history[0].t < now - HISTORY_MS) w.history.shift();
    this.decide(now);
  }

  private score(w: Watched): number {
    const video = w.video;
    if (!this.detector || video.readyState < 2 || !video.videoWidth) return 0;
    const { detections } = this.detector.detect(video);
    return frontality(detections, video.videoWidth, video.videoHeight);
  }

  private decide(now: number) {
    const scores = new Map<string, number>();
    const trends = new Map<string, number>();
    for (const [id, w] of this.watched) {
      const last = w.history[w.history.length - 1];
      scores.set(id, last && now - last.t < STALE_MS ? last.score : 0);
      trends.set(id, trend(w.history, now));
    }
    const winner = chooseCut(this.state, scores, this.program(), now, RULES, trends);
    if (!winner) return;
    this.state.candidateId = null;
    this.state.lastCutAt = now;
    this.cut(winner, backdate(this.watched.get(winner)?.history ?? [], now));
  }

  // One hidden <video> per angle: the detector reads frames from an element
  // and the hub only holds streams.
  private sync(live: AutoCandidate[]) {
    const seen = new Set<string>();
    for (const source of live) {
      if (!source.stream) continue;
      seen.add(source.id);
      const existing = this.watched.get(source.id);
      if (existing?.stream === source.stream) continue;
      if (existing) release(existing);
      this.watched.set(source.id, {
        video: hiddenVideo(source.stream),
        stream: source.stream,
        history: [],
      });
    }
    for (const [id, w] of this.watched) {
      if (seen.has(id)) continue;
      release(w);
      this.watched.delete(id);
    }
  }

  private setStatus(status: AutoStatus, error?: string) {
    this.status = status;
    this.onStatus(status, error);
  }
}

// Parked in the document rather than detached, and invisible by size rather
// than by `display: none`: a hidden element is free to stop decoding frames,
// and frames are the whole point.
function hiddenVideo(stream: MediaStream): HTMLVideoElement {
  const video = document.createElement('video');
  video.srcObject = stream;
  video.muted = true;
  video.autoplay = true;
  video.playsInline = true;
  video.setAttribute('aria-hidden', 'true');
  video.style.cssText =
    'position:fixed;left:0;top:0;width:1px;height:1px;opacity:0;pointer-events:none';
  document.body.appendChild(video);
  void video.play().catch(() => {});
  return video;
}

function release(w: Watched) {
  w.video.pause();
  w.video.srcObject = null;
  w.video.remove();
}
