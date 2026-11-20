// JS mirror of video/src/types.ts buildTimeline — keep the two in sync.
// Timeline zero = the moment every camera was rolling; end = the first camera
// to stop. Within that window all sources cover every frame.
export function buildTimeline({ sources, cuts, fps }) {
  if (sources.length === 0) {
    return { durationInFrames: 1, trim: {}, segments: [] };
  }
  const t0 = Math.max(...sources.map((s) => s.recordStart));
  const end = Math.min(...sources.map((s) => s.recordStart + s.duration * 1000));
  const durationInFrames = Math.max(1, Math.floor(((end - t0) / 1000) * fps));

  const trim = {};
  for (const s of sources) {
    trim[s.id] = Math.max(0, Math.round(((t0 - s.recordStart) / 1000) * fps));
  }

  const ids = new Set(sources.map((s) => s.id));
  const valid = (cuts ?? [])
    .filter((c) => ids.has(c.sourceId) && c.atFrame >= 0 && c.atFrame < durationInFrames)
    .sort((a, b) => a.atFrame - b.atFrame);

  const byFrame = new Map();
  byFrame.set(0, sources[0].id);
  for (const c of valid) byFrame.set(c.atFrame, c.sourceId);
  const points = [...byFrame.entries()].sort((a, b) => a[0] - b[0]);

  const segments = [];
  for (let i = 0; i < points.length; i++) {
    const [start, sourceId] = points[i];
    const next = points[i + 1]?.[0] ?? durationInFrames;
    if (next > start) segments.push({ start, len: next - start, sourceId });
  }
  return { durationInFrames, trim, segments };
}

// JS mirror of video/src/types.ts buildProgram — keep the two in sync.
// Removed stretches are [from, to) on the synced timeline; what is left is
// laid end to end, one piece per angle per kept stretch.
export function normalizeRanges(ranges, duration) {
  const sorted = (ranges ?? [])
    .map((r) => ({
      from: Math.max(0, Math.round(Math.min(r.from, r.to))),
      to: Math.min(duration, Math.round(Math.max(r.from, r.to))),
    }))
    .filter((r) => r.to > r.from)
    .sort((a, b) => a.from - b.from);
  const out = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r.from <= last.to) last.to = Math.max(last.to, r.to);
    else out.push({ ...r });
  }
  if (out.length === 1 && out[0].from === 0 && out[0].to === duration) return [];
  return out;
}

export function buildProgram({ sources, cuts, fps, removed }) {
  const timeline = buildTimeline({ sources, cuts, fps });
  const ranges = normalizeRanges(removed, timeline.durationInFrames);
  const kept = [];
  let at = 0;
  for (const r of ranges) {
    if (r.from > at) kept.push({ from: at, to: r.from });
    at = Math.max(at, r.to);
  }
  if (at < timeline.durationInFrames) kept.push({ from: at, to: timeline.durationInFrames });
  const pieces = [];
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
  return { timeline, removed: ranges, kept, pieces, durationInFrames: Math.max(1, out) };
}
