import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { envPathFor, envValue, upsertEnv } from './env.js';

/** Uncommon port, away from the usual dev ranges (3000/5000/8000/8080/11434...). */
export const DEFAULT_PORT = 47821;

const APP_DIR = 'llm-failover-proxy';

/** Config files looked up in the current directory, in order, before the user config dir. */
const LOCAL_FILENAMES = ['llm-proxy.config.json', 'config.json'];

export const DEFAULTS = {
  version: 1,
  server: {
    host: '127.0.0.1',
    port: DEFAULT_PORT,
    // Key required from clients of the proxy (Authorization: Bearer ...). null = no auth.
    apiKey: null,
    cors: true,
    logLevel: 'info', // debug | info | warn | error
  },
  failover: {
    // Hard limit for a non-streamed request.
    requestTimeoutMs: 15000,
    // Hard limit before the first usable token (streaming).
    firstTokenTimeoutMs: 15000,
    // Hard limit between two chunks once the stream has started.
    idleTimeoutMs: 60000,
    // Ask the next model in the chain when the ones already in flight have not
    // produced a usable answer within this delay — the earlier attempts keep
    // running, and the first usable answer wins. 0 = strictly sequential.
    // Speculative attempts cost tokens on providers that answer too late.
    hedgeDelayMs: 5000,
    // Hard cap on concurrent attempts for one request. 1 disables hedging.
    maxInFlight: 3,
    // 0 = walk the whole chain.
    maxAttempts: 0,
    // Keep falling back to other models when the client asked for a specific one.
    crossModelFallback: true,
    // Treat `finish_reason: content_filter` as an unusable answer.
    treatContentFilterAsFailure: true,
    // When a streaming request fails on every provider, explain it inside the
    // stream (HTTP 200 + assistant content + an `error` chunk) instead of a bare
    // 502 that many clients render as an empty answer.
    streamErrorAsMessage: true,
    // Unknown model name → 404 instead of using the default chain.
    strictModelMatch: false,
    cooldown: {
      failuresBeforeTrip: 2, // consecutive failures before benching an entry
      baseMs: 15000,
      maxMs: 300000,
    },
  },
  providers: [],
  models: [],
};

function configHome() {
  if (process.platform === 'win32' && process.env.APPDATA) return path.join(process.env.APPDATA, APP_DIR);
  if (process.env.XDG_CONFIG_HOME) return path.join(process.env.XDG_CONFIG_HOME, APP_DIR);
  return path.join(os.homedir(), '.config', APP_DIR);
}

/**
 * Resolution order: `$LLM_PROXY_CONFIG`, then a config file in the current
 * directory, then the per-user config directory. The last one is what makes
 * `npx llm-failover-proxy` work: the package directory is disposable, so
 * nothing is ever written there.
 */
export function configPath() {
  if (process.env.LLM_PROXY_CONFIG) return path.resolve(process.env.LLM_PROXY_CONFIG);
  for (const name of LOCAL_FILENAMES) {
    const candidate = path.resolve(process.cwd(), name);
    if (fs.existsSync(candidate)) return candidate;
  }
  return path.join(configHome(), 'config.json');
}

export function configExists(file = configPath()) {
  return fs.existsSync(file);
}

/** Nothing configured yet: the terminal UI opens on the setup wizard. */
export function isFirstRun(config) {
  return !config.providers.length && !config.models.length;
}

/** Counters live next to their config: `config.json` → `config.stats.json`. */
export function statsPathFor(configFile = configPath()) {
  const dir = path.dirname(configFile);
  const base = path.basename(configFile).replace(/\.json$/i, '');
  return path.join(dir, `${base}.stats.json`);
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Fills in missing keys from `defaults`, recursively, without touching present ones. */
function withDefaults(value, defaults) {
  if (!isPlainObject(defaults)) return value === undefined ? defaults : value;
  const out = isPlainObject(value) ? { ...value } : {};
  for (const [key, fallback] of Object.entries(defaults)) out[key] = withDefaults(out[key], fallback);
  return out;
}

export function newId(prefix) {
  return `${prefix}_${crypto.randomBytes(4).toString('hex')}`;
}

export function loadConfig(file = configPath()) {
  let raw = {};
  if (fs.existsSync(file)) {
    try {
      raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
      throw new Error(`Cannot read config (${file}): ${err.message}`);
    }
  }
  const config = withDefaults(raw, DEFAULTS);
  config.providers = Array.isArray(raw.providers) ? raw.providers.map(normalizeProvider) : [];
  config.models = Array.isArray(raw.models) ? raw.models.map(normalizeModel) : [];
  config.__file = file;
  return config;
}

export function saveConfig(config, file = config.__file || configPath()) {
  const { __file, ...clean } = config;
  clean.providers = clean.providers.map(normalizeProvider);
  clean.models = clean.models.map(normalizeModel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(clean, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
  try {
    fs.chmodSync(file, 0o600); // no-op on Windows, meaningful elsewhere
  } catch {
    /* ignore */
  }
  config.__file = file;
  return file;
}

function normalizeProvider(provider) {
  return {
    id: provider.id || newId('prov'),
    name: String(provider.name || 'provider').trim(),
    type: provider.type === 'anthropic' ? 'anthropic' : 'openai',
    baseUrl: String(provider.baseUrl || '').replace(/\/+$/, ''),
    apiKey: provider.apiKey ?? null,
    headers: isPlainObject(provider.headers) ? provider.headers : {},
    enabled: provider.enabled !== false,
  };
}

function normalizeModel(model) {
  return {
    id: model.id || newId('mdl'),
    providerId: model.providerId,
    model: String(model.model || '').trim(),
    alias: (model.alias || model.model || '').trim(),
    kind: model.kind === 'embedding' ? 'embedding' : 'chat',
    enabled: model.enabled !== false,
    params: isPlainObject(model.params) ? model.params : {},
  };
}

/** An `env:NAME` value is read from the environment at call time, never stored. */
export function resolveSecret(value) {
  if (typeof value !== 'string') return value ?? null;
  if (value.startsWith('env:')) return envValue(value.slice(4));
  return value;
}

/** Variable a provider's key is stored under: `azure-openai` → `AZURE_OPENAI_API_KEY`. */
export function envVarName(providerName) {
  const slug = String(providerName || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return `${slug || 'PROVIDER'}_API_KEY`;
}

/**
 * How a stored key reads on screen. `state` drives the colour: a key kept in
 * the config file (`inline`) still works, but it is flagged so it can be moved
 * to the `.env` where it belongs.
 */
export function describeKey(apiKey) {
  if (!apiKey) return { state: 'none', text: 'none' };
  if (typeof apiKey === 'string' && apiKey.startsWith('env:')) {
    const name = apiKey.slice(4);
    return envValue(name)
      ? { state: 'env', text: `env:${name}`, envVar: name }
      : { state: 'missing', text: `env:${name} missing`, envVar: name };
  }
  return { state: 'inline', text: maskSecret(apiKey) };
}

export function maskSecret(value) {
  if (!value) return '(none)';
  if (typeof value === 'string' && value.startsWith('env:')) {
    return `${value} → ${process.env[value.slice(4)] ? 'set' : 'MISSING'}`;
  }
  const text = String(value);
  if (text.length <= 8) return '*'.repeat(text.length);
  return `${text.slice(0, 4)}${'*'.repeat(Math.min(12, text.length - 8))}${text.slice(-4)}`;
}

/** Keys still sitting in the config file, which should be in the `.env` instead. */
export function inlineKeys(config) {
  const isInline = (value) => Boolean(value) && !(typeof value === 'string' && value.startsWith('env:'));
  const found = config.providers.filter((provider) => isInline(provider.apiKey)).map((provider) => provider.name);
  if (isInline(config.server.apiKey)) found.push('the proxy itself');
  return found;
}

/**
 * Moves every key out of the config file and into the `.env` beside it,
 * replacing it with an `env:NAME` reference. Idempotent, and safe to run on a
 * config that has already been migrated.
 */
export function migrateKeys(config, file = config.__file || configPath()) {
  const envFile = envPathFor(file);
  const moved = [];

  for (const provider of config.providers) {
    const key = provider.apiKey;
    if (!key || (typeof key === 'string' && key.startsWith('env:'))) continue;
    const variable = envVarName(provider.name);
    upsertEnv(envFile, { [variable]: key });
    provider.apiKey = `env:${variable}`;
    moved.push({ target: provider.name, envVar: variable });
  }

  const serverKey = config.server.apiKey;
  if (serverKey && !(typeof serverKey === 'string' && serverKey.startsWith('env:'))) {
    upsertEnv(envFile, { LLM_PROXY_API_KEY: serverKey });
    config.server.apiKey = 'env:LLM_PROXY_API_KEY';
    moved.push({ target: 'the proxy itself', envVar: 'LLM_PROXY_API_KEY' });
  }

  if (moved.length) saveConfig(config, file);
  return { moved, envFile };
}

export function getProvider(config, providerId) {
  return config.providers.find((p) => p.id === providerId) || null;
}

export function providerLabel(config, providerId) {
  return getProvider(config, providerId)?.name ?? '(deleted provider)';
}

/** The order of `config.models` IS the priority order (index 0 = priority 1). */
export function moveModel(config, index, delta) {
  const target = index + delta;
  if (index < 0 || index >= config.models.length || target < 0 || target >= config.models.length) return false;
  const [item] = config.models.splice(index, 1);
  config.models.splice(target, 0, item);
  return true;
}
