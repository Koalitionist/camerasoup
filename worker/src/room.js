// One Room per join code. Holds the WebSockets of a producer (role "host")
// and its cameras, and relays "signal" messages (SDP offers/answers, ICE
// candidates) between them by peer id. No storage: a room is exactly the
// set of sockets connected to it, kept alive across hibernation through the
// per-socket attachment. Idle rooms cost nothing.
import { DurableObject } from 'cloudflare:workers';

const PING = '{"type":"ping"}';
const PONG = '{"type":"pong"}';

export class Room extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    // Keep-alives are answered by the runtime without waking the object.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(PING, PONG));
  }

  async fetch(request) {
    const url = new URL(request.url);
    // host = the recording tab; control = a remote-control view (iPad);
    // anything else is a camera.
    const wanted = url.searchParams.get('role');
    const role = wanted === 'host' || wanted === 'control' ? wanted : 'camera';
    const name = (url.searchParams.get('name') ?? '').slice(0, 40);
    const id = crypto.randomUUID().slice(0, 8);

    if (role === 'host') {
      // A reloaded producer tab replaces the previous one.
      for (const ws of this.ctx.getWebSockets('host')) {
        try {
          ws.close(4000, 'replaced by a newer producer tab');
        } catch {
          // already gone
        }
      }
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server, [id, role]);
    server.serializeAttachment({ id, role, name });

    server.send(
      JSON.stringify({
        type: 'joined',
        id,
        role,
        peers: this.peers().filter((p) => p.id !== id),
      })
    );
    this.broadcast({ type: 'peer-joined', id, role, name }, id);
    return new Response(null, { status: 101, webSocket: client });
  }

  peers() {
    return this.ctx.getWebSockets().map((ws) => ws.deserializeAttachment());
  }

  broadcast(msg, exceptId) {
    const text = JSON.stringify(msg);
    for (const ws of this.ctx.getWebSockets()) {
      if (ws.deserializeAttachment().id === exceptId) continue;
      try {
        ws.send(text);
      } catch {
        // closing socket; its close event will announce it
      }
    }
  }

  webSocketMessage(ws, raw) {
    if (typeof raw !== 'string' || raw.length > 64 * 1024) return;
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (msg.type !== 'signal' || typeof msg.to !== 'string') return;
    const from = ws.deserializeAttachment();
    const target = this.ctx.getWebSockets(msg.to)[0];
    if (!target) return;
    try {
      target.send(JSON.stringify({ type: 'signal', from: from.id, data: msg.data }));
    } catch {
      // target closing
    }
  }

  webSocketClose(ws) {
    const a = ws.deserializeAttachment();
    this.broadcast({ type: 'peer-left', id: a.id, role: a.role }, a.id);
  }

  webSocketError(ws) {
    this.webSocketClose(ws);
  }
}
