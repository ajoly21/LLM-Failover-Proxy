/**
 * `.env` support, without a dependency.
 *
 * Secrets never live in the configuration JSON: a provider stores the *name* of
 * the variable holding its key (`env:GROQ_API_KEY`), and the value comes from
 * the environment, either the real one, or a `.env` file loaded here. That way
 * the config can be committed, shared or pasted into an issue as is.
 */
import fs from "node:fs";
import path from "node:path";

const HEADER = [
  "# llm-failover-proxy, provider API keys.",
  "# This file holds secrets: keep it out of version control.",
  "# Copy .env.example to get the list of variables the default chain expects.",
  "",
].join("\n");

/** `KEY=value`, tolerating `export ` and surrounding spaces. */
const KEY_LINE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/;

/** Values this process took from a file: safe to refresh when the file changes. */
const owned = new Set();
let fileValues = {};

function unquote(raw) {
  const value = raw.trim();
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value
      .slice(1, -1)
      .replace(/\\n/g, "\n")
      .replace(/\\r/g, "\r")
      .replace(/\\t/g, "\t")
      .replace(/\\(["'\\])/g, "$1");
  }
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1);
  // Unquoted: ` #` starts a trailing comment. A bare `#` inside a token (as in
  // some API keys) is kept.
  const comment = value.indexOf(" #");
  return (comment === -1 ? value : value.slice(0, comment)).trim();
}

/** Parses `.env` text. Multi-line values are not supported, on purpose. */
export function parseEnv(text) {
  const values = {};
  for (const line of String(text).split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const match = KEY_LINE.exec(line);
    if (match) values[match[1]] = unquote(match[2]);
  }
  return values;
}

/** Quotes only when the value would otherwise be re-read differently. */
export function formatEnvValue(value) {
  const text = String(value ?? "");
  if (text === "") return "";
  return /^[A-Za-z0-9_@:%+=./~,-]+$/.test(text) ? text : JSON.stringify(text);
}

/** The `.env` that belongs to a config file: same directory. */
export function envPathFor(configFile) {
  return path.join(path.dirname(path.resolve(configFile)), ".env");
}

/**
 * Files that may provide keys, most significant first: `$LLM_PROXY_ENV`, the
 * working directory, then the folder holding the config (the one `npx` uses).
 */
export function envFileCandidates(configFile, cwd = process.cwd()) {
  const files = [];
  if (process.env.LLM_PROXY_ENV) files.push(path.resolve(process.env.LLM_PROXY_ENV));
  files.push(path.resolve(cwd, ".env"));
  if (configFile) files.push(envPathFor(configFile));
  return [...new Set(files)];
}

export function readEnvFile(file) {
  try {
    return parseEnv(fs.readFileSync(file, "utf8"));
  } catch {
    return null; // missing or unreadable: not an error, just no keys here
  }
}

/**
 * Exports values to `process.env`. A variable already set in the real
 * environment wins, except when this module is the one that set it, so a
 * reload after an edit is picked up.
 */
export function applyEnvValues(values) {
  const applied = [];
  for (const [name, value] of Object.entries(values)) {
    if (process.env[name] !== undefined && !owned.has(name)) continue;
    process.env[name] = String(value);
    owned.add(name);
    applied.push(name);
  }
  return applied;
}

/** Loads every candidate file. Earlier files win over later ones. */
export function loadEnvFiles({ configFile, cwd } = {}) {
  const files = [];
  const merged = {};
  for (const candidate of envFileCandidates(configFile, cwd)) {
    const values = readEnvFile(candidate);
    if (!values) continue;
    files.push(candidate);
    for (const [name, value] of Object.entries(values)) if (!(name in merged)) merged[name] = value;
  }
  fileValues = merged;
  return { files, keys: Object.keys(merged), applied: applyEnvValues(merged) };
}

/** Last value seen for a variable, file included. */
export function envValue(name) {
  return process.env[name] ?? fileValues[name] ?? null;
}

/**
 * Writes keys into a `.env`, keeping the rest of the file, comments and
 * unrelated variables included. Empty values are ignored rather than stored,
 * so skipping a provider during setup leaves no trace.
 */
export function upsertEnv(file, values, { apply = true } = {}) {
  const entries = Object.entries(values).filter(([, value]) => value != null && String(value) !== "");
  if (!entries.length) return { file, written: [] };

  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    text = HEADER;
  }

  const lines = text.split(/\r?\n/);
  const written = [];
  for (const [name, value] of entries) {
    const line = `${name}=${formatEnvValue(value)}`;
    const index = lines.findIndex((candidate) => KEY_LINE.exec(candidate)?.[1] === name);
    if (index === -1) {
      if (lines.at(-1)?.trim()) lines.push("");
      lines.push(line);
    } else {
      lines[index] = line;
    }
    written.push(name);
  }

  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${lines.join("\n").trimEnd()}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
  try {
    fs.chmodSync(file, 0o600); // no-op on Windows, meaningful elsewhere
  } catch {
    /* ignore */
  }

  if (apply) {
    for (const [name, value] of entries) {
      process.env[name] = String(value);
      owned.add(name);
      fileValues[name] = String(value);
    }
  }
  return { file, written };
}

/** Test seam: forgets what was loaded from files. */
export function resetEnvCache() {
  for (const name of owned) delete process.env[name];
  owned.clear();
  fileValues = {};
}
