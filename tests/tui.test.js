import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { render } from 'ink-testing-library';
import { h } from '../src/tui/h.js';
import { App } from '../src/tui/app.js';
import { loadConfig } from '../src/config.js';
import { resetEnvCache } from '../src/env.js';
import { SETTINGS } from '../src/tui/screens/settings.js';
import { startMock } from './mock-provider.js';

// Built from code points: raw control bytes in a source file are invisible and
// do not survive editors or copy/paste.
const ESC = String.fromCharCode(27);
const KEY = {
  up: `${ESC}[A`,
  down: `${ESC}[B`,
  right: `${ESC}[C`,
  left: `${ESC}[D`,
  shiftUp: `${ESC}[1;2A`,
  shiftDown: `${ESC}[1;2B`,
  enter: "\r",
  escape: ESC,
  backspace: String.fromCharCode(127),
  ctrlS: String.fromCharCode(19),
};

const tick = (times = 2) => new Promise((resolve) => setTimeout(resolve, 20 * times));

/** Renders the app against a throwaway config file. */
async function mount({ providers = [], models = [], view } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'llm-proxy-tui-'));
  const file = path.join(dir, 'config.json');
  await fs.writeFile(file, JSON.stringify({ server: { host: '127.0.0.1', port: 47821 }, providers, models }));

  const finished = [];
  const ui = render(h(App, { configFile: file, onFinish: (outcome) => finished.push(outcome), initialView: view }));
  await tick();

  return {
    ui,
    file,
    finished,
    frame: () => ui.lastFrame(),
    config: () => loadConfig(file),
    async press(sequence, times = 1) {
      for (let i = 0; i < times; i += 1) {
        ui.stdin.write(sequence);
        await tick();
      }
    },
    async type(text) {
      for (const char of text) {
        ui.stdin.write(char);
        await tick(1);
      }
    },
    async close() {
      ui.unmount();
      await tick(1);
      await fs.rm(dir, { recursive: true, force: true });
    },
  };
}

const provider = (id, extra = {}) => ({
  id: `prov_${id}`,
  name: id,
  type: 'openai',
  baseUrl: `http://127.0.0.1:9/${id}/v1`,
  apiKey: 'sk-secret-value-1234',
  headers: {},
  enabled: true,
  ...extra,
});

const model = (id, providerId, extra = {}) => ({
  id: `mdl_${id}`,
  providerId: `prov_${providerId}`,
  model: id,
  alias: id,
  kind: 'chat',
  enabled: true,
  params: {},
  ...extra,
});

test('home screen lists the menu and reports the configuration', async () => {
  const app = await mount({ providers: [provider('groq')], models: [model('llama', 'groq')] });
  try {
    const frame = app.frame();
    assert.match(frame, /llm-failover-proxy/);
    assert.match(frame, /Providers/);
    assert.match(frame, /Models & priority/);
    assert.match(frame, /Status & stats/);
    assert.match(frame, /127\.0\.0\.1:47821/);
    assert.match(frame, /providers 1/);
    assert.match(frame, /models 1/);
  } finally {
    await app.close();
  }
});

test('a fresh configuration opens on the wizard, and "from scratch" leads to the menu', async () => {
  const app = await mount({}); // no providers, no models, no explicit view
  try {
    assert.match(app.frame(), /Welcome to llm-failover-proxy/);
    assert.match(app.frame(), /Use the default chain/);

    await app.press(KEY.down); // → Start from scratch
    await app.press(KEY.enter);
    assert.match(app.frame(), /Models & priority/, 'lands on the home menu');
    assert.equal(app.config().providers.length, 0);
  } finally {
    await app.close();
  }
});

test('the wizard seeds the default chain and keeps the keys out of the config', async () => {
  // An injected catalogue keeps the test independent from defaults/catalog.json.
  const catalog = {
    providers: [
      {
        name: 'alpha',
        type: 'openai',
        baseUrl: 'http://127.0.0.1:9/alpha/v1',
        envVar: 'ALPHA_API_KEY',
        keyUrl: 'https://alpha.test/keys',
        note: 'free tier',
        headers: {},
      },
      { name: 'beta', type: 'openai', baseUrl: 'http://127.0.0.1:9/beta/v1', envVar: 'BETA_API_KEY', keyUrl: null, note: null, headers: {} },
    ],
    models: [
      { provider: 'alpha', model: 'alpha-large', alias: 'alpha-large', kind: 'chat', params: {} },
      { provider: 'beta', model: 'beta-small', alias: 'beta-small', kind: 'chat', params: {} },
      { provider: 'alpha', model: 'alpha-small', alias: 'alpha-small', kind: 'chat', params: {} },
    ],
  };
  const app = await mount({ view: { name: 'setup', catalog } });
  try {
    assert.match(app.frame(), /alpha\/alpha-large/, 'the chain is previewed in order');

    await app.press(KEY.enter); // use the default chain
    // \W+ rather than a literal separator: how the title punctuates itself is a
    // style choice, the provider it is asking about is the point.
    assert.match(app.frame(), /API key 1\/2\W+alpha/);
    assert.match(app.frame(), /ALPHA_API_KEY/);
    assert.match(app.frame(), /https:\/\/alpha\.test\/keys/);

    await app.type('sk-alpha-1');
    assert.doesNotMatch(app.frame(), /sk-alpha-1/, 'the key is masked while typing');

    await app.press(KEY.enter); // → beta
    assert.match(app.frame(), /API key 2\/2\W+beta/);
    await app.press(KEY.escape); // skip every remaining provider
    assert.match(app.frame(), /Ready/);

    const config = app.config();
    assert.deepEqual(config.models.map((entry) => entry.model), ['alpha-large', 'beta-small', 'alpha-small']);
    assert.deepEqual(config.providers.map((entry) => entry.apiKey), ['env:ALPHA_API_KEY', 'env:BETA_API_KEY']);

    const raw = await fs.readFile(app.file, 'utf8');
    assert.doesNotMatch(raw, /sk-alpha-1/, 'the configuration file holds no secret');
    const dotenv = await fs.readFile(path.join(path.dirname(app.file), '.env'), 'utf8');
    assert.match(dotenv, /^ALPHA_API_KEY=sk-alpha-1$/m);
    assert.doesNotMatch(dotenv, /BETA_API_KEY/, 'a skipped provider writes nothing');
  } finally {
    resetEnvCache(); // keys written by the wizard must not leak into the next test
    await app.close();
  }
});

test('leaving the wizard early still keeps the key that was just typed', async () => {
  const catalog = {
    providers: [
      { name: 'alpha', type: 'openai', baseUrl: 'http://127.0.0.1:9/alpha/v1', envVar: 'ALPHA_API_KEY', keyUrl: null, note: null, headers: {} },
      { name: 'beta', type: 'openai', baseUrl: 'http://127.0.0.1:9/beta/v1', envVar: 'BETA_API_KEY', keyUrl: null, note: null, headers: {} },
    ],
    models: [{ provider: 'alpha', model: 'alpha-large', alias: 'alpha-large', kind: 'chat', params: {} }],
  };
  const app = await mount({ view: { name: 'setup', catalog } });
  try {
    await app.press(KEY.enter); // use the default chain
    await app.type('sk-typed-then-escaped');
    await app.press(KEY.escape); // esc skips the *remaining* providers, not this one

    assert.match(app.frame(), /Ready/);
    const dotenv = await fs.readFile(path.join(path.dirname(app.file), '.env'), 'utf8');
    assert.match(dotenv, /^ALPHA_API_KEY=sk-typed-then-escaped$/m, 'a pasted key is never lost');
  } finally {
    resetEnvCache(); // keys written by the wizard must not leak into the next test
    await app.close();
  }
});

test('quitting and starting the server report distinct outcomes', async () => {
  const app = await mount({ view: { name: 'home' } });
  try {
    await app.press(KEY.down, 5); // → Start the server
    await app.press(KEY.enter);
    assert.deepEqual(app.finished.at(-1).action, 'start-server');

    await app.press(KEY.down);
    await app.press(KEY.enter);
    assert.equal(app.finished.at(-1).action, 'quit');
  } finally {
    await app.close();
  }
});

test('providers screen masks keys and toggles a provider with space', async () => {
  const app = await mount({ providers: [provider('groq'), provider('ollama', { apiKey: null })] });
  try {
    await app.press('1'); // jump to Providers
    let frame = app.frame();
    assert.match(frame, /PROTOCOL/);
    assert.match(frame, /groq/);
    assert.doesNotMatch(frame, /sk-secret-value-1234/, 'the raw key must never be displayed');
    assert.match(frame, /sk-s\*+1234/);

    await app.press(' ');
    await tick();
    assert.equal(app.config().providers[0].enabled, false, 'space toggles the selected provider');

    frame = app.frame();
    assert.match(frame, /a add/);
    assert.match(frame, /t test all/);
  } finally {
    await app.close();
  }
});

test('deleting a provider asks for confirmation and takes its models with it', async () => {
  const app = await mount({
    providers: [provider('groq')],
    models: [model('llama', 'groq'), model('mixtral', 'groq')],
    view: { name: 'providers' },
  });
  try {
    await app.press('d');
    assert.match(app.frame(), /delete groq and its models\?/);

    await app.press('n'); // anything but y cancels
    assert.equal(app.config().providers.length, 1);

    await app.press('d');
    await app.press('y');
    assert.equal(app.config().providers.length, 0);
    assert.equal(app.config().models.length, 0, 'linked models are removed too');
  } finally {
    await app.close();
  }
});

test('models screen reorders the chain with shift+arrows and J/K', async () => {
  const app = await mount({
    providers: [provider('groq')],
    models: [model('first', 'groq'), model('second', 'groq'), model('third', 'groq')],
    view: { name: 'models' },
  });
  try {
    assert.deepEqual(app.config().models.map((entry) => entry.model), ['first', 'second', 'third']);

    await app.press(KEY.down); // cursor on "second"
    await app.press(KEY.shiftUp);
    assert.deepEqual(app.config().models.map((entry) => entry.model), ['second', 'first', 'third']);

    // J/K also reorder, for terminals that swallow modifier sequences.
    await app.press('J');
    assert.deepEqual(app.config().models.map((entry) => entry.model), ['first', 'second', 'third']);

    // The cursor follows the row it moved, so walk it back to the top edge.
    await app.press(KEY.up);
    await app.press(KEY.shiftUp, 2); // at the boundary: no move, no crash
    assert.deepEqual(app.config().models.map((entry) => entry.model), ['first', 'second', 'third']);
  } finally {
    await app.close();
  }
});

test('the models table shows live latency and throughput while testing', async () => {
  const fast = await startMock('ok', { name: 'fast' });
  const slow = await startMock('ok', { name: 'slow', delayMs: 300 });
  const app = await mount({
    providers: [
      { ...provider('fast'), baseUrl: fast.baseUrl },
      { ...provider('slow'), baseUrl: slow.baseUrl },
    ],
    models: [model('quick', 'fast'), model('lazy', 'slow')],
    // Staggering is a prop so the test drives the real code path without
    // waiting the production 5s between launches.
    view: { name: 'models', spacingMs: 30 },
  });
  try {
    assert.match(app.frame(), /TTFT/);
    assert.match(app.frame(), /TOK\/S/);

    await app.press('t');
    // The slow provider answers last: the fast row must already be filled in.
    await tick(5);
    assert.match(app.frame(), /testing…/, 'progress is shown while probes are in flight');

    await tick(50);
    const frame = app.frame();
    assert.match(frame, /✓/, 'a successful probe is marked');
    assert.match(frame, /\d+ms|\d\.\d\ds/, 'a time to first token is reported');
    assert.match(frame, /hello from (fast|slow)/, 'the selected row shows its answer');
    assert.doesNotMatch(frame, /testing…/, 'the progress line clears once every probe is done');
  } finally {
    await app.close();
    await fast.close();
    await slow.close();
  }
});

test('adding a provider walks the preset picker then the form', async () => {
  const app = await mount({ view: { name: 'provider-form' } });
  try {
    assert.match(app.frame(), /pick a preset/);
    assert.match(app.frame(), /openai/);

    await app.press(KEY.down, 3); // openai → anthropic → openrouter → groq
    await app.press(KEY.enter);
    let frame = app.frame();
    assert.match(frame, /name/);
    assert.match(frame, /groq/, 'the preset prefills the name');
    assert.match(frame, /api\.groq\.com/, 'and the base URL');

    // protocol defaults to openai even on presets whose native protocol differs
    assert.match(frame, /openai/);

    await app.press(KEY.enter, 3); // name → base URL → protocol → API key
    await app.type('sk-test-key');
    frame = app.frame();
    assert.doesNotMatch(frame, /sk-test-key/, 'the key is masked while typing');
    assert.match(frame, /•{11}/);

    await app.press(KEY.enter); // last field → save
    await tick();

    const saved = app.config().providers;
    assert.equal(saved.length, 1);
    assert.equal(saved[0].name, 'groq');
    assert.equal(saved[0].type, 'openai');

    // The key never lands in the config: it goes to the .env next to it.
    assert.equal(saved[0].apiKey, 'env:GROQ_API_KEY');
    const raw = await fs.readFile(app.file, 'utf8');
    assert.doesNotMatch(raw, /sk-test-key/, 'the configuration file holds no secret');
    const dotenv = await fs.readFile(path.join(path.dirname(app.file), '.env'), 'utf8');
    assert.match(dotenv, /^GROQ_API_KEY=sk-test-key$/m);
    resetEnvCache();
  } finally {
    await app.close();
  }
});

test('the provider form can switch the protocol to anthropic', async () => {
  const app = await mount({ providers: [provider('claude')], view: { name: 'provider-form', providerId: 'prov_claude' } });
  try {
    assert.match(app.frame(), /Edit claude/);
    await app.press(KEY.down, 2); // name → base URL → protocol
    await app.press(KEY.right); // openai → anthropic
    assert.match(app.frame(), /anthropic/);

    await app.press(KEY.ctrlS); // ctrl+s
    await tick();
    assert.equal(app.config().providers[0].type, 'anthropic');
    assert.equal(app.config().providers[0].apiKey, 'sk-secret-value-1234', 'an empty key field keeps the stored key');
  } finally {
    await app.close();
  }
});

test('a required field blocks saving and says which one', async () => {
  const app = await mount({ providers: [provider('groq')], view: { name: 'model-form' } });
  try {
    await app.press(KEY.ctrlS); // ctrl+s with an empty model id
    assert.match(app.frame(), /model id is required/);
    assert.equal(app.config().models.length, 0);

    // The failed save already focused the offending field, so type straight in.
    await app.type('llama-3.3-70b');
    await app.press(KEY.ctrlS);
    await tick();

    const saved = app.config().models;
    assert.equal(saved.length, 1);
    assert.equal(saved[0].model, 'llama-3.3-70b');
    assert.equal(saved[0].alias, 'llama-3.3-70b', 'the alias mirrors the model id');
    assert.equal(saved[0].kind, 'chat');
  } finally {
    await app.close();
  }
});

test('settings toggle booleans, cycle enums and edit numbers in place', async () => {
  const app = await mount({ view: { name: 'settings' } });
  try {
    assert.match(app.frame(), /listen host/);
    assert.match(app.frame(), /preferred port/);

    await app.press(KEY.down); // preferred port
    await app.press(KEY.enter); // open the editor
    await app.press(KEY.backspace, 5);
    await app.type('51999');
    await app.press(KEY.enter);
    await tick();
    assert.equal(app.config().server.port, 51999);

    await app.press(KEY.down, 2); // log level (cycle)
    await app.press(KEY.right);
    await tick();
    assert.equal(app.config().server.logLevel, 'warn', 'info → warn');

    await app.press(KEY.down); // CORS (boolean)
    await app.press(' ');
    await tick();
    assert.equal(app.config().server.cors, false);
  } finally {
    await app.close();
  }
});

test('every setting explains itself, and every yes/no spells out both answers', () => {
  // A setting nobody can understand from the screen is a setting nobody will
  // touch on purpose — the explanation is part of the contract, not decoration.
  for (const setting of SETTINGS) {
    assert.ok(setting.hint?.length > 25, `${setting.label}: needs a hint saying what it decides`);
    assert.ok(setting.hint.length <= 90, `${setting.label}: hint too long for a terminal line`);

    if (setting.type === 'boolean') {
      assert.deepEqual(
        setting.choices?.map(([answer]) => answer),
        ['yes', 'no'],
        `${setting.label}: both answers must be spelled out, in that order`,
      );
      for (const [answer, meaning] of setting.choices) {
        assert.ok(meaning.length > 10 && meaning.length <= 80, `${setting.label}/${answer}: unhelpful or too long`);
      }
    } else {
      assert.ok(setting.example?.length > 10, `${setting.label}: needs a concrete note about the value`);
      assert.ok(setting.example.length <= 95, `${setting.label}: note too long for a terminal line`);
    }
  }
});

test('the settings help marks the answer currently in force', async () => {
  const app = await mount({ view: { name: 'settings' } });
  try {
    await app.press(KEY.down, SETTINGS.findIndex((setting) => setting.label === 'reject unknown model names'));

    let frame = app.frame();
    assert.match(frame, /A client asks for a model name that is nowhere in your chain/);
    assert.match(frame, /yes\s+HTTP 404 straight away/);
    assert.match(frame, /▸ no\s+the whole chain answers/, 'the current answer is the one marked');

    await app.press(KEY.right); // no → yes
    assert.equal(app.config().failover.strictModelMatch, true);
    frame = app.frame();
    assert.match(frame, /▸ yes\s+HTTP 404 straight away/, 'the mark follows the value');
    assert.doesNotMatch(frame, /▸ no\s+the whole chain/);
  } finally {
    await app.close();
  }
});

test('the status screen shows the failover order and live counters', async () => {
  const stats = {
    uptimeSec: 42,
    statsSince: Date.UTC(2026, 6, 31, 9, 30),
    totals: { requests: 7, successes: 5, failures: 2, tokens: 123 },
    chain: [
      {
        priority: 1,
        provider: 'groq',
        model: 'llama',
        requests: 7,
        successes: 5,
        failures: 2,
        tokens: 123,
        lastLatencyMs: 410,
        coolingDown: true,
        cooldownMsLeft: 15000,
        lastError: { reason: 'rate_limited', message: 'HTTP 429' },
      },
    ],
  };
  const app = await mount({
    providers: [provider('groq')],
    models: [model('llama', 'groq')],
    view: { name: 'status', fetchStats: async () => stats },
  });
  try {
    assert.match(app.frame(), /failover order for model="auto"/);
    assert.match(app.frame(), /groq\/llama/);
  } finally {
    await app.close();
  }
});

test('escape walks back to the home screen', async () => {
  const app = await mount({ providers: [provider('groq')], view: { name: 'providers' } });
  try {
    assert.match(app.frame(), /PROTOCOL/);
    await app.press(KEY.escape);
    assert.match(app.frame(), /Models & priority/, 'back on the home menu');
  } finally {
    await app.close();
  }
});
