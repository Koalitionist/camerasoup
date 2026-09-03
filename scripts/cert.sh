#!/usr/bin/env bash
# Issue or renew the Let's Encrypt wildcard certificate for *.<domain> using
# a Cloudflare DNS-01 challenge, and install it where the server expects it:
# server/certs/wildcard.pem + server/certs/wildcard-key.pem.
#
#   scripts/cert.sh cam.camerasoup.com            # or: CAMERASOUP_DOMAIN=... npm run cert
#
# Needs: lego (brew install lego) and a Cloudflare API token with Zone:Read +
# DNS:Edit on the zone in server/certs/cloudflare-token (or CAMERASOUP_CF_TOKEN).
# Safe to re-run: lego only renews when the cert is within 30 days of expiry.
set -euo pipefail
cd "$(dirname "$0")/.."

DOMAIN="${1:-${CAMERASOUP_DOMAIN:-}}"
if [ -z "$DOMAIN" ]; then
  echo "usage: scripts/cert.sh <domain>   (e.g. cam.camerasoup.com)" >&2
  exit 1
fi
EMAIL="${CAMERASOUP_ACME_EMAIL:-$(git config user.email || true)}"
if [ -z "$EMAIL" ]; then
  echo "Set CAMERASOUP_ACME_EMAIL (Let's Encrypt account contact)." >&2
  exit 1
fi
if ! command -v lego >/dev/null; then
  echo "Installing lego via Homebrew..."
  brew install lego
fi

TOKEN="${CAMERASOUP_CF_TOKEN:-}"
[ -n "$TOKEN" ] || TOKEN="$(cat server/certs/cloudflare-token 2>/dev/null || true)"
if [ -z "$TOKEN" ]; then
  echo "No Cloudflare token: put one in server/certs/cloudflare-token or CAMERASOUP_CF_TOKEN." >&2
  exit 1
fi
export CLOUDFLARE_DNS_API_TOKEN="$TOKEN"

LEGO_DIR="server/certs/lego"
CRT="$LEGO_DIR/certificates/${DOMAIN}.crt"
KEY="$LEGO_DIR/certificates/${DOMAIN}.key"

# lego ≥ 5: `run` both issues and renews; with an existing cert it only
# renews when fewer than --renew-days remain, otherwise it's a no-op.
lego run --accept-tos --email "$EMAIL" \
  --dns cloudflare --dns.resolvers 1.1.1.1:53 \
  --domains "*.${DOMAIN}" --cert.name "$DOMAIN" --path "$LEGO_DIR" \
  --renew-days 30 --no-random-sleep

cp "$CRT" server/certs/wildcard.pem
cp "$KEY" server/certs/wildcard-key.pem
chmod 600 server/certs/wildcard-key.pem

echo
echo "Installed *.${DOMAIN} certificate:"
openssl x509 -in server/certs/wildcard.pem -noout -enddate | sed 's/^/  /'
echo "Start the studio with:  CAMERASOUP_DOMAIN=${DOMAIN} npm start"
