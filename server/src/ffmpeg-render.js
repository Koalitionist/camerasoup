import { execFile, spawn } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { readManifest, sessionDir } from './sessions.js';
import { buildProgram } from './timeline.js';

const execFileP = promisify(execFile);

// Pure-ffmpeg render of a session: same semantics as the Remotion composition
// (hard cuts, rotation, cover-crop, one continuous audio track) but rendered
// natively — hardware-encoded via VideoToolbox where available, so a clip
// renders in seconds rather than realtime.

const FORMATS = {
  '4:5': { width: 1080, height: 1350 },
  '9:16': { width: 1080, height: 1920 },
};

const rendering = new Set();

export function isFfmpegRendering(sessionId) {
  return rendering.has(sessionId);
}

export function outFileFor(format) {
  return `out-${format.replace(':', 'x')}.mp4`;
}

function rotationFilter(rotation) {
  const rot = ((rotation % 360) + 360) % 360;
  if (rot === 90) return 'transpose=1,';
  if (rot === 180) return 'hflip,vflip,';
  if (rot === 270) return 'transpose=2,';
  return '';
}

// Phones store display rotation as stream side data, and ffmpeg does not
// apply it when streams feed a filter_complex graph — so read it and apply
// it ourselves (on top of the user-set rotation), with autorotate disabled.
async function probeDisplayRotation(file) {
  const { stdout } = await execFileP('ffprobe', [
    '-v', 'error', '-select_streams', 'v:0', '-show_streams', '-of', 'json', file,
  ]);
  const stream = JSON.parse(stdout).streams?.[0];
  let sideRotation = 0;
  for (const sd of stream?.side_data_list ?? []) {
    if (typeof sd.rotation === 'number') sideRotation = sd.rotation;
  }
  // side data is counter-clockwise; convert to the clockwise display rotation
  return ((-sideRotation % 360) + 360) % 360;
}

// Cover-fit into W x H, pushed in by the framing's zoom and cropped around
// its focus point — the same maths as placeCover() in video/src/types.ts,
// clamped so the crop never leaves the picture.
function coverFilter(W, H, framing) {
  const zoom = Math.min(4, Math.max(1, framing?.zoom ?? 1));
  const fx = Number.isFinite(framing?.x) ? framing.x : 0.5;
  const fy = Number.isFinite(framing?.y) ? framing.y : 0.5;
  const even = (n) => Math.ceil((n * zoom) / 2) * 2;
  return (
    `scale=${even(W)}:${even(H)}:force_original_aspect_ratio=increase,` +
    `crop=${W}:${H}:'clip(${fx.toFixed(5)}*iw-ow/2,0,iw-ow)':'clip(${fy.toFixed(5)}*ih-oh/2,0,ih-oh)'`
  );
}

// The kept stretches of the audio, joined. With crossfade, each stretch is
// read HALF_FADE past the join on either side and acrossfade overlaps them by
// twice that, so the film keeps its length and its sync — the same blend the
// browser renderer does, see studio/src/lib/splice-audio.ts.
const HALF_FADE = 0.01;
function audioFilters(idx, kept, fps, crossfade) {
  const n = kept.length;
  if (n === 1) {
    const k = kept[0];
    return [
      `[${idx}:a]aresample=48000,atrim=start=${(k.from / fps).toFixed(4)}:end=${(k.to / fps).toFixed(4)},` +
        `asetpts=PTS-STARTPTS,apad[a]`,
    ];
  }
  const filters = [`[${idx}:a]aresample=48000,asplit=${n}${kept.map((_, i) => `[x${i}]`).join('')}`];
  kept.forEach((k, i) => {
    const hIn = crossfade && i > 0 ? HALF_FADE : 0;
    const hOut = crossfade && i < n - 1 ? HALF_FADE : 0;
    const start = Math.max(0, k.from / fps - hIn);
    filters.push(
      `[x${i}]atrim=start=${start.toFixed(4)}:end=${(k.to / fps + hOut).toFixed(4)},asetpts=PTS-STARTPTS[p${i}]`
    );
  });
  if (!crossfade) {
    filters.push(`${kept.map((_, i) => `[p${i}]`).join('')}concat=n=${n}:v=0:a=1,apad[a]`);
    return filters;
  }
  let last = 'p0';
  for (let i = 1; i < n; i++) {
    const outLabel = i === n - 1 ? 'j' : `c${i}`;
    filters.push(`[${last}][p${i}]acrossfade=d=${(2 * HALF_FADE).toFixed(4)}:c1=qsin:c2=qsin[${outLabel}]`);
    last = outLabel;
  }
  filters.push(`[j]apad[a]`);
  return filters;
}

function editFromManifest(manifest) {
  const sources = manifest.sources
    .filter((s) => s.status === 'finalized' && s.file && s.recordStart && s.duration)
    .map((s) => ({
      id: s.id,
      file: s.file,
      recordStart: s.recordStart,
      duration: s.duration,
      rotation: s.rotation ?? 0,
      framing: s.framing,
      hasAudio: s.hasAudio,
    }));
  const fps = manifest.fps ?? 30;
  const program = buildProgram({ sources, cuts: manifest.cuts ?? [], fps, removed: manifest.removed });
  const audioId =
    manifest.audioSource ?? sources.find((s) => s.hasAudio !== false)?.id ?? sources[0]?.id ?? null;
  return {
    sources,
    fps,
    program,
    crossfade: manifest.crossfade ?? true,
    audio: sources.find((s) => s.id === audioId) ?? sources[0],
  };
}

function buildArgs(manifest, format, encoder, displayRotations) {
  const { width: W, height: H } = FORMATS[format];
  const { sources, fps, program, crossfade, audio } = editFromManifest(manifest);
  const { timeline } = program;
  const dir = sessionDir(manifest.id);
  const totalSec = program.durationInFrames / fps;
  const srcOf = (id) => sources.find((s) => s.id === id);

  const args = ['-y', '-hide_banner', '-nostats', '-progress', 'pipe:1'];
  const filters = [];
  const concatIns = [];

  // One trimmed input per piece (an angle over a kept stretch): input-level
  // -ss/-t is frame-accurate when re-encoding and keeps the graph trivial.
  // Removed stretches are never read.
  program.pieces.forEach((seg, i) => {
    const src = srcOf(seg.sourceId);
    const startSec = (timeline.trim[src.id] + seg.src) / fps;
    const durSec = seg.len / fps;
    // -display_rotation 0 declares the input rotation-free: it disables
    // autorotation AND prevents the display-matrix side data from propagating
    // into the output (which would make players re-rotate our correct pixels).
    // We apply the probed display rotation + user rotation explicitly below.
    args.push(
      '-display_rotation', '0',
      '-ss', startSec.toFixed(3), '-t', durSec.toFixed(3), '-i', path.join(dir, src.file)
    );
    const rotation = (displayRotations.get(src.id) ?? 0) + src.rotation;
    filters.push(
      `[${i}:v]${rotationFilter(rotation)}fps=${fps},${coverFilter(W, H, src.framing)},` +
        `setsar=1,format=yuv420p,setpts=PTS-STARTPTS[s${i}]`
    );
    concatIns.push(`[s${i}]`);
  });

  // The audio source runs continuously across cuts. A source can legitimately
  // have no sound — a screen share where the picker's audio box went unticked —
  // and mapping [n:a] from a file with no audio stream fails the whole render,
  // so silence is fed in explicitly instead.
  const audioIdx = program.pieces.length;
  const silent = audio.hasAudio === false;
  filters.push(`${concatIns.join('')}concat=n=${program.pieces.length}:v=1:a=0[v]`);
  if (silent) {
    args.push('-f', 'lavfi', '-t', totalSec.toFixed(3), '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000');
    filters.push(`[${audioIdx}:a]apad[a]`);
  } else {
    const audioStart = (timeline.trim[audio.id] ?? 0) / fps;
    const lastSec = program.kept[program.kept.length - 1].to / fps;
    args.push('-ss', audioStart.toFixed(3), '-t', (lastSec + 0.1).toFixed(3), '-i', path.join(dir, audio.file));
    filters.push(...audioFilters(audioIdx, program.kept, fps, crossfade));
  }

  args.push(
    '-filter_complex', filters.join(';'),
    '-map', '[v]', '-map', '[a]',
    ...encoder,
    '-c:a', 'aac', '-b:a', '160k',
    '-t', totalSec.toFixed(3),
    '-movflags', '+faststart',
    path.join(dir, outFileFor(format))
  );
  return { args, totalSec };
}

const ENCODERS = [
  ['-c:v', 'h264_videotoolbox', '-b:v', '10M', '-r', '30'],
  ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-r', '30'],
];

function runFfmpeg(args, totalSec, onProgress) {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    proc.stderr.on('data', (d) => {
      stderr += d;
      if (stderr.length > 20000) stderr = stderr.slice(-20000);
    });
    proc.stdout.on('data', (d) => {
      const m = String(d).match(/out_time=(\d+):(\d+):(\d+(?:\.\d+)?)/);
      if (m) {
        const sec = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
        onProgress(Math.min(1, sec / totalSec));
      }
    });
    proc.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(-600)}`))
    );
    proc.on('error', reject);
  });
}

const VALID_FORMATS = Object.keys(FORMATS);

export async function renderSessionFfmpeg(sessionId, { hub, formats, log = console.log }) {
  if (rendering.has(sessionId)) throw new Error('render already running for this session');
  const wanted = (formats?.length ? formats : VALID_FORMATS).filter((f) =>
    VALID_FORMATS.includes(f)
  );
  if (wanted.length === 0) throw new Error('no valid formats requested');
  rendering.add(sessionId);
  try {
    const manifest = readManifest(sessionId);
    const edit = editFromManifest(manifest);
    if (edit.sources.length === 0) {
      throw new Error('session has no usable sources');
    }
    const displayRotations = new Map();
    for (const src of edit.sources) {
      displayRotations.set(
        src.id,
        await probeDisplayRotation(path.join(sessionDir(sessionId), src.file))
      );
    }
    const files = [];
    for (let i = 0; i < wanted.length; i++) {
      const format = wanted[i];
      const t0 = Date.now();
      let lastPct = -1;
      const emit = (progress) => {
        const pct = Math.round(progress * 100);
        if (pct !== lastPct) {
          lastPct = pct;
          hub.broadcastProducers({
            type: 'render-progress',
            sessionId,
            format,
            index: i,
            total: wanted.length,
            progress,
          });
        }
      };
      let done = false;
      for (const encoder of ENCODERS) {
        const { args, totalSec } = buildArgs(manifest, format, encoder, displayRotations);
        if (process.env.CAMERASOUP_DEBUG) log(`ffmpeg ${args.join(' ')}`);
        try {
          await runFfmpeg(args, totalSec, emit);
          done = true;
          log(
            `render ${sessionId} [${format}]: ${totalSec.toFixed(1)}s of video in ` +
              `${((Date.now() - t0) / 1000).toFixed(1)}s (${encoder[1]})`
          );
          break;
        } catch (err) {
          if (encoder === ENCODERS[ENCODERS.length - 1]) throw err;
          log(`render ${sessionId} [${format}]: ${encoder[1]} failed, falling back`);
        }
      }
      if (done) files.push(outFileFor(format));
    }
    hub.broadcastProducers({ type: 'render-done', sessionId, files });
    return files;
  } catch (err) {
    hub.broadcastProducers({ type: 'render-error', sessionId, message: err.message });
    throw err;
  } finally {
    rendering.delete(sessionId);
  }
}
