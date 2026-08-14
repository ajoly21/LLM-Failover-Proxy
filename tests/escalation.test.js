import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { loadConfig } from '../src/config.js';
import { REASONS } from '../src/errors.js';
import { failureMessage, run } from '../src/router.js';
import { createGoneSignal } from '../src/signal.js';
import { markRateLimited, preferredVia, resetAll, stateFor } from '../src/state.js';
import { tunnelInUse } from '../src/warp/egress.js';
import { clearTunnelRateLimited, rotationPending } from '../src/warp/rotate.js';
import { assemble, backend } from './helpers.js';
import { startMock } from './mock-provider.js';

/**
 * `warp.mode: "on-rate-limit"`: requests leave directly, and a model the provider
 * answered `429` to is asked again through the tunnel.
 *
 * What is being tested here is the *routing decision*, per model and per attempt.
 * The transport itself is tested in `warp.test.js`, and it has to be: a mock
 * provider is on loopback, and `isLocalTarget` refuses — correctly — to send
 * loopback through a tunnel that egresses on the public internet. So no test can
 * do both ends at once, and pretending otherwise would test neither.
 */

/**
 * Two routes reaching two different servers, which is the only way a test can see
 * which one an attempt took. Stands in for the real plan, whose shape it copies.
 */
function twoRoutePlan({ warpOrigin, tunnelUp = true, startDelayMs = 0 }) {
  const used = [];
  // Going out directly means reaching the address the chain holds, whichever
  // provider that is. Rewriting it here would send every model to the same
  // server, and a test where all the models are one model proves nothing.
  const base = {
    via: 'direct',
    send: (input, init) => {
      used.push({ via: 'direct', url: String(typeof input === 'string' ? input : input.url) });
      return fetch(input, init);
    },
  };
  // Arriving from somewhere else is modelled as arriving at somewhere else: the
  // one thing a loopback test can observe about which way a request left.
  const sendVia = (origin) => (input, init) => {
    const target = new URL(String(typeof input === 'string' ? input : input.url));
    used.push({ via: 'warp', url: target.href });
    return fetch(new URL(`${target.pathname}${target.search}`, origin), init);
  };
  // One route object for the whole request, the way the real plan shares a socket
  // pool between however many models escalate at once.
  const tunnel = { via: 'warp', send: sendVia(warpOrigin) };
  let escalations = 0;

  return {
    used,
    get escalations() {
      return escalations;
    },
    plan: {
      via: 'direct',
      unavailable: false,
      degraded: false,
      escalates: true,
      routeFor: async (entryId) => (preferredVia(entryId) === 'warp' && tunnelUp ? { ...tunnel, preferred: true } : base),
      escalate: async () => {
        escalations += 1;
        if (startDelayMs) await new Promise((resolve) => setTimeout(resolve, startDelayMs));
        return tunnelUp ? tunnel : null;
      },
    },
  };
}

/** A config on disk, loaded the way the proxy loads it, for driving `run` directly. */
async function configFor(backends, { failover = {}, warp = {} } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'llm-proxy-esc-'));
  const file = path.join(dir, 'config.json');
  await fs.writeFile(
    file,
    JSON.stringify({
      server: { port: 0, logLevel: 'error' },
      failover: {
        requestTimeoutMs: 5000,
        firstTokenTimeoutMs: 3000,
        hedgeDelayMs: 0,
        cooldown: { failuresBeforeTrip: 2, baseMs: 15000, maxMs: 300000 },
        ...failover,
      },
      warp: { enabled: true, mode: 'on-rate-limit', ...warp },
      ...assemble(backends),
    }),
  );
  return { config: loadConfig(file), cleanup: () => fs.rm(dir, { recursive: true, force: true }) };
}

const ask = (config, plan, body = {}) =>
  run({ config, body: { messages: [{ role: 'user', content: 'hi' }], ...body }, clientGone: createGoneSignal(), plan, requestId: 't' });

test('a rate-limited model is asked again through the tunnel, and answers', async () => {
  resetAll();
  const direct = await startMock('rate-limit', { name: 'quota' });
  const viaWarp = await startMock('ok', { name: 'quota' });
  const { config, cleanup } = await configFor([backend(direct, { id: 'quota', model: 'm', alias: 'a' })]);
  const routes = twoRoutePlan({ warpOrigin: viaWarp.baseUrl });

  try {
    const result = await ask(config, routes.plan);

    assert.equal(result.type, 'json');
    assert.match(result.json.choices[0].message.content, /hello from quota/, 'the answer is the one the tunnel brought back');
    assert.equal(result.via, 'warp');
    assert.equal(result.escalated, true);
    assert.deepEqual(
      routes.used.map((call) => call.via),
      ['direct', 'warp'],
      'directly first, and the tunnel only as the second chance',
    );
    assert.equal(direct.calls, 1, 'the same model, asked twice — not the next one in the chain');
    assert.equal(viaWarp.calls, 1);

    // It answered, so it must not be sitting benched: a 429 the tunnel got round
    // is no reason to step over this model on the next request.
    const state = stateFor('mdl_quota');
    assert.equal(state.successes, 1);
    assert.equal(state.cooldownUntil, 0, 'not benched, it just left by another door');
    assert.equal(state.escalated, 1);
    // And remembered, so the next request skips the 429 it already knows about.
    assert.equal(preferredVia('mdl_quota'), 'warp');
  } finally {
    await cleanup();
    await direct.close();
    await viaWarp.close();
  }
});

test('a model inside its window starts on the tunnel, without spending a 429 first', async () => {
  resetAll();
  const direct = await startMock('rate-limit', { name: 'known' });
  const viaWarp = await startMock('ok', { name: 'known' });
  const { config, cleanup } = await configFor([backend(direct, { id: 'known', model: 'm', alias: 'a' })]);
  const routes = twoRoutePlan({ warpOrigin: viaWarp.baseUrl });

  try {
    markRateLimited('mdl_known', { retryAfterMs: 60000, cooldown: config.failover.cooldown });
    const result = await ask(config, routes.plan);

    assert.equal(result.via, 'warp');
    assert.equal(result.escalated, true);
    assert.deepEqual(
      routes.used.map((call) => call.via),
      ['warp'],
      'straight through the tunnel',
    );
    assert.equal(direct.calls, 0, 'the 429 was already known, so it was not asked for again');
    assert.equal(routes.escalations, 0, 'and nothing had to escalate: the first choice was already right');
  } finally {
    await cleanup();
    await direct.close();
    await viaWarp.close();
  }
});

test('two models in one request leave by two different doors', async () => {
  // The whole point of deciding this per attempt. A is inside its rate-limit
  // window, so it goes through the tunnel; B is launched beside it by the hedge
  // and goes out directly. Both are in flight at once, and neither is moved,
  // cut, or tarred by the other's quota.
  //
  // A's window is set up front rather than raced into existence: which door each
  // model takes is the property under test, and a test that has to win a race
  // first is a test that reports on the race.
  resetAll();
  const throttled = await startMock('rate-limit', { name: 'throttled' });
  const healthy = await startMock('ok', { name: 'healthy' });
  const viaWarp = await startMock('ok', { name: 'tunnelled', delayMs: 400 });
  const { config, cleanup } = await configFor(
    [backend(throttled, { id: 'throttled', model: 'm1', alias: 'a1' }), backend(healthy, { id: 'healthy', model: 'm2', alias: 'a2' })],
    { failover: { hedgeDelayMs: 10 } },
  );
  const routes = twoRoutePlan({ warpOrigin: viaWarp.baseUrl });

  try {
    markRateLimited('mdl_throttled', { retryAfterMs: 60000, cooldown: config.failover.cooldown });
    const result = await ask(config, routes.plan);

    // A is slow through the tunnel, so B answers first — and what is recorded is
    // B's own path, not something decided once for the whole chain.
    assert.equal(result.entry.id, 'mdl_healthy');
    assert.equal(result.via, 'direct', "the winner's own path, not the one its neighbour took");
    assert.equal(result.escalated, false);

    // One request, two routes, one each.
    assert.deepEqual(routes.used.map((call) => call.via).sort(), ['direct', 'warp']);
    assert.equal(throttled.calls, 0, 'the model in its window never went out directly');
    assert.equal(healthy.calls, 1, 'and the healthy one was asked exactly once, directly');
    assert.equal(preferredVia('mdl_healthy'), 'direct', 'B is not tarred with its neighbour’s quota');
    assert.equal(preferredVia('mdl_throttled'), 'warp', 'and A keeps its own window');
  } finally {
    await cleanup();
    await throttled.close();
    await healthy.close();
    await viaWarp.close();
  }
});

test('a 429 that arrives after another model has answered does not escalate', async () => {
  // Escalating then would ask for a tunnel nobody is waiting for and send a
  // request only to abort it. The slow model's rate limit is real, it is simply
  // no longer anybody's problem.
  resetAll();
  const slow = await startMock('rate-limit', { name: 'slow', delayMs: 250 });
  const quick = await startMock('ok', { name: 'quick' });
  const viaWarp = await startMock('ok', { name: 'tunnelled' });
  const { config, cleanup } = await configFor(
    [backend(slow, { id: 'slow', model: 'm1', alias: 'a1' }), backend(quick, { id: 'quick', model: 'm2', alias: 'a2' })],
    { failover: { hedgeDelayMs: 10 } },
  );
  const routes = twoRoutePlan({ warpOrigin: viaWarp.baseUrl });

  try {
    const result = await ask(config, routes.plan);

    assert.equal(result.entry.id, 'mdl_quick', 'the quick model answered while the other was still waiting');
    assert.equal(routes.escalations, 0, 'nothing asked for a tunnel');
    assert.equal(viaWarp.calls, 0);
    // And nothing was remembered about the slow model either: its 429 was never
    // acted on, so there is no window to open.
    assert.equal(preferredVia('mdl_slow'), 'direct');
  } finally {
    await cleanup();
    await slow.close();
    await quick.close();
    await viaWarp.close();
  }
});

test('a rate limit the tunnel cannot get round is reported as exactly that', async () => {
  resetAll();
  const direct = await startMock('rate-limit', { name: 'capped' });
  const viaWarp = await startMock('rate-limit', { name: 'capped' });
  const { config, cleanup } = await configFor([backend(direct, { id: 'capped', model: 'm', alias: 'a' })]);
  const routes = twoRoutePlan({ warpOrigin: viaWarp.baseUrl });

  try {
    const result = await ask(config, routes.plan);

    assert.equal(result.type, 'error');
    const [attempt] = result.attempts;
    assert.equal(attempt.reason, REASONS.RATE_LIMIT);
    assert.equal(attempt.escalated, true, 'the report says the other address was tried too');
    assert.equal(attempt.via, 'warp');
    // Which is the difference between "wait for the quota to refill" and "the
    // quota is on the account, change something" — and the whole value of saying it.
    assert.match(failureMessage(result), /retried through Cloudflare WARP, same answer/);
    // Both routes exhausted, so now it is benched like any other rate limit.
    assert.ok(stateFor('mdl_capped').cooldownUntil > Date.now());
  } finally {
    await cleanup();
    await direct.close();
    await viaWarp.close();
  }
});

test('with no tunnel to be had, the rate limit stands and nothing is remembered', async () => {
  resetAll();
  const direct = await startMock('rate-limit', { name: 'notunnel' });
  const viaWarp = await startMock('ok', { name: 'notunnel' });
  const { config, cleanup } = await configFor([backend(direct, { id: 'notunnel', model: 'm', alias: 'a' })]);
  const routes = twoRoutePlan({ warpOrigin: viaWarp.baseUrl, tunnelUp: false });

  try {
    const result = await ask(config, routes.plan);

    assert.equal(result.type, 'error');
    assert.equal(result.attempts[0].escalated, false, 'nothing was tried through the tunnel');
    assert.equal(viaWarp.calls, 0);
    // Nothing is remembered either: a preference for a tunnel that is not there
    // would send the next request at a port with nothing behind it, and trade a
    // 429 for a network error.
    assert.equal(preferredVia('mdl_notunnel'), 'direct');
  } finally {
    await cleanup();
    await direct.close();
    await viaWarp.close();
  }
});

test('a stream that has already started is never replayed through the tunnel', async () => {
  // Once bytes have reached the client, sending the request again from another
  // address would splice two different answers together. A 429 always arrives
  // before the first byte, so this only ever protects against a later mistake —
  // which is exactly when a test earns its place.
  resetAll();
  const direct = await startMock('mid-stream-error', { name: 'interrupted' });
  const viaWarp = await startMock('ok', { name: 'interrupted' });
  const { config, cleanup } = await configFor([backend(direct, { id: 'interrupted', model: 'm', alias: 'a' })]);
  const routes = twoRoutePlan({ warpOrigin: viaWarp.baseUrl });

  const written = [];
  const sink = {
    committed: false,
    commit() {
      this.committed = true;
    },
    write: (text) => written.push(text),
    end() {},
  };

  try {
    const result = await run({
      config,
      body: { messages: [{ role: 'user', content: 'hi' }], stream: true },
      clientGone: createGoneSignal(),
      plan: routes.plan,
      sink,
      requestId: 't',
    });

    assert.equal(result.type, 'stream');
    assert.equal(result.degraded, true, 'the interruption is reported inside the stream it broke');
    assert.equal(viaWarp.calls, 0, 'and the tunnel was never asked to repeat an answer already half-delivered');
    assert.match(written.join(''), /start/, 'what did arrive was kept');
  } finally {
    await cleanup();
    await direct.close();
    await viaWarp.close();
  }
});

/* ------------------------------------------------------------------ *
 * What the tunnel's own rate limit sets in motion                     *
 * ------------------------------------------------------------------ */

test('a 429 that comes back through the tunnel asks for a new exit address', async () => {
  // A rate limit on the direct route is about this model. A rate limit that
  // followed us through the tunnel is about the address we left from — no other
  // model will do better from it, and no cooldown fixes it.
  resetAll();
  clearTunnelRateLimited();
  const direct = await startMock('rate-limit', { name: 'burnt' });
  const viaWarp = await startMock('rate-limit', { name: 'burnt' });
  const { config, cleanup } = await configFor([backend(direct, { id: 'burnt', model: 'm', alias: 'a' })]);
  const routes = twoRoutePlan({ warpOrigin: viaWarp.baseUrl });

  try {
    await ask(config, routes.plan);
    assert.equal(rotationPending(), true, 'the exit address is what needs replacing here');
  } finally {
    clearTunnelRateLimited();
    await cleanup();
    await direct.close();
    await viaWarp.close();
  }
});

test('a 429 on the direct route says nothing about the exit address', async () => {
  resetAll();
  clearTunnelRateLimited();
  const direct = await startMock('rate-limit', { name: 'quotaonly' });
  const viaWarp = await startMock('ok', { name: 'quotaonly' });
  const { config, cleanup } = await configFor([backend(direct, { id: 'quotaonly', model: 'm', alias: 'a' })]);
  const routes = twoRoutePlan({ warpOrigin: viaWarp.baseUrl });

  try {
    const result = await ask(config, routes.plan);
    assert.equal(result.via, 'warp', 'it escalated and the tunnel answered');
    // The tunnel did its job. Replacing the address it just succeeded from would
    // be throwing away the thing that worked.
    assert.equal(rotationPending(), false);
  } finally {
    clearTunnelRateLimited();
    await cleanup();
    await direct.close();
    await viaWarp.close();
  }
});

test('the tunnel is held for as long as an attempt is travelling through it', async () => {
  // What the rotation gate reads. The count has to be up while the request is in
  // flight and back down once it is done, or a rotation would either never find a
  // window or find one that is not really there.
  resetAll();
  clearTunnelRateLimited();
  const direct = await startMock('rate-limit', { name: 'held' });
  const viaWarp = await startMock('ok', { name: 'held', delayMs: 250 });
  const { config, cleanup } = await configFor([backend(direct, { id: 'held', model: 'm', alias: 'a' })]);
  const routes = twoRoutePlan({ warpOrigin: viaWarp.baseUrl });

  try {
    const before = tunnelInUse();
    const pending = ask(config, routes.plan);
    // Sampled while the escalated attempt is still waiting on the slow mock.
    let peak = before;
    for (let i = 0; i < 20; i += 1) {
      peak = Math.max(peak, tunnelInUse());
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const result = await pending;

    assert.equal(result.via, 'warp');
    assert.equal(peak, before + 1, 'counted while it was in the tunnel');
    assert.equal(tunnelInUse(), before, 'and let go once the answer was complete');
  } finally {
    clearTunnelRateLimited();
    await cleanup();
    await direct.close();
    await viaWarp.close();
  }
});
