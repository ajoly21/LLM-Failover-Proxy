export const SYMBOL = {
  cursor: '▸',
  grab: '⇅',
  ok: '✓',
  fail: '✗',
  queued: '·',
  running: '⋯',
  on: '●',
  off: '○',
};

export const COLOR = {
  accent: 'cyan',
  ok: 'green',
  warn: 'yellow',
  fail: 'red',
  title: 'greenBright',
};

/** Pads to a fixed visible width so highlighted rows stay rectangular. */
export function cell(value, width, align = 'left') {
  const text = String(value ?? '');
  const clipped = text.length > width ? `${text.slice(0, Math.max(0, width - 1))}…` : text;
  return align === 'right' ? clipped.padStart(width) : clipped.padEnd(width);
}

/** Keeps `cursor` inside a window of `size` rows, for lists taller than the screen. */
export function windowAround(total, cursor, size) {
  if (total <= size) return { start: 0, end: total };
  const start = Math.min(Math.max(0, cursor - Math.floor(size / 2)), total - size);
  return { start, end: start + size };
}

// Shared with the plain-text report rather than reimplemented: one definition
// of what a duration or a large count looks like across the whole project.
export { ms as duration, compact, percent } from '../logger.js';
