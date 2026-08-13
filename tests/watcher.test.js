import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { addTarget, cycleTarget, loadConfig, moveModel, saveConfig } from "../src/config.js";
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

test("a request is answered with the file on disk, even with the watcher dead", async () => {
  // The guarantee that does not depend on the OS volunteering anything: closing
  // the watcher is exactly what a filesystem reporting no events looks like — a
  // network share, a bind mount inside a container. The chain still has to be the
  // one on disk, because the person who just reordered it has no way to tell.
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "llm-proxy-nowatch-"));
  const file = path.join(dir, "config.json");
  const model = (n) => ({ id: `mdl_${n}`, providerId: "prov_1", model: `m-${n}`, alias: `a${n}`, kind: "chat", enabled: true, params: {} });
  await fs.writeFile(
    file,
    JSON.stringify({
      server: { host: "127.0.0.1", port: 0, logLevel: "error" },
      providers: [{ id: "prov_1", name: "p", type: "openai", baseUrl: "http://127.0.0.1:9/v1", apiKey: null, headers: {}, enabled: true }],
      models: [model(1), model(2)],
    }),
  );

  const app = await startServer({ configFile: file, statsFile: null });
  const { port } = app.server.address();
  try {
    // Every watcher this server installed, silenced.
    app.server.emit("close");

    for (const [first, second] of [
      ["m-2", "m-1"],
      ["m-1", "m-2"],
    ]) {
      const config = loadConfig(file);
      assert.equal(moveModel(config, 0, 1), true);
      saveConfig(config, file);
      assert.equal(config.models[0].model, first, "the file now leads with this");

      const answer = await fetch(`http://127.0.0.1:${port}/v1/models`).then((response) => response.json());
      const order = answer.data.filter((entry) => entry.id !== "auto").map((entry) => entry.id);
      assert.deepEqual(order, [`a${first.slice(-1)}`, `a${second.slice(-1)}`], "the request read the file, not a stale copy");
    }
  } finally {
    app.server.closeAllConnections?.();
    await new Promise((resolve) => app.server.close(resolve));
    resetEnvCache();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("switching target list swaps the chain a running proxy serves", async () => {
  // The point of having several lists: switching one in the UI has to reach the
  // proxy already running, the same way reordering the chain does. Nothing in the
  // server knows about target lists — it reads `models`, which is what a switch
  // rewrites — and this is the test that says so.
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "llm-proxy-targets-"));
  const file = path.join(dir, "config.json");
  const model = (n) => ({ id: `mdl_${n}`, providerId: "prov_1", model: `m-${n}`, alias: `a${n}`, kind: "chat", enabled: true, params: {} });
  await fs.writeFile(
    file,
    JSON.stringify({
      server: { host: "127.0.0.1", port: 0, logLevel: "error" },
      providers: [{ id: "prov_1", name: "p", type: "openai", baseUrl: "http://127.0.0.1:9/v1", apiKey: null, headers: {}, enabled: true }],
      models: [model(1)],
    }),
  );

  // A second list holding a different chain, exactly as the screen builds it.
  const seed = loadConfig(file);
  addTarget(seed, "other");
  seed.models.push(model(2));
  saveConfig(seed, file);

  const app = await startServer({ configFile: file, statsFile: null });
  const { port } = app.server.address();
  const served = async () => {
    const answer = await fetch(`http://127.0.0.1:${port}/v1/models`).then((response) => response.json());
    return answer.data.filter((entry) => entry.id !== "auto").map((entry) => entry.id);
  };
  try {
    assert.deepEqual(await served(), ["a2"], "the list in use when the server started");

    // One press of ← in the UI.
    const config = loadConfig(file);
    assert.equal(cycleTarget(config, -1), true);
    saveConfig(config, file);
    assert.ok(await waitFor(() => app.config.models[0]?.model === "m-1"), "the switch never reached the running proxy");
    assert.deepEqual(await served(), ["a1"], "and the other chain is being served now");

    // And back, so the parked chain is proven to have survived the round trip.
    const back = loadConfig(file);
    assert.equal(cycleTarget(back, 1), true);
    saveConfig(back, file);
    assert.ok(await waitFor(() => app.config.models[0]?.model === "m-2"));
    assert.deepEqual(await served(), ["a2"]);
  } finally {
    app.server.closeAllConnections?.();
    await new Promise((resolve) => app.server.close(resolve));
    resetEnvCache();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("every save is picked up, not just the first one", async () => {
  // `saveConfig` renames a temporary file over the target. A watch placed on the
  // file itself follows the inode, so on Linux the rename is reported once and
  // every save after it is lost: reordering the chain twice would take effect
  // once, and the only way out would be restarting the daemon. Watching the
  // directory is what survives — and one save can never prove it.
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "llm-proxy-resave-"));
  const file = path.join(dir, "config.json");
  const model = (n) => ({ id: `mdl_${n}`, providerId: "prov_1", model: `m-${n}`, alias: `a${n}`, kind: "chat", enabled: true, params: {} });
  await fs.writeFile(
    file,
    JSON.stringify({
      server: { host: "127.0.0.1", port: 0, logLevel: "error" },
      providers: [{ id: "prov_1", name: "p", type: "openai", baseUrl: "http://127.0.0.1:9/v1", apiKey: null, headers: {}, enabled: true }],
      models: [model(1), model(2), model(3)],
    }),
  );

  const app = await startServer({ configFile: file, statsFile: null });
  const order = () => app.config.models.map((entry) => entry.model).join(",");
  try {
    assert.equal(order(), "m-1,m-2,m-3");
    for (let round = 1; round <= 3; round += 1) {
      const config = loadConfig(file);
      assert.equal(moveModel(config, 0, 1), true);
      saveConfig(config, file);
      const wanted = config.models.map((entry) => entry.model).join(",");
      assert.ok(await waitFor(() => order() === wanted), `reorder ${round} of 3 never reached the running proxy`);
    }
  } finally {
    app.server.closeAllConnections?.();
    await new Promise((resolve) => app.server.close(resolve));
    resetEnvCache();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
