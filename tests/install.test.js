import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { commandStatus, fallbackCommand, globalBinCandidates, installScope, nodeManager, pathAdvice, whichSync } from "../src/install.js";
import { fakeBinDir } from "./helpers.js";

const run = promisify(execFile);
const CLI = path.resolve(import.meta.dirname, "..", "src", "index.js");

const temp = async () => fs.mkdtemp(path.join(os.tmpdir(), "llm-proxy-install-"));

/**
 * Windows semantics run on any host: `;` cannot collide with the drive letter of
 * a temporary directory. POSIX semantics split on `:`, so those cases only make
 * sense where a path cannot contain one — the CI matrix covers both.
 */
test("on Windows, the lookup reports the file the shell can actually run", async () => {
  const dir = await fakeBinDir();
  const elsewhere = await temp();
  try {
    const windows = { pathValue: [elsewhere, dir].join(";"), platform: "win32", pathExt: ".COM;.EXE;.BAT;.CMD" };
    assert.equal(whichSync("llmfp", windows), path.join(dir, "llmfp.CMD"), "cmd.exe will not execute the extensionless shim");
    assert.equal(whichSync("nothing-like-this", windows), null);

    // Only the sh shim: still worth reporting rather than claiming nothing is there.
    const shimOnly = await fakeBinDir(["llmfp"]);
    assert.equal(whichSync("llmfp", { ...windows, pathValue: shimOnly }), path.join(shimOnly, "llmfp"));
    await fs.rm(shimOnly, { recursive: true, force: true });

    // A directory that happens to carry the name is not a command.
    const trap = await temp();
    await fs.mkdir(path.join(trap, "llmfp"));
    assert.equal(whichSync("llmfp", { ...windows, pathValue: trap }), null);
    await fs.rm(trap, { recursive: true, force: true });
  } finally {
    for (const target of [dir, elsewhere]) await fs.rm(target, { recursive: true, force: true });
  }
});

// npm writes `llmfp.cmd`, PATHEXT says `.CMD`, and only Windows calls those the
// same file — so the spelling this reports can only be checked there.
test("the reported name is the one on disk, not the one PATHEXT spells", { skip: process.platform === "win32" ? false : "case-insensitive filesystem" }, async () => {
  const dir = await fakeBinDir(["llmfp", "llmfp.cmd"]);
  try {
    const found = whichSync("llmfp", { pathValue: dir, platform: "win32", pathExt: ".COM;.EXE;.BAT;.CMD" });
    assert.equal(found, path.join(dir, "llmfp.cmd"), "`where llmfp` prints it lower-case, and so must this");
    // The directory is left exactly as PATH gave it: a short-name entry stays short.
    assert.equal(path.dirname(found), dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("on POSIX, the shim is the command", { skip: process.platform === "win32" ? "PATH splits on : here" : false }, async () => {
  const dir = await fakeBinDir();
  const elsewhere = await temp();
  try {
    const unix = { pathValue: [elsewhere, dir].join(":"), platform: "linux" };
    assert.equal(whichSync("llmfp", unix), path.join(dir, "llmfp"));
    assert.equal(whichSync("nothing-like-this", unix), null);

    // Present but not executable: not a command either.
    const unreadable = await fakeBinDir();
    await fs.chmod(path.join(unreadable, "llmfp"), 0o644);
    assert.equal(whichSync("llmfp", { pathValue: unreadable, platform: "linux" }), null);
    await fs.rm(unreadable, { recursive: true, force: true });
  } finally {
    for (const target of [dir, elsewhere]) await fs.rm(target, { recursive: true, force: true });
  }
});

test("an empty or quoted PATH never throws", () => {
  for (const pathValue of ["", ';;"";', ":::"]) {
    assert.equal(whichSync("llmfp", { pathValue, platform: "win32" }), null);
    assert.equal(whichSync("llmfp", { pathValue, platform: "linux" }), null);
  }
});

test("the npm bin directory is taken from npm's own environment first", () => {
  const linux = globalBinCandidates({
    env: { npm_config_global_prefix: "/opt/npm-global", npm_config_prefix: "/ignored" },
    platform: "linux",
    execPath: "/usr/bin/node",
  });
  assert.equal(linux[0], path.resolve("/opt/npm-global/bin"), "on POSIX the commands live in <prefix>/bin");
  assert.ok(linux.includes(path.resolve("/usr/bin")), "node's own directory stays as a fallback");

  const windows = globalBinCandidates({
    env: { npm_config_global_prefix: "C:\\np", APPDATA: "C:\\Users\\x\\AppData\\Roaming" },
    platform: "win32",
    execPath: "C:\\Program Files\\nodejs\\node.exe",
  });
  assert.equal(windows[0], path.resolve("C:\\np"), "on Windows the prefix *is* the bin directory");
  const slashes = (value) => value.replace(/[\\/]+/g, "/");
  assert.ok(
    windows.some((dir) => slashes(dir).endsWith("AppData/Roaming/npm")),
    "%APPDATA%\\npm is where a default install links them",
  );
});

test("a command resolving to another installation is reported, not called ok", async () => {
  const installed = await fakeBinDir();
  const other = await fakeBinDir();
  try {
    const status = commandStatus({
      platform: "win32",
      // No npm in the environment, so the bin directory is node's own — which is
      // where this copy was linked.
      env: {},
      execPath: path.join(installed, "node.exe"),
      // `other` comes first, so that is what the shell would actually run.
      pathValue: [other, installed].join(";"),
    });
    assert.equal(status.dir, installed);
    assert.equal(status.resolved, path.join(other, "llmfp.CMD"));
    assert.equal(status.onPath, true);
    assert.equal(status.shadowed, true, "it answers, but it is not the copy npm just linked");
  } finally {
    for (const dir of [installed, other]) await fs.rm(dir, { recursive: true, force: true });
  }
});

test("nothing on PATH is a clear negative, never an exception", () => {
  const status = commandStatus({ pathValue: "", platform: process.platform, env: {}, execPath: process.execPath });
  assert.equal(status.onPath, false);
  assert.equal(status.resolved, null);
  assert.equal(status.shadowed, false);
  assert.ok(status.dir, "there is still a directory to advise about");
});

test("the advice names a file the shell will actually read", () => {
  const windows = pathAdvice("C:\\np", { platform: "win32", env: {} }).join("\n");
  assert.match(windows, /SetEnvironmentVariable\('Path'/, "the registry-safe form, not `setx`, which truncates");
  assert.match(windows, /open a new terminal/);

  const zsh = pathAdvice("/opt/bin", { platform: "darwin", env: { SHELL: "/bin/zsh" } }).join("\n");
  assert.match(zsh, /~\/\.zprofile/);
  const bash = pathAdvice("/opt/bin", { platform: "linux", env: { SHELL: "/bin/bash" } }).join("\n");
  assert.match(bash, /~\/\.profile/);
  const fish = pathAdvice("/opt/bin", { platform: "linux", env: { SHELL: "/usr/bin/fish" } }).join("\n");
  assert.match(fish, /fish_add_path/);

  for (const advice of [zsh, bash, fish]) {
    assert.match(advice, /cron|systemd/, "the shells that read no profile at all are the reason for this check");
  }
});

test("the fallback command survives paths with spaces, in both shells", () => {
  const windows = fallbackCommand("C:\\Program Files\\nodejs\\node.exe", "C:\\My Tools\\dist\\index.js", "win32");
  assert.equal(windows, '& "C:\\Program Files\\nodejs\\node.exe" "C:\\My Tools\\dist\\index.js"');
  assert.match(windows, /^& /, "PowerShell needs the call operator, a quoted first token is just a string");

  const unix = fallbackCommand("/usr/bin/node", "/opt/llm/dist/index.js", "linux");
  assert.equal(unix, '"/usr/bin/node" "/opt/llm/dist/index.js"');
});

test("a version-managed node is recognised, because login entries hard-code it", () => {
  assert.equal(nodeManager("/home/u/.nvm/versions/node/v24.0.0/bin/node"), "nvm");
  assert.equal(nodeManager("C:\\Users\\x\\AppData\\Roaming\\nvm\\v24.0.0\\node.exe"), "nvm");
  assert.equal(nodeManager("/home/u/.volta/tools/image/node/24.0.0/bin/node"), "volta");
  assert.equal(nodeManager("/usr/bin/node"), null);
  assert.equal(nodeManager("C:\\Program Files\\nodejs\\node.exe"), null);
});

// Native separators only: `path.relative` cannot compare a Windows path on Linux.
test("how the copy got here decides what advice makes sense", { skip: process.platform === "win32" ? "POSIX layout" : false }, () => {
  const posix = { platform: "linux", env: { npm_config_global_prefix: "/usr/local" }, execPath: "/usr/local/bin/node" };
  assert.equal(installScope({ ...posix, entry: "/usr/local/lib/node_modules/llm-failover-proxy/dist/index.js" }), "global");
  assert.equal(installScope({ ...posix, entry: "/home/u/app/node_modules/llm-failover-proxy/dist/index.js" }), "local");
  assert.equal(installScope({ ...posix, entry: "/home/u/checkout/src/index.js" }), "source");
});

test("the same three cases, with the Windows layout", { skip: process.platform === "win32" ? false : "Windows layout" }, () => {
  const windows = { platform: "win32", env: { npm_config_global_prefix: "C:\\np" }, execPath: "C:\\Program Files\\nodejs\\node.exe" };
  assert.equal(installScope({ ...windows, entry: "C:\\np\\node_modules\\llm-failover-proxy\\dist\\index.js" }), "global");
  assert.equal(installScope({ ...windows, entry: "C:\\app\\node_modules\\llm-failover-proxy\\dist\\index.js" }), "local");
  assert.equal(installScope({ ...windows, entry: "C:\\checkout\\src\\index.js" }), "source");
});

/* ------------------------------------------------------------------ *
 * The command itself, run the way a script would run it              *
 * ------------------------------------------------------------------ */

/** No TTY: `execFile` gives the child pipes, which is the case being tested. */
function cli(args, { configFile, cwd, pathValue } = {}) {
  const env = { ...process.env, NO_COLOR: "1" };
  for (const name of Object.keys(env)) if (name.endsWith("_API_KEY")) delete env[name];
  if (pathValue !== undefined) env.PATH = pathValue;
  const argv = configFile ? [CLI, ...args, "--config", configFile] : [CLI, ...args];
  return run(process.execPath, argv, { env, cwd, timeout: 30000 });
}

test("`doctor` reports a usable install and hands the shell back", async () => {
  const dir = await temp();
  const configFile = path.join(dir, "config.json");
  // A PATH that holds the command, whether or not this machine has it installed.
  const bin = await fakeBinDir();
  try {
    const { stdout } = await cli(["doctor"], { configFile, cwd: dir, pathValue: bin });
    assert.match(stdout, /command\s+llmfp/, "the command the user types is the first thing checked");
    assert.match(stdout, /node\s+\S/);
    assert.match(stdout, /config\s+\S/);
    assert.match(stdout, /not written yet/, "a fresh machine has no configuration file, and says so");

    const report = JSON.parse((await cli(["doctor", "--json"], { configFile, cwd: dir, pathValue: bin })).stdout);
    assert.equal(report.configFile, configFile);
    assert.equal(report.configExists, false);
    assert.equal(report.command.onPath, true);
    assert.ok(report.fallback.includes(process.execPath), "a script always gets a command that needs no PATH");
  } finally {
    for (const target of [dir, bin]) await fs.rm(target, { recursive: true, force: true });
  }
});

test("`doctor` fails, and explains, when the command is not on PATH", async () => {
  const dir = await temp();
  const configFile = path.join(dir, "config.json");
  try {
    // Node is invoked by absolute path here, so an empty PATH is survivable.
    await assert.rejects(
      () => cli(["doctor", "--path"], { configFile, cwd: dir, pathValue: dir }),
      (err) => {
        assert.equal(err.code, 1, "an install script can branch on the exit code");
        assert.match(err.stdout, /is not on your PATH/);
        assert.match(err.stdout, /npm links its commands into/);
        assert.match(err.stdout, /this always works/, "and there is always something that runs meanwhile");
        assert.doesNotMatch(err.stdout, /service|at login/, "--path stays to the point, the installer prints it");
        return true;
      },
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("with no terminal, the UI command reports instead of doing nothing", async () => {
  const dir = await temp();
  const configFile = path.join(dir, "config.json");
  try {
    // Nothing configured: the three steps that need no menu.
    const fresh = await cli([], { configFile, cwd: dir });
    assert.match(fresh.stdout, /no terminal attached/);
    assert.match(fresh.stdout, /nothing configured yet/);
    assert.match(fresh.stdout, /llm-failover-proxy start/);
    assert.match(fresh.stdout, new RegExp(String.raw`\.env`), "and where the keys go");

    // Configured: the same report `status` prints, so a pipe gets something useful.
    await fs.writeFile(configFile, JSON.stringify({ providers: [], models: [], server: { port: 1 } }));
    const configured = await cli([], { configFile, cwd: dir });
    assert.match(configured.stdout, /no terminal attached/);
    assert.match(configured.stdout, /Providers/);
    assert.match(configured.stdout, /Effective failover order/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
