import { execFile } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import tls from 'node:tls';
import express from 'express';
import QRCode from 'qrcode';
import qrcode from 'qrcode-terminal';
import { Hub } from './hub.js';
import { bonjourHost, dashedIpHost, lanIp } from './net.js';
import { isFfmpegRendering, renderSessionFfmpeg } from './ffmpeg-render.js';
import { isRendering, renderSession } from './render.js';
import {
  listSessions,
  readManifest,
  SESSIONS_DIR,
  sessionDir,
  writeManifest,
} from './sessions.js';

const PORT = Number(process.env.CAMERASOUP_PORT ?? 4433);
const CA_PORT = Number(process.env.CAMERASOUP_CA_PORT ?? 4434);
const HTTP_MODE = process.env.CAMERASOUP_HTTP === '1'; // tests / trusted-LAN debugging only

const ROOT = path.resolve(import.meta.dirname, '../..');
const CERTS = path.join(ROOT, 'server/certs');
const STUDIO_DIST = path.join(ROOT, 'studio/dist');

// Wildcard-domain mode (the product path): with a domain whose *.<domain>
// wildcard DNS resolves dashed-IP labels (192-168-1-48.<domain> → 192.168.1.48)
// and a matching wildcard cert in server/certs/, phones get a valid HTTPS
// origin with zero per-device setup. See docs/wildcard-https.md.
const DOMAIN = process.env.CAMERASOUP_DOMAIN ?? null;
const WILDCARD_CERT = path.join(CERTS, 'wildcard.pem');
const WILDCARD_KEY = path.join(CERTS, 'wildcard-key.pem');
const domainMode =
  !HTTP_MODE && !!DOMAIN && fs.existsSync(WILDCARD_CERT) && fs.existsSync(WILDCARD_KEY);
const hasMkcert =
  fs.existsSync(path.join(CERTS, 'cert.pem')) && fs.existsSync(path.join(CERTS, 'key.pem'));

const app = express();
app.use(express.json());

// Join URLs for other devices. camera is the primary QR target; fallback is
// what to try when it won't open (mDNS or DNS-rebind-protection failures);
// setup is the one-time mkcert install page, only relevant on the mkcert path.
function joinUrls() {
  if (HTTP_MODE) {
    return {
      camera: `http://${bonjourHost()}:${PORT}/camera`,
      fallback: `http://${lanIp()}:${PORT}/camera`,
      setup: null,
    };
  }
  const setup = fs.existsSync(path.join(CERTS, 'rootCA.pem'))
    ? `http://${lanIp()}:${CA_PORT}/`
    : null;
  if (domainMode) {
    // The mkcert .local URL stays as the fallback for routers whose DNS
    // rebind protection refuses to resolve public names to private IPs.
    return {
      camera: `https://${dashedIpHost(DOMAIN)}:${PORT}/camera`,
      fallback: hasMkcert ? `https://${bonjourHost()}:${PORT}/camera` : null,
      setup: hasMkcert ? setup : null,
    };
  }
  return {
    camera: `https://${bonjourHost()}:${PORT}/camera`,
    fallback: `https://${lanIp()}:${PORT}/camera`,
    setup,
  };
}

function producerUrl() {
  if (HTTP_MODE) return `http://localhost:${PORT}/producer`;
  const host = domainMode ? dashedIpHost(DOMAIN) : bonjourHost();
  return `https://${host}:${PORT}/producer`;
}

app.get('/api/join', (req, res) => res.json(joinUrls()));
app.get('/api/join/qr/:kind', (req, res) => {
  const url = { camera: joinUrls().camera, setup: joinUrls().setup }[req.params.kind];
  if (!url) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  QRCode.toString(url, { type: 'svg', margin: 2 }, (err, svg) => {
    if (err) res.status(500).json({ error: err.message });
    else res.set('Content-Type', 'image/svg+xml').send(svg);
  });
});

app.get('/api/sessions', (req, res) => res.json(listSessions()));
app.get('/api/sessions/:id', (req, res) => {
  try {
    res.json(readManifest(req.params.id));
  } catch {
    res.status(404).json({ error: 'not found' });
  }
});
app.post('/api/sessions/:id/edit', (req, res) => {
  try {
    const manifest = readManifest(req.params.id);
    const { cuts, audioSource, rotations } = req.body ?? {};
    if (Array.isArray(cuts)) manifest.cuts = cuts;
    if (audioSource !== undefined) manifest.audioSource = audioSource;
    if (rotations && typeof rotations === 'object') {
      for (const src of manifest.sources) {
        if (typeof rotations[src.id] === 'number') src.rotation = rotations[src.id];
      }
    }
    writeManifest(manifest);
    res.json({ ok: true });
  } catch {
    res.status(404).json({ error: 'not found' });
  }
});
app.post('/api/sessions/:id/render', (req, res) => {
  const id = req.params.id;
  if (isRendering(id) || isFfmpegRendering(id)) {
    res.status(409).json({ error: 'render already running' });
    return;
  }
  const formats = Array.isArray(req.body?.formats) ? req.body.formats : undefined;
  if (req.body?.engine === 'remotion') {
    // Legacy engine, kept for comparison. The headless render browser fetches
    // footage over plain HTTP (it won't trust the mkcert cert).
    const baseUrl = HTTP_MODE ? `http://127.0.0.1:${PORT}` : `http://127.0.0.1:${CA_PORT}`;
    renderSession(id, { baseUrl, hub, formats }).catch((err) =>
      console.error(`render ${id} failed: ${err.message}`)
    );
  } else {
    renderSessionFfmpeg(id, { hub, formats }).catch((err) =>
      console.error(`render ${id} failed: ${err.message}`)
    );
  }
  res.json({ ok: true });
});
app.post('/api/reveal', (req, res) => {
  const { sessionId } = req.body ?? {};
  try {
    execFile('open', [sessionDir(sessionId)]);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.use('/sessions', express.static(SESSIONS_DIR));
app.use(express.static(STUDIO_DIST));
// SPA fallback for /producer, /camera, /edit
app.get(/^\/(producer|camera|edit)?$/, (req, res) => {
  res.sendFile(path.join(STUDIO_DIST, 'index.html'));
});

const hub = new Hub();

function startMain() {
  return new Promise((resolve, reject) => {
    if (HTTP_MODE) {
      const server = http.createServer(app);
      hub.attach(server);
      server.on('error', reject);
      server.listen(PORT, () => {
        console.log(`[camerasoup] HTTP mode on http://localhost:${PORT}`);
        resolve(server);
      });
      return;
    }
    if (!hasMkcert && !domainMode) {
      console.error('\nNo TLS certs found in server/certs/.');
      console.error('Run once:  npm run setup\n');
      reject(new Error('no TLS certs'));
      return;
    }
    // Default cert serves the mkcert names (.local, LAN IP); an SNI hit on
    // the wildcard domain switches to the bundled wildcard cert, so both URL
    // families work on the same port.
    const mkcertCreds = hasMkcert && {
      cert: fs.readFileSync(path.join(CERTS, 'cert.pem')),
      key: fs.readFileSync(path.join(CERTS, 'key.pem')),
    };
    const wildcardCtx = domainMode
      ? tls.createSecureContext({
          cert: fs.readFileSync(WILDCARD_CERT),
          key: fs.readFileSync(WILDCARD_KEY),
        })
      : null;
    const server = https.createServer(
      {
        ...(mkcertCreds || {
          cert: fs.readFileSync(WILDCARD_CERT),
          key: fs.readFileSync(WILDCARD_KEY),
        }),
        SNICallback: (servername, cb) =>
          cb(null, wildcardCtx && servername.endsWith(`.${DOMAIN}`) ? wildcardCtx : undefined),
      },
      app
    );
    hub.attach(server);
    server.on('error', reject);
    server.listen(PORT, () => {
      banner();
      resolve(server);
    });
  });
}

// Plain-HTTP helper server: lets iPhone/iPad download the mkcert root CA
// before they can trust the HTTPS app.
function startCaServer() {
  const caFile = path.join(CERTS, 'rootCA.pem');
  if (!fs.existsSync(caFile)) return;
  const caApp = express();
  // Also serves session footage over plain HTTP for the render's headless browser.
  caApp.use('/sessions', express.static(SESSIONS_DIR));
  caApp.get('/rootCA.pem', (req, res) => {
    res.set('Content-Type', 'application/x-x509-ca-cert');
    res.set('Content-Disposition', 'attachment; filename="camerasoup-rootCA.pem"');
    res.send(fs.readFileSync(caFile));
  });
  caApp.get('/', (req, res) => {
    res.send(`<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1">
<body style="font-family:-apple-system,sans-serif;max-width:34em;margin:2em auto;padding:0 1em;line-height:1.5">
<h2>camerasoup — one-time device setup</h2>
<ol>
<li><a href="/rootCA.pem">Download the root certificate</a> (choose "Allow")</li>
<li>Settings &rarr; <b>Profile Downloaded</b> &rarr; Install</li>
<li>Settings &rarr; General &rarr; About &rarr; <b>Certificate Trust Settings</b> &rarr; enable full trust for <b>mkcert</b></li>
<li>Open <b>https://${bonjourHost()}:${PORT}/camera</b></li>
</ol></body>`);
  });
  http.createServer(caApp).listen(CA_PORT);
}

function banner() {
  const { camera, fallback, setup } = joinUrls();
  console.log('\n  camerasoup studio is up\n');
  console.log(`  Producer (this Mac):  ${producerUrl()}`);
  console.log(`  Cameras (iPhone/iPad Safari): ${camera}`);
  if (fallback) console.log(`  If that URL won't open on a device: ${fallback}`);
  if (domainMode) console.log(`  Wildcard-domain mode (${DOMAIN}) — no certificate install needed.`);
  console.log('');
  qrcode.generate(camera, { small: true }, (qr) => console.log(qr));
  if (setup) {
    console.log(`  First time on a device? Scan this to install the certificate (${setup}):\n`);
    qrcode.generate(setup, { small: true }, (qr) => console.log(qr));
  }
  console.log('  See README for the 30-second walkthrough.\n');
}

startMain()
  .then(() => {
    if (!HTTP_MODE) startCaServer();
  })
  .catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
