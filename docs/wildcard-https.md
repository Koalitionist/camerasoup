# Wildcard HTTPS: valid camera URLs with zero device setup

The product path for camera onboarding. Instead of installing a private CA on
every phone (the mkcert flow), the studio serves a hostname that carries its
own LAN IP — `192-168-1-48.cam.example.com` — under a domain whose wildcard
DNS resolves that label to `192.168.1.48`, with a bundled `*.cam.example.com`
certificate. Any phone on the same wifi scans the QR and gets a fully valid
HTTPS origin: no profile install, no trust toggle, no tunnel. This is the same
scheme Plex uses (`*.plex.direct`).

The WebSocket signalling already uses the page's own origin
(`wss://<host>/ws`), so nothing is ever blocked as mixed content.

## What the app does (already implemented)

With `CAMERASOUP_DOMAIN=cam.example.com` set and a wildcard cert at
`server/certs/wildcard.pem` + `server/certs/wildcard-key.pem`, the server:

- detects its LAN IP, builds `192-168-1-48.cam.example.com`, and uses that
  hostname for the producer URL, the camera QR, and `/api/join`;
- serves the wildcard cert for that hostname via SNI while the mkcert cert
  (if present) keeps serving `.local`/IP URLs on the same port, so the old
  flow remains as fallback;
- omits the certificate-install step from the join overlay's happy path.

There is deliberately no desktop-app shell: the browser is the control room's
shell. If this ever ships to non-developers, package the server as a single
compiled binary (Bun `--compile` / Node SEA) that opens the default browser
at the producer URL.

## What you have to set up once

### 1. DNS: wildcard that echoes the IP in the label

A plain wildcard A record can't do this (it returns one fixed IP for every
label), so `cam.example.com` needs an authoritative server that parses the
label. Options, easiest first:

- **Run the sslip.io server** (open source, a single Go binary) on any small
  VM, and delegate with `NS` records: `cam.example.com NS ns.example.com`,
  `ns.example.com A <vm-ip>`. It implements exactly this dashed-IP scheme.
- **CoreDNS/PowerDNS** with a template/pipe backend doing
  `^(\d+)-(\d+)-(\d+)-(\d+)\.cam\.example\.com$` → `$1.$2.$3.$4`.

Sanity check: `dig 192-168-1-48.cam.example.com` → `192.168.1.48`.

### 2. Certificate: Let's Encrypt wildcard via DNS-01

```sh
certbot certonly --preferred-challenges dns -d '*.cam.example.com'
```

DNS-01 needs a TXT record under `_acme-challenge.cam.example.com` — put that
zone (or a CNAME to it) somewhere with an API (Cloudflare) so renewal is
automatic. Copy `fullchain.pem` → `wildcard.pem`, `privkey.pem` →
`wildcard-key.pem`.

**Renewal reality:** LE certs last 90 days, so a shipped app needs a cert
refresh channel (the app fetches the renewed cert+key from your server on
launch) — a static bundle goes stale.

**Security note:** every copy of the app shares one private key, so anyone
can extract it and impersonate `*.cam.example.com` on a network they control.
Plex solved this properly with per-user certificates (`*.<hash>.plex.direct`)
issued through a CA partner. For v1 the shared key is a known, bounded risk
(an attacker on your LAN could spoof the camera page); revisit before charging
money.

## Known failure mode: DNS rebind protection

Many routers (Fritz!Box notably — default-on in Germany) refuse to resolve
public DNS names to private IPs, which is precisely what this scheme does.
On such networks the dashed-IP hostname never resolves.

- Fritz!Box: Home Network → Network → Network Settings → DNS Rebind
  Protection → add `cam.example.com` as an exception.
- The join overlay keeps the `.local` mkcert URL as the printed fallback for
  exactly this case; don't remove that path.

## Devices not on the same network

Out of scope for the LAN scheme by definition. The fallback is a tunnel
(relay the camera's chunks through a hosted endpoint); the join API already
separates `camera` from `fallback`, so a tunnel URL can slot in later without
changing the QR flow. Not built yet.

## Single studio on a Cloudflare domain (what runs on camerasoup.com)

For one studio on a domain whose DNS is on Cloudflare, the pattern-parsing
DNS server above is unnecessary: the server registers its own dashed-IP
`A` record at startup (`server/src/cloudflare-dns.js`), and the wildcard
cert comes from Let's Encrypt via a DNS-01 challenge against the same zone.
The hostname scheme and the cert are identical to the product path — only
who answers the DNS query differs. (Plex works this way too: `plex.direct`
names are registered by the server, not pattern-resolved.)

Once:

1. Cloudflare dashboard → My Profile → API Tokens → Create Token → template
   **Edit zone DNS**; add a second permission **Zone → Zone → Read**; Zone
   Resources → Specific zone → `camerasoup.com`. Save the token to
   `server/certs/cloudflare-token` (gitignored; or export
   `CAMERASOUP_CF_TOKEN`).
2. `npm run cert cam.camerasoup.com` — lego issues `*.cam.camerasoup.com`
   and installs `wildcard.pem` + `wildcard-key.pem`. Re-run any time: it
   renews only when fewer than 30 days remain, and the server warns at
   startup once fewer than 21 remain.

Then `CAMERASOUP_DOMAIN=cam.camerasoup.com npm start`: on start the server
upserts `192-168-1-48.cam.camerasoup.com → 192.168.1.48` (TTL 60, DNS-only,
never proxied) and prints the QR. If the Mac's LAN IP changes, the next start
registers the new name; stale names from old IPs are harmless.

For a multi-user product this becomes a small registration API in front of
the zone instead of a DNS-edit token on every install. The DNS-rebind caveat
above applies unchanged.

## Simulating locally (no domain needed)

```sh
cd server/certs && mkcert -cert-file wildcard.pem -key-file wildcard-key.pem '*.cam.camerasoup.test'
CAMERASOUP_DOMAIN=cam.camerasoup.test npm start
# curl: add  --resolve 192-168-1-48.cam.camerasoup.test:4433:<lan-ip>
# a browser: launch Chrome with  --host-resolver-rules='MAP *.cam.camerasoup.test <lan-ip>'
```
