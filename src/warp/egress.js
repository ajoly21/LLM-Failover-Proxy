import { log } from "../logger.js";
import { proxiedFetch } from "../outbound.js";
import { readState, writeState } from "./tunnel.js";

/**
 * Which address the providers see this machine as.
 *
 * The point of the whole feature is being able to answer "did that request
 * leave from the VPS or from WARP", and neither the config nor the tunnel state
 * can answer it: only something on the other side of the connection can. So one
 * lookup is made, on the very path a provider request would take, and cached.
 *
 * `cdn-cgi/trace` is Cloudflare's own echo endpoint: a few hundred bytes of
 * `key=value`, no API key, and it reports `warp=on` when the request really did
 * arrive through WARP — which is the part a plain IP echo could not confirm.
 *
 * One honest caveat, repeated in the README: WARP does not egress from a single
 * address. The IP below is the one *this* connection left from, and another
 * request may leave from a neighbouring one in the same Cloudflare range. It
 * answers "VPS or WARP", which is the question, not "the exact address provider
 * X logged for request Y".
 */

const TRACE_URL = "https://www.cloudflare.com/cdn-cgi/trace";
const TIMEOUT_MS = 5000;

/** Long enough that traffic does not turn this into a second request stream. */
export const EGRESS_TTL_MS = 10 * 60 * 1000;

export function parseTrace(text) {
  const values = new Map();
  for (const line of String(text).split("\n")) {
    const at = line.indexOf("=");
    if (at > 0) values.set(line.slice(0, at).trim(), line.slice(at + 1).trim());
  }
  const ip = values.get("ip");
  if (!ip) return null;
  return {
    ip,
    // `plus` is WARP+; both mean the tunnel carried it.
    warp: ["on", "plus"].includes(values.get("warp")),
    colo: values.get("colo") ?? null,
    loc: values.get("loc") ?? null,
  };
}

/**
 * Asks, over `proxyUrl` when given and directly when not.
 *
 * @returns {Promise<{ip: string, warp: boolean, colo: string|null, loc: string|null, via: string, at: number}|null>}
 */
export async function probeEgress({ proxyUrl = null, via = proxyUrl ? "warp" : "direct", timeoutMs = TIMEOUT_MS } = {}) {
  const send = proxyUrl ? proxiedFetch(proxyUrl) : fetch;
  try {
    const response = await send(TRACE_URL, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { "user-agent": "llm-failover-proxy" },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const trace = parseTrace(await response.text());
    if (!trace) throw new Error("unreadable trace response");
    return { ...trace, via, at: Date.now() };
  } catch (err) {
    log.debug(`warp: could not read the exit IP (${via}): ${err.message}`);
    return null;
  }
}

/** The last measurement, without asking anyone. `null` when there is none. */
export function cachedEgress(configFile) {
  const egress = readState(configFile).egress;
  return egress && typeof egress.ip === "string" ? egress : null;
}

export function isStale(egress, { via = null, ttlMs = EGRESS_TTL_MS } = {}) {
  if (!egress) return true;
  // A measurement of the other path answers a different question.
  if (via && egress.via !== via) return true;
  return Date.now() - Number(egress.at || 0) > ttlMs;
}

/**
 * Measures and stores. Callers that must not wait — a request being served —
 * should not await this.
 */
export async function refreshEgress(configFile, { proxyUrl = null, via = proxyUrl ? "warp" : "direct", timeoutMs } = {}) {
  const measured = await probeEgress({ proxyUrl, via, timeoutMs });
  if (measured) writeState(configFile, { egress: measured });
  return measured;
}

/** Guards against a burst of requests each starting their own lookup. */
let inFlight = null;

/**
 * Returns what is known now, and quietly brings it up to date for next time.
 *
 * Deliberately never awaits the lookup: this is called while answering a
 * request, and no report is worth adding a network round trip to somebody's
 * completion. The first request after a start therefore has no exit IP, and the
 * ones after it do.
 */
export function egressNow(configFile, { proxyUrl = null, via = proxyUrl ? "warp" : "direct", ttlMs = EGRESS_TTL_MS } = {}) {
  const known = cachedEgress(configFile);
  if (isStale(known, { via, ttlMs }) && !inFlight) {
    inFlight = refreshEgress(configFile, { proxyUrl, via }).finally(() => {
      inFlight = null;
    });
  }
  // Stale is still better than nothing, as long as it measured this same path.
  return known && known.via === via ? known : null;
}
