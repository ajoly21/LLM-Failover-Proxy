import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { loadConfig, saveConfig } from '../src/config.js';
import { assemble, backend, postJson, startProxy } from './helpers.js';
import { startMock } from './mock-provider.js';

const run = promisify(execFile);
const CLI = path.resolve(import.meta.dirname, '..', 'src', 'index.js');
const CHAT = { messages: [{ role: 'user', content: 'hi' }] };

/**
 * Runs a console command to completion. `execFile` only resolves when the
 * process exits, so every assertion below also proves the command hands the
 * shell back instead of watching for updates like the UI does.
 */
function cli(args, { configFile, cwd }) {
  const env = { ...process.env, NO_COLOR: '1' };
  for (const name of Object.keys(env)) if (name.endsWith('_API_KEY')) delete env[name];
  return run(process.execPath, [CLI, ...args, '--config', configFile], { env, cwd, timeout: 30000 });
}

test('`stats` reports the counters of a running proxy, then exits', async () => {
  const mock = await startMock('ok', { name: 'p' });
  const proxy = await startProxy(assemble([backend(mock, { model: 'm-1', alias: 'a' })]));
  const where = { configFile: proxy.file, cwd: proxy.dir };
  try {
    // Nothing served yet: no file, no server answer, and it still returns.
    const empty = await cli(['stats'], where);
    assert.match(empty.stdout, /no counters yet/);

    await postJson(`${proxy.url}/v1/chat/completions`, CHAT);
    // The test harness listens on an ephemeral port; write it down so the
    // command can find the running proxy the way it would in real use.
    const config = loadConfig(proxy.file);
    config.server.port = Number(new URL(proxy.url).port);
    saveConfig(config, proxy.file);

    const live = await cli(['stats'], where);
    assert.match(live.stdout, /Running server/);
    assert.match(live.stdout, /PRIO\s+TARGET\s+REQ\s+OK\s+KO\s+CX\s+TOKENS/, 'the counters table is printed');
    assert.match(live.stdout, /p\/m-1/);
    assert.match(live.stdout, /1 request\(s\), 1 ok/);
    assert.doesNotMatch(live.stdout, /Providers|Model chain/, 'just the counters — `status` is the full report');

    const asJson = JSON.parse((await cli(['stats', '--json'], where)).stdout);
    assert.equal(asJson.source, 'server');
    assert.equal(asJson.totals.successes, 1);
    assert.equal(asJson.chain[0].model, 'm-1');
  } finally {
    await proxy.close();
    await mock.close();
  }
});

test('`stats` falls back to the persisted file when nothing is running', async () => {
  const mock = await startMock('ok', { name: 'p' });
  const proxy = await startProxy(assemble([backend(mock, { model: 'm-1', alias: 'a' })]));
  const where = { configFile: proxy.file, cwd: proxy.dir };
  try {
    await postJson(`${proxy.url}/v1/chat/completions`, CHAT);
    await proxy.stop();

    const offline = await cli(['stats'], where);
    assert.match(offline.stdout, /Persisted counters/);
    assert.match(offline.stdout, /read from disk/);
    assert.match(offline.stdout, /p\/m-1/);
    assert.match(offline.stdout, /1 request\(s\), 1 ok/, 'the counters outlive the process');

    const asJson = JSON.parse((await cli(['stats', '--json'], where)).stdout);
    assert.equal(asJson.source, 'file');
    assert.equal(asJson.totals.successes, 1, 'same numbers as the live report');
    assert.equal(asJson.chain[0].priority, 1);
    assert.ok(Number.isFinite(asJson.statsSince));
  } finally {
    await fs.rm(proxy.dir, { recursive: true, force: true });
    await mock.close();
  }
});
