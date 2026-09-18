import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type { Framing, HubSnapshot, SnapshotCamera } from '../lib/rtc-protocol';
import { colorForKey, textOn } from '../lib/theme';

// The control surface: the camera spines, the mosaic, the REC button, the
// hotkeys. Rendered identically from the hub's own state (the Mac's page)
// and from state received over a data channel (an iPad). It never touches
// the hub directly — every action goes through `on`, so the remote and local
// paths are the same code.
export interface ControlActions {
  cut(sourceId: string): void;
  start(): void;
  stop(): void;
  remove(sourceId: string): void;
  cameraControl(sourceId: string, c: { zoom?: number; torch?: boolean; lock?: boolean }): void;
  setAuto(on: boolean): void;
  rename(sourceId: string, name: string): void;
  setFraming(framing: Framing): void;
}

// The program column's share of the wide mosaic: `2fr` in the grid below,
// and the same 2 in the test that decides whether the wide mosaic is usable
// at all. One number, or the two disagree.
const PROGRAM_FR = 2;

// The shape the program monitor takes. A camera is framed for the render —
// 4:5, or 16:9 for the landscape cut — because what ships is a crop of it.
// A screen is shown whole, so it gets its own shape: a portrait display is
// not a 16:9 one, and squeezed into that box it is a sliver with black
// either side. `measured` is the source's real ratio once a frame has
// arrived; 16:9 is only the guess that holds until then.
const programAspect = (cam: SnapshotCamera | null, framing: Framing, measured?: number) => {
  if (cam?.kind === 'local-screen') return measured ?? 16 / 9;
  return framing === 'landscape' ? 16 / 9 : 4 / 5;
};

export default function ControlView({
  state,
  streams,
  actions,
  meta,
  extras,
  onAdd,
  footer,
}: {
  state: HubSnapshot;
  streams: Record<string, MediaStream>;
  actions: ControlActions;
  meta?: ReactNode;
  extras?: ReactNode; // the "add a source" cell, on the Mac only
  onAdd?: () => void; // the rail's + cell, on the Mac only
  footer?: ReactNode; // the recordings strip, on the Mac only
}) {
  const { cameras, recording, finalizing } = state;
  const [renaming, setRenaming] = useState<string | null>(null);
  const live = !!recording && !finalizing;
  const order = cameras.map((c) => c.id);

  // 1..9 drives the program: during a recording it cuts the show live. While
  // a take is being written the hub refuses the cut, so this stays as it is
  // — the lock belongs to the thing that owns the take, not to the keyboard.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'SELECT') return;
      const idx = parseInt(e.key, 10);
      if (idx >= 1 && idx <= order.length) actions.cut(order[idx - 1]);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [order.join(','), actions]);

  // How many cameras have not finished handing their footage over. This is
  // the whole of the wait, so it is worth naming rather than spinning at.
  const flushing = cameras.reduce((n, c) => n + (c.state === 'flushing' ? 1 : 0), 0);
  const programId = state.program ?? order[0] ?? null;
  const program = cameras.find((c) => c.id === programId) ?? null;
  const onlineCount = cameras.filter((c) => c.online).length;

  // The program cell is one wide column spanning every row; the rest of the
  // cameras and the add cell fill the columns beside it. Whatever is on air
  // is shown there and only there — a second, dimmed copy of it in the grid
  // spent a whole cell restating what the big cell's outline already says.
  const others = cameras.filter((c) => c.id !== programId);
  const slots = others.length + (extras ? 1 : 0);
  const rows = slots <= 4 ? 2 : slots <= 6 ? 3 : 4;
  const cols = Math.max(1, Math.ceil(slots / rows));

  // In a window taller than it is wide, a program column spanning every row
  // is a slit: the 4:5 crop is wider than the cell, and the face inside it is
  // cropped to a sliver. So when the column would come out narrower than the
  // tallest thing that ships (9:16), the mosaic stacks instead — program
  // across the top at the shape it is framing for, the rest in a strip
  // beneath it. The test is the mosaic's own box, not the window's: the rail,
  // the header and the recordings strip all take their cut first.
  const mosaic = useRef<HTMLElement>(null);
  const [box, setBox] = useState({ w: 0, h: 0, gap: 0 });
  useLayoutEffect(() => {
    const el = mosaic.current;
    if (!el) return;
    const observer = new ResizeObserver(() => {
      const w = el.clientWidth;
      const h = el.clientHeight;
      // The gap is read rather than repeated: the stylesheet owns it, and a
      // copy here would go quietly wrong the day someone edits it there.
      const gap = parseFloat(getComputedStyle(el).columnGap) || 0;
      setBox((old) => (old.w === w && old.h === h && old.gap === gap ? old : { w, h, gap }));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const stacked =
    box.h > 0 && (box.w * PROGRAM_FR) / (PROGRAM_FR + cols) < box.h * (9 / 16);

  // The shape of the picture a screen share is actually sending. Only a
  // screen is measured, because it is the only source shown whole — a camera
  // is framed for the render whatever its sensor does.
  const [screenAspect, setScreenAspect] = useState<Record<string, number>>({});
  const noteAspect = useCallback((id: string, ratio: number) => {
    setScreenAspect((all) =>
      Math.abs((all[id] ?? 0) - ratio) < 0.001 ? all : { ...all, [id]: ratio }
    );
  }, []);

  // Stacked, the strip is one row of 4:3 thumbnails and the program takes the
  // height that is left — but never more than its own shape needs, or it
  // would just crop the source harder. The arithmetic lives here rather than
  // in the stylesheet because a cell sized from its aspect ratio cannot also
  // be centered by the grid: asking for both leaves it no width at all.
  const scols = slots <= 4 ? Math.max(1, slots) : Math.ceil(slots / 2);
  const aspect = programAspect(program, state.framing, program ? screenAspect[program.id] : undefined);
  const stripH = stacked && slots ? ((box.w - box.gap * (scols - 1)) / scols) * (3 / 4) : 0;
  const programW = stacked
    ? Math.min(box.w, Math.max(0, box.h - (stripH ? stripH + box.gap : 0)) * aspect)
    : 0;

  const cell = (cam: SnapshotCamera, big: boolean) => (
    <Cell
      key={big ? '__program' : cam.id}
      cam={cam}
      big={big}
      stackedWidth={big && stacked ? programW : null}
      aspect={aspect}
      onMedia={noteAspect}
      color={colorForKey(cam.keyNumber)}
      stream={streams[cam.id] ?? null}
      canRemove={!recording && !finalizing && !big}
      framing={state.framing}
      onClick={() => actions.cut(cam.id)}
      onRemove={() => actions.remove(cam.id)}
      onControl={(c) => actions.cameraControl(cam.id, c)}
      renaming={renaming === cam.id}
      onRenameStart={() => setRenaming(cam.id)}
      onRenameEnd={(name) => {
        setRenaming(null);
        if (name !== undefined) actions.rename(cam.id, name);
      }}
    />
  );

  return (
    <div className={`rail-page${finalizing ? ' saving-take' : ''}`}>
      <div className="rail">
        <div className="rail-head">
          <span>camerasoup</span>
        </div>
        {cameras.map((cam) => (
          <CamSpine
            key={cam.id}
            cam={cam}
            color={colorForKey(cam.keyNumber)}
            onCut={() => actions.cut(cam.id)}
            onRename={() => setRenaming(cam.id)}
          />
        ))}
        {onAdd && (
          <div
            className={`rail-add${finalizing ? ' locked' : ''}`}
            onClick={onAdd}
            title={finalizing ? 'Wait for the take to save' : 'Add a camera'}
          >
            +
          </div>
        )}
      </div>

      <div className="rail-main">
        <header className="studio-header">
          {/* On a phone there is no room for the folder, the count and the
              hotkey hint next to the one control that has to be reachable,
              so the lot of them step aside together (see .head-aside). */}
          <span className="head-aside">
            {meta}
            <span className="meta">
              {onlineCount} source{onlineCount === 1 ? '' : 's'}
            </span>
            {live && cameras.length > 1 && (
              <span className="meta">
                {state.auto === 'on'
                  ? 'auto — the camera you face goes on air'
                  : `1–${cameras.length} switches the live camera`}
              </span>
            )}
          </span>
          <span className="spacer" />
          <button
            className="pill ghost small"
            disabled={!!finalizing}
            title="What the program monitor frames for: the social crops, or 16:9"
            onClick={() => actions.setFraming(state.framing === 'social' ? 'landscape' : 'social')}
          >
            {state.framing === 'landscape' ? '16:9' : '4:5 · 9:16'}
          </button>
          {cameras.length > 1 && (
            <button
              className={`pill ghost small auto-toggle${state.auto === 'on' ? ' on' : ''}`}
              disabled={state.auto === 'loading' || !!finalizing}
              title="Cut to whichever camera the subject is facing. A manual switch pauses it for ten seconds."
              onClick={() => actions.setAuto(state.auto !== 'on')}
            >
              {state.auto === 'loading' ? 'auto…' : 'auto'}
            </button>
          )}
          {recording && (
            <RecTimer startedAt={recording.startedAt} stoppedAt={recording.stoppedAt} />
          )}
          {finalizing ? (
            <span className="saving">
              <span className="dot rec" />
              saving{flushing ? ` — ${flushing} still flushing` : '…'}
            </span>
          ) : recording ? (
            <button className="rec-button stop" onClick={actions.stop}>
              ■ Stop
            </button>
          ) : (
            <button className="rec-button" disabled={onlineCount === 0} onClick={actions.start}>
              ● REC
            </button>
          )}
        </header>

        <main
          ref={mosaic}
          className={`mosaic${stacked ? ' stacked' : ''}`}
          style={
            stacked
              ? {
                  gridTemplateColumns: `repeat(${scols}, minmax(0, 1fr))`,
                  gridTemplateRows: 'minmax(0, 1fr)',
                  gridAutoRows: `${stripH}px`,
                  gridAutoFlow: 'row',
                }
              : {
                  gridTemplateColumns: `${PROGRAM_FR}fr repeat(${cols}, 1fr)`,
                  gridTemplateRows: `repeat(${rows}, 1fr)`,
                  gridAutoFlow: 'column',
                }
          }
        >
          {program && cell(program, true)}
          {others.map((c) => cell(c, false))}
          {extras}
        </main>

        {footer}
      </div>
    </div>
  );
}

// The spine's type is set to the spine, not the other way round: the number is
// the hotkey and holds its size, and the name is scaled to whatever room is
// left. One measurement gives the ratio, so there is no fitting loop.
const MIN_NAME_PX = 13;

function CamSpine({
  cam,
  color,
  onCut,
  onRename,
}: {
  cam: SnapshotCamera;
  color: string;
  onCut: () => void;
  onRename: () => void;
}) {
  const label = useRef<HTMLDivElement>(null);
  const num = useRef<HTMLSpanElement>(null);
  const name = useRef<HTMLSpanElement>(null);

  useLayoutEffect(() => {
    const [box, hotkey, text] = [label.current, num.current, name.current];
    if (!box || !hotkey || !text) return;
    const fit = () => {
      text.style.fontSize = '';
      // Vertical writing mode: a run of text measures along the box's height.
      const room = box.clientHeight;
      const taken = hotkey.getBoundingClientRect().height;
      const needed = text.getBoundingClientRect().height;
      if (!needed || taken + needed <= room) return;
      const base = parseFloat(getComputedStyle(text).fontSize);
      text.style.fontSize = `${Math.max(MIN_NAME_PX, (base * (room - taken)) / needed)}px`;
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(box);
    return () => observer.disconnect();
  }, [cam.name, cam.keyNumber]);

  return (
    <div
      className={`cam-spine${cam.online ? '' : ' offline'}`}
      style={{ background: color }}
      onClick={onCut}
      onDoubleClick={onRename}
      title={`${cam.name} — double-click to rename`}
    >
      <div className="cam-spine-label" ref={label} style={{ color: textOn(color) }}>
        <span className="num" ref={num}>
          {cam.keyNumber}
        </span>
        <span className="name" ref={name}>
          &nbsp;{cam.name}
        </span>
      </div>
    </div>
  );
}

// Counts while the camera rolls and stops where it stopped: once Stop is
// pressed the number is the take's length, and a clock that keeps climbing
// through the save is timing the disk, not the film.
export function RecTimer({ startedAt, stoppedAt }: { startedAt: number; stoppedAt?: number | null }) {
  const [, force] = useState(0);
  useEffect(() => {
    if (stoppedAt) return;
    const t = window.setInterval(() => force((n) => n + 1), 500);
    return () => window.clearInterval(t);
  }, [stoppedAt]);
  const s = Math.max(0, ((stoppedAt ?? Date.now()) - startedAt) / 1000);
  return (
    <span className={`rec-timer${stoppedAt ? ' done' : ''}`}>
      {String(Math.floor(s / 60)).padStart(2, '0')}:{String(Math.floor(s % 60)).padStart(2, '0')}
    </span>
  );
}

function Cell({
  cam,
  big,
  stackedWidth,
  aspect,
  onMedia,
  color,
  stream,
  canRemove,
  framing,
  onClick,
  onRemove,
  onControl,
  renaming,
  onRenameStart,
  onRenameEnd,
}: {
  cam: SnapshotCamera;
  big: boolean;
  stackedWidth: number | null; // set only on a stacked program cell
  aspect: number; // the shape the program is drawn at, resolved by the parent
  onMedia: (id: string, ratio: number) => void;
  color: string;
  stream: MediaStream | null;
  canRemove: boolean;
  framing: Framing;
  onClick: () => void;
  onRemove: () => void;
  onControl: (c: { zoom?: number; torch?: boolean; lock?: boolean }) => void;
  renaming: boolean;
  onRenameStart: () => void;
  onRenameEnd: (name?: string) => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const el = videoRef.current;
    if (!el) return;
    if (el.srcObject !== stream) el.srcObject = stream;
    if (stream) void el.play().catch(() => {});
  }, [stream]);

  // A screen's own shape, reported up to whoever is laying the page out: it
  // arrives with the first frame and changes again whenever a shared window
  // is resized mid-take, so `loadedmetadata` alone is not enough. A camera
  // is not measured — it is framed for the render, not for its sensor.
  useEffect(() => {
    const el = videoRef.current;
    if (!el || cam.kind !== 'local-screen') return;
    const report = () => {
      if (!el.videoWidth || !el.videoHeight) return;
      const quarter = Math.abs(cam.rotation ?? 0) % 180 === 90;
      onMedia(cam.id, quarter ? el.videoHeight / el.videoWidth : el.videoWidth / el.videoHeight);
    };
    report();
    el.addEventListener('loadedmetadata', report);
    el.addEventListener('resize', report);
    return () => {
      el.removeEventListener('loadedmetadata', report);
      el.removeEventListener('resize', report);
    };
  }, [stream, cam.id, cam.kind, cam.rotation, onMedia]);

  const buffering = cam.pendingBytes > 4 * 1024 * 1024;
  const className = [
    'cell',
    big && 'big',
    // A camera fills its cell and is cropped a little; a screen is shown
    // whole, because its edges carry content a crop would eat. So is the
    // program when framing for landscape, which is wider than the cell —
    // cropping it would hide the very material that ships.
    (cam.kind === 'local-screen' || (big && framing === 'landscape')) && 'contain',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div
      className={className}
      style={
        big
          ? {
              gridColumn: 1,
              outline: `4px solid ${color}`,
              outlineOffset: -4,
              // Stacked, the parent has measured the room and the shape:
              // the cell spans the strip's columns and sits in the middle.
              ...(stackedWidth !== null && {
                gridColumn: '1 / -1',
                gridRow: 1,
                width: stackedWidth,
                aspectRatio: aspect,
              }),
            }
          : undefined
      }
      onClick={onClick}
    >
      <video
        ref={videoRef}
        muted
        playsInline
        style={cam.rotation ? { transform: `rotate(${cam.rotation}deg)` } : undefined}
      />
      {!stream && <div className="nosignal">{cam.online ? 'connecting…' : 'offline'}</div>}
      {/* The renders are 1080×1350 and 1080×1920, but the monitor is
          landscape: without these you frame a shot that never ships. A
          letterboxed screen share is already whole, so it gets none. */}
      {big && stream && cam.kind !== 'local-screen' && (
        <div className="framing" aria-hidden="true">
          {framing === 'landscape' ? (
            <div className="frame f169">
              <span className="mono">16:9</span>
            </div>
          ) : (
            <>
              <div className="frame f45">
                <span className="mono">4:5</span>
              </div>
              <div className="frame f916">
                <span className="mono">9:16</span>
              </div>
            </>
          )}
        </div>
      )}
      {renaming ? (
        <input
          className="tag tag-input"
          style={{ background: color, color: textOn(color) }}
          defaultValue={cam.name}
          autoFocus
          maxLength={40}
          onClick={(e) => e.stopPropagation()}
          onFocus={(e) => e.currentTarget.select()}
          onBlur={(e) => onRenameEnd(e.currentTarget.value)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === 'Enter') e.currentTarget.blur();
            if (e.key === 'Escape') onRenameEnd();
          }}
        />
      ) : (
        <span
          className="tag"
          style={{ background: color, color: textOn(color) }}
          title="Double-click to rename this angle"
          onDoubleClick={(e) => {
            e.stopPropagation();
            onRenameStart();
          }}
        >
          {cam.keyNumber} {cam.name}
        </span>
      )}
      <span
        className={`cell-status dot ${cam.state === 'recording' ? 'rec' : cam.online ? 'on' : ''}`}
      />
      {buffering && (
        <div className="cell-badge">buffering {(cam.pendingBytes / 1e6).toFixed(0)} MB</div>
      )}
      {cam.state === 'interrupted' && <div className="cell-badge warn">interrupted</div>}
      {canRemove && (
        <button
          className="cell-x"
          title="Remove this camera"
          onClick={(e) => {
            e.stopPropagation();
            onRemove();
          }}
        >
          ✕
        </button>
      )}
      {cam.online && (cam.caps?.zoom || cam.caps?.torch || cam.caps?.lock) && (
        <div className="cell-controls" onClick={(e) => e.stopPropagation()}>
          {cam.caps.zoom && (
            <>
              <span>×{(cam.zoom ?? cam.caps.zoom.value).toFixed(1)}</span>
              <input
                type="range"
                min={cam.caps.zoom.min}
                max={cam.caps.zoom.max}
                step={cam.caps.zoom.step}
                value={cam.zoom ?? cam.caps.zoom.value}
                onChange={(e) => onControl({ zoom: Number(e.target.value) })}
              />
            </>
          )}
          {cam.caps.torch && (
            <button
              style={cam.torch ? { color: color } : undefined}
              onClick={() => onControl({ torch: !cam.torch })}
            >
              Torch
            </button>
          )}
          {cam.caps.lock && (
            <button
              style={cam.lock ? { color: color } : undefined}
              title="Hold this camera's white balance and exposure, so it cannot re-decide mid-take"
              onClick={() => onControl({ lock: !cam.lock })}
            >
              {cam.lock ? 'Locked' : 'Lock'}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
