import { useEffect, useRef, useState } from 'react';
import type { HubSnapshot, SnapshotCamera } from '../lib/rtc-protocol';

// The control surface: the mosaic, the REC button, the hotkeys. Rendered
// identically from the hub's own state (the Mac's page) and from state
// received over a data channel (an iPad). It never touches the hub directly
// — every action goes through `on`, so the remote and local paths are the
// same code.
export interface ControlActions {
  cut(sourceId: string): void;
  start(): void;
  stop(): void;
  remove(sourceId: string): void;
  cameraControl(sourceId: string, c: { zoom?: number; torch?: boolean }): void;
}

const CELL_COLORS = ['#5b9dff', '#3dd68c', '#f5a623', '#e5484d', '#b98aff', '#4dd0e1'];

function textOn(hex: string): string {
  const n = parseInt(hex.slice(1), 16);
  const lum = 0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255);
  return lum > 150 ? '#0d0f12' : '#ffffff';
}

const GRID_CONFIGS: Array<[number, number]> = [
  [3, 2],
  [4, 2],
  [3, 3],
  [4, 3],
  [5, 3],
  [4, 4],
];

export default function ControlView({
  state,
  streams,
  actions,
  extras,
  header,
}: {
  state: HubSnapshot;
  streams: Record<string, MediaStream>;
  actions: ControlActions;
  extras?: React.ReactNode; // the "add a source" cell, on the Mac only
  header?: React.ReactNode; // role-specific header items
}) {
  const { cameras, recording, finalizing } = state;
  const live = !!recording && !finalizing;
  const order = cameras.map((c) => c.id);

  // 1..9 drives the program: during a recording it cuts the show live.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.tagName === 'INPUT') return;
      const idx = parseInt(e.key, 10);
      if (idx >= 1 && idx <= order.length) actions.cut(order[idx - 1]);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [order.join(','), actions]);

  const programId = state.program ?? order[0] ?? null;
  const program = cameras.find((c) => c.id === programId) ?? null;
  const extraCells = cameras.length + (extras ? 1 : 0);
  const [cols, rows] = GRID_CONFIGS.find(([c, r]) => c * r - 4 >= extraCells) ?? [5, 4];
  const onlineCount = cameras.filter((c) => c.online).length;

  const cell = (cam: SnapshotCamera, big: boolean) => (
    <Cell
      key={big ? '__program' : cam.id}
      cam={cam}
      big={big}
      color={CELL_COLORS[(cam.keyNumber - 1) % CELL_COLORS.length]}
      stream={streams[cam.id] ?? null}
      onAir={!big && programId === cam.id}
      live={live && state.program === cam.id}
      canRemove={!recording && !big}
      onClick={() => actions.cut(cam.id)}
      onRemove={() => actions.remove(cam.id)}
      onControl={(c) => actions.cameraControl(cam.id, c)}
    />
  );

  return (
    <>
      <header className="producer-header">
        {header}
        <span className="kind">
          {onlineCount} source{onlineCount === 1 ? '' : 's'}
        </span>
        <span className="spacer" />
        {live && cameras.length > 1 && (
          <span className="kind">1–{cameras.length} switches the live camera</span>
        )}
        {recording && <RecTimer startedAt={recording.startedAt} />}
        {finalizing ? (
          <span className="kind">saving {finalizing}…</span>
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
          gridTemplateColumns: `repeat(${cols}, 1fr)`,
          gridTemplateRows: `repeat(${rows}, 1fr)`,
          gridAutoFlow: 'row dense',
        }}
      >
        {program && cell(program, true)}
        {cameras.map((c) => cell(c, false))}
        {extras}
      </main>
    </>
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
      {Math.floor(s / 60)}:{String(Math.floor(s % 60)).padStart(2, '0')}
    </span>
  );
}

function Cell({
  cam,
  big,
  color,
  stream,
  onAir,
  live,
  canRemove,
  onClick,
  onRemove,
  onControl,
}: {
  cam: SnapshotCamera;
  big: boolean;
  color: string;
  stream: MediaStream | null;
  onAir: boolean;
  live: boolean;
  canRemove: boolean;
  onClick: () => void;
  onRemove: () => void;
  onControl: (c: { zoom?: number; torch?: boolean }) => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const el = videoRef.current;
    if (!el) return;
    if (el.srcObject !== stream) el.srcObject = stream;
    if (stream) void el.play().catch(() => {});
  }, [stream]);

  const buffering = cam.pendingBytes > 4 * 1024 * 1024;
  return (
    <div
      className={[
        'cell',
        big && 'big',
        live && 'live',
        onAir && 'onair',
        // A camera fills its cell and is cropped a little; a screen is shown
        // whole, because its edges carry content a crop would eat.
        cam.kind === 'local-screen' && 'contain',
      ]
        .filter(Boolean)
        .join(' ')}
      style={big ? { gridColumn: '1 / 3', gridRow: '1 / 3' } : undefined}
      onClick={onClick}
    >
      <video
        ref={videoRef}
        muted
        playsInline
        style={cam.rotation ? { transform: `rotate(${cam.rotation}deg)` } : undefined}
      />
      {!stream && <div className="nosignal">{cam.online ? 'connecting…' : 'offline'}</div>}
      <div
        className="sticky"
        style={{ background: live ? 'var(--rec)' : color, color: live ? '#fff' : textOn(color) }}
      >
        <span className="num">{cam.keyNumber}</span>
        <span className="nm">{cam.name}</span>
      </div>
      <span className={`cell-status dot ${cam.state === 'recording' ? 'rec' : cam.online ? 'on' : ''}`} />
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
      {cam.online && cam.caps?.zoom && (
        <div className="cell-controls" onClick={(e) => e.stopPropagation()}>
          <span className="kind">×{(cam.zoom ?? cam.caps.zoom.value).toFixed(1)}</span>
          <input
            type="range"
            min={cam.caps.zoom.min}
            max={cam.caps.zoom.max}
            step={cam.caps.zoom.step}
            value={cam.zoom ?? cam.caps.zoom.value}
            onChange={(e) => onControl({ zoom: Number(e.target.value) })}
          />
          {cam.caps.torch && (
            <button
              style={cam.torch ? { borderColor: 'var(--accent)' } : undefined}
              onClick={() => onControl({ torch: !cam.torch })}
            >
              Torch
            </button>
          )}
        </div>
      )}
    </div>
  );
}
