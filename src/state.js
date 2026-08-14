import fs from "node:fs";
import path from "node:path";
import { REASONS } from "./errors.js";
import { log } from "./logger.js";

/** Per-model-entry runtime state: counters plus circuit breaker. */
const runtime = new Map();

/**
 * The last answered requests, newest first: `{ id, at, ttftMs, via }`.
 *
 * Counters say how much a model has served; this says whether anything is
 * happening right now, and which model took it. Kept a little longer than any
 * screen shows, so a screen can ask for five and still have five after one is
 * deleted from the configuration.
 */
const RECENT_LIMIT = 12;
let recent = [];

const FILE_VERSION = 1;

let persistFile = null;
let since = Date.now();
let exitHookInstalled = false;
let writeFailureLogged = false;

function blank() {
  return {
    consecutiveFailures: 0,
    cooldownUntil: 0,
    cooldownReason: null,
    requests: 0,
    successes: 0,
    failures: 0,
    cancelled: 0,
    lastError: null,
    lastLatencyMs: null,
    lastUsedAt: null,
    tokens: 0,
    // Attempts this entry sent through the tunnel after being rate-limited.
    escalated: 0,
    // Until when this entry is known to be throttled on the direct route, so the
    // next request can start on the tunnel instead of spending a 429 to find out.
    warpUntil: 0,
  };
}

export function stateFor(id) {
  let state = runtime.get(id);
  if (!state) {
    state = blank();
    runtime.set(id, state);
  }
  return state;
}

export function isCoolingDown(id, now = Date.now()) {
  return stateFor(id).cooldownUntil > now;
}

export function cooldownRemaining(id, now = Date.now()) {
  return Math.max(0, stateFor(id).cooldownUntil - now);
}

/* ------------------------------------------------------------------ *
 * Which way this entry should leave                                   *
 * ------------------------------------------------------------------ */

/**
 * This entry was rate-limited on the direct route and retried through the tunnel.
 *
 * Remembering it is the whole economy of the thing: without this every single
 * request pays a `429` before escalating, and the quota the provider is
 * enforcing gets hit again and again for no gain. The window is what the provider
 * asked for in `Retry-After` when it said, and a short one otherwise.
 *
 * Not a cooldown, and deliberately kept apart from one: a benched entry is one
 * the chain steps over, this one is fully in play and merely leaves by a
 * different door.
 */
export function markRateLimited(id, { retryAfterMs = null, cooldown } = {}) {
  const { baseMs = 15000, maxMs = 300000 } = cooldown || {};
  const state = stateFor(id);
  state.escalated += 1;
  state.warpUntil = Date.now() + Math.min(retryAfterMs ?? baseMs, maxMs);
  flushStats();
  return state.warpUntil;
}

/**
 * The route this entry should try first.
 *
 * `direct` once the window has passed, always — the quota may well have refilled,
 * and a preference that never expired would leave a model on the tunnel for the
 * rest of the process's life because of one 429 an hour ago.
 *
 * @returns {'direct'|'warp'}
 */
export function preferredVia(id, now = Date.now()) {
  return stateFor(id).warpUntil > now ? "warp" : "direct";
}

/**
 * Not persisted on its own: the outcome of the same attempt follows within
 * milliseconds to seconds and writes both counters at once.
 */
export function recordStart(id) {
  const state = stateFor(id);
  state.requests += 1;
}

export function recordSuccess(id, { latencyMs = null, ttftMs = null, tokens = 0, via = null, escalated = false } = {}) {
  const state = stateFor(id);
  state.successes += 1;
  state.consecutiveFailures = 0;
  state.cooldownUntil = 0;
  state.cooldownReason = null;
  state.lastError = null;
  state.lastLatencyMs = latencyMs;
  // The direct route answered, so whatever quota closed it has reopened: stop
  // sending this entry through the tunnel. An answer that came *through* the
  // tunnel says nothing of the sort and leaves the window where it was.
  if (via === "direct") state.warpUntil = 0;
  // Stamped on the answer, not on the attempt: a model that was asked and then
  // dropped for losing a race was never used, and saying "used 3s ago" about it
  // would be the wrong answer to "is this model pulling its weight".
  state.lastUsedAt = Date.now();
  state.tokens += tokens || 0;
  // Kept per call rather than per model: the point of the list is what the last
  // few requests felt like, and an average hides exactly the one that was slow.
  // `via` says which way the request left, which is per call too: a WARP tunnel
  // can come up, go down or be rotated between two of these rows.
  recent.unshift({
    id,
    at: state.lastUsedAt,
    ttftMs: nullableNum(ttftMs),
    via: via ?? null,
    // Whether that path was the one asked for or the one fallen back on. A row
    // reading `warp` under `mode: "on-rate-limit"` is only legible with this.
    escalated: Boolean(escalated),
  });
  if (recent.length > RECENT_LIMIT) recent.length = RECENT_LIMIT;
  flushStats();
}

/** The last answered requests, newest first. */
export function recentCalls(limit = RECENT_LIMIT) {
  return recent.slice(0, Math.max(0, limit));
}

/**
 * A speculative attempt that lost the race. Deliberately neither a success nor
 * a failure: it says nothing about the provider's health, so it must never feed
 * the circuit breaker.
 */
export function recordCancelled(id) {
  const state = stateFor(id);
  state.cancelled += 1;
  flushStats();
}

/** @returns {number} cooldown applied, in ms (0 = entry stays available). */
export function recordFailure(id, { reason, message, retryAfterMs = null, cooldown }) {
  const state = stateFor(id);
  state.failures += 1;
  state.consecutiveFailures += 1;
  state.lastError = { reason, message: String(message || "").slice(0, 400), at: Date.now() };

  const { failuresBeforeTrip = 2, baseMs = 15000, maxMs = 300000 } = cooldown || {};
  let pause = 0;
  if (reason === REASONS.RATE_LIMIT) {
    // A 429 benches the entry right away, for as long as the provider asked.
    pause = retryAfterMs != null ? Math.min(retryAfterMs, maxMs) : baseMs;
  } else if (reason === REASONS.AUTH) {
    pause = Math.min(maxMs, baseMs * 4); // bad credentials: retrying is pointless
  } else if (state.consecutiveFailures >= failuresBeforeTrip) {
    const over = state.consecutiveFailures - failuresBeforeTrip;
    pause = Math.min(maxMs, baseMs * 2 ** over);
  }
  if (pause > 0) {
    state.cooldownUntil = Date.now() + pause;
    state.cooldownReason = reason;
  }
  flushStats();
  return pause;
}

export function snapshot() {
  const now = Date.now();
  const out = {};
  for (const [id, state] of runtime) out[id] = { ...state, coolingDown: state.cooldownUntil > now };
  return out;
}

/** Timestamp the current counters started accumulating from. */
export function statsSince() {
  return since;
}

/** A row of counters for an entry nothing has been recorded against yet. */
const NO_COUNTERS = {
  requests: 0,
  successes: 0,
  failures: 0,
  cancelled: 0,
  tokens: 0,
  escalated: 0,
  lastLatencyMs: null,
  lastUsedAt: null,
  coolingDown: false,
  cooldownMsLeft: 0,
  lastError: null,
};

/**
 * Puts a `/stats` chain in the order of `config.models`, which is the priority
 * order every other screen shows.
 *
 * The counters come from whichever proxy answers on the port, and it numbers them
 * from *its* configuration: a background instance still serving an older file, or
 * a different file altogether, reports an order of its own. Matching by id — then
 * by provider and model, for a proxy too old to send one — makes the numbering
 * this reader's own. Entries the answering proxy has and this configuration does
 * not are kept at the end rather than hidden.
 */
export function alignChain(models, chain, providerName) {
  const rows = Array.isArray(chain) ? chain : [];
  const byId = new Map(rows.filter((row) => row.id).map((row) => [row.id, row]));
  const target = (provider, model) => `${provider}/${model}`.toLowerCase();
  const byTarget = new Map(rows.map((row) => [target(row.provider, row.model), row]));

  const taken = new Set();
  const aligned = models.map((entry, index) => {
    const provider = providerName(entry.providerId);
    const found = byId.get(entry.id) ?? byTarget.get(target(provider, entry.model));
    if (found) taken.add(found);
    return { ...NO_COUNTERS, ...found, id: entry.id, priority: index + 1, provider, model: entry.model, alias: entry.alias, kind: entry.kind };
  });

  const extra = rows.filter((row) => !taken.has(row));
  return [...aligned, ...extra.map((row, index) => ({ ...row, priority: aligned.length + index + 1 }))];
}

export function statsFile() {
  return persistFile;
}

/* ------------------------------------------------------------------ *
 * Persistence                                                         *
 * ------------------------------------------------------------------ */

/**
 * Binds the in-memory state to a file so counters and cooldowns survive a
 * restart: a provider benched by a `429` with a long `Retry-After` must not
 * become available again just because the proxy was restarted.
 *
 * @param {string|null} file      target file, or null to stay in memory only
 * @param {Set<string>} knownIds  ids still present in the config; anything else
 *                                is dropped, so deleted models do not linger
 */
export function enableStatsPersistence(file, { knownIds = null } = {}) {
  persistFile = file || null;
  writeFailureLogged = false;
  if (!persistFile) return;

  restoreFrom(persistFile, knownIds);

  if (!exitHookInstalled) {
    exitHookInstalled = true;
    // `exit` covers SIGINT/SIGTERM (both end in process.exit) and normal exits.
    process.on("exit", () => flushStats());
  }
}

function restoreFrom(file, knownIds) {
  if (!fs.existsSync(file)) return;

  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    log.warn(`ignoring unreadable stats file (${file}): ${err.message}`);
    return;
  }
  if (!raw || typeof raw !== "object" || !raw.entries || typeof raw.entries !== "object") return;
  if (Number.isFinite(raw.since)) since = raw.since;

  let restored = 0;
  let dropped = 0;
  for (const [id, saved] of Object.entries(raw.entries)) {
    if (knownIds && !knownIds.has(id)) {
      dropped += 1;
      continue;
    }
    runtime.set(id, sanitize(saved));
    restored += 1;
  }

  // Same treatment as the counters: user-editable, possibly stale, and entries
  // for models that no longer exist are of no use to anyone.
  if (Array.isArray(raw.recent)) {
    recent = raw.recent
      .filter((call) => call && typeof call.id === "string" && Number.isFinite(Number(call.at)))
      .filter((call) => !knownIds || knownIds.has(call.id))
      .slice(0, RECENT_LIMIT)
      .map((call) => ({
        id: call.id,
        at: Number(call.at),
        ttftMs: nullableNum(call.ttftMs),
        // Absent from every file written before WARP existed, which is a row
        // whose path is simply unknown — not one that went out directly.
        via: typeof call.via === "string" ? call.via : null,
        escalated: call.escalated === true,
      }));
  }
  log.debug(`stats restored for ${restored} entry(ies)${dropped ? `, ${dropped} obsolete dropped` : ""}`);
}

const num = (value, fallback = 0) => (Number.isFinite(Number(value)) ? Number(value) : fallback);
/** A measurement that may legitimately be missing stays missing, never becomes 0. */
const nullableNum = (value) => (value == null ? null : num(value));

/** A stats file is user-editable and may be stale: never trust its shape. */
function sanitize(saved) {
  const state = blank();

  state.consecutiveFailures = Math.max(0, num(saved?.consecutiveFailures));
  state.cooldownUntil = Math.max(0, num(saved?.cooldownUntil));
  state.cooldownReason = typeof saved?.cooldownReason === "string" ? saved.cooldownReason : null;
  state.requests = Math.max(0, num(saved?.requests));
  state.successes = Math.max(0, num(saved?.successes));
  state.failures = Math.max(0, num(saved?.failures));
  state.cancelled = Math.max(0, num(saved?.cancelled));
  state.tokens = Math.max(0, num(saved?.tokens));
  state.lastLatencyMs = nullableNum(saved?.lastLatencyMs);
  state.lastUsedAt = nullableNum(saved?.lastUsedAt);
  state.escalated = Math.max(0, num(saved?.escalated));
  // Restored for the same reason a cooldown is: a `Retry-After` of an hour must
  // not be forgotten just because the proxy was restarted inside it.
  state.warpUntil = Math.max(0, num(saved?.warpUntil));

  const lastError = saved?.lastError;
  if (lastError && typeof lastError === "object" && typeof lastError.reason === "string") {
    state.lastError = {
      reason: lastError.reason,
      message: String(lastError.message || "").slice(0, 400),
      at: num(lastError.at, Date.now()),
    };
  }
  return state;
}

/**
 * Writes the current state now. Synchronous on purpose: it must also work from
 * an `exit` handler, and it runs once per finished attempt, an LLM call lasts
 * orders of magnitude longer than writing this file. Deferring it behind a
 * timer instead would lose whatever a hard kill interrupts (and a hard kill is
 * exactly what cannot be caught on Windows).
 */
export function flushStats() {
  if (!persistFile) return;
  const payload = {
    version: FILE_VERSION,
    since,
    updatedAt: Date.now(),
    entries: Object.fromEntries(runtime),
    recent,
  };
  try {
    fs.mkdirSync(path.dirname(persistFile), { recursive: true });
    const tmp = `${persistFile}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(tmp, persistFile);
  } catch (err) {
    // Stats are not worth failing a request over: warn once, keep serving.
    if (!writeFailureLogged) {
      writeFailureLogged = true;
      log.warn(`could not persist stats to ${persistFile}: ${err.message}`);
    }
  }
}

/** Drops everything, including the file binding (used by tests). */
export function resetAll() {
  runtime.clear();
  recent = [];
  persistFile = null;
  writeFailureLogged = false;
  since = Date.now();
}
