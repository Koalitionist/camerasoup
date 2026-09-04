// WebSocket to a Room on the signaling Worker. Carries only connection
// setup (SDP offers/answers, ICE candidates) between a producer tab and its
// cameras; media never goes this way. Rejoins the same room after a drop
// (deploys restart rooms, WiFi blips happen) so a page never has to reload
// just to keep its code.
export type Role = 'host' | 'camera' | 'control';
export interface Peer {
  id: string;
  role: Role;
  name?: string;
}
export type SignalData =
  | { sdp: RTCSessionDescriptionInit }
  | { candidate: RTCIceCandidateInit | null };
export type SignalMsg =
  | { type: 'joined'; id: string; role: Role; peers: Peer[] }
  | { type: 'peer-joined'; id: string; role: Role; name?: string }
  | { type: 'peer-left'; id: string; role: Role }
  | { type: 'signal'; from: string; data: SignalData }
  | { type: 'pong' }
  | { type: 'reconnected'; id: string; peers: Peer[] }
  | { type: 'closed'; code: number; reason: string };

// No 0/O/1/I: codes get read aloud and typed.
const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
export function newRoomCode(length = 6): string {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes, (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
}

// Same origin in production. The localStorage override lets a Vite dev
// server talk to a deployed Worker.
export function signalOrigin(): string {
  const override = localStorage.getItem('camerasoup.signalOrigin');
  return (override || location.origin).replace(/\/$/, '');
}

export function joinUrl(code: string): string {
  return `${signalOrigin()}/j/${code}`;
}

const KEEPALIVE = '{"type":"ping"}'; // answered by the Room without waking it
const KEEPALIVE_MS = 25_000;
const RETRY_BASE_MS = 1000;
const RETRY_MAX_MS = 5000;
const RETRY_LIMIT = 10;
const CLOSE_REPLACED = 4000; // the Room closed us for a newer producer tab

export class Signal {
  id = '';
  peers: Peer[] = [];
  private ws: WebSocket | null = null;
  private handlers = new Set<(msg: SignalMsg) => void>();
  private keepalive: number | undefined;
  private retryTimer: number | undefined;
  private attempts = 0;
  private closedByUs = false;

  private constructor(
    private readonly code: string,
    private readonly role: Role,
    private readonly name: string
  ) {}

  static async connect(code: string, role: Role, name = ''): Promise<Signal> {
    const signal = new Signal(code, role, name);
    await signal.open();
    return signal;
  }

  private url(): string {
    const origin = signalOrigin().replace(/^http/, 'ws');
    const query = new URLSearchParams({ role: this.role, name: this.name });
    return `${origin}/ws/${this.code}?${query}`;
  }

  private open(): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url());
      this.ws = ws;
      let joined = false;
      ws.onopen = () => {
        this.keepalive = window.setInterval(() => ws.send(KEEPALIVE), KEEPALIVE_MS);
      };
      ws.onmessage = (ev) => {
        const msg = JSON.parse(ev.data as string) as SignalMsg;
        if (msg.type === 'joined') {
          this.id = msg.id;
          this.peers = msg.peers;
          const rejoin = this.attempts > 0;
          this.attempts = 0;
          joined = true;
          resolve();
          if (rejoin) {
            this.emit({ type: 'reconnected', id: msg.id, peers: msg.peers });
            return;
          }
        } else if (msg.type === 'peer-joined') {
          this.peers.push({ id: msg.id, role: msg.role, name: msg.name });
        } else if (msg.type === 'peer-left') {
          this.peers = this.peers.filter((p) => p.id !== msg.id);
        }
        this.emit(msg);
      };
      ws.onclose = (ev) => {
        window.clearInterval(this.keepalive);
        const final =
          this.closedByUs || ev.code === CLOSE_REPLACED || this.attempts >= RETRY_LIMIT;
        if (!joined && this.attempts === 0) {
          // First connection never joined: the caller decides.
          reject(new Error(`signaling closed before join (${ev.code})`));
          return;
        }
        if (final) {
          this.emit({ type: 'closed', code: ev.code, reason: ev.reason });
          if (!joined) reject(new Error('gave up reconnecting'));
          return;
        }
        this.attempts += 1;
        const delay = Math.min(RETRY_BASE_MS * this.attempts, RETRY_MAX_MS);
        this.retryTimer = window.setTimeout(() => this.open().catch(() => {}), delay);
        if (!joined) reject(new Error('retrying'));
      };
      ws.onerror = () => {
        // onclose follows with the code
      };
    });
  }

  private emit(msg: SignalMsg) {
    this.handlers.forEach((h) => h(msg));
  }

  get isOpen() {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  send(to: string, data: SignalData) {
    if (this.isOpen) this.ws!.send(JSON.stringify({ type: 'signal', to, data }));
  }

  on(handler: (msg: SignalMsg) => void): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  close() {
    this.closedByUs = true;
    window.clearInterval(this.keepalive);
    window.clearTimeout(this.retryTimer);
    this.ws?.close();
  }
}
