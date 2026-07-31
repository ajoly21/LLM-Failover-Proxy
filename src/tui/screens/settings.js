import crypto from 'node:crypto';
import { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { h } from '../h.js';
import { COLOR, SYMBOL, cell } from '../theme.js';
import { Frame, Hints, TextField, editText } from '../widgets.js';
import { maskSecret } from '../../config.js';

/** Declarative setting list: read from and written back to the config draft. */
const SETTINGS = [
  { label: 'listen host', type: 'text', hint: '127.0.0.1 keeps it local', get: (c) => c.server.host, set: (c, v) => { c.server.host = v || '127.0.0.1'; } },
  { label: 'preferred port', type: 'number', hint: 'a free port is picked if taken', get: (c) => c.server.port, set: (c, v) => { c.server.port = clamp(v, 1024, 65535, 47821); } },
  { label: 'proxy API key', type: 'secret', hint: 'g generates one · empty = no auth · env:NAME reads it from .env', get: (c) => c.server.apiKey, set: (c, v) => { c.server.apiKey = v || null; }, mask: true },
  { label: 'log level', type: 'cycle', options: ['debug', 'info', 'warn', 'error'], get: (c) => c.server.logLevel, set: (c, v) => { c.server.logLevel = v; } },
  { label: 'CORS', type: 'boolean', get: (c) => c.server.cors, set: (c, v) => { c.server.cors = v; } },
  { label: 'request timeout (non-stream)', type: 'number', unit: 'ms', get: (c) => c.failover.requestTimeoutMs, set: (c, v) => { c.failover.requestTimeoutMs = clamp(v, 1000, 600000, 15000); } },
  { label: 'first-token timeout (stream)', type: 'number', unit: 'ms', get: (c) => c.failover.firstTokenTimeoutMs, set: (c, v) => { c.failover.firstTokenTimeoutMs = clamp(v, 1000, 600000, 15000); } },
  { label: 'idle timeout inside a stream', type: 'number', unit: 'ms', get: (c) => c.failover.idleTimeoutMs, set: (c, v) => { c.failover.idleTimeoutMs = clamp(v, 1000, 600000, 60000); } },
  { label: 'hedge delay', type: 'number', unit: 'ms', hint: 'ask the next model after this long · 0 = strictly sequential', get: (c) => c.failover.hedgeDelayMs, set: (c, v) => { c.failover.hedgeDelayMs = clamp(v, 0, 600000, 5000); } },
  { label: 'max attempts in flight', type: 'number', hint: 'concurrent speculative attempts · 1 disables hedging', get: (c) => c.failover.maxInFlight, set: (c, v) => { c.failover.maxInFlight = clamp(v, 1, 10, 3); } },
  { label: 'max attempts', type: 'number', hint: '0 = walk the whole chain', get: (c) => c.failover.maxAttempts, set: (c, v) => { c.failover.maxAttempts = clamp(v, 0, 100, 0); } },
  { label: 'fall back to other models', type: 'boolean', get: (c) => c.failover.crossModelFallback, set: (c, v) => { c.failover.crossModelFallback = v; } },
  { label: 'stream failures as a message', type: 'boolean', hint: 'explain total failure inside the stream instead of a bare 502', get: (c) => c.failover.streamErrorAsMessage, set: (c, v) => { c.failover.streamErrorAsMessage = v; } },
  { label: 'unknown model → 404', type: 'boolean', get: (c) => c.failover.strictModelMatch, set: (c, v) => { c.failover.strictModelMatch = v; } },
  { label: 'content_filter counts as failure', type: 'boolean', get: (c) => c.failover.treatContentFilterAsFailure, set: (c, v) => { c.failover.treatContentFilterAsFailure = v; } },
  { label: 'failures before benching', type: 'number', get: (c) => c.failover.cooldown.failuresBeforeTrip, set: (c, v) => { c.failover.cooldown.failuresBeforeTrip = clamp(v, 1, 50, 2); } },
  { label: 'cooldown base', type: 'number', unit: 'ms', get: (c) => c.failover.cooldown.baseMs, set: (c, v) => { c.failover.cooldown.baseMs = clamp(v, 0, 3600000, 15000); } },
  { label: 'cooldown max', type: 'number', unit: 'ms', get: (c) => c.failover.cooldown.maxMs, set: (c, v) => { c.failover.cooldown.maxMs = clamp(v, 0, 3600000, 300000); } },
];

function clamp(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

export function SettingsScreen({ config, update, notify, onBack }) {
  const [cursor, setCursor] = useState(0);
  const [draft, setDraft] = useState(null); // in-place editor buffer

  const setting = SETTINGS[cursor];
  const labelWidth = Math.max(...SETTINGS.map((entry) => entry.label.length));

  const commit = (value) => {
    update((next) => setting.set(next, value));
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
      update((next) => setting.set(next, generated));
      notify(`generated ${generated}`, COLOR.warn);
    } else if (key.return || input === ' ') {
      setDraft(String(setting.get(config) ?? ''));
    }
  });

  const rows = SETTINGS.map((entry, index) => {
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
  });

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
    h(Box, { flexDirection: 'column', paddingTop: 1 }, ...rows),
    h(
      Box,
      { minHeight: 2, paddingTop: 1 },
      setting.hint ? h(Text, { dimColor: true }, `  ${setting.hint}`) : null,
    ),
  );
}
