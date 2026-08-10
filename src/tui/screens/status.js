import { useEffect, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { h } from '../h.js';
import { COLOR, SYMBOL, compact, duration } from '../theme.js';
import { Frame, Hints, Table } from '../widgets.js';
import { resolveChain } from '../../router.js';
import { providerLabel, resolveSecret } from '../../config.js';
import { daemonStatus } from '../../daemon.js';

const POLL_MS = 2000;

/** Live view of a running proxy: persisted counters, cooldowns, last errors. */
export function StatusScreen({ config, onBack, fetchStats = defaultFetch, pollMs = POLL_MS }) {
  const [stats, setStats] = useState(null);
  const [error, setError] = useState(null);

  useInput((input, key) => {
    if (key.escape || input === 'q') onBack();
  });

  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      try {
        const payload = await fetchStats(config);
        if (cancelled) return;
        setStats(payload);
        setError(null);
      } catch (err) {
        if (cancelled) return;
        setStats(null);
        setError(err.message);
      }
    };
    poll();
    const timer = setInterval(poll, pollMs);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [config.server.host, config.server.port, config.server.apiKey, fetchStats, pollMs]);

  const chain = resolveChain(config, 'auto', 'chat');
  const address = `${config.server.host}:${config.server.port}`;

  const columns = [
    { key: 'priority', label: '#', align: 'right', width: 2 },
    { key: 'target', label: 'TARGET', text: (row) => `${row.provider}/${row.model}` },
    { key: 'requests', label: 'REQ', align: 'right', width: 6, text: (row) => compact(row.requests) },
    { key: 'successes', label: 'OK', align: 'right', width: 6, text: (row) => compact(row.successes), color: () => COLOR.ok },
    {
      key: 'failures',
      label: 'KO',
      align: 'right',
      width: 6,
      text: (row) => compact(row.failures),
      color: (row) => (row.failures ? COLOR.fail : undefined),
    },
    {
      key: 'cancelled',
      label: 'CX',
      align: 'right',
      width: 6,
      // Speculative attempts dropped: explains requests > ok + ko.
      text: (row) => compact(row.cancelled),
      color: (row) => (row.cancelled ? COLOR.warn : undefined),
    },
    { key: 'tokens', label: 'TOKENS', align: 'right', width: 7, text: (row) => compact(row.tokens) },
    { key: 'lastLatencyMs', label: 'LAST', align: 'right', width: 7, text: (row) => duration(row.lastLatencyMs) },
    {
      key: 'cooldown',
      label: 'COOLDOWN',
      align: 'right',
      width: 8,
      text: (row) => (row.coolingDown ? duration(row.cooldownMsLeft) : '-'),
      color: (row) => (row.coolingDown ? COLOR.warn : undefined),
    },
    {
      key: 'lastError',
      label: 'LAST ERROR',
      text: (row) => (row.lastError ? `${row.lastError.reason}: ${row.lastError.message}` : '-'),
      color: (row) => (row.lastError ? COLOR.fail : undefined),
    },
  ];

  return h(
    Frame,
    {
      title: 'Status & stats',
      subtitle: stats ? `live from ${address}` : `no server answering on ${address}`,
      footer: h(Hints, {
        items: [
          ['esc', 'back'],
          ['', `refreshing every ${pollMs / 1000}s`],
        ],
      }),
    },
    h(
      Box,
      { flexDirection: 'column', paddingTop: 1 },
      h(Text, { dimColor: true }, '  failover order for model="auto"'),
      ...(chain.entries.length
        ? chain.entries.map((entry, index) =>
            h(
              Text,
              { key: entry.id },
              `  ${String(index + 1).padStart(3)}. `,
              h(Text, { color: COLOR.accent }, providerLabel(config, entry.providerId)),
              h(Text, { dimColor: true }, `/${entry.model}`),
            ),
          )
        : [h(Text, { key: 'none', color: COLOR.warn }, '  no usable model')]),
    ),
    stats
      ? h(
          Box,
          { flexDirection: 'column', paddingTop: 1 },
          h(
            Text,
            null,
            h(Text, { color: COLOR.ok }, `  ${SYMBOL.ok} `),
            h(Text, { dimColor: true }, `uptime ${stats.uptimeSec}s · counters since ${short(stats.statsSince)} · `),
            h(Text, null, `${compact(stats.totals.requests)} req`),
            h(Text, { dimColor: true }, ' · '),
            h(Text, { color: COLOR.ok }, `${compact(stats.totals.successes)} ok`),
            h(Text, { dimColor: true }, ' · '),
            h(Text, { color: stats.totals.failures ? COLOR.fail : undefined }, `${compact(stats.totals.failures)} failed`),
            h(Text, { dimColor: true }, ' · '),
            h(Text, { color: stats.totals.cancelled ? COLOR.warn : undefined }, `${compact(stats.totals.cancelled)} cancelled`),
            h(Text, { dimColor: true }, ` · ${compact(stats.totals.tokens)} tokens`),
          ),
          h(Box, { paddingTop: 1 }, h(Table, { columns, rows: stats.chain.map((row, index) => ({ ...row, key: index })), maxRows: 10 })),
        )
      : h(
          Box,
          { paddingTop: 1, flexDirection: 'column' },
          h(Text, { dimColor: true }, `  start the proxy to see live counters${error ? ` (${error})` : ''}`),
          h(Text, { dimColor: true }, '  counters are persisted, so they survive restarts'),
        ),
  );
}

async function defaultFetch(config) {
  // A background instance may sit on another port than the configured one.
  const base = daemonStatus(config.__file).url || `http://${config.server.host}:${config.server.port}`;
  const key = resolveSecret(config.server.apiKey);
  const response = await fetch(`${base}/stats`, {
    headers: key ? { authorization: `Bearer ${key}` } : {},
    signal: AbortSignal.timeout(1500),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

const short = (value) => new Date(value).toISOString().replace('T', ' ').slice(0, 16);
