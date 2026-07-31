import test from 'node:test';
import assert from 'node:assert/strict';
import { startMock } from './mock-provider.js';
import { assemble, backend, postJson, readStream, startProxy } from './helpers.js';

const CHAT = { messages: [{ role: 'user', content: 'hi' }] };

/** Builds a proxy over the given mocks, in the given order. */
async function chain(specs, failover = {}) {
  const mocks = [];
  for (const spec of specs) mocks.push(await startMock(spec.behavior ?? 'ok', { name: spec.name, delayMs: spec.delayMs ?? 0 }));
  const backends = mocks.map((mock, index) => backend(mock, { model: `m-${index}`, alias: `a-${index}` }));
  const proxy = await startProxy({ ...assemble(backends), failover });
  return {
    mocks,
    proxy,
    chat: (body = CHAT) => postJson(`${proxy.url}/v1/chat/completions`, body),
    stream: (body = CHAT) => readStream(`${proxy.url}/v1/chat/completions`, { ...body, stream: true }),
    stats: async () => (await fetch(`${proxy.url}/stats`)).json(),
    async close() {
      await proxy.close();
      await Promise.all(mocks.map((mock) => mock.close()));
    },
  };
}

test('a slow first model loses to a faster one launched after the hedge delay', async () => {
  const s = await chain(
    [
      { name: 'slow', delayMs: 400 }, // alive, just slow
      { name: 'quick' },
    ],
    { hedgeDelayMs: 80 },
  );
  try {
    const started = Date.now();
    const res = await s.chat();
    const elapsed = Date.now() - started;

    assert.equal(res.status, 200);
    assert.equal(res.headers.get('x-llm-proxy-provider'), 'quick', 'the answer comes from the hedge');
    assert.equal(res.headers.get('x-llm-proxy-cancelled'), '1', 'the slow attempt was aborted');
    assert.ok(elapsed < 350, `answered in ${elapsed}ms instead of waiting 400ms for the first model`);

    // Both were really asked: the point is to overlap them, not to skip one.
    assert.equal(s.mocks[0].calls, 1);
    assert.equal(s.mocks[1].calls, 1);

    const stats = await s.stats();
    assert.equal(stats.chain[0].cancelled, 1);
    assert.equal(stats.chain[0].failures, 0, 'losing a race is not a provider failure');
    assert.equal(stats.chain[0].coolingDown, false, 'and must never bench the provider');
    assert.equal(stats.chain[1].successes, 1);
  } finally {
    await s.close();
  }
});

test('the preferred model wins when it answers within the hedge delay', async () => {
  const s = await chain([{ name: 'first' }, { name: 'second' }], { hedgeDelayMs: 5000 });
  try {
    const res = await s.chat();
    assert.equal(res.headers.get('x-llm-proxy-provider'), 'first');
    assert.equal(res.headers.get('x-llm-proxy-cancelled'), '0');
    assert.equal(s.mocks[1].calls, 0, 'no speculative call when the order is respected');
  } finally {
    await s.close();
  }
});

test('hedgeDelayMs: 0 keeps failover strictly sequential', async () => {
  const s = await chain([{ name: 'slow', delayMs: 250 }, { name: 'quick' }], { hedgeDelayMs: 0 });
  try {
    const res = await s.chat();
    assert.equal(res.headers.get('x-llm-proxy-provider'), 'slow', 'we waited for the preferred model');
    assert.equal(s.mocks[1].calls, 0, 'the second model was never asked');
  } finally {
    await s.close();
  }
});

test('a failure starts the next model at once, without waiting for the hedge delay', async () => {
  const s = await chain(
    [
      { name: 'broken', behavior: 'error500' },
      { name: 'healthy' },
    ],
    // A delay long enough that waiting for it would blow the test's own budget.
    { hedgeDelayMs: 60000 },
  );
  try {
    const started = Date.now();
    const res = await s.chat();
    const elapsed = Date.now() - started;

    assert.equal(res.status, 200);
    assert.equal(res.headers.get('x-llm-proxy-provider'), 'healthy');
    assert.equal(res.headers.get('x-llm-proxy-fallbacks'), '1');
    assert.ok(elapsed < 1000, `answered in ${elapsed}ms: a failure must free its slot immediately`);
  } finally {
    await s.close();
  }
});

test('maxInFlight caps how many providers are asked at once', async () => {
  const s = await chain(
    [
      { name: 'slow-1', delayMs: 500 },
      { name: 'slow-2', delayMs: 500 },
      { name: 'fast-3' },
      { name: 'fast-4' },
    ],
    { hedgeDelayMs: 50, maxInFlight: 2 },
  );
  try {
    const res = await s.chat();
    assert.equal(res.status, 200);
    // With no cap, fast-3 would have been launched at 100ms and won instantly.
    assert.match(res.headers.get('x-llm-proxy-provider'), /^slow-[12]$/);
    assert.equal(s.mocks[0].calls, 1);
    assert.equal(s.mocks[1].calls, 1);
    assert.equal(s.mocks[2].calls, 0, 'the cap held');
    assert.equal(s.mocks[3].calls, 0);
  } finally {
    await s.close();
  }
});

test('streaming: only the winner reaches the client', async () => {
  const s = await chain([{ name: 'slow', delayMs: 400 }, { name: 'quick' }], { hedgeDelayMs: 80 });
  try {
    const res = await s.stream();
    assert.equal(res.status, 200);
    assert.equal(res.content, 'hello from quick', 'no interleaving of two answers');
    assert.equal(res.done, true);
    assert.equal(res.finishReason, 'stop');
    assert.equal(res.headers.get('x-llm-proxy-provider'), 'quick');
    assert.equal(res.headers.get('x-llm-proxy-racing'), '1', 'one sibling was still in flight when this one won');
    assert.ok(!res.models.some((model) => model.startsWith('slow')), 'not a single chunk from the loser');
  } finally {
    await s.close();
  }
});

test('hedging still walks the whole chain when everything fails', async () => {
  const s = await chain(
    [
      { name: 'a', behavior: 'error500' },
      { name: 'b', behavior: 'rate-limit' },
      { name: 'c', behavior: 'empty' },
    ],
    { hedgeDelayMs: 50 },
  );
  try {
    const res = await s.chat();
    assert.equal(res.status, 502);
    assert.equal(res.json.error.proxy.attempts.length, 3);
    assert.deepEqual(
      res.json.error.proxy.attempts.map((attempt) => attempt.reason).sort(),
      ['empty_response', 'rate_limited', 'upstream_error'],
    );
  } finally {
    await s.close();
  }
});

test('a client that hangs up aborts every speculative attempt', async () => {
  const s = await chain([{ name: 'slow-1', delayMs: 900 }, { name: 'slow-2', delayMs: 900 }], { hedgeDelayMs: 50 });
  try {
    const controller = new AbortController();
    const request = fetch(`${s.proxy.url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(CHAT),
      signal: controller.signal,
    });
    await new Promise((resolve) => setTimeout(resolve, 200));
    controller.abort();
    await assert.rejects(() => request);

    // Neither provider may be blamed for the client leaving.
    await new Promise((resolve) => setTimeout(resolve, 300));
    const stats = await s.stats();
    assert.equal(stats.totals.failures, 0);
    assert.equal(stats.totals.successes, 0);
  } finally {
    await s.close();
  }
});
