import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadConfig, saveConfig } from "../src/config.js";
import { resetEnvCache } from "../src/env.js";
import { startServer, watchPath } from "../src/server.js";

/**
 * A folder reachable under two spellings: its real path, and a link pointing at
 * it. That is the situation `fs.watch` cannot be handed on Windows — libuv
 * compares the path it was given with the one the OS reports for each event and
 * *aborts* when they differ. GitHub's runners hit it through an 8.3 short name
 * (`C:\Users\RUNNER~1\…`); a junction reproduces it anywhere, deterministically.
 */
async function linkedSandbox() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "llm-proxy-watch-"));
  const real = path.join(root, "configuration-folder");
  const link = path.join(root, "link");
  await fs.mkdir(real);
  await fs.symlink(real, link, process.platform === "win32" ? "junction" : "dir");
  return { root, real, link };
}

const waitFor = async (predicate, timeoutMs = 6000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
};

test("a watched path is resolved to the spelling the OS itself reports", async () => {
  const box = await linkedSandbox();
  try {
    const resolved = watchPath(box.link);
    assert.notEqual(resolved, box.link, "the alias is not what gets watched");
    assert.equal(resolved, await fs.realpath(box.real), "the real path is");
    assert.equal(watchPath(path.join(box.real, "config.json")), path.join(box.real, "config.json"), "a file that does not exist yet is passed through untouched");
  } finally {
    await fs.rm(box.root, { recursive: true, force: true });
  }
});

test("a key pasted after startup is picked up, even under an aliased path", async () => {
  const box = await linkedSandbox();
  // Deliberately the alias: this is the spelling that used to abort the process.
  const file = path.join(box.link, "config.json");
  await fs.writeFile(
    file,
    JSON.stringify({
      server: { host: "127.0.0.1", port: 0, logLevel: "error" },
      providers: [
        { id: "prov_1", name: "later", type: "openai", baseUrl: "http://127.0.0.1:9/v1", apiKey: "env:PASTED_LATER_KEY", headers: {}, enabled: true },
      ],
      models: [{ id: "mdl_1", providerId: "prov_1", model: "m-1", alias: "a", kind: "chat", enabled: true, params: {} }],
    }),
  );

  const app = await startServer({ configFile: file, statsFile: null });
  try {
    assert.equal(process.env.PASTED_LATER_KEY, undefined, "no key yet");

    // Exactly what the wizard does while the background proxy is already running.
    await fs.writeFile(path.join(box.link, ".env"), "PASTED_LATER_KEY=sk-pasted\n");
    assert.ok(await waitFor(() => process.env.PASTED_LATER_KEY === "sk-pasted"), "the .env watcher reloaded the keys");

    // The configuration next to it is watched too.
    const config = loadConfig(file);
    config.models.push({ id: "mdl_2", providerId: "prov_1", model: "m-2", alias: "b", kind: "chat", enabled: true, params: {} });
    saveConfig(config, file);
    assert.ok(await waitFor(() => app.config.models.length === 2), "the config watcher reloaded the chain");
  } finally {
    app.server.closeAllConnections?.();
    await new Promise((resolve) => app.server.close(resolve));
    resetEnvCache();
    await fs.rm(box.root, { recursive: true, force: true });
  }
});
