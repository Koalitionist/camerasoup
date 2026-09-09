import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type { HubSnapshot, SnapshotCamera } from '../lib/rtc-protocol';
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
}

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

  // 1..9 drives the program: during a recording it cuts the show live.
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

  const cell = (cam: SnapshotCamera, big: boolean) => (
    <Cell
      key={big ? '__program' : cam.id}
      cam={cam}
      big={big}
      color={colorForKey(cam.keyNumber)}
      stream={streams[cam.id] ?? null}
      canRemove={!recording && !big}
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
    <div className="rail-page">
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
          <div className="rail-add" onClick={onAdd} title="Add a camera">
            +
          </div>
        )}
      </div>

      <div className="rail-main">
        <header className="studio-header">
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
          <span className="spacer" />
          {cameras.length > 1 && (
            <button
              className={`pill ghost small auto-toggle${state.auto === 'on' ? ' on' : ''}`}
              disabled={state.auto === 'loading'}
              title="Cut to whichever camera the subject is facing. A manual switch pauses it for ten seconds."
              onClick={() => actions.setAuto(state.auto !== 'on')}
            >
              {state.auto === 'loading' ? 'auto…' : 'auto'}
            </button>
          )}
          {recording && <RecTimer startedAt={recording.startedAt} />}
          {finalizing ? (
            <span className="meta">saving {finalizing}…</span>
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
          className="mosaic"
          style={{
            gridTemplateColumns: `2fr repeat(${cols}, 1fr)`,
            gridTemplateRows: `repeat(${rows}, 1fr)`,
            gridAutoFlow: 'column',
          }}
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

export function RecTimer({ startedAt }: { startedAt: number }) {
  const [, force] = useState(0);
  useEffect(() => {
    const t = window.setInterval(() => force((n) => n + 1), 500);
    return () => window.clearInterval(t);
  }, []);
  const s = Math.max(0, (Date.now() - startedAt) / 1000);
  return (
    <span className="rec-timer">
      {String(Math.floor(s / 60)).padStart(2, '0')}:{String(Math.floor(s % 60)).padStart(2, '0')}
    </span>
  );
}

function Cell({
  cam,
  big,
  color,
  stream,
  canRemove,
  onClick,
  onRemove,
  onControl,
  renaming,
  onRenameStart,
  onRenameEnd,
}: {
  cam: SnapshotCamera;
  big: boolean;
  color: string;
  stream: MediaStream | null;
  canRemove: boolean;
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

  const buffering = cam.pendingBytes > 4 * 1024 * 1024;
  const className = [
    'cell',
    big && 'big',
    // A camera fills its cell and is cropped a little; a screen is shown
    // whole, because its edges carry content a crop would eat.
    cam.kind === 'local-screen' && 'contain',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div
      className={className}
      style={big ? { gridColumn: 1, outline: `4px solid ${color}`, outlineOffset: -4 } : undefined}
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
          <div className="frame f45">
            <span className="mono">4:5</span>
          </div>
          <div className="frame f916">
            <span className="mono">9:16</span>
          </div>
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
