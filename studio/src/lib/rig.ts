// What the studio should look like when you come back to it.
//
// The room code is remembered per tab, because a new tab means a new room.
// The rig is remembered per machine, because the webcam and screen you shoot
// with do not change between sessions and re-picking them every time is the
// tax this file exists to remove.
//
// A webcam can be reopened without asking: permission is already granted on
// this origin and a deviceId is stable. A screen share cannot — getDisplayMedia
// requires a fresh user gesture every time, by design — so a screen is
// remembered only so its name and place come back once you re-share it.
import { type Framing, slugify } from './rtc-protocol';

const KEY = 'camerasoup.rig';

export interface RigLocal {
  kind: 'local-webcam' | 'local-screen';
  name: string;
  deviceId?: string;
}

export interface Rig {
  locals: RigLocal[];
  names: Record<string, string>; // custom names, by source id
  framing: Framing;
}

// Every call builds its own arrays and objects. Callers mutate what they get
// back before writing it, so handing out a shared empty rig would let one
// write leak into every later read.
function read(): Rig {
  try {
    const raw = localStorage.getItem(KEY);
    const parsed = raw ? (JSON.parse(raw) as Partial<Rig>) : {};
    return {
      locals: Array.isArray(parsed.locals) ? parsed.locals.filter((l) => l && l.kind && l.name) : [],
      names: parsed.names && typeof parsed.names === 'object' ? { ...parsed.names } : {},
      framing: parsed.framing === 'landscape' ? 'landscape' : 'social',
    };
  } catch {
    // unreadable or disabled storage: the studio still works, it just forgets
    return { locals: [], names: {}, framing: 'social' };
  }
}

function write(rig: Rig) {
  try {
    localStorage.setItem(KEY, JSON.stringify(rig));
  } catch {
    // private mode, or full: not worth failing an add over
  }
}

export function loadRig(): Rig {
  return read();
}

export function rememberLocal(entry: RigLocal) {
  const rig = read();
  // One entry per source id, so re-adding the same webcam does not stack up.
  const id = slugify(entry.name);
  rig.locals = [...rig.locals.filter((l) => slugify(l.name) !== id), entry];
  write(rig);
}

export function forgetSource(id: string) {
  const rig = read();
  rig.locals = rig.locals.filter((l) => slugify(l.name) !== id);
  delete rig.names[id];
  write(rig);
}

// A name given in the studio outlives the session that gave it: a phone
// rejoining as "side" comes back as whatever you renamed it to.
export function rememberName(id: string, name: string) {
  const rig = read();
  rig.names[id] = name;
  const local = rig.locals.find((l) => slugify(l.name) === id);
  if (local) local.name = name;
  write(rig);
}

export function rememberFraming(framing: Framing) {
  const rig = read();
  rig.framing = framing;
  write(rig);
}

export function nameFor(id: string): string | null {
  return read().names[id] ?? null;
}
