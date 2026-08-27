import { execFileSync } from 'node:child_process';
import os from 'node:os';

// Bonjour name (<name>.local) is what iOS Safari will trust the cert for;
// bare LAN IPs break WSS on iOS even with an installed CA.
export function bonjourHost() {
  try {
    const name = execFileSync('scutil', ['--get', 'LocalHostName'], { encoding: 'utf8' }).trim();
    if (name) return `${name}.local`;
  } catch {
    // not macOS or scutil unavailable
  }
  const h = os.hostname();
  return h.endsWith('.local') ? h : `${h}.local`;
}

export function lanIp() {
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const iface of ifaces ?? []) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return '127.0.0.1';
}

// Plex-style wildcard-DNS hostname: 192-168-1-48.cam.example.com carries the
// LAN IP in its label, so the public wildcard DNS for *.cam.example.com can
// answer with that IP while a bundled *.cam.example.com cert makes the origin
// a valid secure context — no per-device certificate install.
export function dashedIpHost(domain, ip = lanIp()) {
  return `${ip.replaceAll('.', '-')}.${domain}`;
}
