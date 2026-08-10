/**
 * Background service: run the proxy detached from the terminal, and bring it
 * back at every login.
 *
 * There is no service manager dependency and no elevation: the process is
 * spawned detached with its output appended to a log file, and the boot entry is
 * whatever the platform offers for a plain user, a Startup shortcut on Windows,
 * a LaunchAgent on macOS, a systemd *user* unit on Linux.
 *
 * The running instance is described by a small JSON file next to the config, so
 * `status`, `stop` and the health check work from any other process.
 */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const SERVICE_NAME = "llm-failover-proxy";

/**
 * The CLI entry point to re-execute. `./index.js` resolves next to this file
 * when running from source, and to the bundle itself once published, the whole
 * CLI is a single file there, so `dist/index.js` imports resolve to itself.
 */
const ENTRY = fileURLToPath(new URL("./index.js", import.meta.url));

const MAX_LOG_BYTES = 2 * 1024 * 1024;

/**
 * True when running from the published single-file bundle rather than from a
 * source checkout. Only the bundle can be copied around, being self-contained.
 */
const IS_BUNDLE = path.basename(path.dirname(ENTRY)) === "dist";

const sibling = (configFile, name) => path.join(path.dirname(path.resolve(configFile)), name);

export const runtimePathFor = (configFile) => sibling(configFile, "daemon.json");
export const logPathFor = (configFile) => sibling(configFile, "daemon.log");
const servicePathFor = (configFile) => sibling(configFile, path.join("service", "llm-failover-proxy.mjs"));
const originPathFor = (configFile) => sibling(configFile, path.join("service", "origin.json"));

/**
 * The background process runs from a copy of the CLI kept next to the config,
 * never straight out of `node_modules`.
 *
 * A running Node process holds its own script open, and Windows refuses to
 * rename or delete an open file: without the copy, `npm rm -g` fails with EBUSY
 * and leaves a half-removed package behind. The copy is refreshed whenever the
 * installed file changes, so an upgrade is picked up on the next start.
 */
export function serviceEntry(configFile) {
  if (!IS_BUNDLE) return ENTRY;
  const target = servicePathFor(configFile);
  try {
    const source = fs.statSync(ENTRY);
    const current = fs.existsSync(target) ? fs.statSync(target) : null;
    if (!current || current.size !== source.size || current.mtimeMs < source.mtimeMs) {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(ENTRY, target);
      fs.writeFileSync(originPathFor(configFile), `${JSON.stringify({ origin: ENTRY }, null, 2)}\n`);
    }
    return target;
  } catch {
    return ENTRY; // copying failed: running in place still works
  }
}

/**
 * Was the package uninstalled from under us? The copy keeps working on its own,
 * which is what makes `npm rm -g` succeed, but it also means the login entry
 * would outlive the package, so it cleans itself up instead.
 */
export function orphaned(configFile) {
  try {
    const { origin } = JSON.parse(fs.readFileSync(originPathFor(configFile), "utf8"));
    return typeof origin === "string" && !fs.existsSync(origin);
  } catch {
    return false;
  }
}

/** Deletes the background copy. Stop the daemon first: it holds the file open. */
export function removeServiceCopy(configFile) {
  try {
    fs.rmSync(path.dirname(servicePathFor(configFile)), { recursive: true, force: true });
    return true;
  } catch {
    return false; // still running, or already gone
  }
}

/* ------------------------------------------------------------------ *
 * Runtime file, written by the server, read by everyone else         *
 * ------------------------------------------------------------------ */

export function readRuntime(configFile) {
  try {
    const raw = JSON.parse(fs.readFileSync(runtimePathFor(configFile), "utf8"));
    return typeof raw?.pid === "number" ? raw : null;
  } catch {
    return null;
  }
}

export function writeRuntime(configFile, info) {
  const file = runtimePathFor(configFile);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify({ ...info, configFile: path.resolve(configFile) }, null, 2)}\n`);
  } catch {
    /* a missing runtime file only costs `status` some detail */
  }
  return file;
}

/** Removes the runtime file, unless another instance now owns it. */
export function clearRuntime(configFile, pid = process.pid) {
  const current = readRuntime(configFile);
  if (current && current.pid !== pid) return false;
  try {
    fs.unlinkSync(runtimePathFor(configFile));
    return true;
  } catch {
    return false;
  }
}

/** `kill(pid, 0)` only probes. EPERM means the process exists but is not ours. */
export function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
}

/** Any HTTP answer proves the port is served, a 401 counts as alive. */
export async function reachable(url, timeoutMs = 1000) {
  try {
    await fetch(`${url}/health`, { signal: AbortSignal.timeout(timeoutMs) });
    return true;
  } catch {
    return false;
  }
}

export function daemonStatus(configFile) {
  const runtime = readRuntime(configFile);
  const running = Boolean(runtime && processAlive(runtime.pid));
  return {
    running,
    stale: Boolean(runtime && !running),
    pid: runtime?.pid ?? null,
    host: runtime?.host ?? null,
    port: runtime?.port ?? null,
    url: runtime?.url ?? null,
    startedAt: runtime?.startedAt ?? null,
    logFile: logPathFor(configFile),
    runtimeFile: runtimePathFor(configFile),
  };
}

/* ------------------------------------------------------------------ *
 * Start / stop                                                        *
 * ------------------------------------------------------------------ */

function openLog(configFile) {
  const file = logPathFor(configFile);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try {
    if (fs.statSync(file).size > MAX_LOG_BYTES) fs.truncateSync(file, 0);
  } catch {
    /* no log yet */
  }
  return { file, fd: fs.openSync(file, "a") };
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Tail of the daemon log, used to explain a start that never came up. */
export function logTail(configFile, lines = 12) {
  try {
    const text = fs.readFileSync(logPathFor(configFile), "utf8");
    return text.split(/\r?\n/).filter(Boolean).slice(-lines).join("\n");
  } catch {
    return "";
  }
}

/**
 * Spawns the proxy detached and waits for it to answer, so the caller can
 * report a real outcome instead of "probably started".
 */
export async function startDaemon({ configFile, timeoutMs = 15000 } = {}) {
  const already = daemonStatus(configFile);
  if (already.running) return { status: "already-running", ...already };

  const { file: logFile, fd } = openLog(configFile);
  const child = spawn(process.execPath, [serviceEntry(configFile), "start", "--config", path.resolve(configFile)], {
    detached: true,
    windowsHide: true,
    stdio: ["ignore", fd, fd],
    // Never inherit the caller's directory: npm runs the install hook from inside
    // node_modules, and a process's cwd is locked on Windows, which would make
    // `npm rm -g` fail. The config folder is stable and always exists.
    cwd: path.dirname(path.resolve(configFile)),
    env: { ...process.env, LLM_PROXY_DAEMON: "1" },
  });
  child.unref();
  fs.closeSync(fd);

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await wait(150);
    const runtime = readRuntime(configFile);
    if (runtime?.pid === child.pid && runtime.url && (await reachable(runtime.url))) {
      return { status: "started", ...daemonStatus(configFile), logFile };
    }
    if (child.exitCode !== null && !runtime) break; // died before writing anything
  }

  return { status: "failed", pid: child.pid, logFile, detail: logTail(configFile) };
}

export async function stopDaemon({ configFile, timeoutMs = 8000 } = {}) {
  const status = daemonStatus(configFile);
  if (!status.running) {
    if (status.stale) clearRuntime(configFile, status.pid);
    return { status: "not-running" };
  }

  try {
    process.kill(status.pid, "SIGTERM");
  } catch (err) {
    return { status: "failed", pid: status.pid, error: err.message };
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processAlive(status.pid)) {
      clearRuntime(configFile, status.pid);
      return { status: "stopped", pid: status.pid };
    }
    await wait(150);
  }
  return { status: "failed", pid: status.pid, error: "still running after SIGTERM" };
}

export async function restartDaemon({ configFile, timeoutMs } = {}) {
  await stopDaemon({ configFile });
  return startDaemon({ configFile, timeoutMs });
}

/* ------------------------------------------------------------------ *
 * Start at login                                                      *
 * ------------------------------------------------------------------ */

/** Where the boot entry goes on this platform, and how it is worded. */
export function autostartTarget() {
  if (process.platform === "win32") {
    const startup = path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "Microsoft", "Windows", "Start Menu", "Programs", "Startup");
    return { kind: "startup-folder", file: path.join(startup, `${SERVICE_NAME}.vbs`), label: "Startup folder" };
  }
  if (process.platform === "darwin") {
    return {
      kind: "launchagent",
      file: path.join(os.homedir(), "Library", "LaunchAgents", `com.${SERVICE_NAME}.plist`),
      label: "LaunchAgent",
    };
  }
  return {
    kind: "systemd-user",
    file: path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "systemd", "user", `${SERVICE_NAME}.service`),
    label: "systemd user unit",
  };
}

export function autostartInstalled() {
  return fs.existsSync(autostartTarget().file);
}

/** Doubles the quotes of a command line so it can sit inside a VBS string. */
const vbsLiteral = (text) => `"${String(text).replace(/"/g, '""')}"`;

function autostartContents(kind, configFile) {
  const config = path.resolve(configFile);
  const logFile = logPathFor(config);
  // The login entry points at the same copy the daemon runs from, for the same
  // reason: nothing must keep a file inside node_modules open.
  const entry = serviceEntry(config);

  if (kind === "startup-folder") {
    // `daemon` spawns the detached server and exits, so the logon script does not
    // keep a process (or a console window) around. 0 = hidden window.
    const command = `"${process.execPath}" "${entry}" daemon --config "${config}"`;
    return [
      `' ${SERVICE_NAME}, starts the local LLM proxy in the background at logon.`,
      "' Remove this file, or run `llm-failover-proxy disable`, to stop that.",
      'Set shell = CreateObject("WScript.Shell")',
      `shell.Run ${vbsLiteral(command)}, 0, False`,
      "",
    ].join("\r\n");
  }

  if (kind === "launchagent") {
    const args = [process.execPath, entry, "start", "--config", config];
    return [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
      '<plist version="1.0">',
      "<dict>",
      "  <key>Label</key>",
      `  <string>com.${SERVICE_NAME}</string>`,
      "  <key>ProgramArguments</key>",
      "  <array>",
      ...args.map((arg) => `    <string>${arg.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</string>`),
      "  </array>",
      "  <key>RunAtLoad</key>",
      "  <true/>",
      "  <key>StandardOutPath</key>",
      `  <string>${logFile}</string>`,
      "  <key>StandardErrorPath</key>",
      `  <string>${logFile}</string>`,
      "</dict>",
      "</plist>",
      "",
    ].join("\n");
  }

  return [
    "[Unit]",
    "Description=llm-failover-proxy, OpenAI-compatible proxy with provider failover",
    "After=network-online.target",
    "",
    "[Service]",
    `ExecStart="${process.execPath}" "${entry}" start --config "${config}"`,
    "Restart=on-failure",
    "RestartSec=5",
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
}

/** Best effort: a missing service manager must not turn into a hard failure. */
function activate(kind, file) {
  if (kind === "launchagent") {
    const result = spawnSync("launchctl", ["load", "-w", file], { stdio: "ignore" });
    return result.status === 0;
  }
  if (kind === "systemd-user") {
    if (spawnSync("systemctl", ["--user", "daemon-reload"], { stdio: "ignore" }).error) return false;
    return spawnSync("systemctl", ["--user", "enable", `${SERVICE_NAME}.service`], { stdio: "ignore" }).status === 0;
  }
  return true; // the Startup folder needs nothing
}

function deactivate(kind, file) {
  if (kind === "launchagent") spawnSync("launchctl", ["unload", "-w", file], { stdio: "ignore" });
  if (kind === "systemd-user") spawnSync("systemctl", ["--user", "disable", `${SERVICE_NAME}.service`], { stdio: "ignore" });
}

export function installAutostart({ configFile }) {
  const target = autostartTarget();
  try {
    fs.mkdirSync(path.dirname(target.file), { recursive: true });
    fs.writeFileSync(target.file, autostartContents(target.kind, configFile));
  } catch (err) {
    return { ...target, installed: false, error: err.message };
  }
  return { ...target, installed: true, activated: activate(target.kind, target.file) };
}

export function removeAutostart() {
  const target = autostartTarget();
  if (!fs.existsSync(target.file)) return { ...target, removed: false };
  deactivate(target.kind, target.file);
  try {
    fs.unlinkSync(target.file);
    return { ...target, removed: true };
  } catch (err) {
    return { ...target, removed: false, error: err.message };
  }
}
