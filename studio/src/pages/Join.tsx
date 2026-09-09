import { useEffect, useRef, useState } from 'react';
import SpinePage from '../components/Spine';
import { NO_AUTOFILL } from '../lib/fields';
import VerdictCard from '../components/VerdictCard';
import { PhoneCaps, phoneCapabilities } from '../lib/capabilities';
import { CameraClient, CameraEvents } from '../lib/camera-client';
import { openCamera } from '../lib/capture';
import { CheckReport, onControl, sendControl, serveCheck } from '../lib/check';
import { SignalledPeer, iceServers, waitConnected, waitOpen } from '../lib/peer';
import { platformInfo } from '../lib/platform';
import { Signal } from '../lib/signal';
import { colorForKey, textOn } from '../lib/theme';
import RemoteControl from './RemoteControl';

type Mode = 'choose' | 'camera' | 'control' | 'check';

const NAME_KEY = 'camerasoup.cameraName';
const QUALITY_KEY = 'camerasoup.cameraQuality';
const ROTATION_KEY = 'camerasoup.cameraRotation';
const SUGGESTIONS = ['topdown', 'face', 'action', 'side'];
const QUALITIES = [
  { key: 'high', label: 'High · 10 Mbps', bps: 10_000_000 },
  { key: 'medium', label: 'Medium · 6 Mbps', bps: 6_000_000 },
  { key: 'low', label: 'Low · 3 Mbps', bps: 3_000_000 },
] as const;

const ROLES = [
  {
    mode: 'camera' as const,
    title: 'Be a camera',
    sub: 'Point it, name the angle.',
    bg: '#1F6FE5',
    width: '100%',
  },
  {
    mode: 'control' as const,
    title: 'Be the remote',
    sub: 'Press REC from here.',
    bg: '#FFC61A',
    width: '90%',
  },
  {
    mode: 'check' as const,
    title: 'Test connection',
    sub: 'Ten seconds.',
    bg: '#22B8E0',
    width: '80%',
  },
];

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
      <SpinePage phone>
        <span className="meta">camerasoup</span>
        <h1>This link is missing its code.</h1>
        <p className="lede">Scan the QR on the computer again.</p>
      </SpinePage>
    );
  }
  if (mode === 'control') return <RemoteControl code={code} onLeave={() => setMode('choose')} />;
  if (mode === 'camera') return <CameraMode code={code} />;
  if (mode === 'check') return <CheckMode code={code} />;

  return (
    <SpinePage phone>
      <span className="meta">Room {code}</span>
      <h1>What should {platform.label} do?</h1>
      <div className="role-pills">
        {ROLES.map((r) => (
          <button
            key={r.mode}
            className="role-pill"
            style={{ background: r.bg, color: textOn(r.bg), width: r.width }}
            onClick={() => setMode(r.mode)}
          >
            <b>{r.title}</b>
            <span>{r.sub}</span>
          </button>
        ))}
      </div>
    </SpinePage>
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
    <SpinePage phone>
      <span className="meta">Camera</span>
      <h1>Name this angle.</h1>
      <p className="hint">The name sticks to this device.</p>
      <div className="chip-row">
        {SUGGESTIONS.map((s) => (
          <button key={s} className="chip" onClick={() => setValue(s)}>
            {s}
          </button>
        ))}
      </div>
      <input
        className="name-input"
        {...NO_AUTOFILL}
        name="angle-name"
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
            className={`chip${quality === q.key ? ' on' : ''}`}
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
    </SpinePage>
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
    keyNumber: 1,
    error: null,
    pendingBytes: 0,
    recordingSince: null,
  });
  const [fatal, setFatal] = useState<string | null>(null);
  const [rotation, setRotation] = useState(() => Number(localStorage.getItem(ROTATION_KEY)) || 0);
  const [elapsed, setElapsed] = useState(0);

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

  const since = ev.recordingSince;
  useEffect(() => {
    if (!since) {
      setElapsed(0);
      return;
    }
    const t = window.setInterval(() => setElapsed((Date.now() - since) / 1000), 500);
    return () => window.clearInterval(t);
  }, [since]);

  if (fatal) {
    return (
      <SpinePage phone>
        <span className="meta">Camera</span>
        <div className="edged verdict red">
          <h2>Camera not available.</h2>
          <p className="hint">{fatal}</p>
          <div className="actions">
            <button className="pill outline" onClick={() => location.reload()}>
              Try again
            </button>
          </div>
        </div>
      </SpinePage>
    );
  }

  const recording = ev.state === 'recording';
  const color = colorForKey(ev.keyNumber);
  const rotate = () => {
    const next = (rotation + 90) % 360;
    setRotation(next);
    localStorage.setItem(ROTATION_KEY, String(next));
    clientRef.current?.setRotation(next);
  };
  const timer = `${Math.floor(elapsed / 60)}:${String(Math.floor(elapsed % 60)).padStart(2, '0')}`;

  return (
    <div className="camera-page">
      <div className="camera-spine">
        <div className="camera-spine-fill" style={{ background: color }}>
          <div className="camera-spine-label" style={{ color: textOn(color) }}>
            <span className="num">{ev.keyNumber}</span>
            &nbsp;{name}
          </div>
        </div>
      </div>
      <div className="camera-main">
        <div className="camera-bar">
          <span>camerasoup</span>
          <button className="pill ghost" onClick={rotate}>
            Rotate
          </button>
        </div>
        <video
          ref={videoRef}
          className="camera-video"
          muted
          playsInline
          autoPlay
          style={rotation ? { transform: `rotate(${rotation}deg)` } : undefined}
        />
        <div
          className={`camera-status${recording ? ' rec' : ''}${
            ev.state === 'interrupted' ? ' bad' : ''
          }`}
        >
          {ev.state === 'connecting' && <span>Connecting…</span>}
          {ev.state === 'live' && <span>{ev.connected ? 'Ready — waiting for REC' : 'Reconnecting…'}</span>}
          {recording && (
            <>
              <span>
                <span className="dot rec" style={{ marginRight: 10 }} />
                REC
              </span>
              <span className="tabular">{timer}</span>
            </>
          )}
          {ev.state === 'flushing' && <span>Finishing up…</span>}
          {ev.state === 'interrupted' && <span>{ev.error ?? 'Interrupted'}</span>}
          {ev.pendingBytes > 4 * 1024 * 1024 && (
            <span className="sub">buffering {(ev.pendingBytes / 1e6).toFixed(0)} MB</span>
          )}
        </div>
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
          setError('No studio is waiting for this code. Open camerasoup.com on the computer first.');
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
            setError('Could not connect to the computer. This network may keep devices apart.');
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
    <SpinePage phone>
      <span className="meta">
        Connection check · <b className="check-code-inline">{code}</b>
      </span>
      {stage === 'idle' && (
        <>
          <h1>Ten seconds to see if this network can carry it.</h1>
          <p className="lede">
            This device acts as a camera and sends test data to the computer.
          </p>
          <button className="big" onClick={() => void start()}>
            Start check
          </button>
        </>
      )}
      {stage === 'running' && (
        <>
          <div className="join-status">
            <span className="dot active" />
            Testing…
          </div>
          <video ref={videoRef} playsInline muted autoPlay style={{ width: '100%', borderRadius: 20 }} />
        </>
      )}
      {stage === 'failed' && (
        <div className="edged verdict red">
          <h2>Could not finish the check.</h2>
          <p className="hint">{error}</p>
          <div className="actions">
            <button className="pill outline" onClick={() => location.reload()}>
              Try again
            </button>
          </div>
        </div>
      )}
      {stage === 'done' && report && <VerdictCard report={report} onAgain={() => location.reload()} />}
    </SpinePage>
  );
}
