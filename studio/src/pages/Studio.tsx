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
import { platformInfo } from '../lib/platform';
import type { HubSnapshot } from '../lib/rtc-protocol';
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
      } catch (err) {
        setError(`Could not open the studio room: ${(err as Error).message}`);
        setPhase('error');
      }
    },
    [code]
  );

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
  };

  const addScreen = async () => {
    try {
      const raw = fakeRequested() ? fakeStream('screen', 1277, 713) : await openScreen();
      // Never record a raw screen capture: see normalizeForRecording.
      const normalized = await normalizeForRecording(raw);
      hubRef.current?.addLocal('local-screen', normalized.stream, 'screen', normalized.stop);
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

  const addWebcam = async (device?: MediaDeviceInfo) => {
    setWebcamChoices(null);
    try {
      const stream = await openWebcam(device?.deviceId);
      hubRef.current?.addLocal('local-webcam', stream, device?.label || 'mac-cam');
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
        footer={
          <section className="recordings">
            <div className="recordings-title">Recordings</div>
            {state.sessions.length === 0 && <span className="meta">none yet — hit REC</span>}
            {state.sessions.map((s) => (
              <div className="session-row" key={s.id}>
                <strong>{s.id}</strong>
                <span className="meta">
                  {s.sources
                    .map((x) => `${x.id}${x.duration ? ` ${x.duration.toFixed(0)} s` : ''}`)
                    .join(' · ')}
                </span>
                {s.sources
                  .filter((x) => x.error)
                  .map((x) => (
                    <span key={x.id} className="meta problem">
                      {x.id}: {x.error}
                    </span>
                  ))}
                <span className="spacer" />
                <a href={`/edit?session=${s.id}`}>
                  <button className="pill ghost small">Edit</button>
                </a>
              </div>
            ))}
          </section>
        }
      />

      {showJoin && <JoinOverlay state={state} onClose={() => setShowJoin(false)} />}
      {error && <div className="toast">{error}</div>}
      {state.toast && <div className="toast">{state.toast}</div>}
    </>
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
