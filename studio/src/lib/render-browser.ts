// Rendering in the browser, no server and no ffmpeg.
//
// Mediabunny demuxes each angle and decodes it with WebCodecs; every output
// frame is composited onto one canvas and encoded with the Mac's hardware
// h264 encoder, then muxed to MP4 with AAC audio. The timeline maths is the
// same buildTimeline() the editor previews, so what you see is what renders.
import {
  ALL_FORMATS,
  AudioBufferSink,
  AudioBufferSource,
  BlobSource,
  BufferTarget,
  CanvasSink,
  CanvasSource,
  Input,
  InputAudioTrack,
  Mp4OutputFormat,
  Output,
  QUALITY_HIGH,
  Rotation,
} from 'mediabunny';
import { FilmFormat, FilmProps, FORMATS, buildTimeline, drawGraded } from '../../../video/src/types';
import { SessionStore } from './session-store';

export interface RenderProgress {
  format: FilmFormat;
  progress: number; // 0..1 across every requested format
}

const FILE_NAMES: Record<FilmFormat, string> = {
  '4:5': 'out-4x5.mp4',
  '9:16': 'out-9x16.mp4',
};

const quarterTurns = (deg: number): Rotation => {
  const d = (((Math.round(deg / 90) * 90) % 360) + 360) % 360;
  return d as Rotation;
};

export async function renderSession(opts: {
  props: FilmProps;
  store: SessionStore;
  sessionId: string;
  formats: FilmFormat[];
  onProgress?: (p: RenderProgress) => void;
}): Promise<string[]> {
  const { props, store, sessionId, formats, onProgress } = opts;
  const timeline = buildTimeline(props);
  const { fps } = props;
  const total = timeline.durationInFrames;
  if (!total || !props.sources.length) throw new Error('nothing to render');

  // One Input per angle, reused across formats.
  const inputs = new Map<string, Input>();
  for (const source of props.sources) {
    // fileName is set by the editor; without it there is nothing to demux.
    if (!source.fileName) continue;
    const blob = await store.fileFor(sessionId, source.fileName);
    inputs.set(source.id, new Input({ source: new BlobSource(blob), formats: ALL_FORMATS }));
  }
  if (!inputs.size) throw new Error('no source files to render from');

  const written: string[] = [];
  try {
    for (const [formatIndex, format] of formats.entries()) {
      const { width, height } = FORMATS[format];
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d', { alpha: false });
      if (!ctx) throw new Error('could not open a 2D canvas');

      // The sink only rotates, at the angle's own resolution; the fit into
      // the output frame is done here with the same centre-cover maths the
      // editor's program monitor uses, so the preview and the file agree.
      const sinks = new Map<string, CanvasSink>();
      for (const source of props.sources) {
        const track = await inputs.get(source.id)!.getPrimaryVideoTrack();
        if (!track) continue;
        sinks.set(
          source.id,
          new CanvasSink(track, {
            rotation: quarterTurns(track.rotation + (source.rotation ?? 0)),
            poolSize: 2,
          })
        );
      }
      if (!sinks.size) throw new Error('none of the angles could be decoded');

      // The grade is re-applied here rather than baked into the recording,
      // so it is the same data the editor previewed and can be changed by
      // re-rendering. Same canvas API at both ends, so they cannot drift.
      const grades = new Map(props.sources.map((s) => [s.id, s.grade]));
      const drawCover = (frame: { canvas: HTMLCanvasElement | OffscreenCanvas }, sourceId: string) => {
        const src = frame.canvas;
        if (!src.width || !src.height) return;
        const scale = Math.max(width / src.width, height / src.height);
        const w = src.width * scale;
        const h = src.height * scale;
        drawGraded(ctx, width, height, grades.get(sourceId), () =>
          ctx.drawImage(src, (width - w) / 2, (height - h) / 2, w, h)
        );
      };

      const target = new BufferTarget();
      const output = new Output({ format: new Mp4OutputFormat(), target });
      const videoSource = new CanvasSource(canvas, {
        codec: 'avc',
        quality: QUALITY_HIGH,
        keyFrameInterval: 2,
      });
      output.addVideoTrack(videoSource);

      const audioId = props.audioSourceId ?? props.sources[0]?.id ?? null;
      let audioTrack: InputAudioTrack | null = null;
      let audioSource: AudioBufferSource | null = null;
      if (audioId && inputs.has(audioId)) {
        audioTrack = await inputs.get(audioId)!.getPrimaryAudioTrack();
        if (audioTrack) {
          audioSource = new AudioBufferSource({ codec: 'aac', quality: QUALITY_HIGH });
          output.addAudioTrack(audioSource);
        }
      }

      await output.start();

      // Video, one cut segment at a time: within a segment the timestamps
      // are monotonic, which lets the sink decode each packet once.
      let done = 0;
      const report = () => {
        onProgress?.({
          format,
          progress: (formatIndex + done / total) / formats.length,
        });
      };
      report();

      for (const segment of timeline.segments) {
        const sink = sinks.get(segment.sourceId);
        const trim = timeline.trim[segment.sourceId] ?? 0;
        if (!sink) {
          // An angle we can't decode: hold black rather than abort the render.
          for (let i = 0; i < segment.len; i++) {
            ctx.fillStyle = '#000';
            ctx.fillRect(0, 0, width, height);
            await videoSource.add((segment.start + i) / fps, 1 / fps);
            done++;
          }
          report();
          continue;
        }
        const timestamps: number[] = [];
        for (let i = 0; i < segment.len; i++) timestamps.push((segment.start + i + trim) / fps);
        let i = 0;
        for await (const frame of sink.canvasesAtTimestamps(timestamps)) {
          if (frame) drawCover(frame, segment.sourceId);
          // A null frame (past the end of that angle) holds the last picture.
          await videoSource.add((segment.start + i) / fps, 1 / fps);
          i++;
          done++;
          if (done % 15 === 0) report();
        }
        // Any frames the sink could not supply still need to exist.
        for (; i < segment.len; i++) {
          await videoSource.add((segment.start + i) / fps, 1 / fps);
          done++;
        }
        report();
      }

      if (audioSource && audioTrack && audioId) {
        const trim = timeline.trim[audioId] ?? 0;
        const from = trim / fps;
        const to = (trim + total) / fps;
        const sink = new AudioBufferSink(audioTrack);
        for await (const { buffer } of sink.buffers(from, to)) {
          await audioSource.add(buffer);
        }
        audioSource.close();
      }

      await output.finalize();
      const buffer = target.buffer;
      if (!buffer) throw new Error('the muxer produced no file');
      const name = FILE_NAMES[format];
      await store.writeOutput(sessionId, name, new Blob([buffer], { type: 'video/mp4' }));
      written.push(name);
      onProgress?.({ format, progress: (formatIndex + 1) / formats.length });
    }
  } finally {
    for (const input of inputs.values()) void input.dispose?.();
  }
  return written;
}
