import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { addTarget, loadConfig, saveConfig } from "../src/config.js";
import { assemble, backend, postJson, startProxy } from "./helpers.js";
import { startMock } from "./mock-provider.js";

const run = promisify(execFile);
const CLI = path.resolve(import.meta.dirname, "..", "src", "index.js");
const CHAT = { messages: [{ role: "user", content: "hi" }] };

/**
 * Runs a console command to completion. `execFile` only resolves when the
 * process exits, so every assertion below also proves the command hands the
 * shell back instead of watching for updates like the UI does.
 */
function cli(args, { configFile, cwd }) {
  const env = { ...process.env, NO_COLOR: "1" };
  for (const name of Object.keys(env)) if (name.endsWith("_API_KEY")) delete env[name];
  return run(process.execPath, [CLI, ...args, "--config", configFile], { env, cwd, timeout: 30000 });
}

test("`stats` reports the counters of a running proxy, then exits", async () => {
  const mock = await startMock("ok", { name: "p" });
  const proxy = await startProxy(assemble([backend(mock, { model: "m-1", alias: "a" })]));
  const where = { configFile: proxy.file, cwd: proxy.dir };
  try {
    // Nothing served yet: no file, no server answer, and it still returns.
    const empty = await cli(["stats"], where);
    assert.match(empty.stdout, /no counters yet/);

    await postJson(`${proxy.url}/v1/chat/completions`, CHAT);
    // The test harness listens on an ephemeral port; write it down so the
    // command can find the running proxy the way it would in real use.
    const config = loadConfig(proxy.file);
    config.server.port = Number(new URL(proxy.url).port);
    saveConfig(config, proxy.file);

    const live = await cli(["stats"], where);
    assert.match(live.stdout, /Running server/);
    assert.match(live.stdout, /PRIO\s+TARGET\s+REQ\s+OK\s+KO\s+CX\s+USE\s+UPTIME\s+TOKENS\s+LAST USED/, "the counters table is printed");
    assert.match(live.stdout, /p\/m-1/);
    assert.match(live.stdout, /1 request\(s\), 1 ok/);
    // The only model served everything and answered: both shares are total.
    assert.match(live.stdout, /p\/m-1\s+1\s+1\s+0\s+0\s+100%\s+100%/, "share of the answers, then availability");
    // And the call it just served is listed underneath, with its age.
    assert.match(live.stdout, /last 1 answered/);
    assert.match(live.stdout, /WHEN\s+MODEL/);
    assert.match(live.stdout, /\ds ago\s+p\/m-1/, "seconds old, and which model took it");
    assert.doesNotMatch(live.stdout, /Providers|Model chain/, "just the counters, `status` is the full report");

    const asJson = JSON.parse((await cli(["stats", "--json"], where)).stdout);
    assert.equal(asJson.source, "server");
    assert.equal(asJson.totals.successes, 1);
    assert.equal(asJson.chain[0].model, "m-1");
  } finally {
    await proxy.close();
    await mock.close();
  }
});

test("a cancelled attempt is lost traffic, not unavailability", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "llm-proxy-shares-"));
  const configFile = path.join(dir, "config.json");
  await fs.writeFile(
    configFile,
    JSON.stringify({
      // A port nothing listens on, so the counters are read from disk.
      server: { host: "127.0.0.1", port: 1 },
      providers: [{ id: "prov_1", name: "p", type: "openai", baseUrl: "http://127.0.0.1:1", apiKey: null, headers: {}, enabled: true }],
      models: [
        { id: "mdl_1", providerId: "prov_1", model: "hedged", alias: "hedged", kind: "chat", enabled: true, params: {} },
        { id: "mdl_2", providerId: "prov_1", model: "flaky", alias: "flaky", kind: "chat", enabled: true, params: {} },
      ],
    }),
  );
  await fs.writeFile(
    path.join(dir, "config.stats.json"),
    JSON.stringify({
      since: Date.now(),
      updatedAt: Date.now(),
      entries: {
        // Asked 8 times, served 3 answers, dropped 5 times for losing a race.
        mdl_1: { requests: 8, successes: 3, failures: 0, cancelled: 5, tokens: 100, lastUsedAt: Date.now() - 23_000 },
        // Asked twice, answered once, failed once.
        mdl_2: { requests: 2, successes: 1, failures: 1, cancelled: 0, tokens: 50, lastUsedAt: Date.now() - 125_000 },
      },
      recent: [
        { id: "mdl_1", at: Date.now() - 23_000 },
        { id: "mdl_2", at: Date.now() - 125_000 },
        { id: "mdl_gone", at: Date.now() - 3_600_000 },
      ],
    }),
  );

  try {
    const { stdout } = await cli(["stats"], { configFile, cwd: dir });
    // 3 of the 4 answers, and it answered every time it was asked to finish:
    // neither share is dragged down by the 5 attempts that lost their race.
    assert.match(stdout, /p\/hedged\s+8\s+3\s+0\s+5\s+75%\s+100%/);
    assert.match(stdout, /p\/flaky\s+2\s+1\s+1\s+0\s+25%\s+50%/, "1 of the 4 answers, and one failure out of two decided attempts");

    // Ages, in the units the eye reads: seconds, then minutes.
    assert.match(stdout, /23s ago\s+p\/hedged/);
    assert.match(stdout, /2min ago\s+p\/flaky/);
    assert.match(stdout, /1h ago\s+mdl_gone \(no longer configured\)/, "a deleted model is named, not silently dropped");

    const asJson = JSON.parse((await cli(["stats", "--json"], { configFile, cwd: dir })).stdout);
    assert.equal(asJson.totals.successes, 4, "the shares are taken out of the answers actually served");
    assert.equal(asJson.recent.length, 3, "the recent calls travel in the JSON too");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("`lists` names the model lists, and `use` serves another one", async () => {
  const mock = await startMock("ok", { name: "p" });
  const proxy = await startProxy(assemble([backend(mock, { model: "m-1", alias: "a1" })]));
  const where = { configFile: proxy.file, cwd: proxy.dir };
  // A second list holding a chain of its own, exactly as the UI builds it.
  const seed = loadConfig(proxy.file);
  addTarget(seed, "cheap-and-fast");
  seed.models.push({ id: "mdl_2", providerId: "prov_p", model: "m-2", alias: "a2", kind: "chat", enabled: true, params: {} });
  saveConfig(seed, proxy.file);

  const served = async () => {
    const answer = await fetch(`${proxy.url}/v1/models`).then((response) => response.json());
    return answer.data.filter((entry) => entry.id !== "auto").map((entry) => entry.id);
  };

  try {
    const listed = await cli(["lists"], where);
    assert.match(listed.stdout, /#\s+NAME\s+MODELS\s+ON\s+ACTIVE/);
    assert.match(listed.stdout, /1\s+default\s+1\s+1\s+-/, "the list that is not being served");
    assert.match(listed.stdout, /2\s+cheap-and-fast\s+1\s+1\s+yes/, "and the one that is");
    assert.match(listed.stdout, /llmfp use <name\|index>/, "and how to switch without the UI");

    assert.deepEqual(await served(), ["a2"], "the running proxy serves the active list");

    // By number, the way `lists` prints them: the switch reaches the proxy
    // already running through its config watcher, with nothing restarted.
    const back = await cli(["use", "1"], where);
    assert.match(back.stdout, /now serving default \(1\/2\)\s+1 model\(s\), 1 enabled/);
    assert.deepEqual(loadConfig(proxy.file).models.map((entry) => entry.model), ["m-1"], "the chain in the file is the one that was asked for");
    assert.deepEqual(await served(), ["a1"], "and the request that followed was answered from it");

    // By part of a name, since that is what anyone types.
    const partial = await cli(["use", "cheap"], where);
    assert.match(partial.stdout, /now serving cheap-and-fast \(2\/2\)/);
    assert.deepEqual(await served(), ["a2"]);

    const again = await cli(["use", "cheap-and-fast"], where);
    assert.match(again.stdout, /already serving cheap-and-fast/, "no switch to make, and nothing to say about a restart");

    const asJson = JSON.parse((await cli(["lists", "--json"], where)).stdout);
    assert.equal(asJson.active, "cheap-and-fast");
    assert.equal(asJson.activeIndex, 2);
    assert.deepEqual(
      asJson.lists.map((entry) => entry.name),
      ["default", "cheap-and-fast"],
    );
  } finally {
    await proxy.close();
    await mock.close();
  }
});

test("`use` refuses a name it cannot place, and says what there was", async () => {
  const proxy = await startProxy({ providers: [], models: [] });
  const where = { configFile: proxy.file, cwd: proxy.dir };
  try {
    // Exit code 1, so a script can branch on it rather than parse the message.
    await assert.rejects(
      () => cli(["use", "nope"], where),
      (err) => {
        assert.equal(err.code, 1);
        assert.match(err.stdout, /no list called "nope"/);
        assert.match(err.stdout, /lists:\s+1\. default/, "and the names it could have meant");
        return true;
      },
    );

    await assert.rejects(
      () => cli(["use"], where),
      (err) => {
        assert.equal(err.code, 1);
        assert.match(err.stdout, /which list\?/);
        return true;
      },
    );

    // Same refusal, machine-readable, for the script that asked for JSON.
    await assert.rejects(
      () => cli(["use", "7", "--json"], where),
      (err) => {
        assert.equal(err.code, 1);
        const payload = JSON.parse(err.stdout);
        assert.equal(payload.ok, false);
        assert.match(payload.error, /there is no list 7/);
        assert.deepEqual(payload.lists, ["default"]);
        return true;
      },
    );
  } finally {
    await proxy.close();
  }
});

test("`stats` falls back to the persisted file when nothing is running", async () => {
  const mock = await startMock("ok", { name: "p" });
  const proxy = await startProxy(assemble([backend(mock, { model: "m-1", alias: "a" })]));
  const where = { configFile: proxy.file, cwd: proxy.dir };
  try {
    await postJson(`${proxy.url}/v1/chat/completions`, CHAT);
    await proxy.stop();

    const offline = await cli(["stats"], where);
    assert.match(offline.stdout, /Persisted counters/);
    assert.match(offline.stdout, /read from disk/);
    assert.match(offline.stdout, /p\/m-1/);
    assert.match(offline.stdout, /1 request\(s\), 1 ok/, "the counters outlive the process");

    const asJson = JSON.parse((await cli(["stats", "--json"], where)).stdout);
    assert.equal(asJson.source, "file");
    assert.equal(asJson.totals.successes, 1, "same numbers as the live report");
    assert.equal(asJson.chain[0].priority, 1);
    assert.ok(Number.isFinite(asJson.statsSince));
  } finally {
    await fs.rm(proxy.dir, { recursive: true, force: true });
    await mock.close();
  }
});
