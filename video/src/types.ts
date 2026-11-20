export interface EditSource {
  id: string;
  src: string; // URL of the finalized file (relative in the browser, absolute for renders)
  fileName?: string; // name within the session folder, for the in-browser renderer
  recordStart: number; // server-clock ms when this source's recorder started
  duration: number; // seconds
  rotation?: number; // 0 | 90 | 180 | 270, clockwise
  grade?: Grade; // color correction, applied on every draw
  framing?: Framing; // zoom and position within the output frame
  hasAudio?: boolean; // undefined on older sessions: unknown, not silent
}

export interface Cut {
  atFrame: number;
  sourceId: string;
}

export const FORMATS = {
  '4:5': { width: 1080, height: 1350 }, // Instagram/LinkedIn feed
  '9:16': { width: 1080, height: 1920 }, // YouTube Shorts / Reels
  '16:9': { width: 1920, height: 1080 }, // YouTube, and anything with a lid
} as const;

export type FilmFormat = keyof typeof FORMATS;

// A type alias (not an interface) so it satisfies Remotion's
// `Props extends Record<string, unknown>` constraint on Player/Composition.
export type FilmProps = {
  sources: EditSource[];
  cuts: Cut[];
  audioSourceId: string | null;
  fps: number;
  format?: FilmFormat;
  removed?: Range[]; // stretches cut out of the program, on the synced timeline
  crossfade?: boolean; // blend the audio across each removed stretch
};

// [from, to) in frames of the synced timeline.
export interface Range {
  from: number;
  to: number;
}

export interface Segment {
  start: number;
  len: number;
  sourceId: string;
}

export interface Timeline {
  durationInFrames: number;
  /** frames to trim from each source's start so frame 0 is the same instant everywhere */
  trim: Record<string, number>;
  segments: Segment[];
}

// Timeline zero = the moment every camera was rolling; end = the first camera
// to stop. Within that window all sources cover every frame.
export function buildTimeline(props: FilmProps): Timeline {
  const { sources, cuts, fps } = props;
  if (sources.length === 0) {
    return { durationInFrames: 1, trim: {}, segments: [] };
  }
  const t0 = Math.max(...sources.map((s) => s.recordStart));
  const end = Math.min(...sources.map((s) => s.recordStart + s.duration * 1000));
  const durationInFrames = Math.max(1, Math.floor(((end - t0) / 1000) * fps));

  const trim: Record<string, number> = {};
  for (const s of sources) {
    trim[s.id] = Math.max(0, Math.round(((t0 - s.recordStart) / 1000) * fps));
  }

  const ids = new Set(sources.map((s) => s.id));
  const valid = cuts
    .filter((c) => ids.has(c.sourceId) && c.atFrame >= 0 && c.atFrame < durationInFrames)
    .sort((a, b) => a.atFrame - b.atFrame);

  // Cut points, deduped by frame (last one wins), with an implicit opening cut.
  const byFrame = new Map<number, string>();
  byFrame.set(0, sources[0].id);
  for (const c of valid) byFrame.set(c.atFrame, c.sourceId);
  const points = [...byFrame.entries()].sort((a, b) => a[0] - b[0]);

  const segments: Segment[] = [];
  for (let i = 0; i < points.length; i++) {
    const [start, sourceId] = points[i];
    const next = points[i + 1]?.[0] ?? durationInFrames;
    if (next > start) segments.push({ start, len: next - start, sourceId });
  }
  return { durationInFrames, trim, segments };
}

// ---- cutting out time ---------------------------------------------------
//
// Removed stretches live on the same synced timeline as the angle cuts, not
// on the shortened program. So taking time out never moves a cut, putting it
// back restores exactly what was there, and a cut inside a removed stretch
// simply goes with it.

// Sorted, merged, clipped to the timeline; anything empty dropped.
export function normalizeRanges(ranges: Range[] | undefined, duration: number): Range[] {
  const sorted = (ranges ?? [])
    .map((r) => ({
      from: Math.max(0, Math.round(Math.min(r.from, r.to))),
      to: Math.min(duration, Math.round(Math.max(r.from, r.to))),
    }))
    .filter((r) => r.to > r.from)
    .sort((a, b) => a.from - b.from);
  const out: Range[] = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r.from <= last.to) last.to = Math.max(last.to, r.to);
    else out.push({ ...r });
  }
  // The program cannot be cut down to nothing.
  if (out.length === 1 && out[0].from === 0 && out[0].to === duration) return [];
  return out;
}

// What is left: the complement of the removed stretches.
export function keptSpans(duration: number, removed: Range[]): Range[] {
  const kept: Range[] = [];
  let at = 0;
  for (const r of removed) {
    if (r.from > at) kept.push({ from: at, to: r.from });
    at = Math.max(at, r.to);
  }
  if (at < duration) kept.push({ from: at, to: duration });
  return kept;
}

// One continuous run of a single angle in the finished film.
export interface Piece {
  sourceId: string;
  src: number; // first frame, on the synced timeline
  out: number; // first frame, in the finished film
  len: number;
}

export interface Program {
  timeline: Timeline;
  removed: Range[];
  kept: Range[];
  pieces: Piece[];
  durationInFrames: number; // of the finished film
}

// The film as rendered: the angle segments with the removed stretches taken
// out, laid end to end. Both renderers and the editor's clock read this.
export function buildProgram(props: FilmProps): Program {
  const timeline = buildTimeline(props);
  const removed = normalizeRanges(props.removed, timeline.durationInFrames);
  const kept = keptSpans(timeline.durationInFrames, removed);
  const pieces: Piece[] = [];
  let out = 0;
  for (const span of kept) {
    for (const seg of timeline.segments) {
      const from = Math.max(span.from, seg.start);
      const to = Math.min(span.to, seg.start + seg.len);
      if (to <= from) continue;
      pieces.push({ sourceId: seg.sourceId, src: from, out: out + (from - span.from), len: to - from });
    }
    out += span.to - span.from;
  }
  return { timeline, removed, kept, pieces, durationInFrames: Math.max(1, out) };
}

// Synced-timeline frame → finished-film frame. Inside a removed stretch it
// lands on the join where that stretch used to be.
export function programFrameOf(kept: Range[], frame: number): number {
  let out = 0;
  for (const span of kept) {
    if (frame < span.from) return out;
    if (frame < span.to) return out + (frame - span.from);
    out += span.to - span.from;
  }
  return out;
}

// The removed stretch containing a frame, if any.
export function removedAt(removed: Range[], frame: number): Range | null {
  return removed.find((r) => frame >= r.from && frame < r.to) ?? null;
}

// ---- framing -------------------------------------------------------------
//
// Every angle is fitted to the output by cover: scaled until the frame is
// full, the overflow cropped. Framing is where that crop lands and how far in
// it goes, so something at the edge of a shot can be pushed out of the
// picture. Like a grade it is data, re-applied on every draw.
//
// The position is a focus point on the upright picture, not an offset in
// output pixels: the same point stays in the middle of a 4:5, a 9:16 and a
// 16:9 render, as far as each one's crop allows.

export interface Framing {
  zoom: number; // 1 = the plain cover fit, up to MAX_ZOOM
  x: number; // 0..1 across the upright picture; 0.5 = centered
  y: number; // 0..1 down it
}

export const MAX_ZOOM = 4;
export const UNFRAMED: Framing = { zoom: 1, x: 0.5, y: 0.5 };

export function isUnframed(framing?: Framing | null): boolean {
  if (!framing) return true;
  const near = (a: number, b: number) => Math.abs(a - b) < 0.0005;
  return near(framing.zoom, 1) && near(framing.x, 0.5) && near(framing.y, 0.5);
}

export interface Placement {
  x: number;
  y: number;
  w: number;
  h: number;
}

// Where the upright picture goes in the output frame. Never leaves an edge
// uncovered: the focus point is centered only as far as the picture reaches.
export function placeCover(
  outW: number,
  outH: number,
  contentW: number,
  contentH: number,
  framing?: Framing | null
): Placement {
  const f = framing ?? UNFRAMED;
  const zoom = clamp(f.zoom, 1, MAX_ZOOM);
  const scale = Math.max(outW / contentW, outH / contentH) * zoom;
  const w = contentW * scale;
  const h = contentH * scale;
  return {
    x: clamp(outW / 2 - f.x * w, outW - w, 0),
    y: clamp(outH / 2 - f.y * h, outH - h, 0),
    w,
    h,
  };
}

// The focus point a placement actually shows. Storing this rather than the
// raw drag means pulling past an edge does not bank movement that has to be
// undone before the picture moves back.
export function focusOf(outW: number, outH: number, p: Placement): { x: number; y: number } {
  return { x: (outW / 2 - p.x) / p.w, y: (outH / 2 - p.y) / p.h };
}

// ---- color ---------------------------------------------------------------
//
// A grade is data, like the cuts: the footage stays untouched and the look is
// re-applied on every draw. Both ends that draw a frame — the editor's program
// monitor and the renderer — are a 2D canvas, so the same values reach the
// screen and the file through the same API.
//
// Canvas filter primitives cannot express a per-channel gain, which is exactly
// what white balance is, so a grade is applied in two parts: the filter string
// does the tonal work during the draw, and the gain is a multiply pass over
// the frame afterwards.

export interface Grade {
  brightness: number; // 1 = unchanged
  contrast: number; // 1
  saturation: number; // 1
  gain: [number, number, number]; // per-channel white balance, [1, 1, 1]
}

export const NEUTRAL: Grade = { brightness: 1, contrast: 1, saturation: 1, gain: [1, 1, 1] };

const clamp = (n: number, lo: number, hi: number) => (n < lo ? lo : n > hi ? hi : n);

export function isNeutral(grade?: Grade | null): boolean {
  if (!grade) return true;
  const { brightness, contrast, saturation, gain } = grade;
  return (
    brightness === 1 && contrast === 1 && saturation === 1 && gain.every((g) => g === 1)
  );
}

// A multiply pass can only take light away, so the gains are normalized to a
// maximum of one and the difference is handed to brightness. Same result, and
// it survives a channel that wants boosting.
export function gradeFilter(grade: Grade): string {
  const headroom = Math.max(...grade.gain, 0.0001);
  const brightness = grade.brightness * headroom;
  return `brightness(${brightness.toFixed(4)}) contrast(${grade.contrast.toFixed(
    4
  )}) saturate(${grade.saturation.toFixed(4)})`;
}

export function gradeTint(grade: Grade): string | null {
  const headroom = Math.max(...grade.gain, 0.0001);
  const [r, g, b] = grade.gain.map((v) => Math.round(255 * clamp(v / headroom, 0, 1)));
  return r === 255 && g === 255 && b === 255 ? null : `rgb(${r}, ${g}, ${b})`;
}

// `draw` must cover the whole canvas, because the gain pass does.
export function drawGraded(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  grade: Grade | undefined | null,
  draw: () => void
) {
  if (isNeutral(grade)) {
    draw();
    return;
  }
  const g = grade as Grade;
  ctx.save();
  ctx.filter = gradeFilter(g);
  draw();
  ctx.restore();
  const tint = gradeTint(g);
  if (!tint) return;
  ctx.save();
  ctx.globalCompositeOperation = 'multiply';
  ctx.fillStyle = tint;
  ctx.fillRect(0, 0, width, height);
  ctx.restore();
}

// Named looks, in place of four sliders per angle. A preset is nothing but a
// Grade with a name on it, so the manifest, the monitor and both renderers
// keep working unchanged — and Match can still land on a grade no preset
// describes, which reads back as "graded" rather than as one of these.
export interface GradePreset {
  id: string;
  label: string;
  grade: Grade;
}

export const GRADE_PRESETS: GradePreset[] = [
  // Rescues an angle shot into a dark room; the old Exposure slider's job.
  { id: 'bright', label: 'Bright', grade: { brightness: 1.22, contrast: 0.96, saturation: 1.05, gain: [1, 1, 1] } },
  { id: 'warm', label: 'Warm', grade: { brightness: 1.02, contrast: 1.04, saturation: 1.08, gain: [1.06, 1, 0.93] } },
  { id: 'cool', label: 'Cool', grade: { brightness: 1, contrast: 1.06, saturation: 1, gain: [0.94, 0.99, 1.07] } },
  { id: 'punch', label: 'Punch', grade: { brightness: 1, contrast: 1.2, saturation: 1.3, gain: [1, 1, 1] } },
  { id: 'mono', label: 'Mono', grade: { brightness: 1.03, contrast: 1.12, saturation: 0, gain: [1, 1, 1] } },
];

// Floating point, and a grade can arrive from a manifest written by an older
// build, so presets are recognized by proximity rather than by equality.
function sameGrade(a: Grade, b: Grade): boolean {
  const near = (x: number, y: number) => Math.abs(x - y) < 0.005;
  return (
    near(a.brightness, b.brightness) &&
    near(a.contrast, b.contrast) &&
    near(a.saturation, b.saturation) &&
    a.gain.every((g, i) => near(g, b.gain[i]))
  );
}

export function presetFor(grade?: Grade | null): GradePreset | null {
  if (isNeutral(grade)) return null;
  return GRADE_PRESETS.find((p) => sameGrade(p.grade, grade!)) ?? null;
}

export interface ColorStats {
  mean: [number, number, number];
  luma: { mean: number; std: number };
  chroma: number;
}

// Averages off a thumbnail: matching two cameras needs their central tendency,
// not their detail, and 64x64 is several thousand samples.
const SAMPLE = 64;
let scratch: HTMLCanvasElement | null = null;

export function statsFrom(source: CanvasImageSource): ColorStats | null {
  if (typeof document === 'undefined') return null;
  scratch ??= document.createElement('canvas');
  scratch.width = SAMPLE;
  scratch.height = SAMPLE;
  const ctx = scratch.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;
  try {
    ctx.drawImage(source, 0, 0, SAMPLE, SAMPLE);
  } catch {
    return null; // not yet decodable
  }
  const { data } = ctx.getImageData(0, 0, SAMPLE, SAMPLE);
  const n = data.length / 4;
  let sr = 0, sg = 0, sb = 0, sl = 0, sll = 0, sc = 0;
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i], g = data[i + 1], b = data[i + 2];
    sr += r;
    sg += g;
    sb += b;
    const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    sl += l;
    sll += l * l;
    sc += Math.max(r, g, b) - Math.min(r, g, b);
  }
  const lumaMean = sl / n;
  return {
    mean: [sr / n, sg / n, sb / n],
    luma: { mean: lumaMean, std: Math.sqrt(Math.max(0, sll / n - lumaMean * lumaMean)) },
    chroma: sc / n,
  };
}

// Map one camera onto another: per-channel gain carries the color balance,
// contrast comes from the spread of luma and brightness from its center, and
// saturation from how much color each camera claims to see. Every term is
// clamped, because a frame that happened to be mostly wall should nudge the
// look, not invent one.
export function matchGrade(sample: ColorStats, reference: ColorStats): Grade {
  const ratios = sample.mean.map((m, i) => (m > 1 ? reference.mean[i] / m : 1));
  // Normalized to average one, so gain is pure color balance and the
  // exposure it would otherwise smuggle in is left to brightness.
  const average = (ratios[0] + ratios[1] + ratios[2]) / 3 || 1;
  const gain = ratios.map((r) => clamp(r / average, 0.5, 2)) as [number, number, number];

  const s = sample.luma.mean / 255;
  const r = reference.luma.mean / 255;
  const contrast =
    sample.luma.std > 2 ? clamp(reference.luma.std / sample.luma.std, 0.5, 2) : 1;
  // Undo the shift that contrast puts on the midpoint: filters apply in the
  // order written, so brightness has to anticipate what contrast will do.
  const brightness = s > 0.02 ? clamp(((r - 0.5) / contrast + 0.5) / s, 0.4, 2.5) : 1;
  const saturation = sample.chroma > 2 ? clamp(reference.chroma / sample.chroma, 0.5, 2) : 1;
  return { brightness, contrast, saturation, gain };
}
