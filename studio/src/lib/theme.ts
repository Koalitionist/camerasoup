// One saturated color per camera angle, indexed by the hub's key number.
// Carried through the camera spines, tag pills, program outline and timeline
// so an angle is the same color everywhere you look at it.
export const ANGLE_COLORS = [
  '#1F6FE5', // 1 blue
  '#FFC61A', // 2 yellow
  '#FF3B2F', // 3 red
  '#6F3FB8', // 4 purple
  '#22B8E0', // 5 cyan
  '#FF7A1A', // 6 orange
  '#C4127A', // 7 magenta
  '#17A34A', // 8 green
] as const;

export const REC_COLOR = '#FF3B2F';

/** Key numbers are 1-based and wrap past the end of the palette. */
export function colorForKey(keyNumber: number): string {
  const i = Math.max(0, Math.round(keyNumber) - 1);
  return ANGLE_COLORS[i % ANGLE_COLORS.length];
}

/** Black on the light colors, white on the rest. */
export function textOn(hex: string): string {
  const n = parseInt(hex.slice(1), 16);
  const lum = 0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255);
  return lum > 150 ? '#111111' : '#ffffff';
}
