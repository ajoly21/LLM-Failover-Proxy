import { c, log, ms } from "../logger.js";
import { proxiedFetch } from "../outbound.js";
import { tunnelInUse, withTunnel } from "./egress.js";
import { warpEnabled } from "./mode.js";
import { readState, restartTunnel } from "./tunnel.js";

/**
 * Getting a new exit address, without cutting anything that is using the old one.
 *
 * Cloudflare decides which address a WARP session egresses from when the session
 * is established, so the address is fixed for the life of the session and drawn
 * again by the next one. That makes a plain restart the lever, the identity
 * irrelevant, and roughly three restarts in ten a no-op — which is why this
 * checks whether the address actually moved instead of assuming it.
 */

/* ------------------------------------------------------------------ *
 * What address are we leaving from                                    *
 * ------------------------------------------------------------------ */

/**
 * Cloudflare's own trace endpoint, which is the honest place to ask: it is the
 * network already carrying the request, so nothing is told to a third party that
 * was not already handling the traffic.
 */
const TRACE_URL = "https://www.cloudflare.com/cdn-cgi/trace";
const TRACE_TIMEOUT_MS = 6000;

/**
 * The address the tunnel currently egresses from, or `null` if it cannot be had.
 *
 * One request, and only ever on the way to or from a rotation somebody asked
 * for — never per provider request. That is the difference between answering
 * "did this rotation do anything" and taxing every call to keep a figure fresh.
 */
export async function exitAddress(config) {
  const port = Number(readState(config.__file).httpPort) || config.warp.httpPort;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TRACE_TIMEOUT_MS);
  try {
    const response = await proxiedFetch(`http://127.0.0.1:${port}`)(TRACE_URL, { signal: controller.signal });
    if (!response.ok) return null;
    const trace = await response.text();
    const address = /^ip=(.+)$/m.exec(trace)?.[1]?.trim();
    return address || null;
  } catch {
    // A tunnel that is down, a network that refuses, a shape that changed: all of
    // them mean the same thing here, which is that the change cannot be confirmed.
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------------------------------------------ *
 * A new session, confirmed                                            *
 * ------------------------------------------------------------------ */

/**
 * Restarts the tunnel until it comes back on a different address, or until the
 * attempts run out.
 *
 * `changed` is three-valued on purpose. `true` and `false` are measurements;
 * `null` means the question could not be put — no tunnel to ask before, or the
 * trace did not answer — and saying so beats reporting a success nobody checked.
 *
 * @returns {Promise<{ok: boolean, changed: boolean|null, tries: number, before: string|null, after: string|null, detail?: string}>}
 */
export async function newSession(config, { attempts = 3, verify = true, restart = restartTunnel, probe = exitAddress, canRestart = null } = {}) {
  const before = verify ? await probe(config) : null;
  let after = null;
  let tries = 0;

  while (tries < Math.max(1, attempts)) {
    // Asked again immediately before each restart, and not only before the whole
    // thing. Reading the exit address takes a moment, and an attempt that got its
    // route just before the lock was taken can have started travelling through the
    // tunnel inside it — killing the process then would cut it, which is the one
    // outcome the gate exists to prevent. There is nothing to lose by waiting: the
    // next check comes round in seconds.
    if (canRestart && !canRestart()) return { ok: true, changed: null, deferred: true, tries, before, after: null };
    tries += 1;
    const started = await restart(config);
    if (started.status === "failed") {
      return { ok: false, changed: null, tries, before, after: null, detail: started.detail };
    }
    // Nothing to compare against: the restart happened, and that is all that can
    // honestly be reported.
    if (!verify || !before) return { ok: true, changed: null, tries, before, after: null };

    after = await probe(config);
    if (!after) return { ok: true, changed: null, tries, before, after: null };
    if (after !== before) return { ok: true, changed: true, tries, before, after };
    log.debug(`warp: still on ${after} after restart ${tries}/${attempts}`);
  }
  // Every attempt landed back on the same address. The pool at this colo is small,
  // so this is an ordinary outcome rather than a fault.
  return { ok: true, changed: false, tries, before, after };
}

/** One line describing a rotation, the same wherever it is reported. */
export function describeSession(result) {
  if (!result.ok) return `the tunnel did not come back up${result.detail ? `: ${result.detail}` : ""}`;
  if (result.deferred) return "put off: something started going through the tunnel";
  if (result.changed === true) return `now leaving from ${result.after} (was ${result.before})`;
  if (result.changed === false) return `still leaving from ${result.after} after ${result.tries} restart(s) — the pool at this colo is small`;
  return "the tunnel was restarted; the exit address could not be confirmed";
}

/* ------------------------------------------------------------------ *
 * Doing it when nothing is using the tunnel                           *
 * ------------------------------------------------------------------ */

/** How often the conditions are looked at. Rotations are minutes apart; this is cheap. */
const CHECK_MS = 15000;

/** The address is known to be throttled: rotate at the first quiet moment. */
let burned = false;

/**
 * A provider answered `429` to a request that went *through* the tunnel.
 *
 * The strongest signal there is that this exit address is worth leaving, and the
 * one a clock cannot give: an interval rotates when nothing needed it, and sits
 * still when something does.
 */
export function noteTunnelRateLimited() {
  burned = true;
}

export function rotationPending() {
  return burned;
}

/**
 * The signal has been acted on — or is being deliberately dropped.
 *
 * Cleared whatever the rotation achieved, including when it achieved nothing:
 * leaving it set would make every tick want a rotation for as long as the address
 * stayed the same, and the minimum interval is not there to absorb that.
 */
export function clearTunnelRateLimited() {
  burned = false;
}

/**
 * Whether now is the moment, and if not, why not.
 *
 * Kept a pure function of the four things that decide it, so the policy can be
 * checked without a clock, a tunnel or a provider. Everything below is plumbing.
 *
 * @returns {{go: boolean, why: string|null, holdOff: string|null}}
 */
export function rotationVerdict({ config, age, burned: throttled, inUse }) {
  if (!warpEnabled(config)) return { go: false, why: null, holdOff: "WARP is off" };

  const policy = config.warp.rotate;
  // `everyMs: 0` is not "never" — it is "only when the address is actually being
  // throttled", which is the trigger worth having. A clock rotates when nothing
  // needed it and sits still when something does.
  const aged = policy.everyMs > 0 && age >= policy.everyMs;
  if (!throttled && !aged) return { go: false, why: null, holdOff: "nothing is asking for a new address" };
  if (age < policy.minIntervalMs) return { go: false, why: null, holdOff: `only ${ms(age)} since the last one` };
  // The whole point. Anything travelling through the tunnel, and this waits: a
  // restart closes its sockets, and no address is worth a cut answer.
  if (inUse > 0) return { go: false, why: null, holdOff: `${inUse} request(s) still going through the tunnel` };

  return { go: true, why: throttled ? "the provider rate-limited this address" : `the session is ${ms(age)} old`, holdOff: null };
}

/**
 * Starts watching for a moment to get a new address in.
 *
 * The gate is nothing travelling through the tunnel right now — not "the proxy is
 * idle". Under `mode: "on-rate-limit"` those are very different: the tunnel
 * carries only the attempts that were rate-limited, so it is unused almost all of
 * the time even while the proxy is busy, and a window is never hard to find.
 * Nothing is ever forced: a tunnel that stays busy simply does not get rotated,
 * because forcing it is the one outcome this exists to avoid.
 *
 * @param {() => object} getConfig read per tick, so a hot reload takes effect
 * @returns {{stop: () => void}}
 */
export function startRotationSchedule(getConfig, { intervalMs = CHECK_MS, session = newSession, since = Date.now() } = {}) {
  // From now, not from zero: a proxy that has just started has a session drawn
  // seconds ago, and replacing it on the first tick would throw away a fresh
  // address to draw from the same small pool. `since` is how a test says "as if
  // this one had been running a while", without a config below its own floor.
  let lastAt = since;
  let running = false;

  const tick = async () => {
    if (running) return;
    const config = getConfig();
    const verdict = rotationVerdict({ config, age: Date.now() - lastAt, burned, inUse: tunnelInUse() });
    if (!verdict.go) {
      if (burned && verdict.holdOff) log.debug(`warp: a new address is due, ${verdict.holdOff}`);
      return;
    }

    running = true;
    try {
      const why = verdict.why;
      const result = await withTunnel(() =>
        // The gate again, from inside, right before each restart: `rotationVerdict`
        // above answered for the moment the tick began, and reading the exit
        // address happens between the two.
        session(config, { attempts: config.warp.rotate.attempts, canRestart: () => tunnelInUse() === 0 }),
      );
      // Somebody else held the tunnel: no harm, the next tick will find it free.
      if (result === null) return;

      // Nothing was replaced, so nothing has been spent: leave the clock and the
      // signal where they are, and the next tick tries again in seconds.
      if (result.deferred) {
        log.debug(`warp: ${describeSession(result)}`);
        return;
      }

      lastAt = Date.now();
      clearTunnelRateLimited();
      const line = `warp: new tunnel session (${why}) — ${describeSession(result)}`;
      if (result.ok) log.info(c.cyan(line));
      else log.warn(line);
    } catch (err) {
      log.warn(`warp: could not get a new session: ${err.message}`);
      lastAt = Date.now();
      clearTunnelRateLimited();
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => void tick(), intervalMs);
  // Never the reason the process stays alive.
  timer.unref?.();
  return { stop: () => clearInterval(timer) };
}
