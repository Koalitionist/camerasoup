// Putting a recording into a container that can be seeked.
//
// MediaRecorder in Chrome writes video/webm;codecs=h264 — h264 video inside a
// live WebM, with no Cues, no SeekHead and no duration. Chrome will play such
// a file start to finish, but it reports an infinite duration, exposes no
// seekable range, and on a seek it shows the nearest keyframe and refuses to
// decode forward to the frame actually asked for. With this recorder's
// keyframes 3.4 seconds apart, scrubbing that angle shows the same picture for
// seconds at a time: the angle looks frozen while the phones' mp4s follow the
// playhead exactly.
//
// Measured on one 20s recording, scrubbing fifteen 0.2s steps:
//
//   the .webm as recorded   duration Infinity, no seekable range,  2 frames
//   the same h264 in mp4    duration 20.07,    seekable 0-20.07,  15 frames
//
// So the fix is the container, not the video: the frames are fine and are
// copied through untouched. This is the same repair the local app has always
// done with `ffmpeg -c copy` on finalize, which the browser path never had.
import { ALL_FORMATS, BlobSource, BufferTarget, Conversion, Input, Mp4OutputFormat, Output } from 'mediabunny';

/** True for a file the editor cannot seek: the live WebM above. */
export function needsRemux(file: string | null | undefined): boolean {
  return !!file && file.toLowerCase().endsWith('.webm');
}

export function mp4NameFor(file: string): string {
  return file.replace(/\.[^.]+$/, '') + '.mp4';
}

/** Same encoded frames, mp4 container. No re-encode, so it costs a copy. */
export async function remuxToMp4(file: Blob, onProgress?: (p: number) => void): Promise<Blob> {
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  const target = new BufferTarget();
  const output = new Output({ format: new Mp4OutputFormat({ fastStart: 'in-memory' }), target });
  const conversion = await Conversion.init({ input, output });
  if (onProgress) conversion.onProgress = (p) => onProgress(p);
  if (!conversion.isValid) {
    const why = conversion.discardedTracks.map((t) => t.reason).join(', ');
    throw new Error(`this recording cannot be repaired${why ? ` (${why})` : ''}`);
  }
  await conversion.execute();
  if (!target.buffer) throw new Error('the repair produced no data');
  return new Blob([target.buffer], { type: 'video/mp4' });
}
