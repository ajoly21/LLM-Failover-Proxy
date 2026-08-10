import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { loadConfig, saveConfig } from "../src/config.js";
import { autostartTarget, daemonStatus, installAutostart, logPathFor, processAlive, removeAutostart, runtimePathFor, startDaemon, stopDaemon } from "../src/daemon.js";
import { startMock } from "./mock-provider.js";

const run = promisify(execFile);
const CLI = path.resolve(import.meta.dirname, "..", "src", "index.js");
const BUNDLE = path.resolve(import.meta.dirname, "..", "dist", "index.js");
// The service copy only exists for the published bundle, which is a build artifact.
const bundled = { skip: existsSync(BUNDLE) ? false : "dist/index.js is missing, run `pnpm run build`" };

/**
 * Isolated home: the wizard, the login entry and the `.env` all resolve through
 * environment variables, so nothing here can touch the real machine, and,
 * just as importantly, the real machine cannot influence the test. Keys are
 * stripped from the inherited environment and the working directory is the
 * sandbox, or a developer's own `.env` would decide whether these assertions
 * hold.
 */
async function sandbox() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "llm-proxy-daemon-"));
  const file = path.join(dir, "config.json");
  const env = {
    ...process.env,
    NO_COLOR: "1",
    HOME: dir,
    USERPROFILE: dir,
    APPDATA: path.join(dir, "AppData"),
    XDG_CONFIG_HOME: path.join(dir, ".config"),
    LLM_PROXY_ENV: path.join(dir, ".env"),
  };
  for (const name of Object.keys(env)) if (name.endsWith("_API_KEY")) delete env[name];

  return {
    dir,
    file,
    env,
    /** Runs the CLI (or the service copy) inside the sandbox. */
    cli(args, { entry = CLI, timeout = 60000 } = {}) {
      return run(process.execPath, [entry, ...args, "--config", file], { env, cwd: dir, timeout });
    },
    async cleanup() {
      await run(process.execPath, [CLI, "stop", "--config", file], { env, cwd: dir }).catch(() => {});
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    },
  };
}

test("a first start writes the default chain and reports the missing keys", async () => {
  const box = await sandbox();
  try {
    // `restart` covers both halves at once: seeding a missing config, then
    // bringing the background proxy up from it.
    const { stdout, stderr } = await box.cli(["restart"]);
    const output = stdout + stderr;

    assert.match(output, /wrote the default chain/);
    assert.match(output, /missing API keys/, "a fresh install says which keys it needs");

    const config = loadConfig(box.file);
    assert.ok(config.models.length >= 3, "the chain is seeded");
    assert.ok(
      config.providers.every((provider) => provider.apiKey === null || provider.apiKey.startsWith("env:")),
      "no provider carries a literal key",
    );
    assert.doesNotMatch(await fs.readFile(box.file, "utf8"), /sk-|nvapi-/, "the config file holds no secret");

    // `restart` also brought the server up: it must answer, and say so.
    assert.match(output, /running in the background/);
    const service = daemonStatus(box.file);
    assert.ok(service.running, "the runtime file describes a live process");
    const health = await fetch(`${service.url}/health`);
    assert.equal(health.status, 200);

    const stopped = await box.cli(["stop"]);
    assert.match(stopped.stdout, /stopped/);
    assert.equal(daemonStatus(box.file).running, false);
    assert.equal(
      await fs.access(runtimePathFor(box.file)).then(
        () => true,
        () => false,
      ),
      false,
      "the runtime file is cleaned up",
    );
  } finally {
    await box.cleanup();
  }
});

test("a detached proxy serves requests and survives its parent", async () => {
  const mock = await startMock("ok", { name: "solo" });
  const box = await sandbox();
  try {
    const config = loadConfig(box.file);
    config.server.port = 0; // any free port; the runtime file records which one
    config.server.logLevel = "error";
    config.providers.push({
      id: "prov_solo",
      name: "solo",
      type: "openai",
      baseUrl: mock.baseUrl,
      apiKey: "env:SOLO_API_KEY",
      headers: {},
      enabled: true,
    });
    config.models.push({
      id: "mdl_solo",
      providerId: "prov_solo",
      model: "test-model",
      alias: "chain",
      kind: "chat",
      enabled: true,
      params: {},
    });
    saveConfig(config, box.file);
    // The key lives in the .env, exactly as the wizard would have written it.
    await fs.writeFile(box.env.LLM_PROXY_ENV, "SOLO_API_KEY=sk-from-dotenv\n");

    const started = await startDaemon({ configFile: box.file });
    assert.equal(started.status, "started");
    assert.ok(processAlive(started.pid));

    const answer = await fetch(`${started.url}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "chain", messages: [{ role: "user", content: "hi" }] }),
    });
    const payload = await answer.json();
    assert.equal(answer.status, 200);
    assert.match(payload.choices[0].message.content, /hello from solo/);
    assert.equal(mock.state.requests.at(-1).headers.authorization, "Bearer sk-from-dotenv", "the .env key reached the provider");

    // Asking twice must not start a second one.
    const again = await startDaemon({ configFile: box.file });
    assert.equal(again.status, "already-running");
    assert.equal(again.pid, started.pid);

    const log = await fs.readFile(logPathFor(box.file), "utf8");
    assert.match(log, /listening on/, "output is captured for `logs`");

    const stopped = await stopDaemon({ configFile: box.file });
    assert.equal(stopped.status, "stopped");
    assert.equal(processAlive(started.pid), false);
    assert.equal((await stopDaemon({ configFile: box.file })).status, "not-running");
  } finally {
    await box.cleanup();
    await mock.close();
  }
});

/** Resolves paths the way a child process running with the sandbox env would. */
function withSandboxEnv(box, body) {
  const keys = ["HOME", "USERPROFILE", "APPDATA", "XDG_CONFIG_HOME"];
  const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  for (const key of keys) process.env[key] = box.env[key];
  try {
    return body();
  } finally {
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

test("the published bundle runs the service from a copy, and cleans up when it is gone", bundled, async () => {
  const box = await sandbox();
  try {
    const enabled = await box.cli(["enable"], { entry: BUNDLE });
    assert.match(enabled.stdout, /starts at login/);
    assert.match(enabled.stdout, /running in the background/);

    // Nothing that keeps running may live inside node_modules: a Node process
    // holds its own script open, and Windows then refuses to uninstall it.
    const copy = path.join(box.dir, "service", "llm-failover-proxy.mjs");
    assert.ok(existsSync(copy), "the CLI was copied next to the config");
    const entryFile = withSandboxEnv(box, () => autostartTarget().file);
    const contents = await fs.readFile(entryFile, "utf8");
    assert.ok(contents.includes(copy), "the login entry runs the copy");
    assert.ok(!contents.includes("node_modules"), "and never a file inside node_modules");

    // Simulate `npm rm -g`: the file the copy came from disappears.
    await fs.writeFile(path.join(box.dir, "service", "origin.json"), JSON.stringify({ origin: path.join(box.dir, "uninstalled.js") }));
    const login = await box.cli(["daemon"], { entry: copy });
    assert.match(login.stdout + login.stderr, /no longer installed/);
    assert.equal(existsSync(entryFile), false, "the login entry removed itself");
    assert.equal(existsSync(copy), false, "and so did the copy");
    assert.equal(daemonStatus(box.file).running, false, "and the background proxy was stopped");
  } finally {
    await box.cleanup();
  }
});

test("the login entry points at this install and can be removed", async () => {
  const box = await sandbox();
  const saved = { ...process.env };
  Object.assign(process.env, {
    HOME: box.dir,
    APPDATA: path.join(box.dir, "AppData"),
    XDG_CONFIG_HOME: path.join(box.dir, ".config"),
  });
  try {
    const target = autostartTarget();
    assert.ok(target.file.startsWith(box.dir), `the sandbox owns ${target.file}`);

    const installed = installAutostart({ configFile: box.file });
    assert.equal(installed.installed, true);
    const contents = await fs.readFile(target.file, "utf8");
    assert.ok(contents.includes(path.resolve(box.file)), "it starts with this configuration");
    assert.ok(contents.includes("index.js"), "and re-executes this CLI");
    if (process.platform === "win32") {
      assert.match(contents, /shell\.Run .*, 0, False/, "no console window at logon");
      assert.match(contents, /daemon/, "the logon script only spawns and exits");
    }

    assert.equal(removeAutostart().removed, true);
    assert.equal(
      await fs.access(target.file).then(
        () => true,
        () => false,
      ),
      false,
    );
    assert.equal(removeAutostart().removed, false, "removing twice is not an error");
  } finally {
    Object.assign(process.env, saved);
    await box.cleanup();
  }
});
