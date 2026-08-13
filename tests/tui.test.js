import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { render } from 'ink-testing-library';
import { h } from '../src/tui/h.js';
import { App } from '../src/tui/app.js';
import { loadConfig } from '../src/config.js';
import { envPathFor, readEnvFile, resetEnvCache } from '../src/env.js';
import { SETTINGS } from '../src/tui/screens/settings.js';
import { matchSuggestions } from '../src/tui/widgets.js';
import { Form } from '../src/tui/form.js';
import { PRESETS } from '../src/presets.js';
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

/** The hint lines under the frame, which is where the keys of a screen are written. */
const footer = (app) => {
  const lines = app.lines();
  const border = lines.findIndex((line) => line.includes('╰'));
  return lines.slice(border + 1).join(' ');
};

/**
 * A terminal of a chosen size. The shared test renderer is fixed at 100 columns
 * and has no height at all, so anything about fitting a small screen has to go
 * through ink itself — which is also the only thing that truncates and wraps.
 */
class Terminal extends EventEmitter {
  constructor(columns, rows) {
    super();
    this.columns = columns;
    this.rows = rows;
  }
  write = (frame) => {
    this.frame = frame;
  };
  /** Without the colour codes, and without the trailing blank line ink adds. */
  lastFrame = () => (this.frame ?? '').replace(new RegExp(`${ESC}\\[[0-9;]*m`, 'g'), '').replace(/\n$/, '');
  lines = () => this.lastFrame().split('\n');
}

/**
 * Ink reads a keypress either as a `data` event or through the readable
 * protocol, depending on the terminal it was handed. A stand-in has to offer
 * both, or the arrows silently do nothing.
 */
class Keyboard extends EventEmitter {
  isTTY = true;
  data = null;
  setEncoding() {}
  setRawMode() {}
  resume() {}
  pause() {}
  ref() {}
  unref() {}
  write = (data) => {
    this.data = data;
    this.emit('readable');
    this.emit('data', data);
  };
  read = () => {
    const { data } = this;
    this.data = null;
    return data;
  };
}

/**
 * Renders the app against a throwaway config file. Pass `columns`/`rows` to run
 * it on a terminal of that size instead of the shared 100-column renderer.
 */
async function mount({ providers = [], models = [], targets, activeTargetId, view, columns, rows, update } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'llm-proxy-tui-'));
  const file = path.join(dir, 'config.json');
  await fs.writeFile(
    file,
    JSON.stringify({ server: { host: '127.0.0.1', port: 47821 }, providers, models, ...(targets ? { targets, activeTargetId } : {}) }),
  );

  const finished = [];
  // No test ever reaches the registry: the default checker is replaced by one
  // that answers whatever the case under test needs, immediately.
  const props = {
    configFile: file,
    onFinish: (outcome) => finished.push(outcome),
    initialView: view,
    checkUpdate: async () => update ?? { current: '1.0.0', latest: null, available: false, installable: false },
  };
  let ui;
  if (columns || rows) {
    const { render: inkRender } = await import('ink');
    const stdout = new Terminal(columns ?? 80, rows ?? 24);
    const stdin = new Keyboard();
    // `debug` makes ink write every frame out, the way the test renderer does.
    const app = inkRender(h(App, props), { stdout, stdin, debug: true, patchConsole: false, exitOnCtrlC: false });
    ui = { stdin, lastFrame: () => stdout.lastFrame(), lines: () => stdout.lines(), unmount: () => app.unmount() };
  } else {
    ui = render(h(App, props));
    ui.lines = () => ui.lastFrame().split('\n');
  }
  await tick();

  return {
    ui,
    file,
    finished,
    frame: () => ui.lastFrame(),
    lines: () => ui.lines(),
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
    assert.match(frame, /Models lists/);
    assert.match(frame, /Status & stats/);
    assert.match(frame, /127\.0\.0\.1:47821/);
    assert.match(frame, /providers 1/);
    assert.match(frame, /models 1/);
  } finally {
    await app.close();
  }
});

test('a published release is announced on the menu, and u installs it', async () => {
  const app = await mount({
    providers: [provider('groq')],
    models: [model('llama', 'groq')],
    update: { current: '1.2.0', latest: '1.3.0', available: true, installable: true },
  });
  try {
    const frame = app.frame();
    assert.match(frame, /update available/);
    assert.match(frame, /1\.2\.0 → 1\.3\.0/, 'from what, to what');
    assert.match(frame, /press u to install it/);
    assert.match(frame, /u update/, 'and the key is in the hints');

    await app.press('u');
    assert.deepEqual(app.finished, [{ action: 'update', release: { current: '1.2.0', latest: '1.3.0', available: true, installable: true } }]);
  } finally {
    await app.close();
  }
});

test('a copy that must not be replaced in place is told what to run instead', async () => {
  // A checkout, or an `npm link`: installing the release would swap the very copy
  // being run, which is never what a developer meant by pressing a key.
  const app = await mount({
    providers: [provider('groq')],
    models: [model('llama', 'groq')],
    update: { current: '1.2.0', latest: '1.3.0', available: true, installable: false },
  });
  try {
    assert.match(app.frame(), /update available/);
    assert.match(app.frame(), /npm install --global llm-failover-proxy@latest/);
    assert.doesNotMatch(app.frame(), /press u/);

    await app.press('u');
    assert.deepEqual(app.finished, [], 'and the key does nothing');
  } finally {
    await app.close();
  }
});

test('nothing is said when there is nothing to say', async () => {
  const app = await mount({ providers: [provider('groq')], models: [model('llama', 'groq')] });
  try {
    assert.doesNotMatch(app.frame(), /update/, 'no line, no hint, no reserved space');
    await app.press('u');
    assert.deepEqual(app.finished, []);
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
    assert.match(app.frame(), /Models lists/, 'lands on the home menu');
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

test('a second model list is added, named in place, and reached with the arrows', async () => {
  const app = await mount({
    providers: [provider('groq')],
    models: [model('first', 'groq'), model('second', 'groq')],
    view: { name: 'models' },
  });
  const chain = () => app.config().models.map((entry) => entry.model);
  try {
    assert.match(app.frame(), /list\s+default\s+1\/1/, 'the list in use is named on screen');
    // Every key that acts on a list is written under the list itself…
    assert.match(app.frame(), /←→ switch list · n new list · c copy list · r rename list/, 'and how to get another one');
    // …and nowhere else: the hints at the foot of the screen are the chain's.
    assert.match(footer(app), /↑↓ move · m reorder · a add · e edit · space enable · d delete · t test all · esc back/);
    assert.doesNotMatch(footer(app), /list/, 'no list key is repeated down there');

    // n opens the field, and the name is typed where the name is shown.
    await app.press('n');
    await app.type('cheap');
    assert.match(app.frame(), /new: cheap/, 'typed in place, not on another screen');
    await app.press(KEY.enter);

    assert.match(app.frame(), /list\s+‹ cheap ›\s+2\/2/);
    assert.deepEqual(chain(), [], 'the new list starts empty');
    assert.deepEqual(app.config().targets.map((entry) => entry.name), ['default', 'cheap']);
    assert.deepEqual(app.config().targets[0].models.map((entry) => entry.model), ['first', 'second'], 'the first chain was parked, not lost');

    // ←→ swap which chain the proxy serves, wrapping at both ends.
    await app.press(KEY.left);
    assert.match(app.frame(), /list\s+‹ default ›\s+1\/2/);
    assert.deepEqual(chain(), ['first', 'second'], 'the parked chain is live again');

    await app.press(KEY.left);
    assert.match(app.frame(), /2\/2/, 'wraps round to the last list');
    assert.deepEqual(chain(), []);

    // r renames the list in use, and esc leaves it alone.
    await app.press('r');
    await app.press(KEY.backspace, 5);
    await app.press(KEY.escape);
    assert.match(app.frame(), /list\s+‹ cheap ›/, 'cancelled, so the name stands');

    await app.press('r');
    await app.type('-x');
    await app.press(KEY.enter);
    assert.match(app.frame(), /list\s+‹ cheap-x ›/);
    assert.deepEqual(app.config().targets.map((entry) => entry.name), ['default', 'cheap-x']);
  } finally {
    await app.close();
  }
});

test('c copies the list in use, and x deletes one', async () => {
  const app = await mount({
    providers: [provider('groq')],
    models: [model('first', 'groq'), model('second', 'groq')],
    view: { name: 'models' },
  });
  const chain = () => app.config().models.map((entry) => entry.model);
  try {
    // The copy is offered under a name of its own, prefilled so enter is enough.
    // `c`, not a shifted `n`, which reads as a second way to say "new list".
    await app.press('c');
    assert.match(app.frame(), /copy: default copy/, 'prefilled with a name derived from the original');
    await app.press(KEY.enter);

    assert.match(app.frame(), /list\s+‹ default copy ›\s+2\/2/);
    assert.deepEqual(chain(), ['first', 'second'], 'same models, same order');
    const copied = app.config().targets[1];
    assert.deepEqual(
      copied.models.map((entry) => entry.id).filter((id) => ['mdl_first', 'mdl_second'].includes(id)),
      [],
      'and entries of its own, so the counters of the original stay the original list history',
    );

    // Reordering the copy leaves the list it came from alone.
    await app.press('J');
    assert.deepEqual(chain(), ['second', 'first']);
    assert.deepEqual(app.config().targets[0].models.map((entry) => entry.model), ['first', 'second'], 'the original is untouched');

    // x asks first, and anything but y cancels.
    await app.press('x');
    assert.match(app.frame(), /delete list default copy and its 2 model\(s\)\?/);
    await app.press('n');
    assert.equal(app.config().targets.length, 2, 'cancelled');

    await app.press('x');
    await app.press('y');
    assert.deepEqual(app.config().targets.map((entry) => entry.name), ['default']);
    assert.deepEqual(chain(), ['first', 'second'], 'the list that took its place is being served');
    assert.match(app.frame(), /list\s+default\s+1\/1/);
  } finally {
    await app.close();
  }
});

test('the last model list cannot be deleted, and does not offer to be', async () => {
  const app = await mount({
    providers: [provider('groq')],
    models: [model('first', 'groq')],
    view: { name: 'models' },
  });
  try {
    // Something has to be served, so the key is neither offered nor accepted.
    assert.doesNotMatch(app.frame(), /x delete/);
    await app.press('x');
    assert.doesNotMatch(app.frame(), /delete list/, 'nothing to confirm');
    assert.equal(app.config().targets.length, 1);
    assert.deepEqual(app.config().models.map((entry) => entry.model), ['first']);
  } finally {
    await app.close();
  }
});

test('a single model list has nowhere to switch to, and says nothing about it', async () => {
  const app = await mount({
    providers: [provider('groq')],
    models: [model('first', 'groq')],
    view: { name: 'models' },
  });
  try {
    // No `‹ ›` around a name that leads nowhere, and the arrows are inert rather
    // than wrapping the one list onto itself.
    assert.match(app.frame(), /list\s+default\s+1\/1/);
    assert.doesNotMatch(app.frame(), /‹ default ›/);
    await app.press(KEY.right);
    assert.match(app.frame(), /list\s+default\s+1\/1/);
    assert.deepEqual(app.config().models.map((entry) => entry.model), ['first']);
  } finally {
    await app.close();
  }
});

test('a model can be picked up and carried with plain arrows', async () => {
  const app = await mount({
    providers: [provider('groq')],
    models: [model('first', 'groq'), model('second', 'groq'), model('third', 'groq')],
    view: { name: 'models' },
  });
  const order = () => app.config().models.map((entry) => entry.model);
  try {
    // No modifier anywhere in this test: a phone keyboard cannot send one.
    await app.press('m');
    assert.match(app.frame(), /moving first/, 'the screen says what is being carried');
    assert.match(app.frame(), /drop it here/);

    await app.press(KEY.down);
    assert.deepEqual(order(), ['second', 'first', 'third'], 'the arrow carried the model, not the cursor');

    await app.press(KEY.down);
    assert.deepEqual(order(), ['second', 'third', 'first']);

    // At the bottom edge: nothing moves, nothing throws.
    await app.press(KEY.down);
    assert.deepEqual(order(), ['second', 'third', 'first']);

    await app.press(KEY.enter);
    assert.doesNotMatch(app.frame(), /moving first/, 'dropped');
    assert.match(app.frame(), /3 in the chain/, 'and the screen is back to its usual subtitle');

    // And the arrows move the cursor again, leaving the order alone.
    await app.press(KEY.up, 2);
    assert.deepEqual(order(), ['second', 'third', 'first']);
  } finally {
    await app.close();
  }
});

test('escape drops a held model where it is, rather than putting it back', async () => {
  const app = await mount({
    providers: [provider('groq')],
    models: [model('first', 'groq'), model('second', 'groq')],
    view: { name: 'models' },
  });
  try {
    await app.press('m');
    await app.press(KEY.down);
    await app.press(KEY.escape);
    assert.deepEqual(app.config().models.map((entry) => entry.model), ['second', 'first']);
    // Still on the models screen: escape dropped the model, it did not go back.
    assert.match(app.frame(), /Models lists/);
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

    // Walked from the top of the list, however long it grows.
    await app.press(KEY.down, PRESETS.findIndex((preset) => preset.key === 'groq'));
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

test('suggestions match the middle of a name and rank the ones that start a word first', () => {
  const items = ['openai/gpt-5-mini', 'z-ai/glm-5.2', 'z-ai/glm-5.2-free', 'my-glmodel', 'llama-3.3-70b'];

  // What someone types is the part of the name they remember, not its start:
  // this is the case the whole feature exists for.
  const glm = matchSuggestions(items, 'glm');
  assert.deepEqual(glm, ['z-ai/glm-5.2', 'z-ai/glm-5.2-free', 'my-glmodel'], 'a substring match, shortest and word-initial first');

  assert.deepEqual(matchSuggestions(items, 'GLM-5.2'), ['z-ai/glm-5.2', 'z-ai/glm-5.2-free'], 'case is ignored');
  assert.deepEqual(matchSuggestions(items, 'free glm'), ['z-ai/glm-5.2-free'], 'every word must appear, in any order');
  assert.deepEqual(matchSuggestions(items, 'nothing'), [], 'no match is an empty list, not everything');
  assert.deepEqual(matchSuggestions(items, '   '), [], 'an empty field offers nothing rather than the whole catalogue');
  assert.deepEqual(matchSuggestions([{ value: 'z-ai/glm-5.2', hint: 'in the chain' }], 'glm')[0].hint, 'in the chain', 'items keep their hint');
});

test('the model form offers the models the selected provider advertises', async () => {
  const zed = await startMock('ok', { name: 'zed' });
  const app = await mount({
    providers: [{ ...provider('zed'), baseUrl: zed.baseUrl }],
    view: { name: 'model-form' },
  });
  try {
    await tick(5); // the lookup is a real HTTP call to the mock
    await app.press(KEY.down); // onto the model id field
    assert.match(app.frame(), /2 models on zed/, 'the field says what it knows before anything is typed');
    assert.doesNotMatch(app.frame(), /zed-model-a/, 'but it does not dump the whole list unprompted');

    await app.type('zzz');
    assert.match(app.frame(), /no match for "zzz"/, 'a list known to be complete says when a name is not in it');
    await app.press(String.fromCharCode(21)); // ctrl+u, clear the field

    await app.type('model-b');
    assert.match(app.frame(), /zed-model-b/, 'typing part of a name offers it');
    assert.doesNotMatch(app.frame(), /zed-model-a/, 'and only it');

    await app.press(KEY.down); // into the list
    await app.press(KEY.enter); // take the highlighted one
    await tick();
    assert.match(app.frame(), /zed-model-b/);
    assert.doesNotMatch(app.frame(), /no match/, 'a name that was just picked from the list is not then called unknown');

    await app.press(KEY.ctrlS);
    await tick();
    const saved = app.config().models;
    assert.equal(saved.length, 1);
    assert.equal(saved[0].model, 'zed-model-b', 'the accepted suggestion is what gets saved');
  } finally {
    await app.close();
    await zed.close();
  }
});

test('a provider that cannot be listed leaves the model id a plain text field', async () => {
  // Port 9 is the discard port: nothing answers, so the lookup fails.
  const app = await mount({ providers: [provider('groq')], view: { name: 'model-form' } });
  try {
    await tick(5);
    await app.press(KEY.down);
    assert.match(app.frame(), /did not answer with a model list/, 'the failure is reported, not hidden');

    await app.type('llama-3.3-70b');
    assert.doesNotMatch(app.frame(), /no match/, 'a list that was never obtained does not get to call a name unknown');

    await app.press(KEY.ctrlS);
    await tick();
    assert.equal(app.config().models[0].model, 'llama-3.3-70b', 'typing the id by hand still works');
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

test('the proxy key is written to the .env, whether it is typed or generated', async () => {
  // The only screen that used to put a secret in the config file. There is no
  // command to move keys any more, so this path has to be right on its own.
  const app = await mount({ view: { name: 'settings' } });
  try {
    await app.press(KEY.down, 2); // proxy API key
    await app.press(KEY.enter); // open the editor
    await app.type('sk-typed-by-hand');
    await app.press(KEY.enter);
    await tick();

    assert.equal(app.config().server.apiKey, 'env:LLM_PROXY_API_KEY', 'the config holds the reference');
    assert.doesNotMatch(await fs.readFile(app.file, 'utf8'), /sk-typed-by-hand/, 'and never the key itself');
    resetEnvCache();
    assert.equal(readEnvFile(envPathFor(app.file)).LLM_PROXY_API_KEY, 'sk-typed-by-hand');

    // `g` takes the same route, and overwrites the variable rather than the config.
    await app.press('g');
    await tick();
    assert.equal(app.config().server.apiKey, 'env:LLM_PROXY_API_KEY');
    resetEnvCache();
    const generated = readEnvFile(envPathFor(app.file)).LLM_PROXY_API_KEY;
    assert.match(generated, /^sk-proxy-[0-9a-f]{40}$/, 'a fresh key landed in the .env');
  } finally {
    resetEnvCache();
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

test('settings are grouped by moment, and the groups never come back', async () => {
  // Contiguity is what makes a heading mean something: a section reappearing
  // lower down would tell the reader those timers are unrelated when they are.
  const groups = [];
  let last = null;
  for (const setting of SETTINGS) {
    assert.ok(setting.section, `${setting.label}: no section`);
    if (setting.section !== last) groups.push(setting.section);
    last = setting.section;
  }
  assert.deepEqual(groups, [...new Set(groups)], 'a section must appear once, in one block');

  const app = await mount({ view: { name: 'settings' } });
  try {
    assert.match(app.frame(), /Where it listens/);
    assert.match(app.frame(), /While one request is in flight/);
    assert.match(app.frame(), /\d+-\d+ of \d+/, 'the list is windowed, not clipped');

    await app.press(KEY.down, SETTINGS.length - 1); // walk to the far end
    assert.match(app.frame(), /Afterwards, for the next requests/, 'the cooldown group says it is about later requests');
    assert.match(app.frame(), /Tests you run yourself/);
  } finally {
    await app.close();
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
    const frame = app.frame();
    assert.match(frame, /TARGET/);
    assert.match(frame, /groq\/llama/);
    assert.match(frame, /UPTIME/, 'availability, not the ratio it is computed from');
    assert.match(frame, /LAST USED/);
    assert.doesNotMatch(frame, /failover order/, 'the table is the chain, in order: no second list of the same thing');
  } finally {
    await app.close();
  }
});

test('the last answered requests are listed under the counters, with their age', async () => {
  const now = Date.now();
  const stats = {
    uptimeSec: 300,
    statsSince: Date.UTC(2026, 7, 11, 8, 0),
    totals: { requests: 3, successes: 3, failures: 0, cancelled: 0, tokens: 30 },
    chain: [{ id: 'mdl_llama', priority: 1, provider: 'groq', model: 'llama', requests: 3, successes: 3, failures: 0, cancelled: 0, tokens: 30, lastUsedAt: now - 4000 }],
    recent: [
      { id: 'mdl_llama', at: now - 4000, provider: 'groq', model: 'llama', alias: 'llama', ttftMs: 437 },
      { id: 'mdl_llama', at: now - 90_000, provider: 'groq', model: 'llama', alias: 'llama', ttftMs: 8200 },
      { id: 'mdl_llama', at: now - 7_200_000, provider: 'groq', model: 'llama', alias: 'llama', ttftMs: null },
    ],
  };
  const app = await mount({
    providers: [provider('groq')],
    models: [model('llama', 'groq')],
    view: { name: 'status', fetchStats: async () => stats },
  });
  try {
    const frame = app.frame();
    assert.match(frame, /last 3 answered/);
    assert.match(frame, /WHEN\s+MODEL\s+TTFT/, 'when, what took it, and how long the wait was');
    assert.match(frame, /4s ago\s+groq\/llama\s+437ms/);
    assert.match(frame, /2min ago\s+groq\/llama\s+8\.20s/, 'the slow one is the whole point of listing calls one by one');
    assert.match(frame, /2h ago\s+groq\/llama\s+-/, 'a call recorded before this was measured says so');
  } finally {
    await app.close();
  }

  // On a screen too narrow for three, TTFT goes and the model name stays: a row
  // with no model in it says nothing at all. Columns are sized to their content,
  // so three of them fit further down than one would guess — this is genuinely
  // the width at which one has to go, with a name as short as `groq/llama`.
  const narrow = await mount({
    providers: [provider('groq')],
    models: [model('llama', 'groq')],
    view: { name: 'status', fetchStats: async () => stats },
    columns: 32,
    rows: 30,
  });
  try {
    const frame = narrow.frame();
    assert.match(frame, /last 3 answered/);
    assert.doesNotMatch(frame, /TTFT/, 'dropped rather than truncated into nonsense');
    assert.match(frame, /4s ago\s+groq\/llama/, 'and the row still answers "which model"');
  } finally {
    await narrow.close();
  }
});

test('the counters table follows this configuration, not the order the proxy sends', async () => {
  // A background proxy still serving an older file numbers its chain from that
  // file. Trusting that order puts the rows in one no other screen shows.
  const models = [model('first', 'groq'), model('second', 'groq'), model('third', 'groq')];
  const counters = (id, model) => ({
    id,
    provider: 'groq',
    model,
    requests: 1,
    successes: 1,
    failures: 0,
    cancelled: 0,
    tokens: 10,
    lastUsedAt: Date.now(),
    coolingDown: false,
    cooldownMsLeft: 0,
    lastError: null,
  });
  const stale = {
    uptimeSec: 9,
    statsSince: Date.UTC(2026, 7, 11, 8, 0),
    totals: { requests: 3, successes: 3, failures: 0, cancelled: 0, tokens: 30 },
    // Reversed, renumbered, and carrying an entry this configuration never had.
    chain: [
      { ...counters('mdl_third', 'third'), priority: 1 },
      { ...counters('mdl_gone', 'retired'), priority: 2 },
      { ...counters('mdl_first', 'first'), priority: 3 },
    ],
  };
  const app = await mount({ providers: [provider('groq')], models, view: { name: 'status', fetchStats: async () => stale } });
  try {
    const rows = app
      .lines()
      .map((line) => line.match(/\s(\d+)\s+groq\/(\S+)/))
      .filter(Boolean)
      .map(([, priority, target]) => `${priority} ${target}`);
    assert.deepEqual(rows, ['1 first', '2 second', '3 third'], "the configuration's own priority order, and nothing else");
    // These are the stats of the list in use: an entry the proxy reports and this
    // list does not have belongs to another list, or another file. Left out of the
    // table, but said out loud rather than dropped in silence.
    assert.doesNotMatch(app.frame(), /groq\/retired/, 'a model outside this list is not in the table');
    assert.match(app.frame(), /1 more model\(s\) served, in another list or another config/);
  } finally {
    await app.close();
  }
});

test('escape walks back to the home screen', async () => {
  const app = await mount({ providers: [provider('groq')], view: { name: 'providers' } });
  try {
    assert.match(app.frame(), /PROTOCOL/);
    await app.press(KEY.escape);
    assert.match(app.frame(), /Models lists/, 'back on the home menu');
  } finally {
    await app.close();
  }
});

/* ------------------------------------------------------------------ *
 * Small screens: a phone over SSH is one of the places this runs      *
 * ------------------------------------------------------------------ */

const PHONE = { columns: 40, rows: 20 };

/** Widest rendered line, and how many rows the screen actually took. */
const shape = (app) => {
  const lines = app.lines();
  return { width: Math.max(...lines.map((line) => line.length)), height: lines.length };
};

const chain = (count) =>
  Array.from({ length: count }, (_, index) =>
    model(index === 0 ? 'nvidia/nemotron-3-ultra-550b-a55b:free' : `model-number-${index}`, 'groq'),
  );

test('the reorder that needs no modifier works on a phone-sized terminal', async () => {
  const app = await mount({
    ...PHONE,
    providers: [provider('groq')],
    models: [model('first', 'groq'), model('second', 'groq'), model('third', 'groq')],
    view: { name: 'models' },
  });
  try {
    await app.press('m');
    assert.match(app.frame(), /moving first/);
    await app.press(KEY.down);
    assert.deepEqual(app.config().models.map((entry) => entry.model), ['second', 'first', 'third']);

    const { width, height } = shape(app);
    assert.ok(width <= PHONE.columns && height <= PHONE.rows, 'and holding a model does not make the screen overflow');
  } finally {
    await app.close();
  }
});

test('a suggestion list longer than the screen scrolls instead of hiding the rest', async () => {
  const items = Array.from({ length: 9 }, (_, index) => `mistralai/model-${index + 1}`);
  let saved = null;
  const fields = [
    { name: 'model', label: 'model id', type: 'text', required: true, initial: '', suggest: { items, note: `${items.length} models` } },
    { name: 'position', label: 'priority', type: 'number', initial: '1' },
  ];
  const ui = render(h(Form, { title: 'Add a model', fields, onSubmit: (values) => { saved = values; }, onCancel: () => {} }));
  try {
    await tick();
    for (const char of 'model') {
      ui.stdin.write(char);
      await tick(1);
    }
    assert.match(ui.lastFrame(), /showing 1-6 of 9/, 'the screenful is counted against the whole');
    assert.doesNotMatch(ui.lastFrame(), /model-9/, 'the tail starts off screen');

    for (let index = 0; index < 9; index += 1) {
      ui.stdin.write(KEY.down);
      await tick(1);
    }
    assert.match(ui.lastFrame(), /showing 4-9 of 9/, 'the window follows the cursor down');
    assert.match(ui.lastFrame(), /model-9/, 'so the last match is reachable');

    ui.stdin.write(KEY.enter); // take it
    await tick();
    ui.stdin.write(KEY.ctrlS);
    await tick();
    assert.equal(saved?.model, 'mistralai/model-9', 'a match past the first screenful can be picked');
  } finally {
    ui.unmount();
  }
});

test('the model form fits a phone screen with its suggestion list open', async () => {
  const zed = await startMock('ok', { name: 'zed' });
  const app = await mount({
    ...PHONE,
    providers: [{ ...provider('zed'), baseUrl: zed.baseUrl }],
    view: { name: 'model-form' },
  });
  try {
    await tick(5);
    await app.press(KEY.down);
    await app.type('model');
    assert.match(app.frame(), /zed-model-a/, 'the list is open');

    const { width, height } = shape(app);
    assert.ok(width <= PHONE.columns, `the form is ${width} columns wide, the terminal has ${PHONE.columns}`);
    assert.ok(height <= PHONE.rows, `the form needs ${height} rows, the terminal has ${PHONE.rows}`);
  } finally {
    await app.close();
    await zed.close();
  }
});

/** Counters for a full chain, so the status screen has something to crowd with. */
const busyStats = (models) => ({
  uptimeSec: 4210,
  statsSince: Date.UTC(2026, 7, 10, 7, 37),
  totals: { requests: 42, successes: 20, failures: 3, cancelled: 19, tokens: 812345 },
  chain: models.map((entry, index) => ({
    priority: index + 1,
    provider: 'groq',
    model: entry.model,
    requests: index ? 0 : 22,
    successes: index ? 0 : 4,
    failures: index === 1 ? 3 : 0,
    cancelled: index ? 0 : 18,
    tokens: index ? 0 : 400000,
    lastLatencyMs: index ? null : 8300,
    coolingDown: false,
    cooldownMsLeft: 0,
    lastError: index === 1 ? { reason: 'rate_limited', message: 'HTTP 429 slow down, retry in 37s' } : null,
  })),
});

test('on a phone-sized terminal, no screen overflows in either direction', async () => {
  const models = chain(7);
  const views = [
    { name: 'home' },
    { name: 'models' },
    { name: 'providers' },
    { name: 'settings' },
    { name: 'status', fetchStats: async () => busyStats(models), pollMs: 99999 },
  ];
  for (const view of views) {
    const app = await mount({ ...PHONE, providers: [provider('groq'), provider('openrouter')], models, view });
    try {
      const { width, height } = shape(app);
      assert.ok(width <= PHONE.columns, `${view.name} is ${width} columns wide, the terminal has ${PHONE.columns}`);
      assert.ok(height <= PHONE.rows, `${view.name} needs ${height} rows, the terminal has ${PHONE.rows}`);
    } finally {
      await app.close();
    }
  }

  // The worst case for this screen: several lists, so `x delete` is offered as
  // well, and a screen this short has no room for the line under the list name —
  // so every list key has to fall back into hints that already wrap.
  const crowded = await mount({
    ...PHONE,
    providers: [provider('groq')],
    models,
    targets: [
      { id: 'lst_a', name: 'default', models: [] },
      { id: 'lst_b', name: 'cheap-and-fast', models: [] },
    ],
    activeTargetId: 'lst_b',
    view: { name: 'models' },
  });
  try {
    const { width, height } = shape(crowded);
    assert.ok(width <= PHONE.columns, `the models lists screen is ${width} columns wide, the terminal has ${PHONE.columns}`);
    assert.ok(height <= PHONE.rows, `the models lists screen needs ${height} rows, the terminal has ${PHONE.rows}`);
    assert.match(crowded.frame(), /c copy/, 'the list keys survive a screen with no room for their own line');
    assert.match(crowded.frame(), /x delete/, 'and the key to remove one is reachable there too');
  } finally {
    await crowded.close();
  }
});

test('a narrow table drops columns rather than losing the state of a row', async () => {
  const app = await mount({ ...PHONE, providers: [provider('groq')], models: chain(4), view: { name: 'models' } });
  try {
    const frame = app.frame();
    // The alias identifies the row and the mark says whether it is enabled:
    // those two survive, and every model still has a line of its own.
    assert.match(frame, /ALIAS/);
    assert.match(frame, /ON/);
    assert.doesNotMatch(frame, /TOK\/S/, 'throughput is the first thing a phone gives up');
    assert.doesNotMatch(frame, /PROVIDER/);
    for (let index = 1; index <= 4; index += 1) assert.match(frame, new RegExp(String.raw`\s${index}\s`), `row ${index} is on screen`);
    // The long alias is shortened, not wrapped onto a second line.
    assert.match(frame, /nvidia\/nemotron\S*…/);
  } finally {
    await app.close();
  }
});

test('the two shares are the last counters standing on a narrow screen', async () => {
  const models = chain(5);
  const app = await mount({
    ...PHONE,
    providers: [provider('groq')],
    models,
    view: { name: 'status', fetchStats: async () => busyStats(models), pollMs: 99999 },
  });
  try {
    const frame = app.frame();
    assert.match(frame, /USE/);
    assert.match(frame, /UPTIME/);
    assert.doesNotMatch(frame, /TOKENS/, 'token totals are the first thing to go');
    assert.doesNotMatch(frame, /LAST ERROR/);
    // A percentage still reads with nothing to compare it against; a raw count
    // does not, so the counts are what give way first.
    assert.doesNotMatch(frame, /\sREQ\s/);
    assert.match(frame, /100%/);
  } finally {
    await app.close();
  }
});

test('the title keeps its own characters when the terminal is narrow', async () => {
  const app = await mount({ ...PHONE, providers: [provider('groq')], view: { name: 'providers' } });
  try {
    // Ink shrinks a flexible sibling before wrapping: the title must not be one,
    // or "Providers" comes back as "Provide" and an orphaned "s".
    assert.match(app.frame(), /Providers/);
  } finally {
    await app.close();
  }
});

test('a wide terminal shows every column, and more rows', async () => {
  const app = await mount({ columns: 160, rows: 40, providers: [provider('groq')], models: chain(7), view: { name: 'models' } });
  try {
    const frame = app.frame();
    for (const label of ['ALIAS', 'PROVIDER', 'MODEL', 'ON', 'TTFT', 'TOK/S']) assert.match(frame, new RegExp(label));
    assert.doesNotMatch(frame, /showing 1-/, 'all seven rows fit, so nothing is windowed away');
    assert.match(frame, /nvidia\/nemotron-3-ultra-550b-a55b:free/, 'and the long name is not shortened');
  } finally {
    await app.close();
  }
});
