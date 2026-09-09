import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Grade } from '../../../video/src/types';
import {
  buildTimeline,
  NEUTRAL,
  drawGraded,
  isNeutral,
  gradeFilter,
  gradeTint,
  matchGrade,
  statsFrom,
  Cut,
  EditSource,
  FilmFormat,
  FilmProps,
  FORMATS,
} from '../../../video/src/types';
import SpinePage from '../components/Spine';
import { pickRootFolder } from '../lib/folder';
import { isHosted } from '../lib/platform';
import { colorForKey, textOn } from '../lib/theme';
import type { RenderProgress } from '../lib/render-browser';
import { Manifest, SessionStore, getStore } from '../lib/session-store';
import { Json, StudioSocket } from '../lib/ws';

export default function Edit() {
  const sessionId = new URLSearchParams(location.search).get('session');
  const [store, setStore] = useState<SessionStore | null>(null);
  const [needsFolder, setNeedsFolder] = useState(false);
  const [manifest, setManifest] = useState<Manifest | null>(null);
  const [sessions, setSessions] = useState<Manifest[] | null>(null);

  useEffect(() => {
    void getStore().then((s) => {
      if (s) setStore(s);
      else setNeedsFolder(true); // hosted, but no folder remembered yet
    });
  }, []);

  useEffect(() => {
    if (!store) return;
    if (sessionId) void store.load(sessionId).then(setManifest);
    else void store.list().then(setSessions);
  }, [store, sessionId]);

  if (needsFolder) {
    return (
      <SpinePage>
        <span className="meta">Editor</span>
        <h1>Which folder holds the recordings?</h1>
        <p className="lede">
          The same folder the studio records into. The browser asks once per computer.
        </p>
        <div className="actions-row" style={{ marginTop: 8 }}>
          <button
            className="pill solid"
            onClick={async () => {
              try {
                await pickRootFolder();
                const s = await getStore();
                if (s) {
                  setStore(s);
                  setNeedsFolder(false);
                }
              } catch {
                // picker cancelled
              }
            }}
          >
            Choose folder
          </button>
        </div>
      </SpinePage>
    );
  }
  if (!sessionId) return <SessionPicker sessions={sessions} />;
  if (!manifest) {
    return (
      <SpinePage>
        <div className="join-status">
          <span className="dot active" />
          Loading session…
        </div>
      </SpinePage>
    );
  }
  return <Editor manifest={manifest} store={store!} />;
}

function SessionPicker({ sessions }: { sessions: Manifest[] | null }) {
  const home = isHosted() ? '/studio' : '/producer';
  return (
    <SpinePage>
      <span className="meta">Editor</span>
      <h1>Edit a session</h1>
      {!sessions && <p className="hint">Loading…</p>}
      {sessions?.length === 0 && <p className="lede">No sessions yet — record one first.</p>}
      <div className="roles">
        {sessions?.map((m) => (
          <a key={m.id} className="role" href={`/edit?session=${m.id}`}>
            <b>{m.id}</b>
            <span>{m.sources.map((s) => s.id).join(' · ')}</span>
          </a>
        ))}
      </div>
      <div className="actions-row">
        <a href={home}>
          <button className="pill outline">← Studio</button>
        </a>
      </div>
    </SpinePage>
  );
}

function Editor({ manifest, store }: { manifest: Manifest; store: SessionStore }) {
  const fps = manifest.fps ?? 30;
  const [rotations, setRotations] = useState<Record<string, number>>(() =>
    Object.fromEntries(manifest.sources.map((s) => [s.id, s.rotation ?? 0]))
  );
  const [grades, setGrades] = useState<Record<string, Grade>>(() =>
    Object.fromEntries(manifest.sources.filter((s) => s.grade).map((s) => [s.id, s.grade!]))
  );

  // Playable files: a path on the local server, a blob URL from the folder.
  const usable = useMemo(
    () => manifest.sources.filter((s) => s.status === 'finalized' && s.file && s.recordStart && s.duration),
    [manifest]
  );
  const [urls, setUrls] = useState<Record<string, string> | null>(null);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const map: Record<string, string> = {};
      for (const s of usable) map[s.id] = await store.urlFor(manifest.id, s.file!);
      if (!cancelled) setUrls(map);
    })();
    return () => {
      cancelled = true;
      store.releaseUrls();
    };
  }, [manifest.id, usable, store]);

  const sources: EditSource[] = useMemo(
    () =>
      !urls
        ? []
        : usable
            .filter((s) => urls[s.id])
            .map((s) => ({
              id: s.id,
              src: urls[s.id],
              fileName: s.file!,
              recordStart: s.recordStart!,
              duration: s.duration!,
              rotation: rotations[s.id] ?? 0,
              grade: grades[s.id],
            })),
    [usable, urls, rotations, grades]
  );

  const [cuts, setCuts] = useState<Cut[]>(manifest.cuts ?? []);
  const [audioSourceId, setAudioSourceId] = useState<string | null>(
    manifest.audioSource ?? sources[0]?.id ?? null
  );
  const [format, setFormat] = useState<FilmFormat>('4:5');
  const [render, setRender] = useState<{
    state: 'idle' | 'running' | 'done' | 'error';
    progress: number;
    format?: string;
    files?: string[];
    message?: string;
  }>({ state: 'idle', progress: 0 });

  const props: FilmProps = useMemo(
    () => ({ sources, cuts, audioSourceId, fps, format }),
    [sources, cuts, audioSourceId, fps, format]
  );
  const timeline = useMemo(() => buildTimeline(props), [props]);
  const total = timeline.durationInFrames;

  // ---- transport: our own playback clock (no media element drives time) ----
  const [playing, setPlaying] = useState(false);
  const [frame, setFrame] = useState(0);
  const frameRef = useRef(0);
  const playClock = useRef<{ t: number; f: number } | null>(null);

  const setFrameBoth = useCallback((f: number) => {
    frameRef.current = f;
    setFrame(f);
  }, []);

  const seekTo = useCallback(
    (f: number) => {
      const clamped = Math.max(0, Math.min(total - 1, f));
      if (playClock.current) playClock.current = { t: performance.now(), f: clamped };
      setFrameBoth(clamped);
    },
    [total, setFrameBoth]
  );

  const toggle = useCallback(() => {
    setPlaying((p) => {
      if (!p && frameRef.current >= total - 1) setFrameBoth(0);
      return !p;
    });
  }, [total, setFrameBoth]);

  useEffect(() => {
    if (!playing) {
      playClock.current = null;
      return;
    }
    playClock.current = { t: performance.now(), f: frameRef.current };
    let raf = 0;
    const tick = () => {
      const c = playClock.current;
      if (!c) return;
      const f = c.f + ((performance.now() - c.t) / 1000) * fps;
      if (f >= total - 1) {
        setFrameBoth(total - 1);
        setPlaying(false);
        return;
      }
      setFrameBoth(f);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, fps, total, setFrameBoth]);

  // Registry of the angle-tile <video> elements. The program canvas draws
  // from these directly — no extra media streams (Chrome allows only 6
  // concurrent connections per origin, and long sessions have big files).
  const videoEls = useRef(new Map<string, HTMLVideoElement>());

  // ---- undo history for cut operations (Cmd/Ctrl+Z) ----
  const history = useRef<Cut[][]>([]);
  const pushHistory = useCallback((current: Cut[]) => {
    history.current.push(current);
    if (history.current.length > 100) history.current.shift();
  }, []);
  const updateCuts = useCallback(
    (next: Cut[]) => {
      pushHistory(cuts);
      setCuts(next);
    },
    [cuts, pushHistory]
  );
  const undo = useCallback(() => {
    const prev = history.current.pop();
    if (prev) setCuts(prev);
  }, []);

  // auto-save cuts + audio + rotations (debounced)
  const firstSave = useRef(true);
  useEffect(() => {
    if (firstSave.current) {
      firstSave.current = false;
      return;
    }
    const t = window.setTimeout(() => {
      void store.saveEdit(manifest.id, { cuts, audioSource: audioSourceId, rotations, grades });
    }, 600);
    return () => window.clearTimeout(t);
  }, [cuts, audioSourceId, rotations, grades, manifest.id, store]);

  // render progress over the hub socket (local app only; the browser
  // renderer reports its own progress directly)
  useEffect(() => {
    if (store.kind !== 'server') return;
    const socket = new StudioSocket();
    socket.onOpen(() => socket.send({ type: 'hello', role: 'producer' } as Json));
    socket.on('render-progress', (msg) => {
      if (msg.sessionId === manifest.id)
        setRender({
          state: 'running',
          progress: msg.progress as number,
          format: msg.format as string,
        });
    });
    socket.on('render-done', (msg) => {
      if (msg.sessionId === manifest.id)
        setRender({ state: 'done', progress: 1, files: msg.files as string[] });
    });
    socket.on('render-error', (msg) => {
      if (msg.sessionId === manifest.id)
        setRender({ state: 'error', progress: 0, message: msg.message as string });
    });
    socket.connect();
    return () => socket.close();
  }, [manifest.id, store.kind]);

  const activeSourceAt = useCallback(
    (f: number) => {
      let active = timeline.segments[0]?.sourceId ?? null;
      for (const seg of timeline.segments) {
        if (seg.start <= f) active = seg.sourceId;
        else break;
      }
      return active;
    },
    [timeline]
  );

  const addCut = useCallback(
    (sourceId: string) => {
      const f = Math.round(frameRef.current);
      if (activeSourceAt(f) === sourceId) return;
      updateCuts([...cuts.filter((c) => c.atFrame !== f), { atFrame: f, sourceId }]);
    },
    [activeSourceAt, cuts, updateCuts]
  );

  const deleteCutAtPlayhead = useCallback(() => {
    const f = frameRef.current;
    const containing = [...cuts]
      .sort((a, b) => a.atFrame - b.atFrame)
      .filter((c) => c.atFrame <= f)
      .pop();
    if (containing) updateCuts(cuts.filter((c) => c !== containing));
  }, [cuts, updateCuts]);

  // Live boundary drag: history is pushed once at drag start, not per move.
  const moveCut = useCallback(
    (fromFrame: number, toFrame: number): number | null => {
      const sorted = [...cuts].sort((a, b) => a.atFrame - b.atFrame);
      const idx = sorted.findIndex((c) => c.atFrame === fromFrame);
      if (idx < 0) return null;
      const min = idx > 0 ? sorted[idx - 1].atFrame + 1 : 1;
      const max = idx < sorted.length - 1 ? sorted[idx + 1].atFrame - 1 : total - 1;
      const clamped = Math.max(min, Math.min(max, toFrame));
      if (clamped === fromFrame) return fromFrame;
      setCuts(cuts.map((c) => (c.atFrame === fromFrame ? { ...c, atFrame: clamped } : c)));
      return clamped;
    },
    [cuts, total]
  );

  // keyboard: 1..9 switch, space play/pause, arrows step, backspace delete cut
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'SELECT') return;
      const idx = parseInt(e.key, 10);
      if (idx >= 1 && idx <= sources.length) {
        addCut(sources[idx - 1].id);
      } else if (e.key === ' ') {
        e.preventDefault();
        toggle();
      } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault();
        const step = (e.shiftKey ? 10 : 1) * (e.key === 'ArrowLeft' ? -1 : 1);
        seekTo(Math.round(frameRef.current) + step);
      } else if (e.key === 'Backspace' || e.key === 'Delete') {
        deleteCutAtPlayhead();
      } else if ((e.metaKey || e.ctrlKey) && e.key === 'z') {
        e.preventDefault();
        undo();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [sources, addCut, deleteCutAtPlayhead, undo, toggle, seekTo]);

  if (sources.length === 0) {
    return (
      <SpinePage>
        <span className="meta">{manifest.id}</span>
        <h1>This session has no usable footage.</h1>
        <div className="actions-row">
          <a href="/edit">
            <button className="pill outline">← Sessions</button>
          </a>
        </div>
      </SpinePage>
    );
  }

  const colorOf = (id: string) => colorForKey(sources.findIndex((s) => s.id === id) + 1);
  // Match every other angle onto this one, using the frames already on screen.
  const matchTo = useCallback(
    (referenceId: string) => {
      const el = videoEls.current.get(referenceId);
      // A <video> still buffering has no frame to measure yet.
      const reference = el ? statsFrom(el) : null;
      if (!reference) return;
      setGrades((current) => {
        const next = { ...current };
        // The reference defines the look, so it wears none of the correction.
        delete next[referenceId];
        for (const [id, angle] of videoEls.current) {
          if (id === referenceId) continue;
          // drawImage ignores CSS filters, so this measures the angle as it
          // was shot rather than as it is currently graded — which is what
          // makes matching repeatable instead of compounding.
          const before = statsFrom(angle);
          if (before) next[id] = matchGrade(before, reference);
        }
        return next;
      });
    },
    []
  );

  const activeId = activeSourceAt(frame);
  const activeSource = sources.find((s) => s.id === activeId) ?? null;
  const audioSource = sources.find((s) => s.id === audioSourceId) ?? sources[0];

  return (
    <div className="edit-page">
      <header className="edit-header">
        <a href="/edit" className="back">
          ← Sessions
        </a>
        <span className="session-id">{manifest.id}</span>
        <button className="pill ghost small" onClick={toggle}>
          {playing ? '❚❚' : '▶'}
        </button>
        <span className="timecode">
          {formatFrame(frame, fps)} <span className="total">/ {formatFrame(total, fps)}</span>
        </span>
        <button className="pill ghost small" disabled={cuts.length === 0} onClick={() => updateCuts([])}>
          Clear cuts
        </button>
        <span className="spacer" />
        <label className="field">
          audio
          <select
            value={audioSourceId ?? ''}
            onChange={(e) => setAudioSourceId(e.target.value || null)}
          >
            {sources.map((s) => (
              <option key={s.id} value={s.id}>
                {s.id}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          preview
          <select value={format} onChange={(e) => setFormat(e.target.value as FilmFormat)}>
            {(Object.keys(FORMATS) as FilmFormat[]).map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
          </select>
        </label>
        {render.state === 'running' ? (
          <span className="field">
            rendering {render.format ?? ''} {Math.round(render.progress * 100)}%
          </span>
        ) : (
          <button
            className="render-button"
            onClick={() => {
              setRender({ state: 'running', progress: 0 });
              if (store.kind === 'server') {
                void fetch(`/api/sessions/${manifest.id}/render`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({}),
                });
                return;
              }
              // The demuxer and muxer are a big download; fetch them only
              // when someone actually renders, so the camera page stays light.
              void import('../lib/render-browser')
                .then(({ renderSession }) =>
                  renderSession({
                    props,
                    store,
                    sessionId: manifest.id,
                    formats: ['4:5', '9:16'],
                    onProgress: (p: RenderProgress) =>
                      setRender({ state: 'running', progress: p.progress, format: p.format }),
                  })
                )
                .then((files) => setRender({ state: 'done', progress: 1, files }))
                .catch((err) =>
                  setRender({ state: 'error', progress: 0, message: (err as Error).message })
                );
            }}
          >
            Render 4:5 + 9:16
          </button>
        )}
      </header>

      {render.state === 'done' && (
        <div className="banner">
          Rendered {(render.files ?? []).join(' and ')} into the session folder.
          {store.kind === 'server' && (
            <button className="pill ghost small" onClick={() => void store.reveal(manifest.id)}>
              Reveal
            </button>
          )}
        </div>
      )}
      {render.state === 'error' && <div className="banner error">Render failed: {render.message}</div>}

      <div className="edit-main">
        <div className="rail" style={{ paddingBottom: 0 }}>
          {sources.map((s, i) => {
            const color = colorForKey(i + 1);
            return (
              <div
                key={s.id}
                className="cam-spine"
                style={{ background: color }}
                onClick={() => addCut(s.id)}
                title={`Cut to ${s.id}`}
              >
                <div className="cam-spine-label" style={{ color: textOn(color) }}>
                  <span className="num">{i + 1}</span>
                  &nbsp;{s.id}
                </div>
              </div>
            );
          })}
        </div>
        <div className="edit-program" onClick={toggle}>
          <ProgramCanvas
            width={FORMATS[format].width}
            height={FORMATS[format].height}
            activeSource={activeSource}
            activeColor={activeId ? colorOf(activeId) : '#000'}
            videoEls={videoEls}
          />
        </div>
        <div className="edit-angles">
          {sources.map((s, i) => (
            <AngleTile
              key={s.id}
              source={s}
              index={i}
              fps={fps}
              trim={timeline.trim[s.id] ?? 0}
              frame={frame}
              playing={playing}
              active={activeId === s.id}
              color={colorOf(s.id)}
              onCut={() => addCut(s.id)}
              onRotate={() =>
                setRotations((r) => ({ ...r, [s.id]: ((r[s.id] ?? 0) + 90) % 360 }))
              }
              grade={grades[s.id]}
              onGrade={(g) =>
                setGrades((all) => {
                  const next = { ...all };
                  // A neutral grade is the absence of one, not a value to store.
                  if (g && !isNeutral(g)) next[s.id] = g;
                  else delete next[s.id];
                  return next;
                })
              }
              onMatchTo={() => matchTo(s.id)}
              onVideoEl={(el) => {
                if (el) videoEls.current.set(s.id, el);
                else videoEls.current.delete(s.id);
              }}
            />
          ))}
          <p className="edit-hint">
            1–{sources.length} or click cuts. Space plays, ←/→ steps, ⌫ removes the cut at the
            playhead.
          </p>
        </div>
      </div>

      {audioSource && (
        <AudioTrack
          src={audioSource.src}
          trim={timeline.trim[audioSource.id] ?? 0}
          fps={fps}
          frame={frame}
          playing={playing}
        />
      )}

      <Timeline
        timeline={timeline}
        cuts={cuts}
        fps={fps}
        frame={frame}
        colorOf={colorOf}
        onSeek={seekTo}
        onDeleteCutAt={(atFrame) => updateCuts(cuts.filter((c) => c.atFrame !== atFrame))}
        onMoveCut={moveCut}
        onDragStart={() => pushHistory(cuts)}
      />
    </div>
  );
}

// The program monitor: a canvas that draws the active angle's tile video with
// the same cover-crop + rotation math as the ffmpeg render. Reusing the tile
// <video> elements keeps us inside the browser's per-origin connection limit.
function ProgramCanvas({
  width,
  height,
  activeSource,
  activeColor,
  videoEls,
}: {
  width: number;
  height: number;
  activeSource: EditSource | null;
  activeColor: string;
  videoEls: React.MutableRefObject<Map<string, HTMLVideoElement>>;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const activeRef = useRef(activeSource);
  activeRef.current = activeSource;

  useEffect(() => {
    let raf = 0;
    const draw = () => {
      raf = requestAnimationFrame(draw);
      const canvas = canvasRef.current;
      const ctx = canvas?.getContext('2d');
      if (!canvas || !ctx) return;
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      const active = activeRef.current;
      const v = active ? videoEls.current.get(active.id) : null;
      if (!v || !v.videoWidth) return;
      // The <video> element already applies the file's own display matrix;
      // only the user-set rotation is applied here (mirrors the render).
      const rot = (((active!.rotation ?? 0) % 360) + 360) % 360;
      const quarter = rot === 90 || rot === 270;
      const contentW = quarter ? v.videoHeight : v.videoWidth;
      const contentH = quarter ? v.videoWidth : v.videoHeight;
      const scale = Math.max(canvas.width / contentW, canvas.height / contentH);
      // The renderer draws through the identical helper, so what the monitor
      // shows is what the file gets.
      drawGraded(ctx, canvas.width, canvas.height, active!.grade, () => {
        ctx.save();
        ctx.translate(canvas.width / 2, canvas.height / 2);
        ctx.rotate((rot * Math.PI) / 180);
        ctx.scale(scale, scale);
        ctx.drawImage(v, -v.videoWidth / 2, -v.videoHeight / 2, v.videoWidth, v.videoHeight);
        ctx.restore();
      });
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [videoEls]);

  return (
    <canvas
      ref={canvasRef}
      width={width}
      height={height}
      className="program-canvas"
      style={{ aspectRatio: `${width} / ${height}`, outline: `4px solid ${activeColor}` }}
    />
  );
}

// One continuous audio track, synced to the transport like the angle tiles.
function AudioTrack({
  src,
  trim,
  fps,
  frame,
  playing,
}: {
  src: string;
  trim: number;
  fps: number;
  frame: number;
  playing: boolean;
}) {
  const ref = useRef<HTMLAudioElement>(null);

  useEffect(() => {
    const a = ref.current;
    if (!a) return;
    const target = (frame + trim) / fps;
    if (playing) {
      if (a.paused) void a.play().catch(() => {});
      if (Math.abs(a.currentTime - target) > 0.25) a.currentTime = target;
    } else {
      if (!a.paused) a.pause();
      if (Math.abs(a.currentTime - target) > 0.05) a.currentTime = target;
    }
  }, [frame, playing, trim, fps]);

  return <audio ref={ref} src={src} preload="auto" />;
}

function AngleTile({
  source,
  index,
  fps,
  trim,
  frame,
  playing,
  active,
  color,
  onCut,
  onRotate,
  onVideoEl,
  grade,
  onGrade,
  onMatchTo,
}: {
  source: EditSource;
  index: number;
  fps: number;
  trim: number;
  frame: number;
  playing: boolean;
  active: boolean;
  color: string;
  onCut: () => void;
  onRotate: () => void;
  onVideoEl: (el: HTMLVideoElement | null) => void;
  grade?: Grade;
  onGrade: (grade: Grade | null) => void;
  onMatchTo: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);

  // Keep the angle preview synced to the program playhead: exact while
  // paused/seeking, drift-corrected while playing.
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const target = (frame + trim) / fps;
    if (playing) {
      if (v.paused) void v.play().catch(() => {});
      if (Math.abs(v.currentTime - target) > 0.2) v.currentTime = target;
    } else {
      if (!v.paused) v.pause();
      if (Math.abs(v.currentTime - target) > 1 / fps) v.currentTime = target;
    }
  }, [frame, playing, trim, fps]);

  return (
    <div
      className="angle"
      style={active ? { outline: `4px solid ${color}`, outlineOffset: -4 } : undefined}
      onClick={onCut}
    >
      <video
        ref={(el) => {
          (videoRef as React.MutableRefObject<HTMLVideoElement | null>).current = el;
          onVideoEl(el);
        }}
        src={source.src}
        muted
        playsInline
        preload="auto"
        style={{
          ...(source.rotation ? { transform: `rotate(${source.rotation}deg)` } : {}),
          // Preview only: the program monitor and the render do this properly
          // on canvas. This keeps the thumbnail honest about its own grade.
          ...(isNeutral(grade) ? {} : { filter: gradeFilter(grade!) }),
        }}
      />
      {!isNeutral(grade) && <div className="angle-tint" style={{ background: gradeTint(grade!) ?? undefined }} />}
      <span className="tag" style={{ background: color, color: textOn(color) }}>
        {index + 1} {source.id}
      </span>
      <button
        className="angle-rotate"
        title={`Rotate (now ${source.rotation ?? 0}°)`}
        onClick={(e) => {
          e.stopPropagation();
          onRotate();
        }}
      >
        ⟳
      </button>
      <div className="angle-grade" onClick={(e) => e.stopPropagation()}>
        <button title="Match every other angle to this one" onClick={onMatchTo}>
          Match to this
        </button>
        {GRADE_SLIDERS.map(({ key, label, min, max }) => (
          <label key={key}>
            <span>{label}</span>
            <input
              type="range"
              min={min}
              max={max}
              step={0.01}
              value={(grade ?? NEUTRAL)[key]}
              onChange={(e) =>
                onGrade({ ...(grade ?? NEUTRAL), [key]: Number(e.target.value) })
              }
            />
          </label>
        ))}
        <label>
          <span>Warmth</span>
          <input
            type="range"
            min={-0.5}
            max={0.5}
            step={0.01}
            value={warmthOf(grade ?? NEUTRAL)}
            onChange={(e) => onGrade(withWarmth(grade ?? NEUTRAL, Number(e.target.value)))}
          />
        </label>
        {!isNeutral(grade) && <button onClick={() => onGrade(null)}>Reset</button>}
      </div>
    </div>
  );
}

const GRADE_SLIDERS = [
  { key: 'brightness', label: 'Exposure', min: 0.4, max: 2.5 },
  { key: 'contrast', label: 'Contrast', min: 0.5, max: 2 },
  { key: 'saturation', label: 'Saturation', min: 0, max: 2 },
] as const;

// Warmth is the red/blue half of the gain, shown as one control. An auto-match
// can set a gain no single slider describes, so this reads back what it can
// and leaves green where the match put it.
function warmthOf(grade: Grade): number {
  return (grade.gain[0] - grade.gain[2]) / 2;
}

function withWarmth(grade: Grade, warmth: number): Grade {
  return { ...grade, gain: [1 + warmth, grade.gain[1], 1 - warmth] };
}

function Timeline({
  timeline,
  cuts,
  fps,
  frame,
  colorOf,
  onSeek,
  onDeleteCutAt,
  onMoveCut,
  onDragStart,
}: {
  timeline: ReturnType<typeof buildTimeline>;
  cuts: Cut[];
  fps: number;
  frame: number;
  colorOf: (id: string) => string;
  onSeek: (frame: number) => void;
  onDeleteCutAt: (atFrame: number) => void;
  onMoveCut: (fromFrame: number, toFrame: number) => number | null;
  onDragStart: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const drag = useRef<
    | { type: 'scrub' }
    | { type: 'playhead'; startX: number; startFrame: number }
    | { type: 'cut'; atFrame: number }
    | null
  >(null);
  const duration = timeline.durationInFrames;

  const clampFrame = (f: number) => Math.max(0, Math.min(duration - 1, Math.round(f)));

  const frameAt = (clientX: number) => {
    const r = ref.current!.getBoundingClientRect();
    return clampFrame(((clientX - r.left) / r.width) * duration);
  };

  // Grabbing the playhead or its clock drags from where you took hold, rather
  // than jumping the program to the pointer: the clock is clamped away from
  // the playhead near either end, so an absolute seek there would leap.
  const framesPerPixel = () => duration / (ref.current?.getBoundingClientRect().width || 1);

  const explicitCuts = [...cuts].sort((a, b) => a.atFrame - b.atFrame);

  return (
    <div
      ref={ref}
      className="timeline"
      onPointerDown={(e) => {
        const target = e.target as HTMLElement;
        if (target.closest('.seg-x')) return;
        e.currentTarget.setPointerCapture(e.pointerId);
        const handle = target.closest('.cut-handle') as HTMLElement | null;
        if (handle) {
          drag.current = { type: 'cut', atFrame: Number(handle.dataset.frame) };
          onDragStart();
        } else if (target.closest('.playhead-grip, .playhead-time')) {
          drag.current = { type: 'playhead', startX: e.clientX, startFrame: frame };
        } else {
          drag.current = { type: 'scrub' };
          onSeek(frameAt(e.clientX));
        }
      }}
      onPointerMove={(e) => {
        if (!drag.current) return;
        if (drag.current.type === 'playhead') {
          const moved = (e.clientX - drag.current.startX) * framesPerPixel();
          onSeek(clampFrame(drag.current.startFrame + moved));
          return;
        }
        const f = frameAt(e.clientX);
        if (drag.current.type === 'scrub') {
          onSeek(f);
        } else {
          const moved = onMoveCut(drag.current.atFrame, f);
          if (moved !== null) drag.current.atFrame = moved;
        }
      }}
      onPointerUp={() => (drag.current = null)}
      onPointerCancel={() => (drag.current = null)}
    >
      {timeline.segments.map((seg, i) => {
        const deletable = cuts.some((c) => c.atFrame === seg.start);
        return (
          <div
            key={`${seg.start}-${seg.sourceId}`}
            className={`seg${i === timeline.segments.length - 1 ? ' last' : ''}`}
            style={{
              width: `${(seg.len / duration) * 100}%`,
              background: colorOf(seg.sourceId),
              color: textOn(colorOf(seg.sourceId)),
            }}
            title={`${seg.sourceId} @ ${formatFrame(seg.start, fps)}`}
          >
            <span className="seg-label">{seg.sourceId}</span>
            {deletable && (
              <button
                className="seg-x"
                title="Remove this cut (merges into the previous segment)"
                onClick={() => onDeleteCutAt(seg.start)}
              >
                ×
              </button>
            )}
          </div>
        );
      })}
      {explicitCuts
        .filter((c) => c.atFrame > 0 && c.atFrame < duration)
        .map((c) => (
          <div
            key={c.atFrame}
            className="cut-handle"
            data-frame={c.atFrame}
            style={{ left: `${(c.atFrame / duration) * 100}%` }}
            title="Drag to move this cut"
          />
        ))}
      <div className="playhead" style={{ left: `${(frame / duration) * 100}%` }}>
        <div className="playhead-grip" title="Drag to scrub" />
      </div>
      <div
        className="playhead-time"
        // Clamped so the label stays inside the track at either end.
        style={{ left: `${Math.min(96, Math.max(4, (frame / duration) * 100))}%` }}
        title="Drag to scrub"
      >
        {formatFrame(frame, fps)}
      </div>
    </div>
  );
}

function formatFrame(f: number, fps: number) {
  const s = f / fps;
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.floor(s % 60)).padStart(2, '0')}.${String(Math.floor(f) % fps).padStart(2, '0')}`;
}
