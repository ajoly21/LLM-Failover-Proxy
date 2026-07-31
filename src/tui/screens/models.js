import { useEffect, useRef, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { h } from '../h.js';
import { COLOR, SYMBOL, compact, duration } from '../theme.js';
import { Frame, Hints, Table } from '../widgets.js';
import { getProvider, moveModel, providerLabel } from '../../config.js';
import { probeModel } from '../../probe.js';

/** Probes are launched this far apart, but run concurrently. */
export const TEST_SPACING_MS = 5000;

const sleep = (delay) => new Promise((resolve) => setTimeout(resolve, delay));
const STATE_COLOR = { ok: COLOR.ok, fail: COLOR.fail, running: COLOR.warn, queued: undefined };

export function ModelsScreen({ config, update, notify, navigate, onBack, spacingMs }) {
  const spacing = spacingMs ?? TEST_SPACING_MS;
  const [cursor, setCursor] = useState(0);
  const [confirming, setConfirming] = useState(false);
  const [tests, setTests] = useState({});
  const [running, setRunning] = useState(false);
  const runRef = useRef(0);

  useEffect(() => () => {
    runRef.current += 1; // ignore probe results that land after unmount
  }, []);

  const models = config.models;
  const selected = models[Math.min(cursor, models.length - 1)];

  /**
   * Launches one probe per chat model, `spacingMs` apart, all running in
   * parallel: a slow provider only delays its own row.
   */
  const runTests = () => {
    const entries = models.filter((entry) => entry.kind === 'chat');
    if (!entries.length) {
      notify('no chat model to test', COLOR.warn);
      return;
    }
    const runId = ++runRef.current;
    setRunning(true);
    setTests(Object.fromEntries(entries.map((entry) => [entry.id, { state: 'queued' }])));

    const probes = entries.map(async (entry, index) => {
      await sleep(index * spacing);
      if (runRef.current !== runId) return;
      setTests((previous) => ({ ...previous, [entry.id]: { state: 'running' } }));

      const provider = getProvider(config, entry.providerId);
      const result = provider
        ? await probeModel(config, entry, provider)
        : { ok: false, message: 'provider not found' };
      if (runRef.current !== runId) return;
      setTests((previous) => ({ ...previous, [entry.id]: { state: result.ok ? 'ok' : 'fail', ...result } }));
    });

    Promise.all(probes).then(() => {
      if (runRef.current === runId) setRunning(false);
    });
  };

  useInput((input, key) => {
    if (confirming) {
      if (input === 'y') {
        update((draft) => {
          draft.models = draft.models.filter((entry) => entry.id !== selected.id);
        });
        notify(`removed ${selected.alias}`);
        setCursor(0);
      }
      setConfirming(false);
      return;
    }

    const total = Math.max(1, models.length);
    // Shift+arrows reorder; J/K work the same for terminals that swallow modifiers.
    if ((key.shift && key.upArrow) || input === 'K') {
      if (moveable(models, cursor, -1)) {
        update((draft) => moveModel(draft, cursor, -1));
        setCursor(cursor - 1);
      }
    } else if ((key.shift && key.downArrow) || input === 'J') {
      if (moveable(models, cursor, 1)) {
        update((draft) => moveModel(draft, cursor, 1));
        setCursor(cursor + 1);
      }
    } else if (key.escape || input === 'q') onBack();
    else if (key.upArrow || input === 'k') setCursor((previous) => (previous - 1 + total) % total);
    else if (key.downArrow || input === 'j') setCursor((previous) => (previous + 1) % total);
    else if (input === 'a') navigate({ name: 'model-form' });
    else if (input === 'e' && selected) navigate({ name: 'model-form', modelId: selected.id });
    else if (input === ' ' && selected) {
      update((draft) => {
        const target = draft.models.find((entry) => entry.id === selected.id);
        target.enabled = !target.enabled;
      });
    } else if (input === 'd' && selected) setConfirming(true);
    else if (input === 't') runTests();
  });

  const columns = [
    { key: 'priority', label: '#', align: 'right', width: 2, text: (row) => String(row.index + 1) },
    { key: 'alias', label: 'ALIAS' },
    { key: 'provider', label: 'PROVIDER', text: (row) => providerLabel(config, row.providerId) },
    { key: 'model', label: 'MODEL' },
    {
      key: 'enabled',
      label: 'ON',
      text: (row) => (row.enabled ? SYMBOL.on : SYMBOL.off),
      color: (row) => (row.enabled ? COLOR.ok : COLOR.fail),
    },
    {
      key: 'state',
      label: '',
      width: 1,
      text: (row) => glyph(tests[row.id]),
      color: (row) => STATE_COLOR[tests[row.id]?.state],
    },
    { key: 'ttft', label: 'TTFT', align: 'right', width: 7, text: (row) => (tests[row.id]?.ok ? duration(tests[row.id].ttftMs) : '-') },
    {
      key: 'rate',
      label: 'TOK/S',
      align: 'right',
      width: 6,
      text: (row) => (tests[row.id]?.tokensPerSecond ? tests[row.id].tokensPerSecond.toFixed(1) : '-'),
    },
    {
      key: 'tokens',
      label: 'TOK',
      align: 'right',
      width: 5,
      text: (row) => {
        const test = tests[row.id];
        return test?.tokens ? `${test.tokensApprox ? '~' : ''}${compact(test.tokens)}` : '-';
      },
    },
  ];

  const rows = models.map((entry, index) => ({ ...entry, index, key: entry.id }));
  const detail = tests[selected?.id];
  const done = Object.values(tests).filter((test) => test.state === 'ok' || test.state === 'fail').length;

  return h(
    Frame,
    {
      title: 'Models & priority',
      subtitle: `${models.length} in the chain · order = failover priority`,
      footer: h(Hints, {
        items: [
          ['↑↓', 'move'],
          ['⇧↑⇧↓ / J K', 'reorder'],
          ['a', 'add'],
          ['e', 'edit'],
          ['space', 'enable'],
          ['d', 'delete'],
          ['t', 'test all'],
          ['esc', 'back'],
        ],
      }),
    },
    h(Box, { paddingTop: 1, flexDirection: 'column' }, h(Table, { columns, rows, cursor, empty: 'no model yet — press a to add one' })),
    h(
      Box,
      { minHeight: 2, paddingTop: 1, flexDirection: 'column' },
      confirming ? h(Text, { color: COLOR.warn }, `  delete ${selected.alias}? `, h(Text, { bold: true }, 'y/n')) : null,
      !confirming && running
        ? h(
            Text,
            { dimColor: true },
            `  testing… ${done}/${Object.keys(tests).length} done, launched ${spacing / 1000}s apart, running in parallel`,
          )
        : null,
      !confirming && !running && detail?.message
        ? h(
            Text,
            { wrap: 'truncate' },
            h(Text, { color: detail.ok ? COLOR.ok : COLOR.fail }, `  ${detail.ok ? SYMBOL.ok : SYMBOL.fail} `),
            h(Text, { dimColor: true }, detail.message),
          )
        : null,
    ),
  );
}

function moveable(models, index, delta) {
  const target = index + delta;
  return target >= 0 && target < models.length;
}

function glyph(test) {
  if (!test) return ' ';
  if (test.state === 'queued') return SYMBOL.queued;
  if (test.state === 'running') return SYMBOL.running;
  return test.state === 'ok' ? SYMBOL.ok : SYMBOL.fail;
}
