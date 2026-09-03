// camerasoup.com edge: serves the studio pages as static assets and relays
// WebRTC signaling between a producer tab and its cameras. Footage never
// touches this Worker — once two browsers have exchanged offers through a
// Room they talk to each other directly.
import { Room } from './room.js';
import { Stats } from './stats.js';

export { Room, Stats };

// STUN only: with no TURN relay configured the product can never cost
// bandwidth. Add a relay here (paid tier) without shipping a page change.
const ICE_SERVERS = [{ urls: 'stun:stun.cloudflare.com:3478' }];

const ROOM_CODE = /^\/ws\/([A-Za-z0-9]{4,12})$/;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    const room = url.pathname.match(ROOM_CODE);
    if (room) {
      if (request.headers.get('Upgrade') !== 'websocket') {
        return new Response('expected a WebSocket', { status: 426 });
      }
      const code = room[1].toUpperCase();
      return env.ROOM.get(env.ROOM.idFromName(code)).fetch(request);
    }

    if (url.pathname === '/api/ice') {
      return Response.json({ iceServers: ICE_SERVERS });
    }
    if (url.pathname === '/api/verdict' || url.pathname === '/api/verdicts') {
      return env.STATS.get(env.STATS.idFromName('global')).fetch(request);
    }
    if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/ws')) {
      return new Response('not found', { status: 404 });
    }
    return env.ASSETS.fetch(request);
  },
};
