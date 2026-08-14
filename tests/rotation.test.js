import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { loadConfig } from '../src/config.js';
import { holdTunnel, tunnelInUse, withTunnel } from '../src/warp/egress.js';
import { resetWarpIdentity, rotate } from '../src/warp/index.js';
import {
  clearTunnelRateLimited,
  describeSession,
  newSession,
  noteTunnelRateLimited,
  rotationPending,
  rotationVerdict,
  startRotationSchedule,
} from '../src/warp/rotate.js';

/**
 * Getting a new exit address without cutting what is using the old one.
 *
 * Cloudflare fixes the egress address when a WARP session is established, so a
 * restart is what draws again and the identity is irrelevant — measured on one
 * machine at one colo: ten requests through one session all left from the same
 * address, ten restarts on the same identity moved it seven times, and two full
 * re-registrations moved it not once.
 *
 * The consequence tested here is that a restart is a coin toss, so the code has
 * to look at whether the address actually moved rather than assume it did.
 */

async function configWith(rotate = {}, warp = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'llm-proxy-rot-'));
  const file = path.join(dir, 'config.json');
  await fs.writeFile(file, JSON.stringify({ providers: [], models: [], warp: { enabled: true, mode: 'on-rate-limit', rotate, ...warp } }));
  return { config: loadConfig(file), cleanup: () => fs.rm(dir, { recursive: true, force: true }) };
}

/** A tunnel that comes back on whichever address the script says, in order. */
function fakeTunnel(addresses, { failOn = 0 } = {}) {
  const seen = [];
  let restarts = 0;
  return {
    get restarts() {
      return restarts;
    },
    seen,
    restart: async () => {
      restarts += 1;
      return restarts === failOn ? { status: 'failed', detail: 'wireproxy exited' } : { status: 'started' };
    },
    // The address before the first restart, then one per restart.
    probe: async () => {
      const address = addresses[Math.min(restarts, addresses.length - 1)];
      seen.push(address);
      return address;
    },
  };
}

/* ------------------------------------------------------------------ *
 * Restarting until the address actually moves                         *
 * ------------------------------------------------------------------ */

test('a session is replaced until the exit address really changes', async () => {
  const { config, cleanup } = await configWith();
  // Before .1, then back on .1 twice, then .2 on the third restart.
  const tunnel = fakeTunnel(['1.1.1.1', '1.1.1.1', '1.1.1.1', '2.2.2.2']);
  try {
    const result = await newSession(config, { attempts: 5, restart: tunnel.restart, probe: tunnel.probe });

    assert.equal(result.ok, true);
    assert.equal(result.changed, true);
    assert.equal(result.before, '1.1.1.1');
    assert.equal(result.after, '2.2.2.2');
    assert.equal(result.tries, 3, 'it stopped as soon as the address moved, and not before');
    assert.equal(tunnel.restarts, 3, 'no restart was spent after the one that worked');
    assert.match(describeSession(result), /now leaving from 2\.2\.2\.2 \(was 1\.1\.1\.1\)/);
  } finally {
    await cleanup();
  }
});

test('an address that will not move is reported as unchanged, not as success', async () => {
  const { config, cleanup } = await configWith();
  const tunnel = fakeTunnel(['1.1.1.1']); // always the same
  try {
    const result = await newSession(config, { attempts: 3, restart: tunnel.restart, probe: tunnel.probe });

    // The tunnel did come back up, so `ok`. But nothing moved, and saying
    // otherwise would send somebody looking for a rate limit that is not there.
    assert.equal(result.ok, true);
    assert.equal(result.changed, false);
    assert.equal(result.tries, 3);
    assert.equal(tunnel.restarts, 3, 'the attempt budget is a budget, not a suggestion');
    assert.match(describeSession(result), /still leaving from 1\.1\.1\.1 after 3 restart\(s\)/);
  } finally {
    await cleanup();
  }
});

test('an unconfirmable change says so rather than claiming one', async () => {
  const { config, cleanup } = await configWith();
  try {
    // The tunnel was down beforehand, so there is no address to compare against.
    const noBefore = await newSession(config, {
      attempts: 3,
      restart: async () => ({ status: 'started' }),
      probe: async () => null,
    });
    assert.equal(noBefore.ok, true);
    assert.equal(noBefore.changed, null, 'three-valued on purpose: this is "cannot tell"');
    assert.equal(noBefore.tries, 1, 'and there is nothing to retry towards');
    assert.match(describeSession(noBefore), /could not be confirmed/);

    // And the trace failing after the restart is the same kind of ignorance.
    let calls = 0;
    const fading = await newSession(config, {
      attempts: 3,
      restart: async () => ({ status: 'started' }),
      probe: async () => (++calls === 1 ? '1.1.1.1' : null),
    });
    assert.equal(fading.changed, null);
  } finally {
    await cleanup();
  }
});

test('a tunnel that does not come back up is a failure, and stops trying', async () => {
  const { config, cleanup } = await configWith();
  const tunnel = fakeTunnel(['1.1.1.1'], { failOn: 1 });
  try {
    const result = await newSession(config, { attempts: 3, restart: tunnel.restart, probe: tunnel.probe });

    assert.equal(result.ok, false);
    assert.equal(result.tries, 1, 'restarting again would not fix whatever stopped it');
    assert.equal(result.detail, 'wireproxy exited');
    assert.match(describeSession(result), /did not come back up: wireproxy exited/);
  } finally {
    await cleanup();
  }
});

/* ------------------------------------------------------------------ *
 * When it is allowed to happen at all                                 *
 * ------------------------------------------------------------------ */

test('nothing is rotated while anything is still going through the tunnel', async () => {
  // The whole reason this is gated rather than scheduled: a restart closes the
  // tunnel's sockets, and no exit address is worth a cut answer.
  const { config, cleanup } = await configWith({ everyMs: 60000, minIntervalMs: 60000 });
  try {
    const ripe = { config, age: 120000, burned: false };

    assert.equal(rotationVerdict({ ...ripe, inUse: 0 }).go, true, 'due, and nothing in the way');
    const busy = rotationVerdict({ ...ripe, inUse: 1 });
    assert.equal(busy.go, false);
    assert.match(busy.holdOff, /1 request\(s\) still going through the tunnel/);
    // Not deferred-then-forced: a tunnel that stays busy simply is not rotated.
    assert.equal(rotationVerdict({ config, age: 86400000, burned: true, inUse: 1 }).go, false, 'even long overdue, and even when throttled');
  } finally {
    await cleanup();
  }
});

test('a 429 through the tunnel is what asks for a new address, not the clock', async () => {
  // `everyMs: 0` is the default and does not mean never — it means "when the
  // address is actually being throttled", which a clock cannot know.
  const { config, cleanup } = await configWith({ everyMs: 0, minIntervalMs: 60000 });
  try {
    const quiet = rotationVerdict({ config, age: 86400000, burned: false, inUse: 0 });
    assert.equal(quiet.go, false, 'an old session nobody is complaining about is left alone');
    assert.match(quiet.holdOff, /nothing is asking/);

    const throttled = rotationVerdict({ config, age: 120000, burned: true, inUse: 0 });
    assert.equal(throttled.go, true);
    assert.match(throttled.why, /rate-limited this address/);
  } finally {
    await cleanup();
  }
});

test('the minimum interval outranks every reason to rotate', async () => {
  // Each rotation re-establishes a session with Cloudflare. A burst of 429s must
  // not turn into a burst of restarts, which would be both rude and no more
  // effective — the pool it draws from does not refill any faster.
  const { config, cleanup } = await configWith({ everyMs: 60000, minIntervalMs: 600000 });
  try {
    const tooSoon = rotationVerdict({ config, age: 90000, burned: true, inUse: 0 });
    assert.equal(tooSoon.go, false, 'past `everyMs` and throttled, but inside the floor');
    assert.match(tooSoon.holdOff, /since the last one/);
    assert.equal(rotationVerdict({ config, age: 700000, burned: true, inUse: 0 }).go, true);
  } finally {
    await cleanup();
  }
});

test('WARP being off is the end of it', async () => {
  const { config, cleanup } = await configWith({ everyMs: 60000, minIntervalMs: 60000 }, { enabled: false });
  try {
    assert.equal(rotationVerdict({ config, age: 86400000, burned: true, inUse: 0 }).go, false);
  } finally {
    await cleanup();
  }
});

/* ------------------------------------------------------------------ *
 * The counter the gate reads, and the lock around the process         *
 * ------------------------------------------------------------------ */

test('the in-use count follows the attempts, and a double release cannot corrupt it', () => {
  const start = tunnelInUse();
  const first = holdTunnel();
  const second = holdTunnel();
  assert.equal(tunnelInUse(), start + 2);

  first();
  assert.equal(tunnelInUse(), start + 1);
  // Attempts unwind through more than one path — a race lost, a client gone, a
  // deadline — and a release that ran twice would leave the gate permanently open.
  first();
  first();
  assert.equal(tunnelInUse(), start + 1, 'releasing twice is not releasing somebody else');

  second();
  assert.equal(tunnelInUse(), start);
});

test('only one thing at a time may replace the tunnel', async () => {
  let running = 0;
  let overlapped = false;
  const work = async () => {
    running += 1;
    if (running > 1) overlapped = true;
    await new Promise((resolve) => setTimeout(resolve, 30));
    running -= 1;
    return 'done';
  };

  const [mine, theirs] = await Promise.all([withTunnel(work), withTunnel(work)]);
  assert.equal(mine, 'done');
  // Not queued behind it, and not run alongside it: told plainly that somebody
  // else has the tunnel, so the caller can come back on the next tick.
  assert.equal(theirs, null, 'the second caller is refused, not silently overlapped');
  assert.equal(overlapped, false);

  // And the lock is released afterwards, or nothing would ever rotate again.
  assert.equal(await withTunnel(async () => 'after'), 'after');
});

/* ------------------------------------------------------------------ *
 * The gap between deciding and doing                                  *
 * ------------------------------------------------------------------ */

test('a request that starts using the tunnel after the decision still stops the restart', async () => {
  // The gate is not a single reading. Between "nothing is using it" and the kill
  // there is a trace request, which really does take about a tenth of a second —
  // and an attempt that got its route just before the lock was taken starts
  // travelling inside that window. Killing the process then would cut it.
  const { config, cleanup } = await configWith();
  let inFlightWhenKilled = null;
  try {
    const hold = { taken: false };
    const rotation = newSession(config, {
      attempts: 3,
      probe: async () => {
        // Stands for the trace, and for the window it opens.
        await new Promise((resolve) => setTimeout(resolve, 40));
        return '1.1.1.1';
      },
      restart: async () => {
        inFlightWhenKilled = hold.taken ? 1 : 0;
        return { status: 'started' };
      },
      canRestart: () => !hold.taken,
    });

    await new Promise((resolve) => setTimeout(resolve, 10));
    hold.taken = true; // an attempt is now in the tunnel
    const result = await rotation;

    assert.equal(inFlightWhenKilled, null, 'the tunnel was never killed');
    assert.equal(result.deferred, true);
    assert.equal(result.ok, true, 'putting it off is not a failure — there is another tick coming');
    assert.match(describeSession(result), /put off/);
  } finally {
    await cleanup();
  }
});

test('the guard is asked before every restart, not only the first', async () => {
  // The retry loop is where a restart is most likely to land on a live request:
  // the tunnel has already been down and up once, and an escalation waiting on the
  // lock may have taken it in the meantime.
  const { config, cleanup } = await configWith();
  let restarts = 0;
  try {
    const result = await newSession(config, {
      attempts: 5,
      probe: async () => '1.1.1.1', // never moves, so the loop wants to retry
      restart: async () => {
        restarts += 1;
        return { status: 'started' };
      },
      // Free for the first restart, in use from then on.
      canRestart: () => restarts < 1,
    });

    assert.equal(restarts, 1, 'it stopped as soon as something was using the tunnel again');
    assert.equal(result.deferred, true);
    assert.equal(result.tries, 1);
  } finally {
    await cleanup();
  }
});

/* ------------------------------------------------------------------ *
 * The loop that actually runs in production                           *
 * ------------------------------------------------------------------ */

const AN_HOUR_AGO = () => Date.now() - 3600000;

test('one 429 buys one rotation, not one per tick', async () => {
  // `minIntervalMs` has a 60s floor in the configuration, and rightly so — which
  // means the age has to come from `since` rather than from a config a test bent
  // out of shape. This runs against the real defaults.
  const { config, cleanup } = await configWith();
  const calls = [];
  const schedule = startRotationSchedule(() => config, {
    intervalMs: 15,
    since: AN_HOUR_AGO(),
    session: async (_config, options) => {
      calls.push(options.attempts);
      return { ok: true, changed: true, tries: 1, before: '1.1.1.1', after: '2.2.2.2' };
    },
  });

  try {
    // `everyMs: 0` by default: an old session nobody complains about is left alone.
    await new Promise((resolve) => setTimeout(resolve, 90));
    assert.equal(calls.length, 0, 'age alone asks for nothing');

    noteTunnelRateLimited();
    await new Promise((resolve) => setTimeout(resolve, 120));
    assert.equal(calls.length, 1, 'one rotation for the 429, and the ticks after it stay quiet');
    assert.equal(calls[0], config.warp.rotate.attempts, 'given the configured budget');
    assert.equal(rotationPending(), false, 'the signal was consumed');
  } finally {
    schedule.stop();
    clearTunnelRateLimited();
    await cleanup();
  }
});

test('a deferred rotation keeps its reason and comes back for it', async () => {
  // A tunnel that was busy at the wrong moment must not silently lose its
  // rotation: nothing was spent, so the clock and the signal both stand.
  const { config, cleanup } = await configWith();
  let calls = 0;
  const schedule = startRotationSchedule(() => config, {
    intervalMs: 15,
    since: AN_HOUR_AGO(),
    session: async () => {
      calls += 1;
      return { ok: true, changed: null, deferred: true, tries: 0, before: '1.1.1.1', after: null };
    },
  });

  try {
    noteTunnelRateLimited();
    await new Promise((resolve) => setTimeout(resolve, 120));
    assert.ok(calls >= 2, `a deferral is retried on the next tick, saw ${calls}`);
    assert.equal(rotationPending(), true, 'and the reason to rotate is still standing');
  } finally {
    schedule.stop();
    clearTunnelRateLimited();
    await cleanup();
  }
});

test('the schedule stops when it is stopped', async () => {
  const { config, cleanup } = await configWith();
  let calls = 0;
  const schedule = startRotationSchedule(() => config, {
    intervalMs: 15,
    since: AN_HOUR_AGO(),
    // Deferring keeps it eligible every tick, which is what makes "it stopped"
    // mean something rather than passing because nothing was due anyway.
    session: async () => {
      calls += 1;
      return { ok: true, changed: null, deferred: true, tries: 0, before: '1.1.1.1', after: null };
    },
  });

  try {
    noteTunnelRateLimited();
    await new Promise((resolve) => setTimeout(resolve, 90));
    assert.ok(calls >= 1, 'it was firing');
    schedule.stop();
    const after = calls;
    await new Promise((resolve) => setTimeout(resolve, 90));
    // A timer outliving its server would keep restarting a tunnel nobody serves.
    assert.equal(calls, after, 'and nothing after stop');
  } finally {
    schedule.stop();
    clearTunnelRateLimited();
    await cleanup();
  }
});

/* ------------------------------------------------------------------ *
 * The two commands, and what they refuse to do                        *
 * ------------------------------------------------------------------ */

test('neither command touches the tunnel while something else is replacing it', async () => {
  // Both go through the same lock as the on-demand start, so a rotation typed at
  // the same moment as an escalation bringing the tunnel up cannot interleave with
  // it. Refused with a reason, rather than queued behind it or run alongside.
  const { config, cleanup } = await configWith();
  let release;
  const held = withTunnel(() => new Promise((resolve) => (release = resolve)));
  try {
    const spun = await rotate(config);
    assert.equal(spun.ok, false);
    assert.equal(spun.changed, null, 'nothing was measured, so nothing is claimed');
    assert.match(spun.detail, /busy being started or replaced/);

    const identity = await resetWarpIdentity(config);
    assert.equal(identity.ok, false);
    assert.match(identity.detail, /busy being started or replaced/);
  } finally {
    release();
    await held;
    await cleanup();
  }
});

test('a rotation reports the shape a script reads, whatever happened', async () => {
  // `warp rotate --json` is what a cron job tests, so every outcome carries the
  // same keys — a script must not have to tell "missing" from "false".
  const { config, cleanup } = await configWith();
  try {
    const outcomes = await Promise.all([
      newSession(config, { attempts: 1, probe: async () => '1.1.1.1', restart: async () => ({ status: 'started' }) }),
      newSession(config, { attempts: 1, probe: async () => null, restart: async () => ({ status: 'started' }) }),
      newSession(config, { attempts: 1, probe: async () => '1.1.1.1', restart: async () => ({ status: 'failed', detail: 'nope' }) }),
    ]);
    for (const result of outcomes) {
      for (const key of ['ok', 'changed', 'tries', 'before', 'after']) {
        assert.ok(key in result, `every outcome carries \`${key}\``);
      }
      assert.equal(typeof describeSession(result), 'string');
    }
  } finally {
    await cleanup();
  }
});
