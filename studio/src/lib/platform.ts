// Which kind of device this is, and which role it can play. Roles are fixed
// by capability, not preference: recording needs a folder on disk and a
// hardware encoder, which today means a desktop Chromium browser; everything
// with a camera can be a camera.
export type DeviceKind = 'mac' | 'windows' | 'linux' | 'ipad' | 'iphone' | 'android' | 'unknown';

export interface Platform {
  kind: DeviceKind;
  desktop: boolean;
  canRecord: boolean; // desktop + File System Access API
  label: string; // "this Mac", "this iPad", …
}

const KINDS: DeviceKind[] = ['mac', 'windows', 'linux', 'ipad', 'iphone', 'android'];
const LABELS: Record<DeviceKind, string> = {
  mac: 'this Mac',
  windows: 'this PC',
  linux: 'this PC',
  ipad: 'this iPad',
  iphone: 'this iPhone',
  android: 'this phone',
  unknown: 'this device',
};

export function platformInfo(): Platform {
  const ua = navigator.userAgent;
  let kind: DeviceKind = 'unknown';
  if (/iPhone/.test(ua)) kind = 'iphone';
  // iPadOS Safari claims to be a Mac; the touch points give it away.
  else if (/iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) kind = 'ipad';
  else if (/Android/.test(ua)) kind = 'android';
  else if (/Mac OS X/.test(ua)) kind = 'mac';
  else if (/Windows/.test(ua)) kind = 'windows';
  else if (/Linux|CrOS/.test(ua)) kind = 'linux';

  // ?as=ipad pretends, for checking the copy on a desktop.
  const pretend = new URLSearchParams(location.search).get('as') as DeviceKind | null;
  const pretending = !!pretend && KINDS.includes(pretend);
  if (pretending) kind = pretend!;

  const desktop = kind === 'mac' || kind === 'windows' || kind === 'linux';
  const folderAccess =
    typeof (window as unknown as { showDirectoryPicker?: unknown }).showDirectoryPicker === 'function';
  return { kind, desktop, canRecord: desktop && folderAccess, label: LABELS[kind] };
}

// The same build serves two worlds: the website (Cloudflare Worker) and the
// local studio server. Only the local server has the recording pages.
export function isHosted(): boolean {
  const h = location.hostname;
  return (
    h === 'camerasoup.com' ||
    h === 'www.camerasoup.com' ||
    h.endsWith('.workers.dev') ||
    (h === 'localhost' && location.port === '8787') // wrangler dev
  );
}
