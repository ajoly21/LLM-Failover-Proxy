#!/usr/bin/env node
/**
 * Runs after `npm install`. Puts the proxy in the background so it is ready to
 * answer right away, and, for a global install, brings it back at every login.
 *
 * Deliberately conservative: it does nothing at all for `npx`, for CI, or when
 * the repository's own dependencies are being installed. It also never fails the
 * install, whatever happens.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(packageDir, "dist", "index.js");

/**
 * npm collects the output of install scripts and only shows it on failure, or
 * with `--foreground-scripts`. The controlling terminal is still there though, so
 * writing to it directly is what makes install-time advice visible at all.
 * No terminal (CI, a GUI installer, a Dockerfile) means nothing to say anything
 * to, and the pipe npm gave us is the right fallback.
 */
const terminal = (() => {
  try {
    return fs.openSync(process.platform === "win32" ? "CONOUT$" : "/dev/tty", "w");
  } catch {
    return null;
  }
})();

const say = (text) => {
  const line = `${text}\n`;
  if (terminal === null) return void process.stdout.write(line);
  try {
    fs.writeSync(terminal, line);
  } catch {
    process.stdout.write(line);
  }
};

/** Children print for us, so they get the same destination. */
const run = (args) => spawnSync(process.execPath, [cli, ...args], { stdio: ["ignore", terminal ?? "inherit", terminal ?? "inherit"] });

const isGlobal = process.env.npm_config_global === "true";
const isNpx = process.env.npm_command === "exec" || packageDir.includes("_npx");
// A source checkout installing its own dependencies. `src/` never ships, so its
// presence is the reliable signal; INIT_CWD alone depends on the package manager.
const isSelf = fs.existsSync(path.join(packageDir, "src")) || path.resolve(process.env.INIT_CWD || ".") === packageDir;
const optedOut = Boolean(process.env.LLM_PROXY_NO_AUTOSTART);
const isCI = Boolean(process.env.CI);

try {
  if (isNpx || isSelf) process.exit(0);

  // Before the early exits, and whatever else happens: a command the shell
  // cannot find is the one failure the user has no way to diagnose afterwards.
  // `doctor --path` exits non-zero when it is not on PATH, and that message is
  // worth repeating into npm's own log — where `--foreground-scripts` and a
  // redirected install can still find it — even at the cost of showing twice.
  if (isGlobal && run(["doctor", "--path"]).status !== 0 && terminal !== null) {
    spawnSync(process.execPath, [cli, "doctor", "--path"], { stdio: ["ignore", "inherit", "inherit"] });
  }

  if (optedOut || isCI) {
    say(`llm-failover-proxy: not starting the background service (${optedOut ? "LLM_PROXY_NO_AUTOSTART" : "CI"} is set).`);
    say("  start it yourself with: llm-failover-proxy enable");
    process.exit(0);
  }

  // `enable` also registers the login entry; a local dependency only gets the
  // background process, because its path disappears with node_modules.
  const result = run([isGlobal ? "enable" : "daemon"]);

  if (result.status !== 0) {
    say("llm-failover-proxy: could not start the background service.");
    say("  run `llm-failover-proxy enable` to see why.");
    process.exit(0);
  }

  if (!isGlobal) say("  (login entry skipped for a local install, `llm-failover-proxy enable` adds it)");
  say("  configure it with: llm-failover-proxy   ·   check it with: llm-failover-proxy doctor");
} catch (err) {
  say(`llm-failover-proxy: skipping the background service (${err.message}).`);
}

process.exit(0); // an install must never fail because of this
