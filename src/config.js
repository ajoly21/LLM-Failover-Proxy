import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { envValue } from "./env.js";

/** Uncommon port, away from the usual dev ranges (3000/5000/8000/8080/11434...). */
export const DEFAULT_PORT = 47821;

const APP_DIR = "llm-failover-proxy";

/** Config files looked up in the current directory, in order, before the user config dir. */
const LOCAL_FILENAMES = ["llm-proxy.config.json", "config.json"];

export const DEFAULTS = {
  version: 1,
  server: {
    host: "127.0.0.1",
    port: DEFAULT_PORT,
    // Key required from clients of the proxy (Authorization: Bearer ...). null = no auth.
    apiKey: null,
    cors: true,
    logLevel: "info", // debug | info | warn | error
  },
  failover: {
    // Hard limit for a non-streamed request.
    requestTimeoutMs: 15000,
    // Hard limit before the first usable token (streaming).
    firstTokenTimeoutMs: 15000,
    // Hard limit between two chunks once the stream has started.
    idleTimeoutMs: 60000,
    // Ask the next model in the chain when the ones already in flight have not
    // produced a usable answer within this delay, the earlier attempts keep
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
  probe: {
    // Deadline for one model or provider test from the terminal UI. Separate
    // from the request deadlines above: a benchmark that hangs should not be
    // governed by what production is willing to wait for, and vice versa.
    timeoutMs: 15000,
  },
  update: {
    // Ask the npm registry whether a newer version exists, when the UI opens or
    // `doctor` runs, and say so on the menu. The only outbound request this tool
    // makes on its own behalf; `false` stops it, so does LLM_PROXY_NO_UPDATE_CHECK.
    check: true,
  },
  providers: [],
  models: [],
  // Named chains you switch between. `models` above is the one in use; see
  // `syncTargets` for which of the two wins.
  modelLists: [],
  activeListId: null,
};

/**
 * The names these lists carried in a configuration file up to 1.6.
 *
 * A file holding them is read, renamed on the way in, and saved back under the
 * current names — so an install that predates the rename keeps its lists without
 * anyone having to touch the file. The id keeps its random half, which is what
 * makes `activeListId` still point at the same chain afterwards, and no history
 * is lost either way: the counters are keyed on model ids, never on a list id.
 *
 * Only the file changed names. The helpers below are still `*Target*`: they are
 * internal API, and renaming them would churn every caller for no byte anyone
 * outside this project ever sees.
 */
const LEGACY_KEYS = { lists: "targets", activeId: "activeTargetId" };
const LEGACY_ID = /^tgt_/;
const listId = (id) => (typeof id === "string" ? id.replace(LEGACY_ID, "lst_") : id);

/** Name given to the list that existing configurations are migrated into. */
export const DEFAULT_TARGET_NAME = "default";

function configHome() {
  if (process.platform === "win32" && process.env.APPDATA) return path.join(process.env.APPDATA, APP_DIR);
  if (process.env.XDG_CONFIG_HOME) return path.join(process.env.XDG_CONFIG_HOME, APP_DIR);
  return path.join(os.homedir(), ".config", APP_DIR);
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
  return path.join(configHome(), "config.json");
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
  const base = path.basename(configFile).replace(/\.json$/i, "");
  return path.join(dir, `${base}.stats.json`);
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Fills in missing keys from `defaults`, recursively, without touching present ones. */
function withDefaults(value, defaults) {
  if (!isPlainObject(defaults)) return value === undefined ? defaults : value;
  const out = isPlainObject(value) ? { ...value } : {};
  for (const [key, fallback] of Object.entries(defaults)) out[key] = withDefaults(out[key], fallback);
  return out;
}

export function newId(prefix) {
  return `${prefix}_${crypto.randomBytes(4).toString("hex")}`;
}

export function loadConfig(file = configPath()) {
  let raw = {};
  if (fs.existsSync(file)) {
    try {
      raw = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (err) {
      throw new Error(`Cannot read config (${file}): ${err.message}`);
    }
  }
  const config = withDefaults(raw, DEFAULTS);
  config.providers = Array.isArray(raw.providers) ? raw.providers.map(normalizeProvider) : [];
  config.models = Array.isArray(raw.models) ? raw.models.map(normalizeModel) : [];

  // The current names, or the ones a file written before the rename carries.
  const lists = Array.isArray(raw.modelLists) ? raw.modelLists : raw[LEGACY_KEYS.lists];
  config.modelLists = Array.isArray(lists) ? lists.map(normalizeTarget) : [];
  config.activeListId = listId(raw.activeListId ?? raw[LEGACY_KEYS.activeId] ?? null);
  // Read once and dropped, so the next save writes the new names only —
  // `withDefaults` copies every key it finds, this one included.
  delete config[LEGACY_KEYS.lists];
  delete config[LEGACY_KEYS.activeId];

  syncTargets(config);
  config.__file = file;
  return config;
}

export function saveConfig(config, file = config.__file || configPath()) {
  syncTargets(config);
  const { __file, ...clean } = config;
  clean.providers = clean.providers.map(normalizeProvider);
  clean.models = clean.models.map(normalizeModel);
  clean.modelLists = clean.modelLists.map(normalizeTarget);
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
    id: provider.id || newId("prov"),
    name: String(provider.name || "provider").trim(),
    type: provider.type === "anthropic" ? "anthropic" : "openai",
    baseUrl: String(provider.baseUrl || "").replace(/\/+$/, ""),
    apiKey: provider.apiKey ?? null,
    headers: isPlainObject(provider.headers) ? provider.headers : {},
    enabled: provider.enabled !== false,
  };
}

function normalizeModel(model) {
  return {
    id: model.id || newId("mdl"),
    providerId: model.providerId,
    model: String(model.model || "").trim(),
    alias: (model.alias || model.model || "").trim(),
    kind: model.kind === "embedding" ? "embedding" : "chat",
    enabled: model.enabled !== false,
    params: isPlainObject(model.params) ? model.params : {},
  };
}

function normalizeTarget(target) {
  return {
    id: listId(target.id) || newId("lst"),
    name: targetName(target.name),
    models: Array.isArray(target.models) ? target.models.map(normalizeModel) : [],
  };
}

/** A list with no name cannot be told from another, so it is never stored empty. */
function targetName(name, fallback = DEFAULT_TARGET_NAME) {
  return String(name ?? "").trim() || fallback;
}

/**
 * Reconciles the model lists with the chain in use.
 *
 * `config.models` stays the one source of truth for what the proxy serves: the
 * active list is a *mirror* of it, refreshed here on every load and save, and
 * the other lists are the stash holding the chains that are not in use. That way
 * a hand-edited `models` array — and every screen that mutates it — keeps working
 * without knowing model lists exist. `switchTarget` is the only thing allowed to
 * write in the other direction.
 */
function syncTargets(config) {
  if (!Array.isArray(config.modelLists) || !config.modelLists.length) {
    config.modelLists = [{ id: newId("lst"), name: DEFAULT_TARGET_NAME, models: [] }];
  }
  const active = config.modelLists.find((entry) => entry.id === config.activeListId) ?? config.modelLists[0];
  config.activeListId = active.id;
  active.models = config.models.map((entry) => ({ ...entry }));
  return config;
}

/** The list in use, where it sits in the lineup, and how many there are. */
export function activeTarget(config) {
  const targets = Array.isArray(config.modelLists) ? config.modelLists : [];
  const index = Math.max(0, targets.findIndex((entry) => entry.id === config.activeListId));
  return { target: targets[index] ?? null, index, total: targets.length };
}

/** Appends a list holding `models`, and makes it the one in use. */
function pushTarget(config, name, models) {
  syncTargets(config); // the chain on screen goes back into the list it belongs to
  const target = { id: newId("lst"), name: targetName(name, `list ${config.modelLists.length + 1}`), models };
  config.modelLists.push(target);
  config.activeListId = target.id;
  config.models = models.map((entry) => ({ ...entry }));
  return target;
}

/** Adds an empty list and makes it the one in use. Returns it. */
export function addTarget(config, name) {
  return pushTarget(config, name, []);
}

/**
 * Adds a copy of the chain in use — same models, same order — and switches to it,
 * for trying a variant of a list that already works.
 *
 * The copies are new entries with ids of their own, so each list keeps its own
 * counters: a variant starts from zero rather than inheriting traffic it never
 * served.
 */
export function copyTarget(config, name) {
  return pushTarget(
    config,
    name,
    config.models.map((entry) => ({ ...entry, id: newId("mdl") })),
  );
}

/**
 * Removes a list. The last one is never removed — something has to be served —
 * and removing the live one hands the chain over to the list that takes its place.
 */
export function deleteTarget(config, targetId) {
  if (!Array.isArray(config.modelLists) || config.modelLists.length < 2) return false;
  const index = config.modelLists.findIndex((entry) => entry.id === targetId);
  if (index < 0) return false;
  const wasActive = config.modelLists[index].id === config.activeListId;
  config.modelLists.splice(index, 1);
  if (wasActive) {
    const next = config.modelLists[Math.min(index, config.modelLists.length - 1)];
    config.activeListId = next.id;
    config.models = next.models.map((entry) => ({ ...entry }));
  }
  return true;
}

/**
 * Every model id any list holds — not just the live chain.
 *
 * What the counters are pruned against when the proxy starts: a model parked in
 * another list is not an obsolete one, and its history has to survive being
 * switched away from.
 */
export function knownModelIds(config) {
  const ids = new Set(config.models.map((entry) => entry.id));
  for (const target of Array.isArray(config.modelLists) ? config.modelLists : []) {
    for (const entry of target.models) ids.add(entry.id);
  }
  return ids;
}

export function renameTarget(config, targetId, name) {
  const target = config.modelLists.find((entry) => entry.id === targetId);
  if (!target) return false;
  target.name = targetName(name, target.name);
  return true;
}

/** Parks the current chain in its own list, then makes `targetId`'s chain the live one. */
export function switchTarget(config, targetId) {
  const next = config.modelLists.find((entry) => entry.id === targetId);
  if (!next || next.id === config.activeListId) return false;
  syncTargets(config);
  config.activeListId = next.id;
  config.models = next.models.map((entry) => ({ ...entry }));
  return true;
}

/** Switches to the list `delta` away, wrapping at both ends. */
export function cycleTarget(config, delta) {
  const { index, total } = activeTarget(config);
  if (total < 2) return false;
  return switchTarget(config, config.modelLists[(index + delta + total) % total].id);
}

/** An `env:NAME` value is read from the environment at call time, never stored. */
export function resolveSecret(value) {
  if (typeof value !== "string") return value ?? null;
  if (value.startsWith("env:")) return envValue(value.slice(4));
  return value;
}

/** Variable a provider's key is stored under: `azure-openai` → `AZURE_OPENAI_API_KEY`. */
export function envVarName(providerName) {
  const slug = String(providerName || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return `${slug || "PROVIDER"}_API_KEY`;
}

/**
 * How a stored key reads on screen. `state` drives the colour: a key kept in
 * the config file (`inline`) still works, but it is flagged so it can be moved
 * to the `.env` where it belongs.
 */
export function describeKey(apiKey) {
  if (!apiKey) return { state: "none", text: "none" };
  if (typeof apiKey === "string" && apiKey.startsWith("env:")) {
    const name = apiKey.slice(4);
    return envValue(name) ? { state: "env", text: `env:${name}`, envVar: name } : { state: "missing", text: `env:${name} missing`, envVar: name };
  }
  return { state: "inline", text: maskSecret(apiKey) };
}

export function maskSecret(value) {
  if (!value) return "(none)";
  if (typeof value === "string" && value.startsWith("env:")) {
    return `${value} → ${process.env[value.slice(4)] ? "set" : "MISSING"}`;
  }
  const text = String(value);
  if (text.length <= 8) return "*".repeat(text.length);
  return `${text.slice(0, 4)}${"*".repeat(Math.min(12, text.length - 8))}${text.slice(-4)}`;
}

/** Keys still sitting in the config file, which should be in the `.env` instead. */
export function inlineKeys(config) {
  const isInline = (value) => Boolean(value) && !(typeof value === "string" && value.startsWith("env:"));
  const found = config.providers.filter((provider) => isInline(provider.apiKey)).map((provider) => provider.name);
  if (isInline(config.server.apiKey)) found.push("the proxy itself");
  return found;
}

export function getProvider(config, providerId) {
  return config.providers.find((p) => p.id === providerId) || null;
}

export function providerLabel(config, providerId) {
  return getProvider(config, providerId)?.name ?? "(deleted provider)";
}

/** The order of `config.models` IS the priority order (index 0 = priority 1). */
export function moveModel(config, index, delta) {
  const target = index + delta;
  if (index < 0 || index >= config.models.length || target < 0 || target >= config.models.length) return false;
  const [item] = config.models.splice(index, 1);
  config.models.splice(target, 0, item);
  return true;
}
