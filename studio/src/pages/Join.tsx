import { useEffect, useRef, useState } from 'react';
import VerdictCard from '../components/VerdictCard';
import { PhoneCaps, phoneCapabilities } from '../lib/capabilities';
import { openCamera } from '../lib/capture';
import { CheckReport, onControl, sendControl, serveCheck } from '../lib/check';
import { SignalledPeer, iceServers, waitConnected, waitOpen } from '../lib/peer';
import { Signal } from '../lib/signal';

type Stage = 'intro' | 'starting' | 'waiting' | 'connecting' | 'testing' | 'done' | 'failed';

const OVERALL_TIMEOUT_MS = 120_000;
const HOST_TIMEOUT_MS = 30_000;
// ICE occasionally misses on a perfectly good LAN; one silent retry keeps a
// flake from reading as "your network is broken".
const CONNECT_ATTEMPTS = 2;

// The phone side of the connection check. Opens the camera (so the check
// exercises the real permission and the real sensor), joins the room, and
// answers the producer's measurements.
export default function Join() {
  const code = (location.pathname.split('/')[2] ?? '').toUpperCase();
  const [stage, setStage] = useState<Stage>('intro');
  const [error, setError] = useState<string | null>(null);
  const [report, setReport] = useState<CheckReport | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const signalRef = useRef<Signal | null>(null);
  const peerRef = useRef<SignalledPeer | null>(null);
  const stageRef = useRef<Stage>('intro');
  const attemptRef = useRef(0);
  const signalOffRef = useRef<(() => void) | null>(null);
  const setStageBoth = (s: Stage) => {
    stageRef.current = s;
    setStage(s);
  };

  const stopCamera = () => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  };

  useEffect(
    () => () => {
      stopCamera();
      signalRef.current?.close();
      peerRef.current?.close();
    },
    []
  );

  const fail = (message: string) => {
    if (stageRef.current === 'done') return;
    setError(message);
    setStageBoth('failed');
    stopCamera();
  };

  // Tears down the current signaling and peer, then rejoins the room as a new
  // camera so the producer runs the handshake again.
  const retryConnection = (caps: PhoneCaps) => {
    attemptRef.current += 1;
    signalOffRef.current?.(); // the old socket's close must not read as failure
    signalRef.current?.close();
    peerRef.current?.close();
    signalRef.current = null;
    peerRef.current = null;
    void connect(caps);
  };

  async function start() {
    setError(null);
    setStageBoth('starting');
    attemptRef.current = 1;
    const caps = phoneCapabilities();
    // ?nocam skips the camera so a second desktop tab can stand in for a
    // phone when testing the connection path alone.
    const skipCamera = new URLSearchParams(location.search).has('nocam');
    try {
      if (skipCamera) throw new Error('camera skipped');
      const stream = await openCamera('environment');
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play().catch(() => {});
      }
      const settings = stream.getVideoTracks()[0]?.getSettings();
      caps.cameraOpened = true;
      caps.width = settings?.width ?? 0;
      caps.height = settings?.height ?? 0;
    } catch {
      caps.cameraOpened = false;
    }
    try {
      await navigator.wakeLock?.request('screen');
    } catch {
      // not granted: the hint below covers it
    }

    window.setTimeout(() => {
      if (stageRef.current !== 'done') fail('The check did not finish. Reload this page and try again.');
    }, OVERALL_TIMEOUT_MS);
    await connect(caps);
  }

  async function connect(caps: PhoneCaps) {
    try {
      const signal = await Signal.connect(code, 'camera', 'check');
      signalRef.current = signal;
      setStageBoth('waiting');
      const servers = await iceServers();
      let peer: SignalledPeer | null = null;
      const hostTimer = window.setTimeout(() => {
        if (!peer) fail('No producer is waiting for this code. Open the check page on the Mac first, then scan again.');
      }, HOST_TIMEOUT_MS);

      signalOffRef.current = signal.on((msg) => {
        if (msg.type === 'closed' && stageRef.current !== 'done') {
          fail('Lost the connection to the signaling server.');
          return;
        }
        if (msg.type !== 'signal') return;
        if (!peer) {
          window.clearTimeout(hostTimer);
          peer = new SignalledPeer(signal, msg.from, servers);
          peerRef.current = peer;
          setStageBoth('connecting');
          peer.pc.ondatachannel = (ev) => {
            const dc = ev.channel;
            dc.binaryType = 'arraybuffer';
            serveCheck(dc, (s) => {
              if (s === 'testing') setStageBoth('testing');
            });
            onControl(dc, (m) => {
              if (m.type === 'result') {
                setReport(m.report);
                setStageBoth('done');
                stopCamera();
              }
            });
            waitOpen(dc)
              .then(() => sendControl(dc, { type: 'caps', phone: caps }))
              .catch(() => fail('The data channel never opened.'));
          };
          waitConnected(peer.pc).catch((err) => {
            if (attemptRef.current < CONNECT_ATTEMPTS) retryConnection(caps);
            else fail(`Could not connect to the Mac (${(err as Error).message}).`);
          });
        }
        void peer.handle(msg.data);
      });
    } catch (err) {
      fail(`Could not reach the signaling server: ${(err as Error).message}`);
    }
  }

  if (!code) {
    return (
      <div className="join-page">
        <div className="join-body">
          <h1>camerasoup</h1>
          <p className="hint">This link is missing its code. Scan the QR on the Mac again.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="join-page">
      {stage !== 'intro' && stage !== 'done' && stage !== 'failed' && (
        <video ref={videoRef} playsInline muted autoPlay />
      )}
      <div className="join-body">
        {stage === 'intro' && (
          <>
            <h1>camerasoup</h1>
            <p>
              Connection check for room <b className="check-code-inline">{code}</b>. Your phone will
              open its camera and send test data to the Mac for about ten seconds.
            </p>
            <button className="big" onClick={() => void start()}>
              Start check
            </button>
            <p className="hint">Allow the camera when asked, and keep this screen on until it finishes.</p>
          </>
        )}
        {(stage === 'starting' || stage === 'waiting' || stage === 'connecting' || stage === 'testing') && (
          <div className="join-status">
            <span className="dot active" />
            {stage === 'starting' && 'Opening the camera…'}
            {stage === 'waiting' && 'Waiting for the Mac…'}
            {stage === 'connecting' && 'Connecting to the Mac…'}
            {stage === 'testing' && 'Sending test data…'}
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
        {stage === 'done' && report && (
          <VerdictCard report={report} onAgain={() => location.reload()} />
        )}
      </div>
    </div>
  );
}
