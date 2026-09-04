import QRCode from 'qrcode';
import { useEffect, useRef, useState } from 'react';
import SpinePage from '../components/Spine';
import VerdictCard from '../components/VerdictCard';
import { HostCaps, PhoneCaps, hostCapabilities } from '../lib/capabilities';
import {
  CheckReport,
  TEST_SECONDS,
  buildReport,
  failedReport,
  measureRtt,
  measureUpload,
  postVerdict,
  sendControl,
  waitControl,
} from '../lib/check';
import {
  PathInfo,
  SignalledPeer,
  describePath,
  iceServers,
  waitConnected,
  waitOpen,
} from '../lib/peer';
import { Signal, joinUrl, newRoomCode, signalOrigin } from '../lib/signal';

type Stage = 'probing' | 'waiting' | 'connecting' | 'testing' | 'done';
type StepState = 'pending' | 'active' | 'ok' | 'warn' | 'fail';

// The Mac side of the connection check: opens a room, shows the QR, and when
// a phone joins runs the measurement and produces the verdict. This is the
// same handshake the studio will use — the check is the onboarding.
export default function Check() {
  // ?code=ABC123 pins the room, for typed codes and for testing.
  const [code] = useState(
    () =>
      (new URLSearchParams(location.search).get('code') ?? '')
        .toUpperCase()
        .replace(/[^A-Z0-9]/g, '')
        .slice(0, 12) || newRoomCode()
  );
  const [qr, setQr] = useState('');
  const [host, setHost] = useState<HostCaps | null>(null);
  const [stage, setStage] = useState<Stage>('probing');
  const [phone, setPhone] = useState<PhoneCaps | null>(null);
  const [path, setPath] = useState<PathInfo | null>(null);
  const [liveMbps, setLiveMbps] = useState<number | null>(null);
  const [report, setReport] = useState<CheckReport | null>(null);
  const [signalError, setSignalError] = useState<string | null>(null);
  const signalRef = useRef<Signal | null>(null);
  const peerRef = useRef<SignalledPeer | null>(null);
  const hostRef = useRef<HostCaps | null>(null);
  const busyRef = useRef(false);
  const failTimerRef = useRef<number | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    QRCode.toDataURL(joinUrl(code, 'check'), { margin: 1, width: 480 })
      .then(setQr)
      .catch(() => {});
    (async () => {
      const caps = await hostCapabilities();
      if (cancelled) return;
      hostRef.current = caps;
      setHost(caps);
      try {
        const signal = await Signal.connect(code, 'host', 'check');
        if (cancelled) {
          signal.close();
          return;
        }
        signalRef.current = signal;
        setStage('waiting');
        signal.on((msg) => {
          if (msg.type === 'peer-joined' && msg.role === 'camera') void runTest(msg.id);
          if (msg.type === 'closed') {
            setSignalError(msg.reason || `Lost the signaling connection (${msg.code}). Reload to start over.`);
          }
          if (msg.type === 'reconnected') setSignalError(null);
        });
        const waiting = signal.peers.find((p) => p.role === 'camera');
        if (waiting) void runTest(waiting.id);
      } catch (err) {
        setSignalError(`Could not reach the signaling server: ${(err as Error).message}`);
      }
    })();
    return () => {
      cancelled = true;
      signalRef.current?.close();
      peerRef.current?.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code]);

  async function runTest(peerId: string) {
    const signal = signalRef.current;
    const hostCaps = hostRef.current;
    if (!signal || !hostCaps || busyRef.current) return;
    busyRef.current = true;
    window.clearTimeout(failTimerRef.current); // the phone came back for a retry
    peerRef.current?.close();
    setReport(null);
    setPhone(null);
    setPath(null);
    setLiveMbps(null);
    setStage('connecting');

    let phoneCaps: PhoneCaps | null = null;
    let unsubscribe = () => {};
    try {
      const servers = await iceServers();
      const peer = new SignalledPeer(signal, peerId, servers);
      peerRef.current = peer;
      unsubscribe = signal.on((msg) => {
        if (msg.type === 'signal' && msg.from === peerId) void peer.handle(msg.data);
      });
      const dc = peer.pc.createDataChannel('check', { ordered: true });
      dc.binaryType = 'arraybuffer';
      await peer.offer();
      await waitConnected(peer.pc);
      await waitOpen(dc);

      const caps = await waitControl(dc, 'caps');
      phoneCaps = caps.phone;
      setPhone(caps.phone);
      setStage('testing');

      const rttMs = await measureRtt(dc);
      const started = performance.now();
      let lastPaint = 0;
      const upload = await measureUpload(dc, TEST_SECONDS, (bytes) => {
        const now = performance.now();
        if (now - lastPaint < 200) return;
        lastPaint = now;
        setLiveMbps((bytes * 8) / ((now - started) / 1000) / 1e6);
      });
      setLiveMbps(upload.mbps);
      const pathInfo = await describePath(peer.pc);
      setPath(pathInfo);

      const result = buildReport({ host: hostCaps, phone: phoneCaps, path: pathInfo, upload, rttMs });
      setReport(result);
      setStage('done');
      sendControl(dc, { type: 'result', report: result });
      postVerdict(signalOrigin(), result);
    } catch (err) {
      // The phone retries a failed connection once by rejoining; hold the red
      // verdict long enough for that to land, then report it if it doesn't.
      const result = failedReport((err as Error).message, hostCaps, phoneCaps);
      failTimerRef.current = window.setTimeout(() => {
        setReport(result);
        setStage('done');
        postVerdict(signalOrigin(), result);
      }, 8000);
    } finally {
      unsubscribe();
      busyRef.current = false;
    }
  }

  const hostState: StepState = !host
    ? 'active'
    : !host.folderAccess || !host.webCodecs || !host.h264
      ? 'fail'
      : host.encodeFps >= 60 && host.aac
        ? 'ok'
        : 'warn';
  const hostDetail = !host
    ? 'probing the browser and timing the video encoder…'
    : [
        host.browser,
        host.folderAccess ? 'saves to a folder' : 'no folder access',
        !host.webCodecs
          ? 'no WebCodecs'
          : !host.h264
            ? 'no h264 encoder'
            : host.encodeFps
              ? `encodes ${host.encodeFps} fps at 1080p`
              : 'h264 encoder',
        host.webCodecs && !host.aac ? 'no AAC' : null,
      ]
        .filter(Boolean)
        .join(' · ');

  const phoneState: StepState = phone
    ? phone.cameraOpened && phone.mimeType
      ? 'ok'
      : 'warn'
    : stage === 'waiting'
      ? 'active'
      : stage === 'probing'
        ? 'pending'
        : 'active';
  const phoneDetail = phone
    ? `${phone.browser} · ${phone.cameraOpened ? `camera ${phone.width}×${phone.height}` : 'camera not opened'}`
    : stage === 'waiting'
      ? 'scan the code with the phone'
      : stage === 'probing'
        ? ''
        : 'joining…';

  const connectionState: StepState = path
    ? path.connection === 'direct'
      ? 'ok'
      : 'warn'
    : stage === 'connecting' || stage === 'testing'
      ? 'active'
      : report
        ? 'fail'
        : 'pending';
  const connectionDetail = path
    ? `${path.connection} · ${path.localType} ↔ ${path.remoteType}${path.rttMs != null ? ` · ${path.rttMs} ms` : ''}`
    : stage === 'connecting'
      ? 'negotiating a direct path…'
      : '';

  const speedState: StepState =
    report && path
      ? report.cameras1080 >= 2
        ? 'ok'
        : report.cameras720 >= 1
          ? 'warn'
          : 'fail'
      : stage === 'testing'
        ? 'active'
        : 'pending';
  const speedDetail =
    liveMbps != null ? `${liveMbps.toFixed(0)} Mbps phone → Mac` : stage === 'testing' ? 'measuring…' : '';

  return (
    <SpinePage>
      <span className="meta">Connection check</span>
      <h1>Will it work here?</h1>
      <p className="lede">
        Run this on the computer that will record. One phone sends test footage to it for a few
        seconds, the way it will during a recording. Nothing leaves your network.
      </p>
      <div className="check-grid">
        <section className="steps">
          <Step label="This browser" state={hostState} detail={hostDetail} />
          <Step label="Phone" state={phoneState} detail={phoneDetail} />
          <Step label="Connection" state={connectionState} detail={connectionDetail} />
          <Step label="Speed" state={speedState} detail={speedDetail} />
        </section>
        <aside className="check-join">
          {qr ? (
            <img src={qr} alt={`QR code for ${joinUrl(code, 'check')}`} />
          ) : (
            <div style={{ width: 260, height: 260 }} />
          )}
          <div className="check-code">{code}</div>
          <div className="check-url">{joinUrl(code).replace(/^https?:\/\//, '')}</div>
          <p className="hint">Scan with the phone’s camera app, or type the address in Safari.</p>
        </aside>
      </div>
      {signalError && (
        <div className="edged verdict red">
          <p className="hint">{signalError}</p>
        </div>
      )}
      {report && (
        <VerdictCard
          report={report}
          onAgain={() => {
            setReport(null);
            setPath(null);
            setPhone(null);
            setLiveMbps(null);
            setStage('waiting');
          }}
          againLabel="Test another phone"
        />
      )}
      {stage === 'done' && report && (
        <p className="hint">Tap “Test again” on the phone to repeat with the same code.</p>
      )}
    </SpinePage>
  );
}

function Step({ label, state, detail }: { label: string; state: StepState; detail: string }) {
  return (
    <div className="step">
      <span className={`dot ${state === 'ok' ? 'on' : state}`} />
      <span className="label">{label}</span>
      <span className="detail">{detail}</span>
    </div>
  );
}
