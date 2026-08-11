import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CHECK_TTL_MS, checkDisabled, checkForUpdate, compareVersions, isNewer, latestVersion, updateCachePath, updateCommand } from "../src/update.js";

const temp = async () => fs.mkdtemp(path.join(os.tmpdir(), "llm-proxy-update-"));

/** A checker that counts its calls, so "did it use the cache" is provable. */
function stubRegistry(latest) {
  const calls = [];
  return {
    calls,
    fetchLatest: async (options) => {
      calls.push(options);
      return latest;
    },
  };
}

test("versions compare as numbers, not as text", () => {
  assert.equal(compareVersions("1.10.0", "1.9.0"), 1, "10 is not smaller than 9");
  assert.equal(compareVersions("2.0.0", "1.99.99"), 1);
  assert.equal(compareVersions("1.2.3", "1.2.3"), 0);
  assert.equal(compareVersions("1.2.3", "1.2.4"), -1);
  // A prerelease leads to its release, so it loses to it.
  assert.equal(compareVersions("1.2.0", "1.2.0-beta.1"), 1);
  assert.equal(compareVersions("1.2.0-beta.2", "1.2.0-beta.1"), 1);

  assert.ok(isNewer("1.3.0", "1.2.9"));
  assert.ok(!isNewer("1.2.0", "1.2.0"), "the same version is not an update");
  assert.ok(!isNewer(null, "1.2.0"), "and neither is not knowing");
  assert.ok(!isNewer("", "1.2.0"));
});

test("a fresh answer is reused, a stale one is asked again", async () => {
  const dir = await temp();
  const configFile = path.join(dir, "config.json");
  const registry = stubRegistry("2.0.0");
  try {
    const first = await checkForUpdate({ configFile, current: "1.0.0", fetchLatest: registry.fetchLatest, now: 1_000_000 });
    assert.equal(first.latest, "2.0.0");
    assert.equal(first.available, true);
    assert.equal(first.fromCache, false);
    assert.equal(registry.calls.length, 1);

    const cache = JSON.parse(await fs.readFile(updateCachePath(configFile), "utf8"));
    assert.equal(cache.latest, "2.0.0");
    assert.equal(cache.checkedAt, 1_000_000);

    // Still fresh: the same answer, and no second request.
    const again = await checkForUpdate({ configFile, current: "1.0.0", fetchLatest: registry.fetchLatest, now: 1_000_000 + CHECK_TTL_MS - 1 });
    assert.equal(again.fromCache, true);
    assert.equal(again.latest, "2.0.0");
    assert.equal(registry.calls.length, 1, "a loop of launches is still one request");

    // Past the window: asked again, so a person who looks gets a current answer.
    await checkForUpdate({ configFile, current: "1.0.0", fetchLatest: registry.fetchLatest, now: 1_000_000 + CHECK_TTL_MS });
    assert.equal(registry.calls.length, 2);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("an unreachable registry says so, and never says up to date", async () => {
  const dir = await temp();
  const configFile = path.join(dir, "config.json");
  try {
    const offline = await checkForUpdate({ configFile, current: "1.0.0", fetchLatest: async () => null });
    assert.equal(offline.offline, true);
    assert.equal(offline.available, false);
    assert.equal(offline.checked, false, '"could not ask" and "asked, nothing new" are different answers');
    assert.equal(await fs.readdir(dir).then((files) => files.length), 0, "and nothing is cached from a failed check");

    // With a stale cache to fall back on, what it already knew still stands.
    await fs.writeFile(updateCachePath(configFile), JSON.stringify({ checkedAt: 1, latest: "3.0.0" }));
    const remembered = await checkForUpdate({ configFile, current: "1.0.0", fetchLatest: async () => null, now: 9e12 });
    assert.equal(remembered.offline, true);
    assert.equal(remembered.latest, "3.0.0");
    assert.equal(remembered.available, true, "a known release does not stop existing because the network is down");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("a corrupt cache is ignored rather than fatal", async () => {
  const dir = await temp();
  const configFile = path.join(dir, "config.json");
  try {
    await fs.writeFile(updateCachePath(configFile), "{ this is not json");
    const registry = stubRegistry("2.0.0");
    const result = await checkForUpdate({ configFile, current: "1.0.0", fetchLatest: registry.fetchLatest });
    assert.equal(result.latest, "2.0.0");
    assert.equal(registry.calls.length, 1);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("turned off means no request at all, by setting or by environment", async () => {
  const dir = await temp();
  const configFile = path.join(dir, "config.json");
  const registry = stubRegistry("2.0.0");
  try {
    const bySetting = await checkForUpdate({ configFile, config: { update: { check: false } }, current: "1.0.0", fetchLatest: registry.fetchLatest });
    assert.equal(bySetting.disabled, true);
    assert.equal(bySetting.available, false);

    process.env.LLM_PROXY_NO_UPDATE_CHECK = "1";
    try {
      assert.equal(checkDisabled({ update: { check: true } }), true, "the environment wins for a single run");
      const byEnv = await checkForUpdate({ configFile, current: "1.0.0", fetchLatest: registry.fetchLatest });
      assert.equal(byEnv.disabled, true);
    } finally {
      delete process.env.LLM_PROXY_NO_UPDATE_CHECK;
    }

    assert.equal(registry.calls.length, 0, "nothing left this machine");
    assert.equal(await fs.readdir(dir).then((files) => files.length), 0);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("the registry answer is read from dist-tags, and a bad one is not trusted", async () => {
  const replies = [
    { status: 200, body: '{"latest":"4.5.6","beta":"5.0.0-beta.1"}', expect: "4.5.6" },
    { status: 200, body: '{"beta":"5.0.0-beta.1"}', expect: null },
    { status: 200, body: "not json at all", expect: null },
    { status: 404, body: '{"error":"not found"}', expect: null },
    { status: 500, body: "", expect: null },
  ];

  for (const reply of replies) {
    const server = http.createServer((_req, res) => {
      res.writeHead(reply.status, { "content-type": "application/json" });
      res.end(reply.body);
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${server.address().port}/dist-tags`;
    try {
      assert.equal(await latestVersion({ url }), reply.expect, `HTTP ${reply.status} ${reply.body.slice(0, 20)}`);
    } finally {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    }
  }
});

test("a registry that never answers gives up instead of hanging", async () => {
  // Accepts the connection and says nothing, the worst case for a UI.
  const server = http.createServer(() => {});
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}/dist-tags`;
  try {
    const started = Date.now();
    assert.equal(await latestVersion({ url, timeoutMs: 250 }), null);
    assert.ok(Date.now() - started < 3000, "it returns on its own deadline");
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("the command offered is the one that installs the release", () => {
  const { command, args } = updateCommand();
  assert.equal(command, "npm");
  assert.deepEqual(args, ["install", "--global", "llm-failover-proxy@latest"]);
});
