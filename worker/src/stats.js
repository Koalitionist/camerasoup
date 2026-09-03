// Anonymous tally of /check verdicts: which share of real networks gets a
// direct connection, and how fast. No addresses, no identifiers — just the
// numbers that decide whether a paid relay tier is worth building.
import { DurableObject } from 'cloudflare:workers';

const MAX_LEN = 80;
const str = (v) => (typeof v === 'string' ? v.slice(0, MAX_LEN) : '');
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

export class Stats extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS verdicts (
      ts INTEGER NOT NULL,
      verdict TEXT NOT NULL,
      connection TEXT NOT NULL,
      mbps REAL NOT NULL,
      rtt_ms REAL NOT NULL,
      host TEXT NOT NULL,
      phone TEXT NOT NULL
    )`);
  }

  async fetch(request) {
    if (request.method === 'POST') {
      const body = await request.json().catch(() => null);
      if (!body || typeof body !== 'object') return new Response('bad json', { status: 400 });
      this.sql.exec(
        'INSERT INTO verdicts VALUES (?, ?, ?, ?, ?, ?, ?)',
        Date.now(),
        str(body.verdict) || 'unknown',
        str(body.connection) || 'unknown',
        num(body.mbps),
        num(body.rttMs),
        str(body.host),
        str(body.phone)
      );
      return Response.json({ ok: true });
    }
    const rows = this.sql
      .exec(
        `SELECT verdict, connection, COUNT(*) AS n, ROUND(AVG(mbps)) AS avg_mbps,
                ROUND(AVG(rtt_ms)) AS avg_rtt_ms
         FROM verdicts GROUP BY verdict, connection ORDER BY n DESC`
      )
      .toArray();
    const total = rows.reduce((sum, r) => sum + Number(r.n), 0);
    return Response.json({ total, rows });
  }
}
