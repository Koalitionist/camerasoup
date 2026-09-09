import { useEffect, useRef, useState } from 'react';
import ControlView, { ControlActions } from '../components/ControlView';
import SpinePage from '../components/Spine';
import { SignalledPeer, iceServers } from '../lib/peer';
import type { ControlToHub, HubSnapshot, HubToControl } from '../lib/rtc-protocol';
import { onJson, sendJson } from '../lib/rtc-protocol';
import { Signal } from '../lib/signal';

// The iPad (or any device) as the control room: joins the room as "control",
// receives the hub's state plus a forwarded video track per camera, and
// sends back commands. It never touches footage.
export default function RemoteControl({ code, onLeave }: { code: string; onLeave: () => void }) {
  const [state, setState] = useState<HubSnapshot | null>(null);
  const [streams, setStreams] = useState<Record<string, MediaStream>>({});
  const [error, setError] = useState<string | null>(null);
  const dcRef = useRef<RTCDataChannel | null>(null);
  const byStreamId = useRef<Record<string, MediaStream>>({});

  useEffect(() => {
    let signal: Signal | null = null;
    let peer: SignalledPeer | null = null;
    let cancelled = false;

    (async () => {
      try {
        const servers = await iceServers();
        signal = await Signal.connect(code, 'control', 'control');
        if (cancelled) {
          signal.close();
          return;
        }
        if (!signal.peers.some((p) => p.role === 'host')) {
          setError('No studio is running with this code. Start it on the computer, then reload.');
          return;
        }
        signal.on((msg) => {
          if (msg.type === 'closed') setError('Lost the connection to the studio.');
          if (msg.type === 'peer-left' && msg.role === 'host') {
            setError('The studio tab on the computer closed.');
          }
          if (msg.type !== 'signal') return;
          if (!peer) {
            peer = new SignalledPeer(signal!, msg.from, servers);
            peer.pc.ondatachannel = (ev) => {
              const dc = ev.channel;
              dcRef.current = dc;
              onJson<HubToControl>(dc, (m) => {
                if (m.type === 'state') setState(m.state);
              });
            };
            // Each camera arrives as its own stream; the snapshot maps
            // stream ids to camera ids.
            peer.pc.ontrack = (ev) => {
              const stream = ev.streams[0];
              if (!stream) return;
              byStreamId.current[stream.id] = stream;
              setStreams({ ...byStreamId.current });
            };
            peer.pc.onconnectionstatechange = () => {
              if (peer!.pc.connectionState === 'failed') {
                setError('Lost the direct connection to the computer.');
              }
            };
          }
          void peer.handle(msg.data);
        });
      } catch (err) {
        setError(`Could not reach the studio: ${(err as Error).message}`);
      }
    })();

    return () => {
      cancelled = true;
      peer?.close();
      signal?.close();
    };
  }, [code]);

  const send = (msg: ControlToHub) => sendJson(dcRef.current, msg);
  const actions: ControlActions = {
    cut: (sourceId) => send({ type: 'command', cmd: 'cut', sourceId }),
    start: () => send({ type: 'command', cmd: 'record-start' }),
    stop: () => send({ type: 'command', cmd: 'record-stop' }),
    remove: (sourceId) => send({ type: 'command', cmd: 'remove', sourceId }),
    cameraControl: (sourceId, c) => send({ type: 'command', cmd: 'camera-control', sourceId, ...c }),
    setAuto: (on) => send({ type: 'command', cmd: 'auto', on }),
    setFraming: (value) => send({ type: 'command', cmd: 'framing', value }),
    rename: (sourceId, name) => send({ type: 'command', cmd: 'rename', sourceId, name }),
  };

  if (error) {
    return (
      <SpinePage phone>
        <span className="meta">Remote control</span>
        <div className="edged verdict red">
          <h2>Not connected.</h2>
          <p className="hint">{error}</p>
          <div className="actions">
            <button className="pill outline" onClick={() => location.reload()}>
              Try again
            </button>
            <button className="pill outline" onClick={onLeave}>
              Back
            </button>
          </div>
        </div>
      </SpinePage>
    );
  }

  if (!state) {
    return (
      <SpinePage phone>
        <span className="meta">Remote control</span>
        <div className="join-status">
          <span className="dot active" />
          Connecting to the studio…
        </div>
      </SpinePage>
    );
  }

  // Map the hub's stream ids onto camera ids for the shared view.
  const mapped: Record<string, MediaStream> = {};
  for (const cam of state.cameras) {
    if (cam.streamId && streams[cam.streamId]) mapped[cam.id] = streams[cam.streamId];
  }

  return (
    <>
      <ControlView
        state={state}
        streams={mapped}
        actions={actions}
        meta={<span className="meta">remote · {state.code}</span>}
      />
      {state.toast && <div className="toast">{state.toast}</div>}
    </>
  );
}
