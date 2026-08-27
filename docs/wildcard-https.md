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

With `FILMSTUDIE_DOMAIN=cam.example.com` set and a wildcard cert at
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

## Simulating locally (no domain needed)

```sh
cd server/certs && mkcert -cert-file wildcard.pem -key-file wildcard-key.pem '*.cam.filmstudie.test'
FILMSTUDIE_DOMAIN=cam.filmstudie.test npm start
# curl: add  --resolve 192-168-1-48.cam.filmstudie.test:4433:<lan-ip>
# a browser: launch Chrome with  --host-resolver-rules='MAP *.cam.filmstudie.test <lan-ip>'
```
