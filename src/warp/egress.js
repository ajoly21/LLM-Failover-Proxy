import { processAlive } from "../daemon.js";
import { REASONS } from "../errors.js";
import { log } from "../logger.js";
import { proxiedFetch, retireTunnels } from "../outbound.js";
import { preferredVia } from "../state.js";
import { warpMode } from "./mode.js";
import { listening, readState, startTunnel } from "./tunnel.js";

/**
 * Which way a request leaves, and what a rate-limited attempt may try next.
 *
 * Two questions, and they used to be one. Routing everything through the tunnel
 * is decided once for a whole request: the answer is the same for every model in
 * the chain, so a single probe covers it. Escalating on a rate limit is not —
 * each model reaches its own quota at its own time, and the whole point is that
 * one of them going through the tunnel leaves the others exactly where they were.
 */

/* ------------------------------------------------------------------ *
 * Is the tunnel answering                                             *
 * ------------------------------------------------------------------ */

/**
 * Probing the tunnel costs a loopback connection, and a request that hedges asks
 * more than once. Two seconds is short enough that `warp up` in another terminal
 * is picked up while a person is still looking at the screen.
 */
const PROBE_TTL_MS = 2000;
let probe = { at: 0, port: null, up: false };

async function tunnelUp(configFile, port) {
  if (probe.port === port && Date.now() - probe.at < PROBE_TTL_MS) return probe.up;
  // Both checks, for the reason `tunnelStatus` sets out: a port that answers
  // without our own process behind it is somebody else's proxy, and provider
  // traffic must not be handed to it just because the number matched.
  const up = (await listening(port)) && processAlive(Number(readState(configFile).pid));
  probe = { at: Date.now(), port, up };
  return up;
}

/** Forces the next check to ask again: the tunnel just changed underneath us. */
function forgetProbe() {
  probe = { at: 0, port: null, up: false };
}

/** The tunnel just changed: forget what was known, and drop the old sockets. */
export function forgetTunnelProbe() {
  forgetProbe();
  failedAt = 0;
  // Pooled sockets through the old tunnel are worthless once it is replaced.
  // Retired rather than destroyed, so answers still in flight through it arrive.
  retireTunnels();
}

/* ------------------------------------------------------------------ *
 * Who is using it, and who is allowed to replace it                   *
 * ------------------------------------------------------------------ */

/**
 * Attempts currently travelling through the tunnel.
 *
 * Counted at the attempt level rather than around the `fetch`, because a streamed
 * answer is not finished when its promise resolves — it is finished when the body
 * has been read. Replacing the tunnel on the strength of the earlier moment would
 * cut a stream in half, which is the exact failure this counter exists to prevent.
 */
let inUse = 0;

export function tunnelInUse() {
  return inUse;
}

/** @returns {() => void} call it when the attempt is over, streaming included. */
export function holdTunnel() {
  inUse += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    inUse -= 1;
  };
}

/**
 * The one piece of work touching the tunnel process at a time.
 *
 * Starting it and replacing it are the same kind of act — a `stopTunnel` racing a
 * `startTunnel` would leave nobody able to say what is running — so they share a
 * lock rather than each having their own.
 *
 * Only within this process. `llmfp warp rotate` runs in its own, and the state
 * file plus `startTunnel`'s refusal to adopt a foreign port is all that
 * coordinates the two; a rotation typed in a terminal is still the caller's
 * choice of moment, which is what it has always been.
 *
 * @returns the work's value, or `null` when somebody else already holds it.
 */
let busy = null;

export function withTunnel(work) {
  if (busy) return Promise.resolve(null);
  busy = Promise.resolve()
    .then(work)
    .finally(() => {
      // Whatever it did, what was known about the tunnel no longer holds.
      forgetTunnelProbe();
      busy = null;
    });
  return busy;
}

function tunnelPort(config) {
  return Number(readState(config.__file).httpPort) || config.warp.httpPort;
}

/* ------------------------------------------------------------------ *
 * Bringing it up on demand                                            *
 * ------------------------------------------------------------------ */

/**
 * How long an escalating attempt is willing to wait for a tunnel that is not up.
 *
 * A first escalation on a fresh install downloads two binaries and registers a
 * WARP account, which is a minute the request waiting on it must not spend. So
 * the wait is bounded and the start is not: whoever asked reports the rate limit
 * it already has, and the tunnel carries on coming up for the next one to find.
 */
const START_BUDGET_MS = 3000;

/** It just failed to come up. Retrying on every 429 would tax every request. */
const START_RETRY_MS = 30000;

let failedAt = 0;

/** Waits `work` out, but not past the budget: the work carries on regardless. */
async function withinBudget(work) {
  let timer = null;
  try {
    return await Promise.race([
      work,
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(false), START_BUDGET_MS);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function ensureTunnel(config, requestId) {
  const port = tunnelPort(config);
  if (await tunnelUp(config.__file, port)) return true;
  if (failedAt && Date.now() - failedAt < START_RETRY_MS) return false;

  // Somebody is already starting it, or replacing it for a new exit address.
  // Waiting on them beats fighting over the process, and their answer is not
  // ours to interpret: ask the port afterwards.
  if (busy) {
    await withinBudget(busy);
    return await tunnelUp(config.__file, tunnelPort(config));
  }

  log.info(`[${requestId}] warp: bringing the tunnel up for a rate-limited attempt`);
  const started = withTunnel(async () => {
    try {
      const result = await startTunnel(config);
      const ok = result.status !== "failed";
      if (!ok) log.warn(`warp: the tunnel did not come up${result.detail ? `\n${result.detail}` : ""}`);
      failedAt = ok ? 0 : Date.now();
      return ok;
    } catch (err) {
      log.warn(`warp: ${err.message}`);
      failedAt = Date.now();
      return false;
    }
  });

  return (await withinBudget(started)) === true;
}

/* ------------------------------------------------------------------ *
 * What a failed attempt is allowed to do about it                     *
 * ------------------------------------------------------------------ */

/**
 * Whether a failure is worth trying again from another address.
 *
 * A rate limit and nothing else. It is the one failure where the identical
 * request, sent from somewhere else, plausibly succeeds — a 5xx would fail again,
 * a rejected parameter would fail again, and a bad key certainly would. A 403 is
 * the tempting case and stays out: "not available in your country" is exactly
 * what the tunnel fixes, an invalid key is not, and the status does not say which.
 */
export function worthEscalating(error) {
  return error?.reason === REASONS.RATE_LIMIT;
}

/* ------------------------------------------------------------------ *
 * The plan for one request                                            *
 * ------------------------------------------------------------------ */

/** The `fetch` to use for `path`. */
export function fetchVia(path) {
  return path.proxyUrl ? proxiedFetch(path.proxyUrl) : fetch;
}

/**
 * The path a whole request takes, when that is a question with one answer.
 *
 * @returns {Promise<{via: 'warp'|'direct', proxyUrl: string|null, escalates?: boolean, unavailable?: boolean, degraded?: boolean}>}
 */
export async function outboundPath(config) {
  const mode = warpMode(config);
  if (mode === "off") return { via: "direct", proxyUrl: null };

  // Held in reserve. Whether it is up is deliberately not asked here: a request
  // that never gets rate-limited must not pay for the probe, and the escalation
  // asks when it turns out to matter.
  if (mode === "on-rate-limit") return { via: "direct", proxyUrl: null, escalates: true };

  const port = tunnelPort(config);
  if (await tunnelUp(config.__file, port)) return { via: "warp", proxyUrl: `http://127.0.0.1:${port}` };

  // WARP is on and the tunnel is not. Falling back silently would send the
  // request from the address the user turned this on to hide, so it is a choice
  // they make explicitly and the stats record which way it went.
  if (config.warp.fallbackDirect) return { via: "direct", proxyUrl: null, degraded: true };
  return { via: "warp", proxyUrl: `http://127.0.0.1:${port}`, unavailable: true };
}

/**
 * How each attempt in one request may leave.
 *
 * Built once per request and asked per attempt. In every mode but
 * `on-rate-limit` it hands back the same route to everyone, which is what keeps
 * `/stats` able to say where a request left from. In `on-rate-limit` it hands
 * back a route per model: the tunnel to one the provider is currently throttling,
 * direct to the rest, and a `escalate()` a rate-limited attempt can call to move
 * itself — and only itself — onto the tunnel.
 */
export async function planEgress(config) {
  const path = await outboundPath(config);
  const base = { via: path.via, send: fetchVia(path) };

  if (!path.escalates) {
    return {
      via: path.via,
      unavailable: Boolean(path.unavailable),
      degraded: Boolean(path.degraded),
      escalates: false,
      routeFor: async () => base,
      escalate: async () => null,
    };
  }

  const url = `http://127.0.0.1:${tunnelPort(config)}`;
  // One route object, so several models escalating within the same request share
  // a socket pool instead of opening one each.
  let tunnel = null;
  const warpRoute = () => (tunnel ??= { via: "warp", send: proxiedFetch(url) });

  return {
    via: path.via,
    unavailable: false,
    degraded: false,
    escalates: true,
    /**
     * A model the provider rate-limited recently starts on the tunnel: the
     * window is still open, so asking directly first would spend a `429` to
     * learn what is already known.
     *
     * The tunnel is confirmed before being chosen, and only for an entry inside
     * that window — a probe is worth paying for exactly there, and nowhere else.
     * If it cannot be had, the direct route is still the better guess: another
     * 429 at worst, where a proxy that is not listening is a certain failure.
     */
    routeFor: async (entryId, requestId = "-") => {
      if (preferredVia(entryId) !== "warp") return base;
      return (await ensureTunnel(config, requestId)) ? { ...warpRoute(), preferred: true } : base;
    },
    /** Second chance for a rate-limited attempt, if the tunnel can be had quickly. */
    escalate: async (requestId = "-") => ((await ensureTunnel(config, requestId)) ? warpRoute() : null),
  };
}
