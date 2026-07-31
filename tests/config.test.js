import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, maskSecret, moveModel, resolveSecret, saveConfig, statsPathFor } from '../src/config.js';
import { listModels, resolveChain } from '../src/router.js';
import { ESC, ansi, compact } from '../src/logger.js';
import { stripAnsi } from '../src/cli.js';

test('secrets are never echoed back in clear text', () => {
  assert.equal(maskSecret('sk-abcdefghijklmnop'), 'sk-a***********mnop'); // 4 + 11 masked + 4
  assert.equal(maskSecret('sk-12345'), '********');
  assert.equal(maskSecret(null), '(none)');

  process.env.__TEST_KEY = 'super-secret';
  assert.equal(resolveSecret('env:__TEST_KEY'), 'super-secret');
  assert.match(maskSecret('env:__TEST_KEY'), /set/);
  delete process.env.__TEST_KEY;
  assert.equal(resolveSecret('env:__TEST_KEY'), null);
});

test('colour sequences carry a real 0x1B escape, and are stripped for column widths', () => {
  // Regression guard: a raw ESC byte in the source is invisible, so it can be
  // dropped by an editor or a copy/paste, turning every line into "[1m[32m…".
  assert.equal(ESC.length, 1);
  assert.equal(ESC.charCodeAt(0), 27, 'ESC must be the control character, not a literal "["');

  const coloured = ansi(32, 'hello');
  assert.equal(coloured, `${String.fromCharCode(27)}[32mhello${String.fromCharCode(27)}[0m`);
  assert.equal(coloured.charCodeAt(0), 27, 'output must not start with a literal bracket');

  assert.equal(stripAnsi(coloured), 'hello');
  assert.equal(stripAnsi(`${ansi(1, 'a')}${ansi(90, 'bc')}`), 'abc');
  assert.equal(stripAnsi('plain'), 'plain');
});

test('large counters are shown compactly, and roll over cleanly', () => {
  // Token totals and request counts sit in fixed-width columns.
  assert.equal(compact(0), '0');
  assert.equal(compact(847), '847');
  assert.equal(compact(999), '999');
  assert.equal(compact(1000), '1k');
  assert.equal(compact(1499), '1.5k');
  assert.equal(compact(12345), '12.3k');
  assert.equal(compact(99949), '99.9k');
  assert.equal(compact(123456), '123k');
  // Never "1000k": the unit rolls over first.
  assert.equal(compact(999499), '999k');
  assert.equal(compact(999500), '1M');
  assert.equal(compact(1234567), '1.2M');
  assert.equal(compact(99e6), '99M');
  assert.equal(compact(1.5e9), '1.5B');
  assert.equal(compact(2.7e12), '2.7T');
  assert.equal(compact(-4200), '-4.2k');

  assert.equal(compact(null), '-');
  assert.equal(compact(undefined), '-');
  assert.equal(compact(Number.NaN), '-');

  // Narrow enough for a table column, always.
  for (const value of [0, 999, 1e4, 1e6, 5.5e9, 9.9e12]) assert.ok(compact(value).length <= 6, `${value}`);
});

test('config survives a disk round-trip and keeps its order', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'llm-proxy-cfg-'));
  const file = path.join(dir, 'config.json');

  const config = loadConfig(file);
  config.providers.push({
    id: 'prov_1',
    name: 'p1',
    type: 'openai',
    baseUrl: 'http://a/v1',
    apiKey: 'k',
    enabled: true,
    headers: {},
  });
  config.models.push({ id: 'm1', providerId: 'prov_1', model: 'aa', alias: 'x', kind: 'chat', enabled: true, params: {} });
  config.models.push({
    id: 'm2',
    providerId: 'prov_1',
    model: 'bb',
    alias: 'y',
    kind: 'chat',
    enabled: true,
    params: { max_tokens: 10 },
  });
  saveConfig(config, file);

  const reloaded = loadConfig(file);
  assert.deepEqual(reloaded.models.map((entry) => entry.model), ['aa', 'bb']);
  assert.deepEqual(reloaded.models[1].params, { max_tokens: 10 });
  // Defaults missing from the file are filled back in.
  assert.equal(typeof reloaded.failover.cooldown.baseMs, 'number');
  assert.equal(reloaded.failover.firstTokenTimeoutMs, 15000);

  assert.equal(moveModel(reloaded, 1, -1), true);
  assert.deepEqual(reloaded.models.map((entry) => entry.model), ['bb', 'aa']);
  assert.equal(moveModel(reloaded, 0, -1), false, 'no out-of-bounds move');

  // Exposed catalogue: `auto` then one alias per entry, in priority order.
  assert.deepEqual(listModels(reloaded).map((entry) => entry.id), ['auto', 'y', 'x']);

  // Two entries sharing an alias = one failover group, exposed once.
  reloaded.models.forEach((entry) => {
    entry.alias = 'group';
  });
  assert.deepEqual(resolveChain(reloaded, 'group', 'chat').entries.map((entry) => entry.model), ['bb', 'aa']);
  assert.deepEqual(listModels(reloaded).map((entry) => entry.id), ['auto', 'group']);

  await fs.rm(dir, { recursive: true, force: true });
});

test('stats live next to their config file', () => {
  assert.equal(statsPathFor(path.join('/tmp', 'config.json')), path.join('/tmp', 'config.stats.json'));
  assert.equal(
    statsPathFor(path.join('/tmp', 'llm-proxy.config.json')),
    path.join('/tmp', 'llm-proxy.config.stats.json'),
  );
});
