import { processAlive } from "../daemon.js";
import { log } from "../logger.js";
import { forgetTunnelProbe, withTunnel } from "./egress.js";
import { warpEnabled, warpMode } from "./mode.js";
import { supported } from "./platform.js";
import { warpDir, warpPaths } from "./paths.js";
import { describeSession, newSession } from "./rotate.js";
import { proxyUrl, readState, resetIdentity, startTunnel, stopTunnel, tunnelLogTail, tunnelStatus } from "./tunnel.js";

export { fetchVia, forgetTunnelProbe, holdTunnel, outboundPath, planEgress, tunnelInUse, withTunnel, worthEscalating } from "./egress.js";
export { warpEnabled, warpMode } from "./mode.js";
export { UnsupportedPlatformError, WGCF_VERSION, WIREPROXY_VERSION, supported } from "./platform.js";
export { warpDir, warpPaths } from "./paths.js";
export { clearTunnelRateLimited, describeSession, exitAddress, newSession, noteTunnelRateLimited, rotationPending, rotationVerdict, startRotationSchedule } from "./rotate.js";
export { proxyUrl, readState, resetIdentity, restartTunnel, startTunnel, stopTunnel, tunnelLogTail, tunnelStatus } from "./tunnel.js";

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
 * Both modes start the tunnel, `on-rate-limit` included. A wireproxy sitting
 * there with nothing going through it costs one idle process, and it is what
 * spares the first rate-limited attempt the wait for one to come up.
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
    // Only when the tunnel actually moved. An unrelated WARP setting saved from
    // the Settings screen adopts the serving tunnel and reaches here as
    // `already-running`: retiring a healthy socket pool for that would make every
    // request that follows pay for a fresh handshake, for no change at all.
    if (result.status !== "already-running") forgetTunnelProbe();
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
 * `warp rotate`: a new tunnel session, hence in all likelihood a new exit address.
 *
 * The identity is left alone, because it turns out to have nothing to do with the
 * address — Cloudflare draws that when a session is established. See
 * `restartTunnel` for the measurements. `resetIdentity` is the separate command
 * for the separate problem of credentials that must not be used again.
 *
 * The new address *is* reported, which an earlier version of this refused to do on
 * the grounds that WARP does not egress from a single address. It does, per
 * session: ten requests through one session all left from the same one. So the
 * question has an answer, and one trace request on the way in and out is what
 * turns "the tunnel was restarted" into "it now leaves from somewhere else" —
 * worth knowing, since roughly three restarts in ten change nothing.
 */
export async function rotate(config, options = {}) {
  // Through the lock, so a rotation cannot land in the middle of this process
  // bringing the tunnel up for a rate-limited attempt.
  const result = await withTunnel(() => newSession(config, options));
  if (result === null) return { ok: false, changed: null, tries: 0, before: null, after: null, detail: "the tunnel is busy being started or replaced" };
  return result;
}

/** `warp reset-identity`: throw the WARP device registration away. */
export async function resetWarpIdentity(config) {
  const result = await withTunnel(async () => {
    const started = await resetIdentity(config);
    return started.status === "failed" ? { ok: false, detail: started.detail } : { ok: true, ...started };
  });
  if (result === null) return { ok: false, detail: "the tunnel is busy being started or replaced" };
  return result;
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
    // What the `via` of each row below is allowed to be: under `always` every
    // row says warp, under `on-rate-limit` a row saying warp is a model that hit
    // its quota and was retried through the tunnel.
    mode: warpMode(config),
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
    mode: warpMode(config),
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
