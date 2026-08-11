import { useEffect, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { h } from '../h.js';
import { useLayout } from '../size.js';
import { COLOR, SYMBOL, compact, duration, percent } from '../theme.js';
import { Frame, Hints, Table } from '../widgets.js';
import { resolveChain } from '../../router.js';
import { providerLabel, resolveSecret } from '../../config.js';
import { daemonStatus } from '../../daemon.js';

const POLL_MS = 2000;

/**
 * The failover list and the counters table hold the same entries in the same
 * order, so on anything but a tall terminal the list is cut to a preview and the
 * table — which carries the numbers too — is the one that gets the rows.
 */
const CHAIN_PREVIEW = 3;

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

  const layout = useLayout();
  const chain = resolveChain(config, 'auto', 'chat');
  const address = `${config.server.host}:${config.server.port}`;

  // The name shortens first; then the widest numbers go, cheapest first.
  const columns = [
    { key: 'priority', label: '#', align: 'right', width: 2 },
    { key: 'target', label: 'TARGET', flex: true, min: 14, text: (row) => `${row.provider}/${row.model}` },
    { key: 'requests', label: 'REQ', align: 'right', width: 5, drop: 2, text: (row) => compact(row.requests) },
    // The raw counts go before the two shares, which say the same thing in the
    // space a phone has: a percentage needs no reference point to be read.
    { key: 'successes', label: 'OK', align: 'right', width: 5, drop: 1, text: (row) => compact(row.successes), color: () => COLOR.ok },
    {
      key: 'failures',
      label: 'KO',
      align: 'right',
      width: 5,
      drop: 1,
      text: (row) => compact(row.failures),
      color: (row) => (row.failures ? COLOR.fail : undefined),
    },
    {
      key: 'cancelled',
      label: 'CX',
      align: 'right',
      width: 5,
      drop: 5,
      // Speculative attempts dropped: explains requests > ok + ko.
      text: (row) => compact(row.cancelled),
      color: (row) => (row.cancelled ? COLOR.warn : undefined),
    },
    {
      key: 'share',
      label: 'USE',
      align: 'right',
      width: 5,
      // Share of the answers that came from this model. Counted on successes
      // rather than attempts: a racing attempt that was dropped served nothing.
      text: (row) => percent(row.successes, stats?.totals?.successes),
    },
    {
      key: 'reliability',
      label: 'OK%',
      align: 'right',
      width: 5,
      // Of the attempts that were carried to an answer. Cancelled ones lost a
      // race, they say nothing about whether the model was available.
      text: (row) => percent(row.successes, row.successes + row.failures),
      color: (row) => reliabilityColor(row),
    },
    { key: 'tokens', label: 'TOKENS', align: 'right', width: 6, drop: 6, text: (row) => compact(row.tokens) },
    { key: 'lastLatencyMs', label: 'LAST', align: 'right', width: 7, drop: 4, text: (row) => duration(row.lastLatencyMs) },
    {
      key: 'lastError',
      label: 'LAST ERROR',
      width: 28,
      drop: 3,
      text: (row) => (row.lastError ? `${row.lastError.reason}: ${row.lastError.message}` : '-'),
      color: (row) => (row.lastError ? COLOR.fail : undefined),
    },
  ];

  // Room for the whole list only on a tall terminal; the counters table repeats
  // it in the same order, so cutting it here costs nothing.
  const room = layout.short ? CHAIN_PREVIEW : layout.listRows(20);
  const preview =
    chain.entries.length > room
      ? { entries: chain.entries.slice(0, room), hidden: chain.entries.length - room }
      : { entries: chain.entries, hidden: 0 };

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
      h(Text, { dimColor: true, wrap: 'truncate' }, `  failover order for model="auto"${preview.hidden ? ` · ${preview.hidden} more in the table` : ''}`),
      ...(chain.entries.length
        ? preview.entries.map((entry, index) =>
            h(
              Text,
              { key: entry.id, wrap: 'truncate' },
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
            { wrap: 'truncate' },
            h(Text, { color: COLOR.ok }, `  ${SYMBOL.ok} `),
            // The provenance of the numbers matters less than the numbers, so it
            // is what gives way when the line no longer fits.
            layout.narrow ? null : h(Text, { dimColor: true }, `uptime ${stats.uptimeSec}s · counters since ${short(stats.statsSince)} · `),
            h(Text, null, `${compact(stats.totals.requests)} req`),
            h(Text, { dimColor: true }, ' · '),
            h(Text, { color: COLOR.ok }, `${compact(stats.totals.successes)} ok`),
            h(Text, { dimColor: true }, ' · '),
            h(Text, { color: stats.totals.failures ? COLOR.fail : undefined }, `${compact(stats.totals.failures)} failed`),
            h(Text, { dimColor: true }, ' · '),
            h(Text, { color: stats.totals.cancelled ? COLOR.warn : undefined }, `${compact(stats.totals.cancelled)} cancelled`),
            h(Text, { dimColor: true }, ` · ${compact(stats.totals.tokens)} tokens`),
          ),
          // Reserved: frame, title, hints, the chain list, the totals line, the
          // gaps — and the subtitle's own line once the terminal is narrow.
          h(
            Box,
            { paddingTop: 1 },
            h(Table, { columns, rows: byPriority(stats.chain), maxRows: layout.listRows(12 + preview.entries.length + (layout.narrow ? 1 : 0)) }),
          ),
        )
      : h(
          Box,
          { paddingTop: 1, flexDirection: 'column' },
          h(Text, { dimColor: true }, `  start the proxy to see live counters${error ? ` (${error})` : ''}`),
          h(Text, { dimColor: true }, '  counters are persisted, so they survive restarts'),
        ),
  );
}

/** Green once a model is answering, red once it mostly is not, nothing to judge yet at zero. */
function reliabilityColor(row) {
  const decided = row.successes + row.failures;
  if (!decided) return undefined;
  if (!row.failures) return COLOR.ok;
  return row.successes / decided < 0.5 ? COLOR.fail : COLOR.warn;
}

/**
 * The counters come from whichever proxy answers, which may be a background
 * instance of another version. Sorting here rather than trusting the payload
 * keeps this table in the same order as the failover list above it.
 */
const byPriority = (chain) => [...chain].sort((a, b) => a.priority - b.priority).map((row, index) => ({ ...row, key: index }));

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
