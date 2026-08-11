import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  envPathFor,
  formatEnvValue,
  loadEnvFiles,
  parseEnv,
  readEnvFile,
  resetEnvCache,
  upsertEnv,
} from '../src/env.js';
import { CATALOG_FILE, applyCatalog, catalogKeys, loadCatalog, renderEnvExample } from '../src/catalog.js';
import { describeKey, envVarName, inlineKeys, loadConfig, resolveSecret, saveConfig } from '../src/config.js';

const ROOT = path.resolve(import.meta.dirname, '..');

async function tempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'llm-proxy-env-'));
}

test('a .env is parsed the way every other tool parses it', () => {
  const values = parseEnv(
    [
      '# a comment',
      '',
      'PLAIN=abc123',
      '  SPACED = spaced value  ',
      'export EXPORTED=exported',
      'QUOTED="with spaces # and a hash"',
      "SINGLE='raw $NOT_EXPANDED'",
      'ESCAPED="line1\\nline2"',
      'TRAILING=value # a trailing comment',
      'HASHED=sk-a#b',
      'EMPTY=',
      'not a variable',
    ].join('\r\n'),
  );

  assert.equal(values.PLAIN, 'abc123');
  assert.equal(values.SPACED, 'spaced value');
  assert.equal(values.EXPORTED, 'exported');
  assert.equal(values.QUOTED, 'with spaces # and a hash');
  assert.equal(values.SINGLE, 'raw $NOT_EXPANDED');
  assert.equal(values.ESCAPED, 'line1\nline2');
  assert.equal(values.TRAILING, 'value', 'an unquoted value stops at " #"');
  assert.equal(values.HASHED, 'sk-a#b', 'a hash inside a token is part of the key');
  assert.equal(values.EMPTY, '');
  assert.equal('not a variable' in values, false);
});

test('values are written back exactly as they will be read', () => {
  assert.equal(formatEnvValue('sk-plain_123'), 'sk-plain_123', 'no needless quoting');
  assert.equal(formatEnvValue('with space'), '"with space"');
  assert.equal(formatEnvValue('two#parts'), '"two#parts"');
  assert.equal(formatEnvValue(''), '');

  for (const value of ['sk-plain_123', 'with space', 'two#parts', 'a"b', 'multi\nline']) {
    assert.equal(parseEnv(`K=${formatEnvValue(value)}`).K, value, `round trip: ${JSON.stringify(value)}`);
  }
});

test('writing a key keeps the rest of the .env intact', async () => {
  const dir = await tempDir();
  const file = path.join(dir, '.env');
  await fs.writeFile(file, ['# my keys', 'ALPHA_API_KEY=old-value', '', '# keep me', 'OTHER=untouched', ''].join('\n'));

  upsertEnv(file, { ALPHA_API_KEY: 'new-value', BETA_API_KEY: 'beta-key' }, { apply: false });

  const text = await fs.readFile(file, 'utf8');
  assert.match(text, /^# my keys$/m, 'comments survive');
  assert.match(text, /^ALPHA_API_KEY=new-value$/m, 'an existing key is updated in place');
  assert.match(text, /^OTHER=untouched$/m);
  assert.match(text, /^BETA_API_KEY=beta-key$/m, 'a new key is appended');
  assert.equal(text.match(/ALPHA_API_KEY/g).length, 1, 'no duplicate line');

  // An empty value means "skipped", not "stored empty".
  upsertEnv(file, { GAMMA_API_KEY: '' }, { apply: false });
  assert.doesNotMatch(await fs.readFile(file, 'utf8'), /GAMMA_API_KEY/);

  if (process.platform !== 'win32') {
    assert.equal((await fs.stat(file)).mode & 0o777, 0o600, 'secrets are not world-readable');
  }
  await fs.rm(dir, { recursive: true, force: true });
});

test('the real environment wins over a .env, and reloads pick up an edit', async () => {
  const dir = await tempDir();
  const file = path.join(dir, '.env');
  const configFile = path.join(dir, 'config.json');
  await fs.writeFile(file, 'FROM_FILE=file-value\nOVERRIDDEN=file-value\n');

  process.env.OVERRIDDEN = 'real-value';
  try {
    const loaded = loadEnvFiles({ configFile, cwd: dir });
    assert.ok(loaded.files.includes(file));
    assert.equal(process.env.FROM_FILE, 'file-value');
    assert.equal(process.env.OVERRIDDEN, 'real-value', 'a real variable is never clobbered');

    // The background service is started long before a key is pasted.
    await fs.writeFile(file, 'FROM_FILE=edited\n');
    loadEnvFiles({ configFile, cwd: dir });
    assert.equal(process.env.FROM_FILE, 'edited', 'values this module owns are refreshed');
  } finally {
    resetEnvCache();
    delete process.env.OVERRIDDEN;
    await fs.rm(dir, { recursive: true, force: true });
  }
  assert.equal(process.env.FROM_FILE, undefined, 'the cache reset cleans up after itself');
});

test('a provider key is described by where it comes from', () => {
  assert.equal(envVarName('nvidia'), 'NVIDIA_API_KEY');
  assert.equal(envVarName('azure-openai'), 'AZURE_OPENAI_API_KEY');
  assert.equal(envVarName('  my proxy!  '), 'MY_PROXY_API_KEY');
  assert.equal(envVarName(''), 'PROVIDER_API_KEY');

  assert.equal(describeKey(null).state, 'none');
  assert.equal(describeKey('env:__MISSING_KEY').state, 'missing');
  assert.equal(describeKey('sk-abcdefghijklmnop').state, 'inline');
  assert.doesNotMatch(describeKey('sk-abcdefghijklmnop').text, /efghijkl/, 'an inline key stays masked');

  process.env.__PRESENT_KEY = 'value';
  const present = describeKey('env:__PRESENT_KEY');
  assert.equal(present.state, 'env');
  assert.equal(present.text, 'env:__PRESENT_KEY', 'the variable name is shown, never the value');
  assert.equal(resolveSecret('env:__PRESENT_KEY'), 'value');
  delete process.env.__PRESENT_KEY;
});

test('the shipped catalogue is valid, ordered, and secret-free', async () => {
  const catalog = loadCatalog();
  assert.equal(catalog.file, CATALOG_FILE);
  assert.ok(catalog.providers.length >= 1);
  assert.ok(catalog.models.length >= catalog.providers.length);

  const raw = await fs.readFile(CATALOG_FILE, 'utf8');
  assert.doesNotMatch(raw, /"apiKey"/, 'a catalogue never carries a key');
  assert.doesNotMatch(raw, /sk-[A-Za-z0-9]{16}/);

  for (const provider of catalog.providers) {
    assert.match(provider.baseUrl, /^https?:\/\//, `${provider.name} has a usable base URL`);
    assert.ok(provider.envVar === null || /^[A-Z][A-Z0-9_]*$/.test(provider.envVar), `${provider.name} names a variable`);
  }

  // A model pointing at a provider that does not exist is a hard error, not a
  // silent drop: the catalogue is what a first run depends on.
  const broken = path.join(await tempDir(), 'catalog.json');
  await fs.writeFile(
    broken,
    JSON.stringify({ providers: [{ name: 'a', baseUrl: 'http://a/v1' }], models: [{ provider: 'ghost', model: 'x' }] }),
  );
  assert.throws(() => loadCatalog(broken), /unknown provider/);
  assert.throws(() => loadCatalog(path.join(ROOT, 'does-not-exist.json')), /Cannot read the default catalogue/);
  await fs.rm(path.dirname(broken), { recursive: true, force: true });
});

test('applying the catalogue is additive and never overwrites a key', async () => {
  const dir = await tempDir();
  const file = path.join(dir, 'config.json');
  const config = loadConfig(file);
  const catalog = loadCatalog();

  const first = applyCatalog(config, catalog);
  assert.equal(first.providers.length, catalog.providers.length);
  assert.equal(first.models.length, catalog.models.length);
  assert.deepEqual(config.models.map((entry) => entry.model), catalog.models.map((entry) => entry.model), 'order is the priority');
  for (const provider of config.providers) {
    const source = catalog.providers.find((entry) => entry.name === provider.name);
    assert.equal(provider.apiKey, source.envVar ? `env:${source.envVar}` : null);
  }

  // Re-running the wizard must not duplicate anything.
  config.providers[0].apiKey = 'sk-typed-by-hand';
  const second = applyCatalog(config, catalog);
  assert.deepEqual(second, { providers: [], models: [] });
  assert.equal(config.providers.length, catalog.providers.length);
  assert.equal(config.models.length, catalog.models.length);
  assert.equal(config.providers[0].apiKey, 'sk-typed-by-hand', 'a hand-written key is left alone');

  await fs.rm(dir, { recursive: true, force: true });
});

test('.env.example lists every variable the catalogue needs', async () => {
  const catalog = loadCatalog();
  const expected = renderEnvExample(catalog);
  const onDisk = await fs.readFile(path.join(ROOT, '.env.example'), 'utf8');
  assert.equal(onDisk, expected, '`pnpm run env:example` regenerates this file');

  for (const entry of catalogKeys(catalog)) {
    assert.match(onDisk, new RegExp(`^${entry.envVar}=$`, 'm'), `${entry.envVar} is listed, with no value`);
    if (entry.keyUrl) assert.ok(onDisk.includes(entry.keyUrl), 'and says where to get a key');
  }
  const filled = onDisk.split('\n').filter((line) => !line.trimStart().startsWith('#') && /=\s*\S/.test(line));
  assert.deepEqual(filled, [], 'the example never ships a value');
});

test('a key left in an old config file still works, and is still pointed out', async () => {
  // There is no command to move keys any more: every screen that takes one
  // writes it to the .env. A config written by an older version can still hold
  // one, so it has to keep working — and keep being flagged, since a config
  // file is the thing people share.
  const dir = await tempDir();
  const file = path.join(dir, 'config.json');
  const config = loadConfig(file);
  config.server.apiKey = 'sk-proxy-secret';
  config.providers.push(
    { id: 'prov_1', name: 'nvidia', type: 'openai', baseUrl: 'http://a/v1', apiKey: 'nvapi-secret', headers: {}, enabled: true },
    { id: 'prov_2', name: 'ollama', type: 'openai', baseUrl: 'http://b/v1', apiKey: null, headers: {}, enabled: true },
    { id: 'prov_3', name: 'groq', type: 'openai', baseUrl: 'http://c/v1', apiKey: 'env:GROQ_API_KEY', headers: {}, enabled: true },
  );
  saveConfig(config, file);
  try {
    assert.deepEqual(inlineKeys(config), ['nvidia', 'the proxy itself'], 'a keyless provider and an env: reference are not flagged');

    const stored = loadConfig(file);
    assert.equal(resolveSecret(stored.providers[0].apiKey), 'nvapi-secret', 'the request can still be signed');
    assert.equal(describeKey(stored.providers[0].apiKey).state, 'inline', 'and the UI colours it as such');
    assert.doesNotMatch(describeKey(stored.providers[0].apiKey).text, /nvapi-secret/, 'without printing it');
  } finally {
    resetEnvCache();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
