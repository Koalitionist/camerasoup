// Registers the studio's dashed-IP hostname in Cloudflare DNS.
//
// The product path in docs/wildcard-https.md is a DNS server that parses the
// IP out of the label for any client. For a single studio on a Cloudflare-
// managed domain that's unnecessary: with an API token that can edit the
// zone's DNS, the server upserts <dashed-lan-ip>.<domain> → <lan-ip> itself
// on every start, so the wildcard cert's origin resolves with no DNS
// infrastructure to run. The hostname scheme is identical either way.
import fs from 'node:fs';
import path from 'node:path';

const API = 'https://api.cloudflare.com/client/v4';

// Token with Zone:Read + DNS:Edit on the zone. Env var wins; otherwise the
// (gitignored) server/certs/cloudflare-token file, which scripts/cert.sh
// shares for the ACME DNS-01 challenge.
export function readCloudflareToken(certsDir) {
  const env = process.env.CAMERASOUP_CF_TOKEN?.trim();
  if (env) return env;
  try {
    return fs.readFileSync(path.join(certsDir, 'cloudflare-token'), 'utf8').trim() || null;
  } catch {
    return null;
  }
}

async function cf(token, method, url, body) {
  const res = await fetch(`${API}${url}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!json.success) {
    const msg = json.errors?.map((e) => e.message).join('; ') || `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return json.result;
}

// The zone containing `host` is its longest suffix that Cloudflare knows.
async function findZone(token, host) {
  const parts = host.split('.');
  for (let i = 1; i < parts.length - 1; i++) {
    const name = parts.slice(i).join('.');
    const zones = await cf(token, 'GET', `/zones?name=${encodeURIComponent(name)}`);
    if (zones.length) return zones[0];
  }
  throw new Error(`no Cloudflare zone found for ${host}`);
}

export async function upsertARecord(token, host, ip, log = console.log) {
  const zone = await findZone(token, host);
  const existing = await cf(
    token,
    'GET',
    `/zones/${zone.id}/dns_records?type=A&name=${encodeURIComponent(host)}`
  );
  const record = {
    type: 'A',
    name: host,
    content: ip,
    ttl: 60,
    proxied: false, // a private IP can't be proxied, and the cert is ours
    comment: 'camerasoup studio: set automatically at startup',
  };
  if (existing.length === 0) {
    await cf(token, 'POST', `/zones/${zone.id}/dns_records`, record);
    log(`[dns] created ${host} → ${ip}`);
  } else if (existing[0].content !== ip || existing[0].proxied) {
    await cf(token, 'PUT', `/zones/${zone.id}/dns_records/${existing[0].id}`, record);
    log(`[dns] updated ${host} → ${ip}`);
  } else {
    log(`[dns] ${host} → ${ip} is current`);
  }
}
