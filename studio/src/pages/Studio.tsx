import QRCode from 'qrcode';
import { useCallback, useEffect, useRef, useState } from 'react';
import ControlView, { ControlActions } from '../components/ControlView';
import SpinePage from '../components/Spine';
import {
  fakeRequested,
  fakeStream,
  normalizeForRecording,
  openScreen,
  openWebcam,
} from '../lib/capture';
import {
  folderPermission,
  hasFolderAccess,
  loadRootFolder,
  opfsRequested,
  opfsRoot,
  pickRootFolder,
  requestFolderPermission,
} from '../lib/folder';
import { Hub } from '../lib/hub';
import { loadRig, rememberLocal } from '../lib/rig';
import { platformInfo } from '../lib/platform';
import type { HubSnapshot, SessionSummary } from '../lib/rtc-protocol';
import { stickyRoomCode } from '../lib/signal';

type Phase = 'folder' | 'starting' | 'running' | 'error';

// The Mac's studio page: picks the folder, runs the hub, and renders the
// same control surface an iPad gets.
export default function Studio() {
  const [phase, setPhase] = useState<Phase>('folder');
  const [error, setError] = useState<string | null>(null);
  const [needsPermission, setNeedsPermission] = useState<FileSystemDirectoryHandle | null>(null);
  const [state, setState] = useState<HubSnapshot | null>(null);
  const [streams, setStreams] = useState<Record<string, MediaStream>>({});
  const [webcamChoices, setWebcamChoices] = useState<MediaDeviceInfo[] | null>(null);
  const [showJoin, setShowJoin] = useState(false);
  const hubRef = useRef<Hub | null>(null);
  const platform = platformInfo();

  const [code] = useState(() => stickyRoomCode(new URLSearchParams(location.search).get('code')));

  // Keep the code in the URL as well as the tab's storage, so a reload or a
  // trip through the editor lands back in the same room either way.
  useEffect(() => {
    const url = new URL(location.href);
    if (url.searchParams.get('code') === code) return;
    url.searchParams.set('code', code);
    history.replaceState(null, '', url);
  }, [code]);

  useEffect(() => {
    if (opfsRequested()) {
      void opfsRoot().then((root) => void startHub(root));
      return;
    }
    if (!hasFolderAccess()) {
      setError('This browser can’t save recordings into a folder. Use Chrome, Edge, Brave or Arc.');
      setPhase('error');
      return;
    }
    void loadRootFolder().then(async (handle) => {
      if (!handle) return;
      const perm = await folderPermission(handle).catch(() => 'prompt' as PermissionState);
      if (perm === 'granted') void startHub(handle);
      else setNeedsPermission(handle);
    });
    return () => hubRef.current?.dispose();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Recording into a folder must survive the tab losing focus.
  useEffect(() => {
    if (phase !== 'running') return;
    let lock: WakeLockSentinel | null = null;
    const acquire = async () => {
      try {
        lock = (await navigator.wakeLock?.request('screen')) ?? null;
      } catch {
        // denied: the banner in the header covers it
      }
    };
    void acquire();
    const onVisible = () => {
      if (document.visibilityState === 'visible' && !lock) void acquire();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      void lock?.release().catch(() => {});
    };
  }, [phase]);

  const startHub = useCallback(
    async (root: FileSystemDirectoryHandle) => {
      setPhase('starting');
      const hub = new Hub(code, root);
      hubRef.current = hub;
      hub.onChange((snap, s) => {
        setState(snap);
        setStreams(s);
      });
      try {
        await hub.start();
        setPhase('running');
        void restoreRig(hub);
      } catch (err) {
        setError(`Could not open the studio room: ${(err as Error).message}`);
        setPhase('error');
      }
    },
    [code]
  );

  // Bring back the sources this machine was last shooting with. A webcam can
  // be reopened silently — permission is already granted and the deviceId is
  // stable. A screen cannot: getDisplayMedia needs a fresh gesture every time,
  // so a remembered screen waits for one click rather than reopening itself.
  const restoreRig = async (hub: Hub) => {
    if (fakeRequested()) return;
    for (const local of loadRig().locals) {
      if (local.kind !== 'local-webcam') continue;
      try {
        hub.addLocal('local-webcam', await openWebcam(local.deviceId), local.name);
      } catch {
        // unplugged, or permission withdrawn since: keep it remembered anyway
      }
    }
  };

  const pickFolder = async () => {
    try {
      const handle = await pickRootFolder();
      await startHub(handle);
    } catch (err) {
      if ((err as Error).name !== 'AbortError') setError((err as Error).message);
    }
  };

  const actions: ControlActions = {
    cut: (id) => hubRef.current?.cut(id),
    start: () => void hubRef.current?.startRecording(),
    stop: () => hubRef.current?.stopRecording(),
    remove: (id) => hubRef.current?.removeSource(id),
    cameraControl: (id, c) => hubRef.current?.cameraControl(id, c),
    setAuto: (on) => hubRef.current?.setAuto(on),
    rename: (sourceId, name) => hubRef.current?.renameSource(sourceId, name),
  };

  const addScreen = async () => {
    try {
      const raw = fakeRequested() ? fakeStream('screen', 1277, 713) : await openScreen();
      // Never record a raw screen capture: see normalizeForRecording.
      const normalized = await normalizeForRecording(raw);
      hubRef.current?.addLocal('local-screen', normalized.stream, 'screen', normalized.stop);
      rememberLocal({ kind: 'local-screen', name: 'screen' });
    } catch {
      // the user cancelled the picker
    }
  };

  // Device labels only appear after permission is granted, so open a
  // throwaway stream first, then enumerate.
  const listWebcams = async () => {
    try {
      const tmp = await navigator.mediaDevices.getUserMedia({ video: true });
      const devices = await navigator.mediaDevices.enumerateDevices();
      tmp.getTracks().forEach((t) => t.stop());
      const cams = devices.filter((d) => d.kind === 'videoinput');
      if (cams.length === 1) await addWebcam(cams[0]);
      else if (cams.length) setWebcamChoices(cams);
    } catch (err) {
      setError(`Could not list cameras: ${(err as Error).message}`);
    }
  };

  // "MacBook Pro Camera (0000:0001)" — the trailing hardware id is noise that
  // then has to be truncated in every label that shows it.
  const cameraName = (label?: string) =>
    (label ?? '').replace(/\s*\([0-9a-f]{4}:[0-9a-f]{4}\)\s*$/i, '').trim() || 'mac-cam';

  const addWebcam = async (device?: MediaDeviceInfo) => {
    setWebcamChoices(null);
    try {
      const stream = await openWebcam(device?.deviceId);
      const name = cameraName(device?.label);
      hubRef.current?.addLocal('local-webcam', stream, name);
      rememberLocal({
        kind: 'local-webcam',
        name,
        // From the track, not the picker: with a single camera there is no
        // picker and `device` is undefined.
        deviceId: stream.getVideoTracks()[0]?.getSettings().deviceId,
      });
    } catch (err) {
      setError(`Could not add camera: ${(err as Error).message}`);
    }
  };

  if (phase === 'error') {
    return (
      <SpinePage>
        <div className="edged verdict red">
          <h2>Can’t start the studio here.</h2>
          <p className="hint">{error}</p>
          <div className="actions">
            <button className="pill outline" onClick={() => (location.href = '/')}>
              Back
            </button>
          </div>
        </div>
      </SpinePage>
    );
  }

  if (phase === 'folder' || phase === 'starting') {
    return (
      <SpinePage>
        <span className="meta">Studio</span>
        <h1>Where should recordings go?</h1>
        <p className="lede">
          Pick a folder on {platform.label}. Every session gets its own subfolder, and the footage
          never leaves this machine. You are asked once.
        </p>
        <div className="actions-row" style={{ marginTop: 8 }}>
          {needsPermission ? (
            <>
              <button
                className="pill solid"
                onClick={async () => {
                  if (await requestFolderPermission(needsPermission)) {
                    setNeedsPermission(null);
                    await startHub(needsPermission);
                  }
                }}
              >
                Use “{needsPermission.name}” again
              </button>
              <button className="pill outline" onClick={() => void pickFolder()}>
                Choose a different folder
              </button>
            </>
          ) : (
            <button
              className="pill solid"
              disabled={phase === 'starting'}
              onClick={() => void pickFolder()}
            >
              {phase === 'starting' ? 'Starting…' : 'Choose folder'}
            </button>
          )}
        </div>
        {error && <p className="hint">{error}</p>}
      </SpinePage>
    );
  }

  if (!state) return null;

  return (
    <>
      <ControlView
        state={state}
        streams={streams}
        actions={actions}
        onAdd={() => setShowJoin(true)}
        meta={<span className="meta">{state.folder}</span>}
        extras={
          <div className="cell add">
            <button className="pill ghost" onClick={() => setShowJoin(true)}>
              + iPhone / iPad
            </button>
            {webcamChoices ? (
              <>
                {webcamChoices.map((d, i) => (
                  <button key={d.deviceId || i} className="pill ghost" onClick={() => void addWebcam(d)}>
                    {d.label || `Camera ${i + 1}`}
                  </button>
                ))}
                <button className="pill ghost" onClick={() => setWebcamChoices(null)}>
                  Cancel
                </button>
              </>
            ) : (
              <>
                <button className="pill ghost" onClick={() => void addScreen()}>
                  + this screen
                </button>
                <button className="pill ghost" onClick={() => void listWebcams()}>
                  + this webcam
                </button>
              </>
            )}
          </div>
        }
        footer={<LastTake sessions={state.sessions} />}
      />

      {showJoin && <JoinOverlay state={state} onClose={() => setShowJoin(false)} />}
      {error && <div className="toast">{error}</div>}
      {state.toast && <div className="toast">{state.toast}</div>}
    </>
  );
}

// While shooting, the only recording worth screen space is the one just made.
// The full archive is the session picker at /edit, so this is a line and a
// link rather than a table that grew to a third of the producer.
function LastTake({ sessions }: { sessions: SessionSummary[] }) {
  const last = sessions[0];
  if (!last) {
    return (
      <section className="recordings">
        <span className="meta">No recordings yet — hit REC</span>
      </section>
    );
  }
  const failed = last.sources.filter((x) => x.error);
  return (
    <section className="recordings">
      <span className="meta">Last take</span>
      <strong>{last.id}</strong>
      <span className="meta">
        {last.sources
          .map((x) => `${x.id}${x.duration ? ` ${x.duration.toFixed(0)} s` : ''}`)
          .join(' · ')}
      </span>
      {failed.length > 0 && (
        <span className="meta problem">
          {failed.length} source{failed.length === 1 ? '' : 's'} failed
        </span>
      )}
      <span className="spacer" />
      <a href={`/edit?session=${last.id}`}>
        <button className="pill ghost small">Edit</button>
      </a>
      <a href="/edit">
        <button className="pill ghost small">
          All {sessions.length} recording{sessions.length === 1 ? '' : 's'}
        </button>
      </a>
    </section>
  );
}

// One QR for both roles: a phone opens it as a camera, an iPad can switch to
// the remote control from that same page.
function JoinOverlay({ state, onClose }: { state: HubSnapshot; onClose: () => void }) {
  const [qr, setQr] = useState('');
  useEffect(() => {
    QRCode.toDataURL(state.joinUrl, { margin: 1, width: 480 }).then(setQr).catch(() => {});
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [state.joinUrl, onClose]);

  return (
    <div className="overlay" onClick={onClose}>
      <div className="join-panel" onClick={(e) => e.stopPropagation()}>
        <div className="join-col">
          <h2>Add a camera</h2>
          {qr && <img className="join-qr" src={qr} alt={`QR code for ${state.joinUrl}`} />}
          <span className="check-code">{state.code}</span>
          <span className="join-url">{state.joinUrl.replace(/^https?:\/\//, '')}</span>
          <span className="hint">
            Scan with the phone’s camera app. Any phone or tablet on this WiFi can join, and an
            iPad can take over as the remote control from the same page.
          </span>
        </div>
        <button className="join-x" onClick={onClose}>
          ✕
        </button>
      </div>
    </div>
  );
}
