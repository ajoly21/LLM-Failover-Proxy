import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { startMock } from './mock-provider.js';
import { statsPathFor } from '../src/config.js';
import { flushStats } from '../src/state.js';
import { assemble, backend, postJson, startProxy } from './helpers.js';

const CHAT = { messages: [{ role: 'user', content: 'hi' }] };

const statsOf = async (configFile) => JSON.parse(await fs.readFile(statsPathFor(configFile), 'utf8'));
const getStats = async (proxy) => (await fetch(`${proxy.url}/stats`)).json();

test('counters survive a restart', async () => {
  const mocks = [await startMock('error500', { name: 'broken' }), await startMock('ok', { name: 'healthy' })];
  const backends = [backend(mocks[0], { model: 'm-1', alias: 'a' }), backend(mocks[1], { model: 'm-2', alias: 'b' })];

  const first = await startProxy(assemble(backends));
  try {
    await postJson(`${first.url}/v1/chat/completions`, CHAT);
    await postJson(`${first.url}/v1/chat/completions`, CHAT);

    const before = await getStats(first);
    assert.equal(before.totals.requests, 4, '2 requests × (1 failure + 1 success)');
    assert.equal(before.totals.successes, 2);
    assert.equal(before.totals.failures, 2);
    assert.ok(before.totals.tokens > 0);

    flushStats(); // the throttled write would otherwise land up to 1s later
    await first.stop();

    // Same config file → same stats file: this is a restart, not a fresh setup.
    const restarted = await startProxy({ reuse: first.file });
    const after = await getStats(restarted);
    assert.equal(after.totals.requests, before.totals.requests);
    assert.equal(after.totals.successes, before.totals.successes);
    assert.equal(after.totals.failures, before.totals.failures);
    assert.equal(after.totals.tokens, before.totals.tokens);
    assert.equal(after.statsSince, before.statsSince, 'the accumulation start date is kept');
    assert.equal(after.chain[0].lastError.reason, 'upstream_error');
    assert.equal(after.uptimeSec >= 0, true);
    await restarted.stop();

    // Later requests keep adding up rather than starting over.
    const third = await startProxy({ reuse: first.file });
    await postJson(`${third.url}/v1/chat/completions`, CHAT);
    const grown = await getStats(third);
    assert.equal(grown.totals.successes, before.totals.successes + 1);
    await third.stop();
  } finally {
    await fs.rm(first.dir, { recursive: true, force: true });
    await Promise.all(mocks.map((mock) => mock.close()));
  }
});

test('a benched provider stays benched across a restart', async () => {
  const mocks = [await startMock('rate-limit', { name: 'limited' }), await startMock('ok', { name: 'steady' })];
  const backends = [backend(mocks[0], { model: 'm-1', alias: 'a' }), backend(mocks[1], { model: 'm-2', alias: 'b' })];

  const first = await startProxy({
    ...assemble(backends),
    // Long enough that only persistence — not expiry — decides the outcome.
    failover: { cooldown: { failuresBeforeTrip: 2, baseMs: 60000, maxMs: 120000 } },
  });
  try {
    await postJson(`${first.url}/v1/chat/completions`, CHAT);
    assert.equal(mocks[0].calls, 1);
    const before = await getStats(first);
    assert.equal(before.chain[0].coolingDown, true);

    flushStats();
    await first.stop();

    const restarted = await startProxy({ reuse: first.file });
    const res = await postJson(`${restarted.url}/v1/chat/completions`, CHAT);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('x-llm-proxy-provider'), 'steady');
    assert.equal(res.headers.get('x-llm-proxy-fallbacks'), '0', 'the benched entry is skipped without an attempt');
    assert.equal(mocks[0].calls, 1, 'the rate-limited provider is not called again after the restart');

    const after = await getStats(restarted);
    assert.equal(after.chain[0].coolingDown, true);
    assert.equal(after.chain[0].lastError.reason, 'rate_limited');
    await restarted.stop();
  } finally {
    await fs.rm(first.dir, { recursive: true, force: true });
    await Promise.all(mocks.map((mock) => mock.close()));
  }
});

test('a success clears a persisted cooldown', async () => {
  const mock = await startMock('rate-limit', { name: 'flaky' });
  const first = await startProxy({
    ...assemble([backend(mock, { model: 'm-1', alias: 'a' })]),
    failover: { cooldown: { failuresBeforeTrip: 2, baseMs: 60000, maxMs: 120000 } },
  });
  try {
    await postJson(`${first.url}/v1/chat/completions`, CHAT);
    assert.equal((await getStats(first)).chain[0].coolingDown, true);
    flushStats();
    await first.stop();

    // Benched but alone in the chain: it is retried as a last resort, and works.
    mock.behavior = 'ok';
    const restarted = await startProxy({ reuse: first.file });
    const res = await postJson(`${restarted.url}/v1/chat/completions`, CHAT);
    assert.equal(res.status, 200);

    const after = await getStats(restarted);
    assert.equal(after.chain[0].coolingDown, false);
    assert.equal(after.chain[0].cooldownMsLeft, 0);
    assert.equal(after.chain[0].lastError, null);
    await restarted.stop();
  } finally {
    await fs.rm(first.dir, { recursive: true, force: true });
    await mock.close();
  }
});

test('a fresh install has no stats file until it has something to record', async () => {
  // The file is the user's own history: it must be created by their own usage,
  // never shipped, and never present in a clone or a fresh install.
  const mock = await startMock('ok', { name: 'p' });
  const proxy = await startProxy(assemble([backend(mock, { model: 'm-1', alias: 'a' })]));
  const statsFile = statsPathFor(proxy.file);
  try {
    const exists = () => fs.access(statsFile).then(() => true, () => false);
    assert.equal(await exists(), false, 'starting the proxy alone writes nothing');

    await fetch(`${proxy.url}/stats`); // reading counters is not a reason to write either
    assert.equal(await exists(), false);

    await postJson(`${proxy.url}/v1/chat/completions`, CHAT);
    assert.equal(await exists(), true, 'the first finished request creates it');
    const saved = await statsOf(proxy.file);
    assert.deepEqual(Object.keys(saved.entries), ['mdl_p']);
  } finally {
    await proxy.close();
    await mock.close();
  }
});

test('stats file: written next to the config, restricted to configured models', async () => {
  const mock = await startMock('ok', { name: 'p' });
  const proxy = await startProxy(assemble([backend(mock, { model: 'm-1', alias: 'a' })]));
  try {
    await postJson(`${proxy.url}/v1/chat/completions`, CHAT);
    flushStats();

    const saved = await statsOf(proxy.file);
    assert.equal(saved.version, 1);
    assert.ok(Number.isFinite(saved.since) && Number.isFinite(saved.updatedAt));
    assert.deepEqual(Object.keys(saved.entries), ['mdl_p']);
    assert.equal(saved.entries.mdl_p.successes, 1);

    // An entry that no longer exists in the config is dropped on restore.
    saved.entries.mdl_ghost = { requests: 99, successes: 99 };
    await fs.writeFile(statsPathFor(proxy.file), JSON.stringify(saved));
    await proxy.stop();

    const restarted = await startProxy({ reuse: proxy.file });
    const after = await getStats(restarted);
    assert.equal(after.totals.requests, 1, 'the ghost entry does not inflate the totals');
    assert.equal(after.chain.length, 1);
    await restarted.stop();
  } finally {
    await fs.rm(proxy.dir, { recursive: true, force: true });
    await mock.close();
  }
});

test('a corrupt or hand-edited stats file never breaks startup', async () => {
  const mock = await startMock('ok', { name: 'p' });
  const proxy = await startProxy(assemble([backend(mock, { model: 'm-1', alias: 'a' })]));
  const statsFile = statsPathFor(proxy.file);
  try {
    await proxy.stop();

    for (const garbage of ['{ not json', '[]', '{"entries":"nope"}', '{"entries":{"mdl_p":{"requests":"abc","lastError":42}}}']) {
      await fs.writeFile(statsFile, garbage);
      const restarted = await startProxy({ reuse: proxy.file });
      const stats = await getStats(restarted);
      assert.equal(stats.chain.length, 1, `survived: ${garbage}`);
      assert.equal(Number.isFinite(stats.totals.requests), true, `numeric totals: ${garbage}`);

      const res = await postJson(`${restarted.url}/v1/chat/completions`, CHAT);
      assert.equal(res.status, 200, `still serving: ${garbage}`);
      await restarted.stop();
    }
  } finally {
    await fs.rm(proxy.dir, { recursive: true, force: true });
    await mock.close();
  }
});

test('statsFile: null keeps everything in memory', async () => {
  const mock = await startMock('ok', { name: 'p' });
  const { createServer } = await import('../src/server.js');
  const proxy = await startProxy(assemble([backend(mock, { model: 'm-1', alias: 'a' })]));
  try {
    await proxy.stop();
    await fs.rm(statsPathFor(proxy.file), { force: true });

    const app = createServer({ configFile: proxy.file, statsFile: null });
    await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${app.server.address().port}`;
    await postJson(`${url}/v1/chat/completions`, CHAT);
    flushStats();

    await assert.rejects(() => fs.access(statsPathFor(proxy.file)), 'no stats file must be created');
    app.server.closeAllConnections?.();
    await new Promise((resolve) => app.server.close(resolve));
  } finally {
    await fs.rm(proxy.dir, { recursive: true, force: true });
    await mock.close();
  }
});
