// Joining the kept stretches of one audio track into a continuous film track.
//
// Sample-exact, so the sound stays on the picture however many stretches are
// cut out: each kept stretch takes exactly as many samples as its frames
// last, counted from the start of the film so rounding never accumulates.
//
// With crossfade on, every join is blended over CROSSFADE_S, centered on the
// join. The material for the blend is the audio just past each side of the
// cut, which the recording still has, so the film does not get shorter and
// the picture stays in sync. Equal-power curves, because the two sides are
// different moments and do not sum like a continuous signal would.

export const CROSSFADE_S = 0.02;

export interface SpliceSpan {
  from: number; // seconds in the source audio
  to: number;
  outStart: number; // seconds in the film
  outEnd: number;
}

export interface DecodedChunk {
  timestamp: number; // seconds in the source audio
  channels: Float32Array[];
}

export async function spliceAudio(opts: {
  spans: SpliceSpan[];
  crossfade: boolean;
  sampleRate: number;
  channelCount: number;
  /** Decoded audio covering [from, to), in order. Gaps are filled with silence. */
  read: (from: number, to: number) => AsyncIterable<DecodedChunk>;
  /** Receives the film's audio, in order, in chunks. */
  emit: (channels: Float32Array[]) => Promise<void>;
  chunkFrames?: number;
}): Promise<void> {
  const { spans, crossfade, sampleRate: sr, channelCount, read, emit } = opts;
  const chunkFrames = opts.chunkFrames ?? sr;
  const H = crossfade ? Math.round((CROSSFADE_S / 2) * sr) : 0;

  let chunk = Array.from({ length: channelCount }, () => new Float32Array(chunkFrames));
  let filled = 0;
  const push = async (v: number[]) => {
    for (let c = 0; c < channelCount; c++) chunk[c][filled] = v[c];
    if (++filled === chunkFrames) {
      await emit(chunk);
      chunk = Array.from({ length: channelCount }, () => new Float32Array(chunkFrames));
      filled = 0;
    }
  };

  // The previous stretch's fade-out, waiting to be laid under the next
  // stretch's fade-in.
  let carry: Float32Array[] | null = null;

  const live = spans
    .map((span) => ({
      span,
      L: Math.round(span.outEnd * sr) - Math.round(span.outStart * sr),
    }))
    .filter((s) => s.L > 0);
  // Both sides of a join must agree on whether it blends, or the samples
  // stop adding up. A stretch shorter than two blends gets hard joins.
  const blends = live.map((s, k) => k < live.length - 1 && H > 0 && s.L >= 2 * H && live[k + 1].L >= 2 * H);

  for (const [k, { span, L }] of live.entries()) {
    const fin = k > 0 && blends[k - 1] ? H : 0;
    const fout = blends[k] ? H : 0;
    const nextCarry = fout ? Array.from({ length: channelCount }, () => new Float32Array(2 * fout)) : null;

    const end = L + fout; // window is [-fin, end)
    let cursor = -fin;
    const v = new Array<number>(channelCount).fill(0);

    const process = async (i: number) => {
      let g = 1;
      if (fin && i < fin) g *= Math.sin((Math.PI / 2) * ((i + fin) / (2 * fin)));
      if (fout && i >= L - fout) g *= Math.cos((Math.PI / 2) * ((i - (L - fout)) / (2 * fout)));
      for (let c = 0; c < channelCount; c++) v[c] *= g;
      if (carry && i < -fin + carry[0].length) {
        const at = i + fin;
        for (let c = 0; c < channelCount; c++) v[c] += carry[c][at];
      }
      if (nextCarry && i >= L - fout) {
        const at = i - (L - fout);
        for (let c = 0; c < channelCount; c++) nextCarry[c][at] = v[c];
      } else {
        await push(v);
      }
    };

    const winFrom = Math.max(0, span.from - fin / sr);
    for await (const d of read(winFrom, span.from + end / sr)) {
      const b = Math.round((d.timestamp - span.from) * sr);
      const n = d.channels[0]?.length ?? 0;
      while (cursor < b && cursor < end) {
        v.fill(0);
        await process(cursor++);
      }
      for (let j = Math.max(0, cursor - b); j < n && cursor < end; j++) {
        for (let c = 0; c < channelCount; c++) v[c] = (d.channels[c] ?? d.channels[0])[j];
        await process(cursor++);
      }
      if (cursor >= end) break;
    }
    while (cursor < end) {
      v.fill(0);
      await process(cursor++);
    }
    carry = nextCarry;
  }

  if (filled) await emit(chunk.map((ch) => ch.subarray(0, filled)));
}
