import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { processAlive } from "../daemon.js";
import { log } from "../logger.js";
import { ensureBinaries, ensureIdentity, writeTunnelConfig } from "./binaries.js";
import { downloads } from "./platform.js";
import { warpPaths } from "./paths.js";

const STATE_VERSION = 1;
const START_TIMEOUT_MS = 45000;
const STOP_TIMEOUT_MS = 8000;
const MAX_LOG_BYTES = 512 * 1024;

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* ------------------------------------------------------------------ *
 * State file                                                          *
 * ------------------------------------------------------------------ */

/**
 * What is running, and on which ports.
 *
 * A file rather than memory because two processes take part: the proxy serves
 * requests through the tunnel, while `llmfp warp rotate` — a separate, short
 * lived process — replaces the identity underneath it. The file is how the
 * running proxy finds out, with no IPC to keep alive.
 */
export function readState(configFile) {
  try {
    const raw = JSON.parse(fs.readFileSync(warpPaths(configFile).state, "utf8"));
    return raw && typeof raw === "object" ? raw : {};
  } catch {
    return {};
  }
}

export function writeState(configFile, patch) {
  const file = warpPaths(configFile).state;
  const next = { ...readState(configFile), ...patch, version: STATE_VERSION };
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch {
    /* losing this file costs `warp status` its detail, never a request */
  }
  return next;
}

/* ------------------------------------------------------------------ *
 * Liveness                                                            *
 * ------------------------------------------------------------------ */

/** Whether something accepts connections there, which is the only proof that counts. */
export function listening(port, host = "127.0.0.1", timeoutMs = 500) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host });
    const done = (answer) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(answer);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

/**
 * Is the tunnel usable right now, and on which ports.
 *
 * Two things have to hold, and neither is enough alone. A listening port proves
 * something is there, but not that it is ours: anything at all could hold 25345,
 * and pointing provider traffic into an unknown local proxy is worse than
 * failing. A live pid proves our process exists, but not that it finished
 * binding, and after a reboot a recycled pid proves nothing at all.
 *
 * `foreign` is the interesting third case — port taken, not by us — which gets
 * its own message instead of a bind error nobody can act on.
 */
export async function tunnelStatus(config) {
  const state = readState(config.__file);
  const httpPort = Number(state.httpPort) || config.warp.httpPort;
  const socksPort = Number(state.socksPort) || config.warp.socksPort;
  const pid = Number(state.pid) || null;
  const alive = processAlive(pid);
  const bound = await listening(httpPort);
  return {
    running: bound && alive,
    foreign: bound && !alive,
    pid,
    alive,
    httpPort,
    socksPort,
    endpoint: state.endpoint ?? config.warp.endpoint,
    startedAt: state.startedAt ?? null,
    rotatedAt: state.rotatedAt ?? null,
    // A tunnel started for other ports than the ones now configured has to be
    // replaced, or the proxy would keep using the old one for ever.
    stale: bound && alive && (httpPort !== config.warp.httpPort || socksPort !== config.warp.socksPort),
  };
}

/** Where the outbound requests are pointed. */
export function proxyUrl(config, status = null) {
  return `http://127.0.0.1:${status?.httpPort ?? config.warp.httpPort}`;
}

/* ------------------------------------------------------------------ *
 * Start / stop                                                        *
 * ------------------------------------------------------------------ */

function openLog(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try {
    if (fs.statSync(file).size > MAX_LOG_BYTES) fs.truncateSync(file, 0);
  } catch {
    /* no log yet */
  }
  return fs.openSync(file, "a");
}

/** The end of the tunnel log, to explain a start that never came up. */
export function tunnelLogTail(configFile, lines = 12) {
  try {
    const text = fs.readFileSync(warpPaths(configFile).log, "utf8");
    return text
      .split(/\r?\n/)
      .filter(Boolean)
      .slice(-lines)
      .join("\n");
  } catch {
    return "";
  }
}

/**
 * Brings the tunnel up, installing and registering whatever is missing first.
 *
 * Idempotent: an already-serving tunnel on the configured ports is adopted, so
 * the proxy, the UI and `warp up` can all call this without fighting over one
 * process. The child is detached and outlives its parent on purpose — the tunnel
 * belongs to the configuration, not to whichever process happened to start it,
 * and a `restart` of the proxy should not drop every connection through it.
 *
 * @returns {Promise<{status: 'already-running'|'started', detail?: string} & Awaited<ReturnType<typeof tunnelStatus>>>}
 */
export async function startTunnel(config, { timeoutMs = START_TIMEOUT_MS } = {}) {
  const configFile = config.__file;
  const current = await tunnelStatus(config);
  if (current.running && !current.stale) return { status: "already-running", ...current };
  if (current.foreign) {
    // Spawning here would fail on the bind with a message about an address in
    // use, which says nothing about what to do. This does.
    return {
      status: "failed",
      ...current,
      detail:
        `Something else is already listening on 127.0.0.1:${config.warp.httpPort}, and it is not a tunnel this proxy started. ` +
        "Free that port, or set another one in the `warp` section of the configuration file.",
    };
  }
  if (current.stale) {
    log.info(`warp: ports changed, restarting the tunnel on ${config.warp.httpPort}`);
    await stopTunnel(config);
  }

  const plan = downloads(); // UnsupportedPlatformError on a platform with no build
  const { paths } = await ensureBinaries(configFile);
  await ensureIdentity(configFile, { plan });
  writeTunnelConfig(configFile, config.warp, { plan });

  const fd = openLog(paths.log);
  const child = spawn(paths.wireproxy, ["-c", paths.conf], {
    detached: true,
    windowsHide: true,
    stdio: ["ignore", fd, fd],
    // Same reasoning as the daemon: never inherit the caller's directory, which
    // under `npx` or an npm hook is a folder that may be deleted underneath us.
    cwd: paths.dir,
  });
  child.unref();
  fs.closeSync(fd);

  writeState(configFile, {
    pid: child.pid,
    socksPort: config.warp.socksPort,
    httpPort: config.warp.httpPort,
    endpoint: config.warp.endpoint,
    startedAt: new Date().toISOString(),
  });

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await wait(200);
    if (await listening(config.warp.httpPort)) {
      const status = await tunnelStatus(config);
      log.info(`warp: tunnel up on 127.0.0.1:${status.httpPort} (http) and :${status.socksPort} (socks5)`);
      return { status: "started", ...status };
    }
    if (child.exitCode !== null) break; // died on its own, no point waiting
  }

  return { status: "failed", ...(await tunnelStatus(config)), detail: tunnelLogTail(configFile) };
}

export async function stopTunnel(config, { timeoutMs = STOP_TIMEOUT_MS } = {}) {
  const configFile = config.__file;
  const state = readState(configFile);
  const pid = Number(state.pid);
  if (!processAlive(pid)) {
    writeState(configFile, { pid: null });
    return { status: "not-running" };
  }

  try {
    process.kill(pid, "SIGTERM");
  } catch (err) {
    return { status: "failed", pid, error: err.message };
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processAlive(pid)) {
      writeState(configFile, { pid: null });
      return { status: "stopped", pid };
    }
    await wait(150);
  }
  return { status: "failed", pid, error: "still running after SIGTERM" };
}

/**
 * Forces a new exit address: throws the WARP device registration away and comes
 * back with a fresh one.
 *
 * This is the whole point of the feature for anyone rate-limited by IP, and it
 * is deliberately a plain command with no prompt, so a script or a cron job can
 * call it. The tunnel goes down for the couple of seconds a registration takes,
 * and requests in flight through it fail — the caller decides when that is
 * acceptable, which is why it never happens on its own.
 */
export async function rotateTunnel(config, { timeoutMs = START_TIMEOUT_MS } = {}) {
  await stopTunnel(config);
  // Registering needs the executables, and asking for a new identity before they
  // exist would fail for a reason that has nothing to do with rotating.
  await ensureBinaries(config.__file);
  await ensureIdentity(config.__file, { force: true });
  writeState(config.__file, { rotatedAt: new Date().toISOString() });
  return startTunnel(config, { timeoutMs });
}
