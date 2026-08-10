import fs from "node:fs";
import path from "node:path";
import { REASONS } from "./errors.js";
import { log } from "./logger.js";

/** Per-model-entry runtime state: counters plus circuit breaker. */
const runtime = new Map();

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

/**
 * Not persisted on its own: the outcome of the same attempt follows within
 * milliseconds to seconds and writes both counters at once.
 */
export function recordStart(id) {
  const state = stateFor(id);
  state.requests += 1;
  state.lastUsedAt = Date.now();
}

export function recordSuccess(id, { latencyMs = null, tokens = 0 } = {}) {
  const state = stateFor(id);
  state.successes += 1;
  state.consecutiveFailures = 0;
  state.cooldownUntil = 0;
  state.cooldownReason = null;
  state.lastError = null;
  state.lastLatencyMs = latencyMs;
  state.tokens += tokens || 0;
  flushStats();
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
  log.debug(`stats restored for ${restored} entry(ies)${dropped ? `, ${dropped} obsolete dropped` : ""}`);
}

/** A stats file is user-editable and may be stale: never trust its shape. */
function sanitize(saved) {
  const num = (value, fallback = 0) => (Number.isFinite(Number(value)) ? Number(value) : fallback);
  const nullableNum = (value) => (value == null ? null : num(value));
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
  persistFile = null;
  writeFailureLogged = false;
  since = Date.now();
}
