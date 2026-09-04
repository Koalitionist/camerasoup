// RTCPeerConnection plumbing over a Signal. The host makes the offer, the
// camera answers; ICE candidates trickle both ways as they appear.
import { Signal, SignalData, signalOrigin } from './signal';

export type Connection = 'direct' | 'reflexive' | 'relay' | 'unknown';

export interface PathInfo {
  connection: Connection;
  localType: string;
  remoteType: string;
  localAddress: string;
  remoteAddress: string;
  protocol: string;
  rttMs: number | null;
}

const FALLBACK_ICE: RTCIceServer[] = [{ urls: 'stun:stun.cloudflare.com:3478' }];
let iceCache: RTCIceServer[] | null = null;

// Served by the Worker so a relay can be added later without a page change.
export async function iceServers(): Promise<RTCIceServer[]> {
  if (iceCache) return iceCache;
  try {
    const res = await fetch(`${signalOrigin()}/api/ice`);
    const json = (await res.json()) as { iceServers?: RTCIceServer[] };
    if (Array.isArray(json.iceServers) && json.iceServers.length) iceCache = json.iceServers;
  } catch {
    // offline or dev server: STUN fallback below
  }
  return iceCache ?? FALLBACK_ICE;
}

// Only the host ever offers, so there is no glare to resolve; offers are
// serialized so a renegotiation (a new track for a control view) waits for
// the previous answer.
export class SignalledPeer {
  readonly pc: RTCPeerConnection;
  private queued: RTCIceCandidateInit[] = [];
  private remoteSet = false;
  private offers: Promise<void> = Promise.resolve();

  constructor(
    readonly signal: Signal,
    readonly peerId: string,
    servers: RTCIceServer[],
    // Answerer hook: attach local tracks to the offer's transceivers before
    // the answer is built.
    private readonly beforeAnswer?: (pc: RTCPeerConnection) => Promise<void>
  ) {
    this.pc = new RTCPeerConnection({ iceServers: servers });
    this.pc.onicecandidate = (ev) => {
      signal.send(peerId, { candidate: ev.candidate ? ev.candidate.toJSON() : null });
    };
  }

  offer(): Promise<void> {
    this.offers = this.offers.then(() => this.offerNow()).catch(() => {});
    return this.offers;
  }

  private async offerNow() {
    if (this.pc.signalingState === 'closed') return;
    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);
    this.signal.send(this.peerId, { sdp: offer });
    await this.untilStable(10_000);
  }

  private untilStable(timeoutMs: number): Promise<void> {
    return new Promise((resolve) => {
      if (this.pc.signalingState === 'stable') {
        resolve();
        return;
      }
      const timer = window.setTimeout(done, timeoutMs);
      const check = () => {
        if (this.pc.signalingState === 'stable' || this.pc.signalingState === 'closed') done();
      };
      function done() {
        window.clearTimeout(timer);
        resolve();
      }
      this.pc.addEventListener('signalingstatechange', check);
    });
  }

  async handle(data: SignalData) {
    if ('sdp' in data) {
      await this.pc.setRemoteDescription(data.sdp);
      this.remoteSet = true;
      for (const c of this.queued) await this.pc.addIceCandidate(c).catch(() => {});
      this.queued = [];
      if (data.sdp.type === 'offer') {
        await this.beforeAnswer?.(this.pc);
        const answer = await this.pc.createAnswer();
        await this.pc.setLocalDescription(answer);
        this.signal.send(this.peerId, { sdp: answer });
      }
      return;
    }
    if (data.candidate === null) return; // end of candidates
    if (!this.remoteSet) this.queued.push(data.candidate);
    else await this.pc.addIceCandidate(data.candidate).catch(() => {});
  }

  close() {
    this.pc.close();
  }
}

// LAN ICE connects within a few seconds or not at all; a long wait only
// delays the retry.
export function waitConnected(pc: RTCPeerConnection, timeoutMs = 12_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      cleanup();
      reject(new Error(`no connection within ${Math.round(timeoutMs / 1000)} seconds`));
    }, timeoutMs);
    const check = () => {
      if (pc.connectionState === 'connected') {
        cleanup();
        resolve();
      } else if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
        cleanup();
        reject(new Error(`connection ${pc.connectionState}`));
      }
    };
    const cleanup = () => {
      window.clearTimeout(timer);
      pc.removeEventListener('connectionstatechange', check);
    };
    pc.addEventListener('connectionstatechange', check);
    check();
  });
}

export function waitOpen(dc: RTCDataChannel, timeoutMs = 10_000): Promise<void> {
  return new Promise((resolve, reject) => {
    if (dc.readyState === 'open') {
      resolve();
      return;
    }
    const timer = window.setTimeout(() => reject(new Error('data channel did not open')), timeoutMs);
    dc.addEventListener(
      'open',
      () => {
        window.clearTimeout(timer);
        resolve();
      },
      { once: true }
    );
  });
}

function isPrivate(address: string | undefined): boolean {
  if (!address) return false;
  return (
    address.endsWith('.local') ||
    /^10\./.test(address) ||
    /^192\.168\./.test(address) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(address) ||
    /^169\.254\./.test(address) ||
    /^f[cd][0-9a-f]{2}:/i.test(address) ||
    /^fe80:/i.test(address)
  );
}

// Which path ICE picked. Two host candidates = direct LAN traffic; a
// server-reflexive candidate means the router is hairpinning; relay means a
// TURN server carried the bytes. Browsers mask host candidates as mDNS
// names, so a peer-reflexive candidate on a private address still counts
// as direct.
export async function describePath(pc: RTCPeerConnection): Promise<PathInfo> {
  const stats = await pc.getStats();
  let pair: Record<string, unknown> | null = null;
  stats.forEach((s) => {
    if (s.type === 'transport' && s.selectedCandidatePairId) {
      pair = stats.get(s.selectedCandidatePairId) ?? null;
    }
  });
  if (!pair) {
    stats.forEach((s) => {
      if (s.type === 'candidate-pair' && s.state === 'succeeded' && (s.selected || s.nominated)) {
        pair = s;
      }
    });
  }
  const p = pair as Record<string, unknown> | null;
  const local = (p && stats.get(p.localCandidateId as string)) as Record<string, unknown> | undefined;
  const remote = (p && stats.get(p.remoteCandidateId as string)) as
    | Record<string, unknown>
    | undefined;
  const lt = String(local?.candidateType ?? 'unknown');
  const rt = String(remote?.candidateType ?? 'unknown');
  const la = local?.address as string | undefined;
  const ra = remote?.address as string | undefined;

  const directish = (t: string, a: string | undefined) =>
    t === 'host' || (t === 'prflx' && isPrivate(a));
  let connection: Connection = 'unknown';
  if (lt === 'relay' || rt === 'relay') connection = 'relay';
  else if (directish(lt, la) && directish(rt, ra)) connection = 'direct';
  else if (lt === 'srflx' || rt === 'srflx' || lt === 'prflx' || rt === 'prflx') {
    connection = 'reflexive';
  }

  const fmt = (c?: Record<string, unknown>) =>
    c ? `${c.address ?? '?'}:${c.port ?? '?'}` : 'unknown';
  const rtt = p?.currentRoundTripTime;
  return {
    connection,
    localType: lt,
    remoteType: rt,
    localAddress: fmt(local),
    remoteAddress: fmt(remote),
    protocol: String(local?.protocol ?? ''),
    rttMs: typeof rtt === 'number' ? Math.round(rtt * 1000) : null,
  };
}
