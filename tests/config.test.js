import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  activeTarget,
  addTarget,
  copyTarget,
  cycleTarget,
  deleteTarget,
  describeTarget,
  knownModelIds,
  loadConfig,
  MAX_DESCRIPTION,
  maskSecret,
  moveModel,
  renameTarget,
  resolveSecret,
  saveConfig,
  statsPathFor,
  switchTarget,
} from '../src/config.js';
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

test('model lists park a chain and hand another one to the router', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'llm-proxy-targets-'));
  const file = path.join(dir, 'config.json');
  const entry = (model) => ({ id: `mdl_${model}`, providerId: 'prov_1', model, alias: model, kind: 'chat', enabled: true, params: {} });

  // A configuration written before model lists existed: one is made for it, so
  // the chain already on disk is never the one left without a home.
  await fs.writeFile(file, JSON.stringify({ models: [entry('aa'), entry('bb')] }));
  const config = loadConfig(file);
  assert.equal(activeTarget(config).total, 1, 'migrated into a single list');
  assert.equal(activeTarget(config).target.name, 'default');
  assert.deepEqual(activeTarget(config).target.models.map((m) => m.model), ['aa', 'bb'], 'which mirrors the live chain');

  // A second list starts empty, and takes over as the chain being served.
  const second = addTarget(config, 'fast');
  assert.deepEqual(config.models, [], 'a new list is empty');
  assert.equal(activeTarget(config).target.name, 'fast');
  config.models.push(entry('cc'));
  saveConfig(config, file);

  // Both lists survive the round trip, and only the active one is live.
  const reloaded = loadConfig(file);
  assert.deepEqual(reloaded.models.map((m) => m.model), ['cc'], 'the router still reads config.models');
  assert.deepEqual(reloaded.modelLists.map((t) => t.name), ['default', 'fast']);
  assert.deepEqual(reloaded.modelLists[0].models.map((m) => m.model), ['aa', 'bb'], 'the parked chain is untouched');

  // Switching puts the live chain back in its own list and loads the other.
  assert.equal(switchTarget(reloaded, reloaded.modelLists[0].id), true);
  assert.deepEqual(reloaded.models.map((m) => m.model), ['aa', 'bb']);
  assert.deepEqual(reloaded.modelLists[1].models.map((m) => m.model), ['cc'], 'the chain left behind was kept');
  assert.equal(switchTarget(reloaded, reloaded.activeListId), false, 'switching to the current list is a no-op');
  assert.equal(switchTarget(reloaded, 'lst_nope'), false);

  // Reordering the live chain reorders the list it belongs to, and nothing else.
  moveModel(reloaded, 1, -1);
  saveConfig(reloaded, file);
  const again = loadConfig(file);
  assert.deepEqual(again.modelLists[0].models.map((m) => m.model), ['bb', 'aa'], 'the mirror followed the chain');
  assert.deepEqual(again.modelLists[1].models.map((m) => m.model), ['cc'], 'the other list did not move');

  // ←→ wraps in both directions, and a rename never leaves a list nameless.
  assert.equal(cycleTarget(again, 1), true);
  assert.equal(activeTarget(again).target.name, 'fast');
  assert.equal(cycleTarget(again, 1), true, 'wraps past the end');
  assert.equal(activeTarget(again).target.name, 'default');
  assert.equal(renameTarget(again, second.id, '  cheap  '), true);
  assert.equal(again.modelLists[1].name, 'cheap', 'trimmed');
  renameTarget(again, second.id, '   ');
  assert.equal(again.modelLists[1].name, 'cheap', 'a blank name is refused, the old one stands');
  assert.equal(renameTarget(again, 'lst_nope', 'x'), false);

  await fs.rm(dir, { recursive: true, force: true });
});

test('a list says what it is for, and a copy is tried for the same job', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'llm-proxy-describe-'));
  const file = path.join(dir, 'config.json');
  const entry = (model) => ({ id: `mdl_${model}`, providerId: 'prov_1', model, alias: model, kind: 'chat', enabled: true, params: {} });
  await fs.writeFile(file, JSON.stringify({ models: [entry('aa')] }));

  const config = loadConfig(file);
  const live = () => activeTarget(config).target;
  assert.equal(live().description, '', 'nothing is invented for a list nobody has explained');

  // Written, then read back off disk: the note is part of the list, not of a screen.
  assert.equal(describeTarget(config, config.activeListId, '  everyday   work\n— free tiers first  '), true);
  assert.equal(live().description, 'everyday work — free tiers first', 'newlines and runs of spaces are flattened to the one line it is shown on');
  saveConfig(config, file);
  assert.equal(activeTarget(loadConfig(file)).target.description, 'everyday work — free tiers first');

  // A variant is tried for the job the original does, so the note comes with it.
  const copy = copyTarget(config, 'variant');
  assert.equal(copy.description, 'everyday work — free tiers first');
  // And each list owns its own: correcting the copy leaves the original alone.
  describeTarget(config, copy.id, 'same chain, hedging turned off');
  assert.equal(config.modelLists[0].description, 'everyday work — free tiers first');

  // Blank clears it: a note that stopped being true is worse than no note.
  assert.equal(describeTarget(config, copy.id, '   '), true);
  assert.equal(copy.description, '');
  // Renaming is not describing, and neither touches the other.
  describeTarget(config, copy.id, 'for the day nothing free answers');
  renameTarget(config, copy.id, 'paid-fallback');
  assert.equal(copy.description, 'for the day nothing free answers');
  assert.equal(copy.name, 'paid-fallback');

  assert.equal(describeTarget(config, 'lst_nope', 'x'), false);
  // One line, so it is stored as one: anything past that would never be shown.
  describeTarget(config, copy.id, 'x'.repeat(MAX_DESCRIPTION + 50));
  assert.equal(copy.description.length, MAX_DESCRIPTION);

  await fs.rm(dir, { recursive: true, force: true });
});

test('lists written under the names of an older version are read, then saved under the current ones', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'llm-proxy-legacy-'));
  const file = path.join(dir, 'config.json');
  const entry = (model) => ({ id: `mdl_${model}`, providerId: 'prov_1', model, alias: model, kind: 'chat', enabled: true, params: {} });

  // Exactly what a 1.6 install has on disk: `targets`, `activeTargetId`, `tgt_` ids.
  await fs.writeFile(
    file,
    JSON.stringify({
      models: [entry('cc')],
      activeTargetId: 'tgt_live',
      targets: [
        { id: 'tgt_parked', name: 'cheap', models: [entry('aa'), entry('bb')] },
        { id: 'tgt_live', name: 'everything', models: [entry('cc')] },
      ],
    }),
  );

  const config = loadConfig(file);
  assert.deepEqual(config.modelLists.map((list) => list.name), ['cheap', 'everything'], 'both lists came across');
  // The list that was being served is still the one being served: the id kept
  // its random half, so the pointer survived the rename.
  assert.equal(activeTarget(config).target.name, 'everything');
  assert.equal(config.activeListId, 'lst_live');
  assert.deepEqual(config.modelLists.map((list) => list.id), ['lst_parked', 'lst_live']);
  assert.deepEqual(config.models.map((m) => m.model), ['cc'], 'and the chain the router reads is untouched');

  // Saving writes the current names, and does not leave the old ones behind.
  saveConfig(config, file);
  const written = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.ok(Array.isArray(written.modelLists), 'saved under modelLists');
  assert.equal(written.activeListId, 'lst_live');
  assert.equal('targets' in written, false, 'the old key is gone, not duplicated');
  assert.equal('activeTargetId' in written, false);
  assert.doesNotMatch(JSON.stringify(written), /tgt_/, 'and no id still carries the old prefix');

  // Reading the file the migration wrote changes nothing further.
  const reloaded = loadConfig(file);
  assert.deepEqual(reloaded.modelLists.map((list) => list.id), ['lst_parked', 'lst_live']);
  assert.equal(activeTarget(reloaded).target.name, 'everything');
  assert.deepEqual(switchTarget(reloaded, 'lst_parked') && reloaded.models.map((m) => m.model), ['aa', 'bb'], 'the parked chain is still reachable');

  await fs.rm(dir, { recursive: true, force: true });
});

test('a model list can be copied and removed, and the last one always stands', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'llm-proxy-copy-'));
  const file = path.join(dir, 'config.json');
  const entry = (model) => ({ id: `mdl_${model}`, providerId: 'prov_1', model, alias: model, kind: 'chat', enabled: true, params: {} });
  await fs.writeFile(file, JSON.stringify({ models: [entry('aa'), entry('bb')] }));

  const config = loadConfig(file);
  const copy = copyTarget(config, 'variant');
  assert.deepEqual(config.models.map((m) => m.model), ['aa', 'bb'], 'same chain, same order');
  assert.equal(activeTarget(config).target.name, 'variant', 'and it is the one in use');
  // Entries of its own: each list keeps its own counters, which are kept by id.
  assert.deepEqual(config.models.map((m) => m.id).filter((id) => ['mdl_aa', 'mdl_bb'].includes(id)), []);
  assert.equal(new Set([...config.modelLists.flatMap((t) => t.models.map((m) => m.id))]).size, 4, 'no id is shared between the two lists');

  // Reordering the copy does not disturb the list it came from.
  moveModel(config, 0, 1);
  saveConfig(config, file);
  const reloaded = loadConfig(file);
  assert.deepEqual(reloaded.models.map((m) => m.model), ['bb', 'aa']);
  assert.deepEqual(reloaded.modelLists[0].models.map((m) => m.model), ['aa', 'bb']);

  // Counters are pruned against every list, not just the live one, so the chain
  // parked in `default` does not lose its history the next time the proxy starts.
  const ids = knownModelIds(reloaded);
  assert.equal(ids.size, 4);
  assert.ok(ids.has('mdl_aa') && ids.has('mdl_bb'), 'the parked list counts as known');

  // Removing the list in use hands the chain to the one that takes its place.
  assert.equal(deleteTarget(reloaded, copy.id), true);
  assert.deepEqual(reloaded.modelLists.map((t) => t.name), ['default']);
  assert.deepEqual(reloaded.models.map((m) => m.model), ['aa', 'bb'], 'and that list is now being served');
  assert.equal(activeTarget(reloaded).target.name, 'default');

  // The last one is never removed: something has to be served.
  assert.equal(deleteTarget(reloaded, reloaded.modelLists[0].id), false);
  assert.equal(reloaded.modelLists.length, 1);

  // Removing a list that is not the live one leaves the live chain alone.
  addTarget(reloaded, 'scratch');
  const parked = reloaded.modelLists[0].id;
  assert.equal(deleteTarget(reloaded, parked), true);
  assert.deepEqual(reloaded.modelLists.map((t) => t.name), ['scratch']);
  assert.deepEqual(reloaded.models, [], 'still on the empty list it was on');
  assert.equal(deleteTarget(reloaded, 'lst_nope'), false);

  await fs.rm(dir, { recursive: true, force: true });
});

test('stats live next to their config file', () => {
  assert.equal(statsPathFor(path.join('/tmp', 'config.json')), path.join('/tmp', 'config.stats.json'));
  assert.equal(
    statsPathFor(path.join('/tmp', 'llm-proxy.config.json')),
    path.join('/tmp', 'llm-proxy.config.stats.json'),
  );
});
