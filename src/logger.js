const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

/** 0x1B derived from its code point: a raw ESC byte in the source is invisible,
 *  and it does not survive every editor, diff or copy/paste. */
export const ESC = String.fromCharCode(27);

/** Wraps `text` in an SGR sequence. Exported so tests can pin the encoding. */
export const ansi = (code, text) => `${ESC}[${code}m${text}${ESC}[0m`;

export const supportsColor = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
const wrap = (code) => (text) => (supportsColor ? ansi(code, text) : String(text));

export const c = {
  bold: wrap(1),
  dim: wrap(2),
  red: wrap(31),
  green: wrap(32),
  yellow: wrap(33),
  blue: wrap(34),
  magenta: wrap(35),
  cyan: wrap(36),
  gray: wrap(90),
};

let threshold = LEVELS.info;

export function setLogLevel(level) {
  threshold = LEVELS[level] ?? LEVELS.info;
}

function timestamp() {
  return c.gray(new Date().toISOString().slice(11, 23));
}

function emit(level, tag, args) {
  if (LEVELS[level] < threshold) return;
  const stream = LEVELS[level] >= LEVELS.warn ? process.stderr : process.stdout;
  stream.write(`${timestamp()} ${tag} ${args.join(" ")}\n`);
}

export const log = {
  debug: (...args) => emit("debug", c.gray("debug"), args),
  info: (...args) => emit("info", c.blue("info "), args),
  warn: (...args) => emit("warn", c.yellow("warn "), args),
  error: (...args) => emit("error", c.red("error"), args),
  raw: (...args) => process.stdout.write(`${args.join(" ")}\n`),
};

/** Human-friendly duration: `840ms`, `1.42s`. */
export function ms(value) {
  if (value == null) return "-";
  return value < 1000 ? `${Math.round(value)}ms` : `${(value / 1000).toFixed(2)}s`;
}

const SCALES = [
  { limit: 1e3, suffix: "k" },
  { limit: 1e6, suffix: "M" },
  { limit: 1e9, suffix: "B" },
  { limit: 1e12, suffix: "T" },
];

/**
 * Compact count for display: `847`, `1.2k`, `12.3k`, `123k`, `4.5M`.
 *
 * Token totals and request counters grow without bound on a long-running proxy,
 * and they sit in fixed-width table columns. Exact values stay available in the
 * `/stats` JSON, this is for reading, not for accounting.
 */
export function compact(value) {
  const number = Number(value);
  if (value == null || !Number.isFinite(number)) return "-";
  const sign = number < 0 ? "-" : "";
  const absolute = Math.abs(number);
  if (absolute < 999.5) return `${sign}${Math.round(absolute)}`;

  for (const [index, { limit, suffix }] of SCALES.entries()) {
    const scaled = absolute / limit;
    // Roll over before a unit would print "1000k" instead of "1M".
    if (scaled >= 999.5 && index < SCALES.length - 1) continue;
    // One decimal below 100 (1.2k, 12.3k), none above (123k): narrow columns.
    const text = scaled < 99.95 ? scaled.toFixed(1).replace(/\.0$/, "") : String(Math.round(scaled));
    return `${sign}${text}${suffix}`;
  }
  return `${sign}${Math.round(absolute)}`;
}
