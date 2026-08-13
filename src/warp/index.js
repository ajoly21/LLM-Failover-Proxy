import { processAlive } from "../daemon.js";
import { log } from "../logger.js";
import { proxiedFetch, resetTunnels } from "../outbound.js";
import { supported } from "./platform.js";
import { warpDir, warpPaths } from "./paths.js";
import { listening, proxyUrl, readState, rotateTunnel, startTunnel, stopTunnel, tunnelLogTail, tunnelStatus } from "./tunnel.js";

export { UnsupportedPlatformError, WGCF_VERSION, WIREPROXY_VERSION, supported } from "./platform.js";
export { warpDir, warpPaths } from "./paths.js";
export { proxyUrl, readState, rotateTunnel, startTunnel, stopTunnel, tunnelLogTail, tunnelStatus } from "./tunnel.js";

/**
 * Whether the providers are reached through Cloudflare WARP, and how.
 *
 * The default is off, and off costs nothing: no binary is downloaded, no process
 * runs, and requests go out exactly as they did before this module existed. An
 * install that upgrades into this version behaves identically until somebody
 * turns it on.
 */
export function warpEnabled(config) {
  return Boolean(config?.warp?.enabled);
}

/* ------------------------------------------------------------------ *
 * Which way out                                                       *
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
export function forgetTunnelProbe() {
  probe = { at: 0, port: null, up: false };
  // Sockets pooled through the old tunnel are worthless once it is replaced.
  resetTunnels();
}

/**
 * The path this request should take, decided once for the whole request rather
 * than per attempt — a chain that failed over halfway would otherwise be half
 * reported as WARP and half as direct, and the stats would say neither.
 *
 * @returns {Promise<{via: 'warp'|'direct', proxyUrl: string|null, unavailable?: boolean, degraded?: boolean}>}
 */
export async function outboundPath(config) {
  if (!warpEnabled(config)) return { via: "direct", proxyUrl: null };

  const port = Number(readState(config.__file).httpPort) || config.warp.httpPort;
  if (await tunnelUp(config.__file, port)) return { via: "warp", proxyUrl: `http://127.0.0.1:${port}` };

  // WARP is on and the tunnel is not. Falling back silently would send the
  // request from the address the user turned this on to hide, so it is a choice
  // they make explicitly and the stats record which way it went.
  if (config.warp.fallbackDirect) return { via: "direct", proxyUrl: null, degraded: true };
  return { via: "warp", proxyUrl: `http://127.0.0.1:${port}`, unavailable: true };
}

/** The `fetch` to use for `path`. */
export function fetchVia(path) {
  return path.proxyUrl ? proxiedFetch(path.proxyUrl) : fetch;
}

/* ------------------------------------------------------------------ *
 * Lifecycle, driven by the configuration                              *
 * ------------------------------------------------------------------ */

/**
 * Brings the tunnel in line with `config.warp.enabled`.
 *
 * Called when the proxy starts and again whenever the configuration file
 * changes, which is what makes the toggle in the Settings screen take effect on
 * a running server without anyone restarting anything. Never throws: WARP
 * failing to install must not stop the proxy from serving, it must be reported.
 *
 * @returns {Promise<{action: string, detail?: string}>}
 */
export async function syncTunnel(config) {
  const enabled = warpEnabled(config);
  const state = readState(config.__file);

  if (!enabled) {
    if (!state.pid) return { action: "idle" };
    const stopped = await stopTunnel(config);
    forgetTunnelProbe();
    if (stopped.status === "stopped") log.info("warp: disabled, tunnel stopped");
    return { action: "stopped" };
  }

  const platform = supported();
  if (!platform.ok) {
    log.warn(`warp: ${platform.reason}, requests keep going out directly`);
    return { action: "unsupported", detail: platform.reason };
  }

  try {
    const result = await startTunnel(config);
    forgetTunnelProbe();
    if (result.status === "failed") {
      log.error(`warp: the tunnel did not come up${result.detail ? `\n${result.detail}` : ""}`);
      return { action: "failed", detail: result.detail };
    }
    return { action: result.status };
  } catch (err) {
    log.error(`warp: ${err.message}`);
    return { action: "failed", detail: err.message };
  }
}

/**
 * `warp rotate`: a new WARP identity, hence a new exit address.
 *
 * What the new address *is* is deliberately not reported: WARP does not egress
 * from a single one, so any figure printed here would be the address one probe
 * happened to leave from and not the one the next request will use. What can
 * honestly be said is that the identity was replaced and the tunnel came back up.
 */
export async function rotate(config) {
  const result = await rotateTunnel(config);
  forgetTunnelProbe();
  if (result.status === "failed") return { ok: false, ...result };
  return { ok: true, ...result };
}

/**
 * The WARP side of `/stats`, from the configuration and the state file only.
 *
 * Deliberately does no probing: `/stats` is polled every couple of seconds by
 * the Status screen, and a loopback connection per poll to answer a question the
 * state file already answers would be a waste. `warpReport` checks the port.
 */
export function warpSummary(config) {
  if (!warpEnabled(config)) return { enabled: false };
  const state = readState(config.__file);
  return {
    enabled: true,
    httpPort: Number(state.httpPort) || config.warp.httpPort,
    socksPort: Number(state.socksPort) || config.warp.socksPort,
    endpoint: state.endpoint ?? config.warp.endpoint,
    pid: Number(state.pid) || null,
    // `kill(pid, 0)` and nothing more: enough to tell "the tunnel is gone" from
    // "it is up", without the loopback connection a real probe would cost.
    alive: processAlive(Number(state.pid)),
    startedAt: state.startedAt ?? null,
    rotatedAt: state.rotatedAt ?? null,
    fallbackDirect: Boolean(config.warp.fallbackDirect),
  };
}

/** Everything `status`, `doctor` and the UI need to describe the WARP side. */
export async function warpReport(config) {
  const platform = supported();
  const status = await tunnelStatus(config);
  return {
    enabled: warpEnabled(config),
    supported: platform.ok,
    unsupportedReason: platform.reason,
    running: status.running,
    // The port is taken, but not by us. Reported rather than folded into "down":
    // the fix is different, and so is the risk of guessing.
    foreign: Boolean(status.foreign),
    pid: status.pid,
    socksPort: status.socksPort,
    httpPort: status.httpPort,
    endpoint: status.endpoint,
    startedAt: status.startedAt,
    rotatedAt: status.rotatedAt,
    proxyUrl: proxyUrl(config, status),
    socksUrl: `socks5://127.0.0.1:${status.socksPort}`,
    dir: warpDir(config.__file),
    logFile: warpPaths(config.__file).log,
  };
}
