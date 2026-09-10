export interface EditSource {
  id: string;
  src: string; // URL of the finalized file (relative in the browser, absolute for renders)
  fileName?: string; // name within the session folder, for the in-browser renderer
  recordStart: number; // server-clock ms when this source's recorder started
  duration: number; // seconds
  rotation?: number; // 0 | 90 | 180 | 270, clockwise
  grade?: Grade; // colour correction, applied on every draw
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
};

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

// ---- colour ---------------------------------------------------------------
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

// A multiply pass can only take light away, so the gains are normalised to a
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

// Map one camera onto another: per-channel gain carries the colour balance,
// contrast comes from the spread of luma and brightness from its centre, and
// saturation from how much colour each camera claims to see. Every term is
// clamped, because a frame that happened to be mostly wall should nudge the
// look, not invent one.
export function matchGrade(sample: ColorStats, reference: ColorStats): Grade {
  const ratios = sample.mean.map((m, i) => (m > 1 ? reference.mean[i] / m : 1));
  // Normalised to average one, so gain is pure colour balance and the
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
