import crypto from 'node:crypto';
import { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { h } from '../h.js';
import { useLayout } from '../size.js';
import { COLOR, SYMBOL, cell, windowAround } from '../theme.js';
import { Frame, Hints, TextField, editText } from '../widgets.js';
import { maskSecret } from '../../config.js';
import { envPathFor, upsertEnv } from '../../env.js';

/**
 * Declarative setting list: read from and written back to the config draft.
 *
 * Each entry explains itself in the help area under the list: `hint` says what
 * the setting decides, then `choices` spells out what each answer means (the
 * current one is marked) or `example` gives the one thing worth knowing about
 * the value. Nobody should have to open the README to understand a line here.
 */
/**
 * The five groups, in the order a request lives through them. The cooldown one
 * is deliberately worded to say what the timeouts above do not: it is about the
 * requests that come *after* the one that failed.
 */
const SECTIONS = {
  server: 'Where it listens',
  request: 'While one request is in flight',
  failure: 'When a model fails or is unknown',
  cooldown: 'Afterwards, for the next requests',
  tools: 'Tests you run yourself',
};

/** Most rows visible at once; a shorter terminal gets fewer, and scrolls. */
const MAX_ROWS = 12;

export const SETTINGS = [
  {
    section: 'server',
    label: 'listen host',
    type: 'text',
    hint: 'Address the proxy answers on.',
    example: '127.0.0.1 = this machine only · 0.0.0.0 = your whole network (set a proxy API key first)',
    get: (c) => c.server.host,
    set: (c, v) => { c.server.host = v || '127.0.0.1'; },
  },
  {
    section: 'server',
    label: 'preferred port',
    type: 'number',
    hint: 'Port your apps point at: http://host:port/v1',
    example: 'if it is already taken, the next free one is used and printed at startup',
    get: (c) => c.server.port,
    set: (c, v) => { c.server.port = clamp(v, 1024, 65535, 47821); },
  },
  {
    section: 'server',
    label: 'proxy API key',
    type: 'secret',
    hint: 'Key your own apps must send to be allowed through.',
    example: 'empty = no check, fine on 127.0.0.1 · g generates one · env:NAME reuses a variable',
    get: (c) => c.server.apiKey,
    set: (c, v) => { c.server.apiKey = v || null; },
    // Like a provider key: the secret goes to the .env and the config keeps only
    // the reference, so the config file stays something you can share.
    envVar: 'LLM_PROXY_API_KEY',
    mask: true,
  },
  {
    section: 'server',
    label: 'log level',
    type: 'cycle',
    options: ['debug', 'info', 'warn', 'error'],
    hint: 'How much the proxy prints while it runs.',
    example: 'debug shows every attempt and its timing · info is the normal choice',
    get: (c) => c.server.logLevel,
    set: (c, v) => { c.server.logLevel = v; },
  },
  {
    section: 'server',
    label: 'CORS',
    type: 'boolean',
    hint: 'Should a web page be able to call the proxy straight from the browser?',
    choices: [
      ['yes', 'a web app served from another origin can use it'],
      ['no', 'browsers refuse the call; server-side code still works'],
    ],
    get: (c) => c.server.cors,
    set: (c, v) => { c.server.cors = v; },
  },
  {
    section: 'request',
    label: 'request timeout (non-stream)',
    type: 'number',
    unit: 'ms',
    hint: 'Non-streamed request: the complete answer must arrive within this.',
    example: 'past it the attempt is dropped and the next model is tried',
    get: (c) => c.failover.requestTimeoutMs,
    set: (c, v) => { c.failover.requestTimeoutMs = clamp(v, 1000, 600000, 15000); },
  },
  {
    section: 'request',
    label: 'first-token timeout (stream)',
    type: 'number',
    unit: 'ms',
    hint: 'Streamed request: the first token must arrive within this.',
    example: 'a model still silent by then is treated as broken, not as slow',
    get: (c) => c.failover.firstTokenTimeoutMs,
    set: (c, v) => { c.failover.firstTokenTimeoutMs = clamp(v, 1000, 600000, 15000); },
  },
  {
    section: 'request',
    label: 'idle timeout inside a stream',
    type: 'number',
    unit: 'ms',
    hint: 'Streamed request, once started: longest gap between two tokens.',
    example: 'catches a provider that stalls halfway through an answer',
    get: (c) => c.failover.idleTimeoutMs,
    set: (c, v) => { c.failover.idleTimeoutMs = clamp(v, 1000, 600000, 60000); },
  },
  {
    section: 'request',
    label: 'hedge delay',
    type: 'number',
    unit: 'ms',
    hint: 'Same request: how long the favourite gets alone before the next is asked too.',
    example: 'the first usable answer wins, the others are cancelled · 0 = one at a time',
    get: (c) => c.failover.hedgeDelayMs,
    set: (c, v) => { c.failover.hedgeDelayMs = clamp(v, 0, 600000, 5000); },
  },
  {
    section: 'request',
    label: 'max attempts in flight',
    type: 'number',
    hint: 'How many models may be working on the same request at once.',
    example: '1 = never in parallel · every loser still generated tokens you may be billed for',
    get: (c) => c.failover.maxInFlight,
    set: (c, v) => { c.failover.maxInFlight = clamp(v, 1, 10, 3); },
  },
  {
    section: 'request',
    label: 'max attempts',
    type: 'number',
    hint: 'How many models to try before giving up on a request.',
    example: '0 = go through the whole chain',
    get: (c) => c.failover.maxAttempts,
    set: (c, v) => { c.failover.maxAttempts = clamp(v, 0, 100, 0); },
  },
  {
    section: 'failure',
    label: 'fall back to other models',
    type: 'boolean',
    hint: 'The model that was asked for failed. May a different one answer?',
    choices: [
      ['yes', 'the rest of the chain takes over — an answer beats an error'],
      ['no', 'the request fails; only the requested model may serve it'],
    ],
    get: (c) => c.failover.crossModelFallback,
    set: (c, v) => { c.failover.crossModelFallback = v; },
  },
  {
    section: 'failure',
    label: 'reject unknown model names',
    type: 'boolean',
    hint: 'A client asks for a model name that is nowhere in your chain.',
    choices: [
      ['yes', 'HTTP 404 straight away, no provider is called'],
      ['no', 'the whole chain answers instead — apps hardcoding gpt-4o just work'],
    ],
    get: (c) => c.failover.strictModelMatch,
    set: (c, v) => { c.failover.strictModelMatch = v; },
  },
  {
    section: 'failure',
    label: 'stream failures as a message',
    type: 'boolean',
    hint: 'Every model failed on a streamed request. What does the client receive?',
    choices: [
      ['yes', 'the reason, streamed as a readable answer (plus an error header)'],
      ['no', 'a bare 502, which most chat apps show as an empty reply'],
    ],
    get: (c) => c.failover.streamErrorAsMessage,
    set: (c, v) => { c.failover.streamErrorAsMessage = v; },
  },
  {
    section: 'failure',
    label: 'content_filter counts as failure',
    type: 'boolean',
    hint: 'A provider cut the answer off for content reasons.',
    choices: [
      ['yes', 'count it as a failure and try another model'],
      ['no', 'hand the refusal back to the client as it came'],
    ],
    get: (c) => c.failover.treatContentFilterAsFailure,
    set: (c, v) => { c.failover.treatContentFilterAsFailure = v; },
  },
  {
    section: 'cooldown',
    label: 'failures before benching',
    type: 'number',
    hint: 'Consecutive failures that put a model aside for the requests that follow.',
    example: 'a 429 or an auth error benches it immediately, whatever this says',
    get: (c) => c.failover.cooldown.failuresBeforeTrip,
    set: (c, v) => { c.failover.cooldown.failuresBeforeTrip = clamp(v, 1, 50, 2); },
  },
  {
    section: 'cooldown',
    label: 'cooldown base',
    type: 'number',
    unit: 'ms',
    hint: 'How long a model is skipped once it has been put aside.',
    example: 'doubles with each new failure, up to the maximum below · any success clears it',
    get: (c) => c.failover.cooldown.baseMs,
    set: (c, v) => { c.failover.cooldown.baseMs = clamp(v, 0, 3600000, 15000); },
  },
  {
    section: 'cooldown',
    label: 'cooldown max',
    type: 'number',
    unit: 'ms',
    hint: 'Longest a model can stay skipped, however often it fails.',
    example: 'a Retry-After sent by the provider wins over this',
    get: (c) => c.failover.cooldown.maxMs,
    set: (c, v) => { c.failover.cooldown.maxMs = clamp(v, 0, 3600000, 300000); },
  },
  {
    section: 'tools',
    label: 'model test timeout',
    type: 'number',
    unit: 'ms',
    hint: 'Not a request: how long a test you started from Models lists may take.',
    example: 'only for the tests you run yourself; the deadlines above govern real requests',
    get: (c) => c.probe.timeoutMs,
    set: (c, v) => { c.probe.timeoutMs = clamp(v, 1000, 300000, 15000); },
  },
  {
    section: 'tools',
    label: 'check for updates',
    type: 'boolean',
    hint: 'Ask the npm registry, when this screen opens, whether a newer version is out.',
    choices: [
      ['yes', 'the menu says so when one is available, and u installs it'],
      ['no', 'no outbound request is ever made on this tool’s own behalf'],
    ],
    get: (c) => c.update.check,
    set: (c, v) => { c.update.check = Boolean(v); },
  },
];

function clamp(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

export function SettingsScreen({ config, update, notify, onBack }) {
  const [cursor, setCursor] = useState(0);
  const [draft, setDraft] = useState(null); // in-place editor buffer
  const layout = useLayout();

  const setting = SETTINGS[cursor];
  // Long enough for the longest label, unless that would leave no room for the
  // value it is there to introduce.
  const labelWidth = Math.min(Math.max(...SETTINGS.map((entry) => entry.label.length)), Math.max(12, layout.inner - 14));

  /**
   * What actually gets written to the config. A secret with an `envVar` is put
   * in the .env beside the config and replaced by its `env:NAME` reference, so
   * no key is ever stored in the file. `undefined` means the .env could not be
   * written, and nothing should be saved.
   */
  const toStored = (value) => {
    if (!setting.envVar) return value;
    const typed = String(value ?? '').trim();
    if (!typed) return null;
    if (typed.startsWith('env:')) return typed; // already points at a variable
    try {
      upsertEnv(envPathFor(config.__file), { [setting.envVar]: typed });
    } catch (err) {
      notify(`could not write .env: ${err.message}`, COLOR.fail);
      return undefined;
    }
    return `env:${setting.envVar}`;
  };

  const commit = (value) => {
    const stored = toStored(value);
    if (stored === undefined) return;
    update((next) => setting.set(next, stored));
    setDraft(null);
    notify(`${setting.label} updated`);
  };

  useInput((input, key) => {
    if (draft !== null) {
      if (key.escape) {
        setDraft(null);
        return;
      }
      if (key.return) {
        commit(draft);
        return;
      }
      setDraft(editText(draft, input, key));
      return;
    }

    if (key.escape || input === 'q') onBack();
    else if (key.upArrow || input === 'k') setCursor((previous) => (previous - 1 + SETTINGS.length) % SETTINGS.length);
    else if (key.downArrow || input === 'j') setCursor((previous) => (previous + 1) % SETTINGS.length);
    else if (setting.type === 'boolean' && (key.return || input === ' ' || key.leftArrow || key.rightArrow)) {
      update((next) => setting.set(next, !setting.get(next)));
    } else if (setting.type === 'cycle' && (key.return || input === ' ' || key.leftArrow || key.rightArrow)) {
      const index = setting.options.indexOf(setting.get(config));
      const step = key.leftArrow ? -1 : 1;
      update((next) => setting.set(next, setting.options[(index + step + setting.options.length) % setting.options.length]));
    } else if (setting.mask && input === 'g') {
      const generated = `sk-proxy-${crypto.randomBytes(20).toString('hex')}`;
      const stored = toStored(generated);
      if (stored === undefined) return;
      update((next) => setting.set(next, stored));
      // Shown once, because it is now in the .env and the screen will not show it again.
      notify(`generated ${generated}`, COLOR.warn);
    } else if (key.return || input === ' ') {
      setDraft(String(setting.get(config) ?? ''));
    }
  });

  const row = (entry, index) => {
    const focused = index === cursor;
    const value = entry.get(config);
    let display;

    if (focused && draft !== null) {
      display = h(TextField, { value: draft, focused: true, masked: false, placeholder: 'type a value' });
    } else if (entry.type === 'boolean') {
      display = h(Text, { color: value ? COLOR.ok : COLOR.fail }, `${value ? SYMBOL.on : SYMBOL.off} ${value ? 'yes' : 'no'}`);
    } else if (entry.mask) {
      display = h(Text, { color: value ? undefined : COLOR.warn }, value ? maskSecret(value) : 'none');
    } else {
      display = h(Text, null, `${value}${entry.unit ? ` ${entry.unit}` : ''}`);
    }

    return h(
      Box,
      { key: entry.label },
      h(Text, { color: focused ? COLOR.accent : undefined }, `${focused ? SYMBOL.cursor : ' '} `),
      h(Text, { bold: focused, dimColor: !focused }, cell(entry.label, labelWidth)),
      h(Text, null, '  '),
      display,
    );
  };

  // Windowed, so the list cannot outgrow a short terminal, and headed by
  // section, because "which of these five timers is this one" is the question
  // the flat list never answered.
  // Reserved: frame, title, hints, the help block, section headings — all of
  // which take more lines when they have to wrap.
  const { start, end } = windowAround(SETTINGS.length, cursor, Math.min(MAX_ROWS, layout.listRows(layout.narrow ? 15 : 12)));
  const rows = [];
  let shown = null;
  for (let index = start; index < end; index += 1) {
    const entry = SETTINGS[index];
    if (entry.section !== shown) {
      shown = entry.section;
      rows.push(h(Text, { key: `section-${shown}`, color: COLOR.title, bold: true }, `  ${SECTIONS[shown]}`));
    }
    rows.push(row(entry, index));
  }
  if (start > 0 || end < SETTINGS.length) {
    rows.push(h(Text, { key: 'window', dimColor: true }, `  … ${start + 1}-${end} of ${SETTINGS.length}`));
  }

  const editable = setting.type === 'boolean' || setting.type === 'cycle';

  return h(
    Frame,
    {
      title: 'Settings',
      subtitle: 'saved to disk immediately, picked up by a running server',
      footer: h(Hints, {
        items:
          draft !== null
            ? [
                ['enter', 'save'],
                ['ctrl+u', 'clear'],
                ['esc', 'cancel'],
              ]
            : [
                ['↑↓', 'move'],
                [editable ? '←→' : 'enter', editable ? 'change' : 'edit'],
                setting.mask ? ['g', 'generate key'] : null,
                ['esc', 'back'],
              ],
      }),
    },
    h(Box, { flexDirection: 'column', paddingTop: 1 }, h(Box, { flexDirection: 'column' }, ...rows), h(Help, { setting, value: setting.get(config), layout })),
  );
}

/**
 * Explains the highlighted setting: what it decides, then what each answer
 * means with the current one marked. Fixed height, so moving through the list
 * does not shift the table above.
 */
function Help({ setting, value, layout }) {
  const lines = [h(Text, { key: 'hint', dimColor: true }, `  ${setting.hint ?? ''}`)];

  if (setting.choices) {
    for (const [answer, meaning] of setting.choices) {
      const current = (answer === 'yes') === Boolean(value);
      // Narrow: only the answer in force. Spelling out the other one is what
      // makes this block three wrapped lines instead of one.
      if (layout?.narrow && !current) continue;
      lines.push(
        h(
          Text,
          { key: answer, color: current ? COLOR.accent : undefined, dimColor: !current },
          `    ${current ? SYMBOL.cursor : ' '} ${cell(answer, 3)}  ${meaning}`,
        ),
      );
    }
  } else if (setting.example) {
    lines.push(h(Text, { key: 'example', dimColor: true }, `    ${setting.example}`));
  }

  return h(Box, { flexDirection: 'column', minHeight: layout?.narrow ? 2 : 4, paddingTop: 1 }, ...lines);
}
