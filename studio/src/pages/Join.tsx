import { useEffect, useRef, useState } from 'react';
import VerdictCard from '../components/VerdictCard';
import { PhoneCaps, phoneCapabilities } from '../lib/capabilities';
import { CameraClient, CameraEvents } from '../lib/camera-client';
import { openCamera } from '../lib/capture';
import { CheckReport, onControl, sendControl, serveCheck } from '../lib/check';
import { SignalledPeer, iceServers, waitConnected, waitOpen } from '../lib/peer';
import { platformInfo } from '../lib/platform';
import { Signal } from '../lib/signal';
import RemoteControl from './RemoteControl';

type Mode = 'choose' | 'camera' | 'control' | 'check';

const NAME_KEY = 'camerasoup.cameraName';
const QUALITY_KEY = 'camerasoup.cameraQuality';
const SUGGESTIONS = ['topdown', 'face', 'action', 'side'];
const QUALITIES = [
  { key: 'high', label: 'High · 10 Mbps', bps: 10_000_000 },
  { key: 'medium', label: 'Medium · 6 Mbps', bps: 6_000_000 },
  { key: 'low', label: 'Low · 3 Mbps', bps: 3_000_000 },
] as const;

// Everything a phone or tablet does in a session starts here: /j/<code>.
// The device picks its role — camera, remote control, or the one-off
// connection check.
export default function Join() {
  const code = (location.pathname.split('/')[2] ?? '').toUpperCase();
  const params = new URLSearchParams(location.search);
  const [mode, setMode] = useState<Mode>(() => {
    const m = params.get('mode');
    return m === 'check' || m === 'control' || m === 'camera' ? (m as Mode) : 'choose';
  });
  const platform = platformInfo();

  if (!code) {
    return (
      <div className="home-page">
        <header className="check-header">
          <h1>camerasoup</h1>
        </header>
        <p className="hint">This link is missing its code. Scan the QR on the Mac again.</p>
      </div>
    );
  }
  if (mode === 'control') return <RemoteControl code={code} onLeave={() => setMode('choose')} />;
  if (mode === 'camera') return <CameraMode code={code} />;
  if (mode === 'check') return <CheckMode code={code} />;

  return (
    <div className="home-page">
      <header className="check-header">
        <h1>camerasoup</h1>
        <span>room {code}</span>
      </header>
      <p className="lede">What should {platform.label} do?</p>
      <div className="role-picker">
        <button onClick={() => setMode('camera')}>
          <b>Be a camera</b>
          <span>Point it, name the angle, and the Mac records it.</span>
        </button>
        <button onClick={() => setMode('control')}>
          <b>Be the remote control</b>
          <span>See every camera and press REC from here. The Mac keeps recording.</span>
        </button>
        <button className="quiet" onClick={() => setMode('check')}>
          <b>Test the connection</b>
          <span>Ten seconds, to see how many cameras this WiFi can carry.</span>
        </button>
      </div>
    </div>
  );
}

// --- camera ------------------------------------------------------------------

function CameraMode({ code }: { code: string }) {
  const [name, setName] = useState(() => localStorage.getItem(NAME_KEY) ?? '');
  const [started, setStarted] = useState(false);
  if (!started) {
    return (
      <NameGate
        name={name}
        onStart={(n) => {
          localStorage.setItem(NAME_KEY, n);
          setName(n);
          setStarted(true);
        }}
      />
    );
  }
  return <LiveCamera code={code} name={name} />;
}

function NameGate({ name, onStart }: { name: string; onStart: (n: string) => void }) {
  const [value, setValue] = useState(name);
  const [quality, setQuality] = useState(() => localStorage.getItem(QUALITY_KEY) ?? 'high');
  return (
    <div className="camera-page">
      <div className="center-card">
        <h1>camerasoup camera</h1>
        <p className="hint">Name this angle. The name sticks to this device.</p>
        <div className="chip-row">
          {SUGGESTIONS.map((s) => (
            <button key={s} onClick={() => setValue(s)}>
              {s}
            </button>
          ))}
        </div>
        <input
          value={value}
          placeholder="camera name"
          onChange={(e) => setValue(e.target.value)}
          autoCapitalize="none"
          autoCorrect="off"
        />
        <p className="hint">Quality — pick Medium or Low for an older phone or weak WiFi.</p>
        <div className="chip-row">
          {QUALITIES.map((q) => (
            <button
              key={q.key}
              style={quality === q.key ? { borderColor: 'var(--accent)' } : undefined}
              onClick={() => {
                localStorage.setItem(QUALITY_KEY, q.key);
                setQuality(q.key);
              }}
            >
              {q.label}
            </button>
          ))}
        </div>
        <button className="big" disabled={!value.trim()} onClick={() => onStart(value.trim())}>
          Start camera
        </button>
        <p className="hint">
          Keep this tab open and the screen on while recording. iOS stops the camera if Safari goes
          to the background or the screen locks.
        </p>
      </div>
    </div>
  );
}

function LiveCamera({ code, name }: { code: string; name: string }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const clientRef = useRef<CameraClient | null>(null);
  const wakeRef = useRef<WakeLockSentinel | null>(null);
  const [ev, setEv] = useState<CameraEvents>({
    state: 'connecting',
    connected: false,
    sourceId: null,
    error: null,
    pendingBytes: 0,
    recordingSince: null,
  });
  const [fatal, setFatal] = useState<string | null>(null);
  const [rotation, setRotation] = useState(
    () => Number(localStorage.getItem('camerasoup.cameraRotation')) || 0
  );

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const stream = await openCamera('environment');
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          void videoRef.current.play().catch(() => {});
        }
        const bps =
          QUALITIES.find((q) => q.key === localStorage.getItem(QUALITY_KEY))?.bps ?? QUALITIES[0].bps;
        const client = new CameraClient({ code, name, stream, rotation, videoBitsPerSecond: bps });
        clientRef.current = client;
        client.onChange(setEv);
        await client.start();
      } catch (err) {
        setFatal(
          (err as Error).name === 'NotAllowedError'
            ? 'Camera access was denied. Allow it in Settings, then reload this page.'
            : `Could not start the camera: ${(err as Error).message}`
        );
      }
    })();
    return () => {
      cancelled = true;
      clientRef.current?.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code, name]);

  // iOS kills the camera when Safari backgrounds; hold the screen awake and
  // re-acquire the lock when the tab comes back.
  useEffect(() => {
    const acquire = async () => {
      try {
        wakeRef.current = (await navigator.wakeLock?.request('screen')) ?? null;
      } catch {
        // not granted
      }
    };
    void acquire();
    const onVisible = () => {
      if (document.visibilityState === 'visible') void acquire();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      void wakeRef.current?.release().catch(() => {});
    };
  }, []);

  if (fatal) {
    return (
      <div className="home-page">
        <header className="check-header">
          <h1>camerasoup</h1>
        </header>
        <section className="verdict red">
          <h2>Camera not available.</h2>
          <ul>
            <li>{fatal}</li>
          </ul>
          <div className="actions">
            <button onClick={() => location.reload()}>Try again</button>
          </div>
        </section>
      </div>
    );
  }

  const recording = ev.state === 'recording';
  const rotate = () => {
    const next = (rotation + 90) % 360;
    setRotation(next);
    localStorage.setItem('camerasoup.cameraRotation', String(next));
    clientRef.current?.setRotation(next);
  };

  return (
    <div className={`camera-page${recording ? ' recording' : ''}`}>
      <div className="camera-bar">
        <span className={`dot ${recording ? 'rec' : ev.connected ? 'on' : ''}`} />
        <span className="name">{name}</span>
        <span className="spacer" />
        <button onClick={rotate}>Rotate</button>
      </div>
      <video
        ref={videoRef}
        className="camera-video"
        muted
        playsInline
        autoPlay
        style={rotation ? { transform: `rotate(${rotation}deg)` } : undefined}
      />
      <div className={`camera-status${recording ? ' rec' : ''}`}>
        {ev.state === 'connecting' && 'Connecting to the studio…'}
        {ev.state === 'live' && (ev.connected ? 'Ready — waiting for REC' : 'Reconnecting…')}
        {recording && 'RECORDING'}
        {ev.state === 'flushing' && 'Finishing up…'}
        {ev.state === 'interrupted' && (ev.error ?? 'Interrupted')}
        {ev.pendingBytes > 4 * 1024 * 1024 && ` · buffering ${(ev.pendingBytes / 1e6).toFixed(0)} MB`}
      </div>
    </div>
  );
}

// --- connection check --------------------------------------------------------

function CheckMode({ code }: { code: string }) {
  const [stage, setStage] = useState<'idle' | 'running' | 'done' | 'failed'>('idle');
  const [error, setError] = useState<string | null>(null);
  const [report, setReport] = useState<CheckReport | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const cleanupRef = useRef<(() => void) | null>(null);

  useEffect(() => () => cleanupRef.current?.(), []);

  async function start() {
    setStage('running');
    setError(null);
    const caps: PhoneCaps = phoneCapabilities();
    let stream: MediaStream | null = null;
    try {
      stream = await openCamera('environment');
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        void videoRef.current.play().catch(() => {});
      }
      const s = stream.getVideoTracks()[0]?.getSettings();
      caps.cameraOpened = true;
      caps.width = s?.width ?? 0;
      caps.height = s?.height ?? 0;
    } catch {
      caps.cameraOpened = false;
    }
    try {
      const servers = await iceServers();
      const signal = await Signal.connect(code, 'camera', 'check');
      let peer: SignalledPeer | null = null;
      const stop = () => {
        peer?.close();
        signal.close();
        stream?.getTracks().forEach((t) => t.stop());
      };
      cleanupRef.current = stop;
      const timer = window.setTimeout(() => {
        if (!peer) {
          setError('No studio is waiting for this code. Open camerasoup.com on the Mac first.');
          setStage('failed');
          stop();
        }
      }, 30_000);
      signal.on((msg) => {
        if (msg.type !== 'signal') return;
        if (!peer) {
          window.clearTimeout(timer);
          peer = new SignalledPeer(signal, msg.from, servers);
          peer.pc.ondatachannel = (ev) => {
            const dc = ev.channel;
            dc.binaryType = 'arraybuffer';
            serveCheck(dc);
            onControl(dc, (m) => {
              if (m.type === 'result') {
                setReport(m.report);
                setStage('done');
                stop();
              }
            });
            void waitOpen(dc).then(() => sendControl(dc, { type: 'caps', phone: caps }));
          };
          waitConnected(peer.pc).catch(() => {
            setError('Could not connect to the Mac. This network may keep devices apart.');
            setStage('failed');
            stop();
          });
        }
        void peer.handle(msg.data);
      });
    } catch (err) {
      setError(`Could not reach the signaling server: ${(err as Error).message}`);
      setStage('failed');
    }
  }

  return (
    <div className="join-page">
      {stage === 'running' && <video ref={videoRef} playsInline muted autoPlay />}
      <div className="join-body">
        {stage === 'idle' && (
          <>
            <h1>camerasoup</h1>
            <p>
              Connection check for room <b className="check-code-inline">{code}</b>. This device
              acts as a camera and sends test data to the Mac for about ten seconds.
            </p>
            <button className="big" onClick={() => void start()}>
              Start check
            </button>
          </>
        )}
        {stage === 'running' && (
          <div className="join-status">
            <span className="dot active" />
            Testing…
          </div>
        )}
        {stage === 'failed' && (
          <section className="verdict red">
            <h2>Could not finish the check.</h2>
            <ul>
              <li>{error}</li>
            </ul>
            <div className="actions">
              <button onClick={() => location.reload()}>Try again</button>
            </div>
          </section>
        )}
        {stage === 'done' && report && <VerdictCard report={report} onAgain={() => location.reload()} />}
      </div>
    </div>
  );
}
