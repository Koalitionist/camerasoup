import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Framing, Grade, Range } from '../../../video/src/types';
import {
  buildProgram,
  buildTimeline,
  drawGraded,
  normalizeRanges,
  programFrameOf,
  removedAt,
  focusOf,
  isNeutral,
  isUnframed,
  MAX_ZOOM,
  placeCover,
  UNFRAMED,
  gradeFilter,
  gradeTint,
  GRADE_PRESETS,
  matchGrade,
  presetFor,
  statsFrom,
  Cut,
  EditSource,
  FilmFormat,
  FilmProps,
  FORMATS,
} from '../../../video/src/types';
import SpinePage from '../components/Spine';
import {
  folderGoneMessage,
  folderPermission,
  folderReachable,
  loadRootFolder,
  opfsRequested,
  pickRootFolder,
  requestFolderPermission,
} from '../lib/folder';
import { isHosted } from '../lib/platform';
import { colorForKey, textOn } from '../lib/theme';
import type { RenderProgress } from '../lib/render-browser';
import { mp4NameFor, needsRemux, remuxToMp4 } from '../lib/remux';
import { Manifest, SessionStore, getStore, isFolderStore } from '../lib/session-store';
import { Json, StudioSocket } from '../lib/ws';

export default function Edit() {
  const sessionId = new URLSearchParams(location.search).get('session');
  const [store, setStore] = useState<SessionStore | null>(null);
  const [needsFolder, setNeedsFolder] = useState(false);
  // A remembered folder whose permission the browser has since forgotten:
  // Chrome drops the grant once every tab of the site has been closed.
  const [regrant, setRegrant] = useState<FileSystemDirectoryHandle | null>(null);
  const [manifest, setManifest] = useState<Manifest | null>(null);
  const [sessions, setSessions] = useState<Manifest[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [gone, setGone] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      if (isHosted() && !opfsRequested()) {
        const handle = await loadRootFolder();
        if (handle) {
          const perm = await folderPermission(handle).catch(() => 'prompt' as PermissionState);
          if (perm !== 'granted') {
            setRegrant(handle);
            return;
          }
          if (!(await folderReachable(handle))) {
            setGone(folderGoneMessage(handle));
            setNeedsFolder(true);
            return;
          }
        }
      }
      const s = await getStore();
      if (s) setStore(s);
      else setNeedsFolder(true); // hosted, but no folder remembered yet
    })();
  }, []);

  const refresh = useCallback(() => {
    if (!store) return;
    setProblem(null);
    store.list().then(setSessions, (e: unknown) => {
      setSessions([]);
      setProblem(`Could not read the folder: ${e instanceof Error ? e.message : String(e)}`);
    });
  }, [store]);

  useEffect(() => {
    if (!store) return;
    if (!sessionId) return refresh();
    store.load(sessionId).then(
      (m) => (m ? setManifest(m) : setProblem(`Could not open session ${sessionId}.`)),
      (e: unknown) => setProblem(e instanceof Error ? e.message : String(e))
    );
  }, [store, sessionId, refresh]);

  const chooseFolder = async () => {
    try {
      await pickRootFolder();
      const s = await getStore();
      if (s) {
        setStore(s);
        setNeedsFolder(false);
        setRegrant(null);
        setGone(null);
      }
    } catch {
      // picker cancelled
    }
  };

  if (needsFolder || regrant) {
    return (
      <SpinePage>
        <span className="meta">Editor</span>
        <h1>Which folder holds the recordings?</h1>
        <p className="lede">
          The same folder the studio records into. The browser asks once per computer.
        </p>
        <div className="actions-row" style={{ marginTop: 8 }}>
          {regrant ? (
            <>
              <button
                className="pill solid"
                onClick={async () => {
                  if (!(await requestFolderPermission(regrant))) return;
                  setRegrant(null);
                  if (await folderReachable(regrant)) setStore(await getStore());
                  else {
                    setGone(folderGoneMessage(regrant));
                    setNeedsFolder(true);
                  }
                }}
              >
                Use “{regrant.name}” again
              </button>
              <button className="pill outline" onClick={() => void chooseFolder()}>
                Choose a different folder
              </button>
            </>
          ) : (
            <button className="pill solid" onClick={() => void chooseFolder()}>
              Choose folder
            </button>
          )}
        </div>
        {gone && <p className="hint">{gone}</p>}
      </SpinePage>
    );
  }
  if (!sessionId)
    return <SessionPicker sessions={sessions} store={store} problem={problem} onChanged={refresh} />;
  if (!manifest) {
    return (
      <SpinePage>
        {problem ? (
          <>
            <p className="hint danger-text">{problem}</p>
            <div className="actions-row">
              <a href="/edit">
                <button className="pill outline">← All sessions</button>
              </a>
            </div>
          </>
        ) : (
          <div className="join-status">
            <span className="dot active" />
            Loading session…
          </div>
        )}
      </SpinePage>
    );
  }
  return <Repaired manifest={manifest} store={store!} onRepaired={setManifest} />;
}

// A session recorded by the browser studio holds whatever MediaRecorder
// produced, and on the Mac that is a WebM the editor cannot seek — see
// lib/remux.ts. The repair is a container copy, it happens once, and the
// session then behaves like one recorded by the local app.
function Repaired({
  manifest,
  store,
  onRepaired,
}: {
  manifest: Manifest;
  store: SessionStore;
  onRepaired: (m: Manifest) => void;
}) {
  const todo = manifest.sources.filter((s) => s.status === 'finalized' && needsRemux(s.file));
  const [progress, setProgress] = useState<{ name: string; at: number; done: number } | null>(null);
  const [failed, setFailed] = useState<string | null>(null);

  useEffect(() => {
    if (!todo.length || store.kind !== 'folder') return;
    let cancelled = false;
    void (async () => {
      for (const [i, source] of todo.entries()) {
        try {
          setProgress({ name: source.name || source.id, at: 0, done: i });
          const blob = await store.fileFor(manifest.id, source.file!);
          const mp4 = await remuxToMp4(blob, (at) => {
            if (!cancelled) setProgress({ name: source.name || source.id, at, done: i });
          });
          if (cancelled) return;
          await store.replaceSourceFile(manifest.id, source.id, mp4NameFor(source.file!), mp4);
        } catch (err) {
          if (!cancelled) setFailed(`${source.name || source.id}: ${(err as Error).message}`);
          return;
        }
      }
      const fresh = await store.load(manifest.id);
      if (!cancelled && fresh) onRepaired(fresh);
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [manifest.id, store]);

  if (failed) {
    return (
      <SpinePage>
        <span className="meta">{manifest.id}</span>
        <h1>This recording could not be repaired.</h1>
        <p className="lede">{failed}</p>
        <p className="hint">
          The footage is untouched. Rendering still works; only scrubbing that angle does not.
        </p>
        <div className="actions-row">
          <a href="/edit">
            <button className="pill outline">← Sessions</button>
          </a>
        </div>
      </SpinePage>
    );
  }
  if (todo.length && store.kind === 'folder') {
    const pct = Math.round(((progress?.done ?? 0) + (progress?.at ?? 0)) * (100 / todo.length));
    return (
      <SpinePage>
        <span className="meta">{manifest.id}</span>
        <h1>Getting {todo.length === 1 ? 'an angle' : `${todo.length} angles`} ready to scrub.</h1>
        <p className="lede">
          {progress?.name ?? todo[0].name ?? todo[0].id} — {pct}%. The frames are copied as they
          are, not re-encoded, and this happens once per recording.
        </p>
      </SpinePage>
    );
  }
  return <Editor manifest={manifest} store={store} />;
}

// A take is a dud if a source failed outright or nothing ran long enough to
// be footage. Most of what piles up in a folder is one or the other.
const DUD_SECONDS = 3;

function takeStats(m: Manifest) {
  const seconds = m.sources.reduce((n, s) => Math.max(n, s.duration ?? 0), 0);
  const bytes = m.sources.reduce((n, s) => n + (s.bytes ?? 0), 0);
  const failed = m.sources.filter((s) => s.status === 'failed').length;
  return { seconds, bytes, failed, dud: failed > 0 || seconds < DUD_SECONDS };
}

function sizeOf(bytes: number) {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${Math.round(bytes / 1e6)} MB`;
  return `${Math.max(1, Math.round(bytes / 1e3))} kB`;
}

function SessionPicker({
  sessions,
  store,
  problem: readProblem,
  onChanged,
}: {
  sessions: Manifest[] | null;
  store: SessionStore | null;
  problem: string | null;
  onChanged: () => void;
}) {
  const home = isHosted() ? '/studio' : '/producer';
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const takes = sessions ?? [];
  const duds = takes.filter((m) => takeStats(m).dud);
  const chosen = takes.filter((m) => picked.has(m.id));
  const freed = chosen.reduce((n, m) => n + takeStats(m).bytes, 0);

  // Any change to the selection disarms the confirm: the count on that button
  // has to be the count you agreed to.
  const select = (ids: string[]) => {
    setConfirming(false);
    setPicked(new Set(ids));
  };
  const toggle = (id: string) => {
    setConfirming(false);
    setPicked((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const deleteChosen = async () => {
    if (!store || !chosen.length) return;
    setBusy(true);
    setProblem(null);
    const stuck: string[] = [];
    for (const m of chosen) {
      try {
        await store.remove(m.id);
      } catch {
        stuck.push(m.id);
      }
    }
    setBusy(false);
    setConfirming(false);
    setPicked(new Set());
    setProblem(
      stuck.length ? `Could not delete ${stuck.length}: ${stuck.slice(0, 3).join(', ')}` : null
    );
    onChanged();
  };

  return (
    <SpinePage>
      <span className="meta">Editor</span>
      <h1>Edit a session</h1>
      {!sessions && <p className="hint">Loading…</p>}
      {readProblem && <p className="hint danger-text">{readProblem}</p>}
      {sessions?.length === 0 && !readProblem && (
        <p className="lede">No sessions yet — record one first.</p>
      )}

      {takes.length > 0 && (
        <div className="take-tools">
          <span className="meta">
            {takes.length} recording{takes.length === 1 ? '' : 's'}
          </span>
          <button className="pill outline small" onClick={() => select(takes.map((m) => m.id))}>
            Select all
          </button>
          {duds.length > 0 && (
            <button
              className="pill outline small"
              title={`Failed takes, and anything under ${DUD_SECONDS} seconds`}
              onClick={() => select(duds.map((m) => m.id))}
            >
              Select the duds · {duds.length}
            </button>
          )}
          {picked.size > 0 && (
            <button className="pill outline small" onClick={() => select([])}>
              Clear
            </button>
          )}
          <span className="spacer" />
          {picked.size > 0 &&
            (confirming ? (
              <>
                <button className="pill small danger" disabled={busy} onClick={deleteChosen}>
                  {busy ? 'Deleting…' : `Delete ${picked.size} for good`}
                </button>
                <button className="pill outline small" onClick={() => setConfirming(false)}>
                  Cancel
                </button>
              </>
            ) : (
              <button className="pill outline small" onClick={() => setConfirming(true)}>
                Delete {picked.size} · {sizeOf(freed)}
              </button>
            ))}
        </div>
      )}
      {confirming && (
        <p className="hint danger-text">
          This removes the footage from the folder. There is no undo and it does not go to the
          Trash.
        </p>
      )}
      {problem && <p className="hint danger-text">{problem}</p>}

      <div className="takes">
        {takes.map((m) => {
          const { seconds, bytes, failed, dud } = takeStats(m);
          return (
            <label key={m.id} className={`take${picked.has(m.id) ? ' picked' : ''}`}>
              <input type="checkbox" checked={picked.has(m.id)} onChange={() => toggle(m.id)} />
              <b>{m.id}</b>
              <span className="take-detail">{m.sources.map((s) => s.name || s.id).join(' · ')}</span>
              <span className="take-meta">
                {seconds >= 1 ? `${Math.round(seconds)} s` : '—'} · {sizeOf(bytes)}
                {failed > 0 && <span className="danger-text"> · {failed} failed</span>}
                {dud && failed === 0 && <span className="meta"> · short</span>}
              </span>
              <a href={`/edit?session=${m.id}`} onClick={(e) => e.stopPropagation()}>
                <button className="pill outline small">Edit</button>
              </a>
            </label>
          );
        })}
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
  const [framings, setFramings] = useState<Record<string, Framing>>(() =>
    Object.fromEntries(manifest.sources.filter((s) => s.framing).map((s) => [s.id, s.framing!]))
  );
  const setFraming = useCallback((id: string, f: Framing | null) => {
    setFramings((all) => {
      const next = { ...all };
      // Like a grade: the plain center crop is the absence of a framing.
      if (f && !isUnframed(f)) next[id] = f;
      else delete next[id];
      return next;
    });
  }, []);

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
              framing: framings[s.id],
              hasAudio: s.hasAudio,
            })),
    [usable, urls, rotations, grades, framings]
  );

  const [cuts, setCuts] = useState<Cut[]>(manifest.cuts ?? []);
  // Time taken out of the program, on the synced timeline (see buildProgram).
  const [removed, setRemoved] = useState<Range[]>(manifest.removed ?? []);
  const [crossfade, setCrossfade] = useState(manifest.crossfade ?? true);
  // In and out marks for the next stretch to cut out.
  const [marks, setMarks] = useState<{ in: number | null; out: number | null }>({ in: null, out: null });
  // Null means "not chosen yet" and resolves below; only an explicit pick is
  // stored, so opening a session never rewrites its manifest.
  const [audioSourceId, setAudioSourceId] = useState<string | null>(manifest.audioSource);
  // A screen share is only silent if we know it is: undefined comes from
  // sessions recorded before the flag existed and must not be read as silence.
  const carriesAudio = (s: EditSource) => s.hasAudio !== false;
  // Default to a source that actually has sound — the first angle is often
  // the shared screen, and picking it would render a silent film.
  const chosenAudioId =
    audioSourceId ?? sources.find(carriesAudio)?.id ?? sources[0]?.id ?? null;
  // The finished file, played in place. A browser tab cannot open Finder, so
  // "where did it go" is answered by showing the thing itself.
  const [preview, setPreview] = useState<{ file: string; url: string; own: boolean } | null>(null);
  const closePreview = useCallback(() => {
    setPreview((p) => {
      if (p?.own) URL.revokeObjectURL(p.url);
      return null;
    });
  }, []);
  const openPreview = useCallback(
    async (file: string) => {
      closePreview();
      // A path on the local server can be played straight; the folder store
      // has to hand over a blob, and this one is revoked here rather than in
      // releaseUrls, which belongs to the angle sources.
      if (store.kind === 'server') {
        setPreview({ file, url: await store.urlFor(manifest.id, file), own: false });
      } else {
        const blob = await store.fileFor(manifest.id, file);
        setPreview({ file, url: URL.createObjectURL(blob), own: true });
      }
    },
    [closePreview, manifest.id, store]
  );
  useEffect(() => closePreview, [closePreview]);

  const [format, setFormat] = useState<FilmFormat>('4:5');
  // Landscape is off by default: it is a third encode, and most takes here are
  // going somewhere vertical.
  const [outputs, setOutputs] = useState<FilmFormat[]>(['4:5', '9:16']);
  const [render, setRender] = useState<{
    state: 'idle' | 'running' | 'done' | 'error';
    progress: number;
    format?: string;
    files?: string[];
    message?: string;
  }>({ state: 'idle', progress: 0 });

  const props: FilmProps = useMemo(
    () => ({ sources, cuts, audioSourceId: chosenAudioId, fps, format, removed, crossfade }),
    [sources, cuts, chosenAudioId, fps, format, removed, crossfade]
  );
  const program = useMemo(() => buildProgram(props), [props]);
  const { timeline } = program;
  // The playhead runs on the synced timeline, like the cuts; the clock shows
  // the finished film's time.
  const total = timeline.durationInFrames;
  const removedRef = useRef(program.removed);
  removedRef.current = program.removed;

  // A removed stretch is never stood in: landing in one moves past it, the
  // way you were going, unless that runs off the end.
  const outsideRemoved = useCallback(
    (f: number, dir: 1 | -1 = 1) => {
      const r = removedAt(removedRef.current, f);
      if (!r) return f;
      if (dir > 0 && r.to < total) return r.to;
      if (r.from > 0) return r.from - 1;
      return r.to < total ? r.to : f;
    },
    [total]
  );

  // ---- transport: our own playback clock (no media element drives time) ----
  const [playing, setPlaying] = useState(false);
  const [frame, setFrame] = useState(0);
  const frameRef = useRef(0);
  const playClock = useRef<{ t: number; f: number } | null>(null);

  const setFrameBoth = useCallback((f: number) => {
    frameRef.current = f;
    setFrame(f);
  }, []);

  // Bumped whenever playback jumps a removed stretch, so the media elements
  // follow at once rather than waiting to drift far enough to correct.
  const [skips, setSkips] = useState(0);

  const seekTo = useCallback(
    (f: number, dir: 1 | -1 = 1) => {
      const clamped = outsideRemoved(Math.max(0, Math.min(total - 1, f)), dir);
      if (playClock.current) playClock.current = { t: performance.now(), f: clamped };
      setFrameBoth(clamped);
    },
    [total, setFrameBoth, outsideRemoved]
  );

  // The last frame the film actually shows.
  const lastKept = program.kept.length ? program.kept[program.kept.length - 1].to - 1 : total - 1;

  const toggle = useCallback(() => {
    setPlaying((p) => {
      if (!p && frameRef.current >= lastKept) setFrameBoth(outsideRemoved(0));
      return !p;
    });
  }, [lastKept, setFrameBoth, outsideRemoved]);

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
      let f = c.f + ((performance.now() - c.t) / 1000) * fps;
      if (f >= lastKept) {
        setFrameBoth(lastKept);
        setPlaying(false);
        return;
      }
      const r = removedAt(removedRef.current, Math.floor(f));
      if (r) {
        // Jump the stretch and restart the clock from its far side.
        f = r.to;
        playClock.current = { t: performance.now(), f };
        setSkips((n) => n + 1);
      }
      setFrameBoth(f);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, fps, lastKept, setFrameBoth]);

  // Registry of the angle-tile <video> elements. The program canvas draws
  // from these directly — no extra media streams (Chrome allows only 6
  // concurrent connections per origin, and long sessions have big files).
  const videoEls = useRef(new Map<string, HTMLVideoElement>());

  // ---- undo history for the edit: angle cuts and removed time (Cmd/Ctrl+Z) ----
  const history = useRef<{ cuts: Cut[]; removed: Range[] }[]>([]);
  const pushHistory = useCallback(() => {
    history.current.push({ cuts, removed });
    if (history.current.length > 100) history.current.shift();
  }, [cuts, removed]);
  const updateCuts = useCallback(
    (next: Cut[]) => {
      pushHistory();
      setCuts(next);
    },
    [pushHistory]
  );
  const updateRemoved = useCallback(
    (next: Range[]) => {
      pushHistory();
      setRemoved(normalizeRanges(next, total));
    },
    [pushHistory, total]
  );
  const undo = useCallback(() => {
    const prev = history.current.pop();
    if (!prev) return;
    setCuts(prev.cuts);
    setRemoved(prev.removed);
  }, []);

  // Cut the marked stretch out of the program.
  const cutOutMarked = useCallback(() => {
    if (marks.in === null || marks.out === null) return;
    const from = Math.min(marks.in, marks.out);
    const to = Math.max(marks.in, marks.out);
    if (to <= from) return;
    updateRemoved([...program.removed, { from, to }]);
    setMarks({ in: null, out: null });
    seekTo(to);
  }, [marks, program.removed, updateRemoved, seekTo]);

  // auto-save cuts + audio + rotations (debounced)
  const firstSave = useRef(true);
  useEffect(() => {
    if (firstSave.current) {
      firstSave.current = false;
      return;
    }
    const t = window.setTimeout(() => {
      void store.saveEdit(manifest.id, {
        cuts,
        audioSource: audioSourceId,
        rotations,
        grades,
        framings,
        removed,
        crossfade,
      });
    }, 600);
    return () => window.clearTimeout(t);
  }, [cuts, audioSourceId, rotations, grades, framings, removed, crossfade, manifest.id, store]);

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

  // Give a shot a different angle and keep both of its edges. Removing a cut
  // hands its stretch to the shot before and loses the edit point; this is
  // what replacing a shot that didn't work usually means.
  const swapAt = useCallback(
    (atFrame: number, sourceId: string) => {
      updateCuts([...cuts.filter((c) => c.atFrame !== atFrame), { atFrame, sourceId }]);
    },
    [cuts, updateCuts]
  );
  const swapAtPlayhead = useCallback(
    (sourceId: string) => {
      const f = frameRef.current;
      const seg = [...timeline.segments].reverse().find((s) => s.start <= f);
      if (seg && seg.sourceId !== sourceId) swapAt(seg.start, sourceId);
    },
    [timeline, swapAt]
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

  // keyboard: 1..9 switch, shift+1..9 swap the shot, space play/pause,
  // arrows step, backspace delete cut
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'SELECT') return;
      // By code, not key: shift turns the 1 into ! on most layouts.
      const digit = /^Digit([1-9])$/.exec(e.code);
      if (e.shiftKey && digit && Number(digit[1]) <= sources.length) {
        swapAtPlayhead(sources[Number(digit[1]) - 1].id);
        return;
      }
      const idx = parseInt(e.key, 10);
      if (idx >= 1 && idx <= sources.length) {
        addCut(sources[idx - 1].id);
      } else if (e.key === ' ') {
        e.preventDefault();
        toggle();
      } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault();
        const dir = e.key === 'ArrowLeft' ? -1 : 1;
        seekTo(Math.round(frameRef.current) + (e.shiftKey ? 10 : 1) * dir, dir);
      } else if (e.key === 'i' || e.key === 'I') {
        const f = Math.round(frameRef.current);
        setMarks((m) => ({ in: f, out: m.out !== null && m.out > f ? m.out : null }));
      } else if (e.key === 'o' || e.key === 'O') {
        const f = Math.round(frameRef.current);
        setMarks((m) => ({ in: m.in !== null && m.in < f ? m.in : null, out: f }));
      } else if (e.key === 'x' || e.key === 'X') {
        cutOutMarked();
      } else if (e.key === 'Escape') {
        setMarks({ in: null, out: null });
      } else if (e.key === 'Backspace' || e.key === 'Delete') {
        deleteCutAtPlayhead();
      } else if ((e.metaKey || e.ctrlKey) && e.key === 'z') {
        e.preventDefault();
        undo();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [sources, addCut, swapAtPlayhead, deleteCutAtPlayhead, undo, toggle, seekTo, cutOutMarked]);

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

  // Every hook must sit above this line: the early return runs a shorter list
  // of them, and React tears the tree down when the counts disagree.
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
  const activeId = activeSourceAt(frame);
  const activeSource = sources.find((s) => s.id === activeId) ?? null;
  const audioSource = sources.find((s) => s.id === chosenAudioId) ?? sources[0];

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
        {/* The finished film's clock: removed time does not count. */}
        <span className="timecode">
          {formatFrame(programFrameOf(program.kept, frame), fps)}{' '}
          <span className="total">/ {formatFrame(program.durationInFrames, fps)}</span>
        </span>
        <button className="pill ghost small" disabled={cuts.length === 0} onClick={() => updateCuts([])}>
          Clear cuts
        </button>
        {marks.in !== null && marks.out !== null ? (
          <button className="pill solid small" title="Cut the marked stretch out (X)" onClick={cutOutMarked}>
            Cut out {formatFrame(marks.out - marks.in, fps)}
          </button>
        ) : marks.in !== null || marks.out !== null ? (
          <span className="field">
            {marks.in === null ? 'I marks the start' : 'O marks the end'}
          </span>
        ) : null}
        {program.removed.length > 0 && (
          <button
            className="pill ghost small"
            title="Put every removed stretch back"
            onClick={() => updateRemoved([])}
          >
            Restore all
          </button>
        )}
        <span className="spacer" />
        <label className="field">
          audio
          <select value={chosenAudioId ?? ''} onChange={(e) => setAudioSourceId(e.target.value)}>
            {sources.map((s) => (
              <option key={s.id} value={s.id}>
                {carriesAudio(s) ? s.id : `${s.id} (silent)`}
              </option>
            ))}
          </select>
        </label>
        <label className="field" title="Blend the sound across each stretch you cut out">
          crossfade
          <input type="checkbox" checked={crossfade} onChange={(e) => setCrossfade(e.target.checked)} />
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
        <label className="field">
          render
          <span className="format-picks">
            {(Object.keys(FORMATS) as FilmFormat[]).map((f) => (
              <button
                key={f}
                type="button"
                className={outputs.includes(f) ? 'on' : undefined}
                title={`${FORMATS[f].width}×${FORMATS[f].height}`}
                onClick={() =>
                  setOutputs((current) =>
                    current.includes(f) ? current.filter((x) => x !== f) : [...current, f]
                  )
                }
              >
                {f}
              </button>
            ))}
          </span>
        </label>
        {Object.keys(grades).length > 0 && (
          <button
            className="pill ghost small"
            title="Clear the color correction on every angle"
            onClick={() => setGrades({})}
          >
            Reset color
          </button>
        )}
        {render.state === 'running' ? (
          <span className="field">
            rendering {render.format ?? ''} {Math.round(render.progress * 100)}%
          </span>
        ) : (
          <button
            className="render-button"
            disabled={!outputs.length}
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
                    formats: outputs,
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
            {outputs.length ? `Render ${outputs.join(' + ')}` : 'Pick a format'}
          </button>
        )}
      </header>

      {render.state === 'done' && (
        <div className="banner">
          Rendered into {isFolderStore(store) ? `${store.folderName}/${manifest.id}` : 'the session folder'}.
          {(render.files ?? []).map((file) => (
            <button key={file} className="pill ghost small" onClick={() => void openPreview(file)}>
              ▶ {file}
            </button>
          ))}
          {store.kind === 'server' && (
            <button className="pill ghost small" onClick={() => void store.reveal(manifest.id)}>
              Reveal
            </button>
          )}
        </div>
      )}

      {preview && (
        <div className="preview-scrim" onClick={closePreview}>
          <div className="preview-box" onClick={(e) => e.stopPropagation()}>
            {/* Shaped from the file name so the box opens at the right size
                instead of snapping from 300x150 when metadata arrives. */}
            <video
              src={preview.url}
              style={{ aspectRatio: aspectOf(preview.file) }}
              controls
              autoPlay
              playsInline
            />
            <div className="preview-bar">
              <span>{preview.file}</span>
              <button className="pill ghost small" onClick={closePreview}>
                Close
              </button>
            </div>
          </div>
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
        <div className="edit-program">
          <ProgramCanvas
            width={FORMATS[format].width}
            height={FORMATS[format].height}
            activeSource={activeSource}
            activeColor={activeId ? colorOf(activeId) : '#000'}
            videoEls={videoEls}
            onToggle={toggle}
            onFraming={setFraming}
          />
          {activeSource && (
            <FrameBar
              source={activeSource}
              onFraming={(f) => setFraming(activeSource.id, f)}
            />
          )}
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
              skips={skips}
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
            playhead. Shift+1–{sources.length}, or the numbers on a shot, swap its angle and keep its
            timing. I and O mark a stretch, X cuts it out; click a hatched sliver to put it back.
            Drag the picture to reframe the angle on screen; scroll or pinch to zoom.
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
          skips={skips}
        />
      )}

      <Timeline
        timeline={timeline}
        cuts={cuts}
        fps={fps}
        frame={frame}
        colorOf={colorOf}
        onSeek={seekTo}
        angles={sources.map((s) => s.id)}
        onSwap={swapAt}
        program={program}
        marks={marks}
        onRestore={(r) => updateRemoved(program.removed.filter((x) => x.from !== r.from))}
        onDeleteCutAt={(atFrame) => updateCuts(cuts.filter((c) => c.atFrame !== atFrame))}
        onMoveCut={moveCut}
        onDragStart={pushHistory}
      />
    </div>
  );
}

// The program monitor: a canvas that draws the active angle's tile video with
// the same cover, framing and rotation maths as the render. Reusing the tile
// <video> elements keeps us inside the browser's per-origin connection limit.
//
// It is also where an angle is framed: drag the picture to move the crop,
// scroll or pinch to push in. A click that does not move still plays.
function ProgramCanvas({
  width,
  height,
  activeSource,
  activeColor,
  videoEls,
  onToggle,
  onFraming,
}: {
  width: number;
  height: number;
  activeSource: EditSource | null;
  activeColor: string;
  videoEls: React.MutableRefObject<Map<string, HTMLVideoElement>>;
  onToggle: () => void;
  onFraming: (id: string, framing: Framing | null) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const activeRef = useRef(activeSource);
  // Wheel events arrive faster than React re-renders, so each one builds on
  // the last one sent rather than on a prop that has not caught up yet.
  const pending = useRef<{ id: string; framing: Framing } | null>(null);
  if (activeRef.current !== activeSource) pending.current = null;
  activeRef.current = activeSource;
  // The upright size of what is on screen, for turning pointer movement
  // into a framing. Written by the draw loop.
  const content = useRef<{ w: number; h: number } | null>(null);
  const [dragging, setDragging] = useState(false);

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
      if (!v || !v.videoWidth) {
        content.current = null;
        return;
      }
      // The <video> element already applies the file's own display matrix;
      // only the user-set rotation is applied here (mirrors the render).
      const rot = (((active!.rotation ?? 0) % 360) + 360) % 360;
      const quarter = rot === 90 || rot === 270;
      const contentW = quarter ? v.videoHeight : v.videoWidth;
      const contentH = quarter ? v.videoWidth : v.videoHeight;
      content.current = { w: contentW, h: contentH };
      const framing =
        pending.current?.id === active!.id ? pending.current.framing : active!.framing;
      const p = placeCover(canvas.width, canvas.height, contentW, contentH, framing);
      // The renderer draws through the identical helpers, so what the
      // monitor shows is what the file gets.
      drawGraded(ctx, canvas.width, canvas.height, active!.grade, () => {
        ctx.save();
        ctx.translate(p.x + p.w / 2, p.y + p.h / 2);
        ctx.rotate((rot * Math.PI) / 180);
        const scale = p.w / contentW;
        ctx.scale(scale, scale);
        ctx.drawImage(v, -v.videoWidth / 2, -v.videoHeight / 2, v.videoWidth, v.videoHeight);
        ctx.restore();
      });
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [videoEls]);

  const current = (): Framing => {
    const active = activeRef.current!;
    return pending.current?.id === active.id
      ? pending.current.framing
      : (active.framing ?? UNFRAMED);
  };

  // Takes where the picture should go and stores the focus point it actually
  // shows once the edges are respected.
  const send = (zoom: number, placed: { x: number; y: number; w: number; h: number }) => {
    const active = activeRef.current;
    const c = content.current;
    if (!active || !c) return;
    const focus = focusOf(width, height, placed);
    const settled = placeCover(width, height, c.w, c.h, { zoom, ...focus });
    const framing = { zoom, ...focusOf(width, height, settled) };
    pending.current = { id: active.id, framing };
    onFraming(active.id, framing);
  };

  const drag = useRef<{
    x: number;
    y: number;
    moved: boolean;
    from: { x: number; y: number; w: number; h: number };
    zoom: number;
  } | null>(null);

  // Wheel needs a non-passive listener to keep the page from scrolling, and
  // React attaches its wheel handler passively.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const onWheel = (e: WheelEvent) => {
      const c = content.current;
      if (!activeRef.current || !c) return;
      e.preventDefault();
      const f = current();
      // A trackpad pinch arrives as a wheel with ctrlKey and small deltas.
      const zoom = Math.min(
        MAX_ZOOM,
        Math.max(1, f.zoom * Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.002)))
      );
      if (zoom === f.zoom) return;
      // Keep the point under the cursor where it is.
      const rect = canvas.getBoundingClientRect();
      const cx = ((e.clientX - rect.left) / rect.width) * width;
      const cy = ((e.clientY - rect.top) / rect.height) * height;
      const before = placeCover(width, height, c.w, c.h, f);
      const u = (cx - before.x) / before.w;
      const v = (cy - before.y) / before.h;
      const after = placeCover(width, height, c.w, c.h, { ...f, zoom });
      send(zoom, { x: cx - u * after.w, y: cy - v * after.h, w: after.w, h: after.h });
    };
    canvas.addEventListener('wheel', onWheel, { passive: false });
    return () => canvas.removeEventListener('wheel', onWheel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [width, height, onFraming]);

  return (
    <canvas
      ref={canvasRef}
      width={width}
      height={height}
      className={`program-canvas${dragging ? ' dragging' : ''}`}
      style={{ aspectRatio: `${width} / ${height}`, outline: `4px solid ${activeColor}` }}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        const c = content.current;
        const f = activeRef.current && c ? current() : null;
        drag.current = {
          x: e.clientX,
          y: e.clientY,
          moved: false,
          from: f && c ? placeCover(width, height, c.w, c.h, f) : { x: 0, y: 0, w: 0, h: 0 },
          zoom: f?.zoom ?? 1,
        };
        e.currentTarget.setPointerCapture(e.pointerId);
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d || !content.current) return;
        if (!d.moved && Math.hypot(e.clientX - d.x, e.clientY - d.y) < 4) return;
        if (!d.moved) setDragging(true);
        d.moved = true;
        const rect = e.currentTarget.getBoundingClientRect();
        const dx = ((e.clientX - d.x) / rect.width) * width;
        const dy = ((e.clientY - d.y) / rect.height) * height;
        send(d.zoom, { ...d.from, x: d.from.x + dx, y: d.from.y + dy });
      }}
      onPointerUp={() => {
        const d = drag.current;
        drag.current = null;
        setDragging(false);
        if (d && !d.moved) onToggle();
      }}
      onPointerCancel={() => {
        drag.current = null;
        setDragging(false);
      }}
    />
  );
}

// Under the monitor, for whichever angle is on screen: how far in it is, and
// a way back to the plain center crop. The drag and the wheel do the same
// thing; this is where you find out that they exist.
function FrameBar({
  source,
  onFraming,
}: {
  source: EditSource;
  onFraming: (framing: Framing | null) => void;
}) {
  const framing = source.framing ?? UNFRAMED;
  const framed = !isUnframed(source.framing);
  return (
    <div className={`frame-bar${framed ? ' framed' : ''}`}>
      <span className="frame-bar-label">{source.id}</span>
      <label title="Zoom in on this angle">
        zoom
        <input
          type="range"
          min={1}
          max={MAX_ZOOM}
          step={0.01}
          value={framing.zoom}
          onChange={(e) => onFraming({ ...framing, zoom: Number(e.target.value) })}
        />
        <span className="frame-bar-value">{framing.zoom.toFixed(1)}×</span>
      </label>
      <button
        className="pill ghost small"
        disabled={!framed}
        title="Back to the full picture, centered"
        onClick={() => onFraming(null)}
      >
        Reset
      </button>
    </div>
  );
}

// One continuous audio track, synced to the transport like the angle tiles.
// The Mac records through MediaRecorder, which writes a live WebM: no Cues,
// no SeekHead, no duration in the container. Chrome plays such a file happily
// but reports an infinite duration and seeks it by scanning, so every sync
// correction stalls it — that angle freezes, and the program monitor with it,
// while the phones' mp4s roll on. (The local app never sees this: its ffmpeg
// remux on finalize puts the index back.)
//
// Seeking once past any possible end makes Chrome scan to the real one, settle
// the duration and build what it needs to seek; afterwards the element behaves
// like any other. Callers hold their own syncing off until it has.
function usePrimedSeeking(ref: React.RefObject<HTMLMediaElement | null>, src: string) {
  const [primed, setPrimed] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    setPrimed(false);
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      el.removeEventListener('timeupdate', finish);
      el.removeEventListener('seeked', finish);
      el.currentTime = 0;
      setPrimed(true);
    };
    const start = () => {
      if (Number.isFinite(el.duration)) {
        setPrimed(true);
        return;
      }
      el.addEventListener('timeupdate', finish);
      el.addEventListener('seeked', finish);
      // Not a real time: it asks Chrome "where does this actually end?"
      el.currentTime = 1e101;
      // A file too damaged to answer must not hold the element hostage.
      window.setTimeout(finish, 5000);
    };
    if (el.readyState >= 1) start();
    else el.addEventListener('loadedmetadata', start, { once: true });
    return () => {
      settled = true;
      el.removeEventListener('loadedmetadata', start);
      el.removeEventListener('timeupdate', finish);
      el.removeEventListener('seeked', finish);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src]);
  return primed;
}

function AudioTrack({
  src,
  trim,
  fps,
  frame,
  playing,
  skips,
}: {
  src: string;
  trim: number;
  fps: number;
  frame: number;
  playing: boolean;
  skips: number;
}) {
  const ref = useRef<HTMLAudioElement>(null);
  const lastSkips = useRef(skips);
  // The audio source can be the same live WebM as an angle, and stalls the
  // same way — the film then plays to a silence that never recovers.
  const primed = usePrimedSeeking(ref, src);

  useEffect(() => {
    const a = ref.current;
    if (!a || !primed) return;
    const target = (frame + trim) / fps;
    // Playback just jumped a removed stretch: follow now, however short.
    const skipped = skips !== lastSkips.current;
    lastSkips.current = skips;
    if (playing) {
      if (a.paused) void a.play().catch(() => {});
      if (skipped || Math.abs(a.currentTime - target) > 0.25) a.currentTime = target;
    } else {
      if (!a.paused) a.pause();
      if (Math.abs(a.currentTime - target) > 0.05) a.currentTime = target;
    }
  }, [frame, playing, trim, fps, primed, skips]);

  return <audio ref={ref} src={src} preload="auto" />;
}

function AngleTile({
  source,
  index,
  fps,
  trim,
  frame,
  playing,
  skips,
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
  skips: number;
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
  const preset = presetFor(grade);

  const primed = usePrimedSeeking(videoRef, source.src);

  // Keep the angle preview synced to the program playhead: exact while
  // paused/seeking, drift-corrected while playing.
  //
  // A seek costs however far it is back to the previous keyframe, and
  // playback is stalled for all of it — 3.4s apart on a MacBook webcam
  // recording against 1s on a phone's, because MediaRecorder picks the
  // interval and won't be told otherwise. Correcting on every frame tick
  // therefore feeds itself on the slow angle: the correction lands later
  // than the threshold allows, so it needs another, which cancels the
  // first, and that angle sits seeking forever while the others play.
  //
  // Hence: never a second correction while one is in flight, a cooldown
  // long enough for the element to make real progress, and a threshold
  // wider than a seek costs, so landing from one does not ask for the
  // next. Half a second of lag on a preview is invisible; a frozen angle
  // is not. Paused is still exact, which is what judging a cut needs.
  const lastCorrection = useRef(0);
  const lastSkips = useRef(skips);
  useEffect(() => {
    const v = videoRef.current;
    if (!v || !primed) return;
    const target = (frame + trim) / fps;
    if (playing) {
      if (v.paused) void v.play().catch(() => {});
      const now = performance.now();
      // A jump over a removed stretch is a seek we asked for, not drift:
      // take it at once, cooldown or not.
      if (skips !== lastSkips.current) {
        lastSkips.current = skips;
        lastCorrection.current = now;
        v.currentTime = target;
        return;
      }
      if (v.seeking || now - lastCorrection.current < CORRECTION_COOLDOWN_MS) return;
      if (Math.abs(v.currentTime - target) > PLAYING_DRIFT_S) {
        lastCorrection.current = now;
        v.currentTime = target;
      }
    } else {
      if (!v.paused) v.pause();
      if (Math.abs(v.currentTime - target) > 1 / fps) v.currentTime = target;
    }
  }, [frame, playing, trim, fps, primed, skips]);

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
      <button
        className="angle-match"
        title="Match every other angle to this one"
        onClick={(e) => {
          e.stopPropagation();
          onMatchTo();
        }}
      >
        Match
      </button>
      {/* Otherwise a corrected angle looks exactly like an untouched one, and
          there is no way to tell what you have already changed. A grade that
          came from Match fits no preset, and says so. */}
      {(!isNeutral(grade) || !isUnframed(source.framing)) && (
        <span className="angle-graded">
          {[
            !isNeutral(grade) && (preset?.label.toLowerCase() ?? 'graded'),
            !isUnframed(source.framing) && 'framed',
          ]
            .filter(Boolean)
            .join(' · ')}
        </span>
      )}
      <div className="angle-grade" onClick={(e) => e.stopPropagation()}>
        <button className={isNeutral(grade) ? 'on' : ''} onClick={() => onGrade(null)}>
          None
        </button>
        {GRADE_PRESETS.map((p) => (
          <button
            key={p.id}
            className={preset?.id === p.id ? 'on' : ''}
            onClick={() => onGrade(p.grade)}
          >
            {p.label}
          </button>
        ))}
      </div>
    </div>
  );
}

// Wider than a long-GOP seek costs, so arriving from one correction does not
// immediately trigger the next.
const PLAYING_DRIFT_S = 0.5;
const CORRECTION_COOLDOWN_MS = 1000;

// out-4x5.mp4, out-9x16.mp4, out-16x9.mp4 — the render names its own shape.
function aspectOf(file: string): string {
  const m = /out-(\d+)x(\d+)/.exec(file);
  return m ? `${m[1]} / ${m[2]}` : '4 / 5';
}

// The program strip. Shots are laid out as the finished film runs, and each
// stretch you cut out stays on it as a thin hatched sliver — click one to put
// it back. Positions are in display units: film frames plus a fixed width
// per sliver.
function Timeline({
  timeline,
  program,
  cuts,
  marks,
  fps,
  frame,
  colorOf,
  onSeek,
  angles,
  onSwap,
  onDeleteCutAt,
  onRestore,
  onMoveCut,
  onDragStart,
}: {
  timeline: ReturnType<typeof buildTimeline>;
  program: ReturnType<typeof buildProgram>;
  cuts: Cut[];
  marks: { in: number | null; out: number | null };
  fps: number;
  frame: number;
  colorOf: (id: string) => string;
  onSeek: (frame: number, dir?: 1 | -1) => void;
  angles: string[];
  onSwap: (atFrame: number, sourceId: string) => void;
  onDeleteCutAt: (atFrame: number) => void;
  onRestore: (range: Range) => void;
  onMoveCut: (fromFrame: number, toFrame: number) => number | null;
  onDragStart: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const drag = useRef<
    | { type: 'scrub' }
    | { type: 'playhead'; startX: number; startDisp: number }
    | { type: 'cut'; atFrame: number }
    | null
  >(null);
  const duration = timeline.durationInFrames;
  const { removed } = program;

  // ---- synced-timeline frames <-> display units ----
  const sliver = Math.max(1, Math.round(program.durationInFrames * 0.012));
  const dispTotal = program.durationInFrames + removed.length * sliver;
  const toDisp = (f: number) => {
    let d = 0;
    let at = 0;
    for (const r of removed) {
      if (f < r.from) return d + (f - at);
      d += r.from - at;
      if (f < r.to) return d + ((f - r.from) / (r.to - r.from)) * sliver;
      d += sliver;
      at = r.to;
    }
    return d + (f - at);
  };
  const fromDisp = (d: number) => {
    let acc = 0;
    let at = 0;
    for (const r of removed) {
      if (d < acc + (r.from - at)) return at + (d - acc);
      acc += r.from - at;
      if (d < acc + sliver) return r.from + ((d - acc) / sliver) * (r.to - r.from);
      acc += sliver;
      at = r.to;
    }
    return at + (d - acc);
  };
  const pct = (d: number) => `${(d / dispTotal) * 100}%`;

  const clampFrame = (f: number) => Math.max(0, Math.min(duration - 1, Math.round(f)));
  const dispAt = (clientX: number) => {
    const r = ref.current!.getBoundingClientRect();
    return ((clientX - r.left) / r.width) * dispTotal;
  };
  const frameAt = (clientX: number) => clampFrame(fromDisp(dispAt(clientX)));

  // Grabbing the playhead or its clock drags from where you took hold, rather
  // than jumping the program to the pointer: the clock is clamped away from
  // the playhead near either end, so an absolute seek there would leap.
  const unitsPerPixel = () => dispTotal / (ref.current?.getBoundingClientRect().width || 1);

  const segmentOf = (f: number) =>
    timeline.segments.find((seg) => f >= seg.start && f < seg.start + seg.len) ?? timeline.segments[0];
  const playheadDisp = toDisp(frame);
  const markIn = marks.in !== null ? toDisp(marks.in) : null;
  const markOut = marks.out !== null ? toDisp(marks.out) : null;

  return (
    <div
      ref={ref}
      className="timeline"
      onPointerDown={(e) => {
        const target = e.target as HTMLElement;
        if (target.closest('.seg-swap, .sliver')) return;
        e.currentTarget.setPointerCapture(e.pointerId);
        const handle = target.closest('.cut-handle') as HTMLElement | null;
        if (handle) {
          drag.current = { type: 'cut', atFrame: Number(handle.dataset.frame) };
          onDragStart();
        } else if (target.closest('.playhead-grip, .playhead-time')) {
          drag.current = { type: 'playhead', startX: e.clientX, startDisp: playheadDisp };
        } else {
          drag.current = { type: 'scrub' };
          onSeek(frameAt(e.clientX));
        }
      }}
      onPointerMove={(e) => {
        if (!drag.current) return;
        if (drag.current.type === 'playhead') {
          const moved = (e.clientX - drag.current.startX) * unitsPerPixel();
          onSeek(clampFrame(fromDisp(drag.current.startDisp + moved)), moved < 0 ? -1 : 1);
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
      <div className="timeline-track">
        {program.pieces.map((piece) => {
          const seg = segmentOf(piece.src);
          const left = toDisp(piece.src);
          // The opening shot has nothing before it to take its place.
          const deletable = cuts.some((c) => c.atFrame === seg.start);
          return (
            <div
              key={`${piece.src}-${piece.sourceId}`}
              className={`seg${left > 0 ? ' joined' : ''}`}
              style={{
                left: pct(left),
                width: pct(piece.len),
                background: colorOf(piece.sourceId),
                color: textOn(colorOf(piece.sourceId)),
              }}
              title={`${piece.sourceId} @ ${formatFrame(programFrameOf(program.kept, piece.src), fps)}`}
            >
              <span className="seg-label">{piece.sourceId}</span>
              {/* Swap keeps the shot's start and end; × removes the shot and
                  the one before it runs on to fill the space. Every other cut
                  stays on its frame either way. */}
              <span className="seg-swap">
                {angles.map((id, n) =>
                  id === piece.sourceId ? null : (
                    <button
                      key={id}
                      style={{ background: colorOf(id), color: textOn(colorOf(id)) }}
                      title={`Show ${id} here instead (Shift+${n + 1})`}
                      onClick={() => onSwap(seg.start, id)}
                    >
                      {n + 1}
                    </button>
                  )
                )}
                {deletable && (
                  <button
                    className="seg-delete"
                    title="Remove this shot; the one before it fills the space"
                    onClick={() => onDeleteCutAt(seg.start)}
                  >
                    ×
                  </button>
                )}
              </span>
            </div>
          );
        })}
        {removed.map((r) => (
          <button
            key={r.from}
            className="sliver"
            style={{ left: pct(toDisp(r.from)), width: pct(sliver) }}
            title={`${formatFrame(r.to - r.from, fps)} cut out here. Click to put it back.`}
            onClick={() => onRestore(r)}
          />
        ))}
      </div>
      {markIn !== null && markOut !== null && markOut > markIn && (
        <div className="mark-range" style={{ left: pct(markIn), width: pct(markOut - markIn) }} />
      )}
      {markIn !== null && <div className="mark in" style={{ left: pct(markIn) }} />}
      {markOut !== null && <div className="mark out" style={{ left: pct(markOut) }} />}
      {[...cuts]
        .filter((c) => c.atFrame > 0 && c.atFrame < duration && !removedAt(removed, c.atFrame))
        .map((c) => (
          <div
            key={c.atFrame}
            className="cut-handle"
            data-frame={c.atFrame}
            style={{ left: pct(toDisp(c.atFrame)) }}
            title="Drag to move this cut"
          />
        ))}
      <div className="playhead" style={{ left: pct(playheadDisp) }}>
        <div className="playhead-grip" title="Drag to scrub" />
      </div>
      <div
        className="playhead-time"
        // Clamped so the label stays inside the track at either end.
        style={{ left: `${Math.min(96, Math.max(4, (playheadDisp / dispTotal) * 100))}%` }}
        title="Drag to scrub"
      >
        {formatFrame(programFrameOf(program.kept, frame), fps)}
      </div>
    </div>
  );
}

function formatFrame(f: number, fps: number) {
  const s = f / fps;
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.floor(s % 60)).padStart(2, '0')}.${String(Math.floor(f) % fps).padStart(2, '0')}`;
}
