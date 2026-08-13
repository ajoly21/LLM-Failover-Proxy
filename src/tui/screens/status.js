import { useEffect, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { h } from '../h.js';
import { useLayout } from '../size.js';
import { COLOR, SYMBOL, ago, compact, duration, percent } from '../theme.js';
import { Frame, Hints, Table } from '../widgets.js';
import { resolveChain } from '../../router.js';
import { providerLabel, resolveSecret } from '../../config.js';
import { daemonStatus } from '../../daemon.js';
import { alignChain } from '../../state.js';

const POLL_MS = 2000;

/** Answered requests listed under the counters, and fewer on a short screen. */
const RECENT_ROWS = 5;

/**
 * What the counters cannot say: whether anything is being served right now, by
 * which model, how long the wait was before the answer started coming, and which
 * way out it took.
 *
 * An average would hide the one call that took eight seconds, which is the only
 * one anybody wants to know about — so these are individual calls, newest first.
 * The path goes first when the screen runs out of room, then TTFT: the model
 * name is what makes a row mean anything at all. On any terminal 66 columns or
 * wider all four fit, so the choice only arises on a phone.
 */
const RECENT_COLUMNS = [
  { key: 'at', label: 'WHEN', align: 'right', width: 9, text: (row) => ago(row.at) },
  {
    key: 'target',
    label: 'MODEL',
    flex: true,
    min: 14,
    text: (row) => (row.model ? `${row.provider}/${row.model}` : `${row.id} (no longer configured)`),
  },
  // A non-streamed answer arrives whole, so its first token is its whole latency.
  { key: 'ttft', label: 'TTFT', align: 'right', width: 8, drop: 1, text: (row) => duration(row.ttftMs) },
  {
    key: 'via',
    label: 'VIA',
    width: 8,
    drop: 2,
    // A dash is a row served by a proxy too old to record the path, which is not
    // the same as one that is known to have gone out directly.
    text: (row) => row.via || '-',
    color: (row) => (row.via === 'warp' ? COLOR.accent : undefined),
  },
];

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
  const usable = resolveChain(config, 'auto', 'chat').entries.length > 0;
  const address = `${config.server.host}:${config.server.port}`;
  const recentRows = layout.short ? 3 : RECENT_ROWS;
  const recent = (Array.isArray(stats?.recent) ? stats.recent : []).slice(0, recentRows);

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
      key: 'uptime',
      label: 'UPTIME',
      align: 'right',
      width: 6,
      // Availability: of the attempts it was allowed to finish, how many it
      // answered. Cancelled ones lost a race and say nothing about being up.
      text: (row) => percent(row.successes, row.successes + row.failures),
      color: (row) => reliabilityColor(row),
    },
    { key: 'tokens', label: 'TOKENS', align: 'right', width: 6, drop: 6, text: (row) => compact(row.tokens) },
    // When it last answered, not how fast: on a chain this long the useful
    // question is which models are still being reached at all.
    { key: 'lastUsedAt', label: 'LAST USED', align: 'right', width: 9, drop: 4, text: (row) => ago(row.lastUsedAt) },
    {
      key: 'lastError',
      label: 'LAST ERROR',
      width: 28,
      drop: 3,
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
    usable ? null : h(Box, { paddingTop: 1 }, h(Text, { color: COLOR.warn }, '  no usable model: check the providers screen')),
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
          stats.warp?.enabled ? h(WarpLine, { warp: stats.warp }) : null,
          // Reserved: frame, title, hints, the totals line, the gaps, the block
          // of recent calls — and the subtitle's own line once it is narrow.
          h(
            Box,
            { paddingTop: 1 },
            h(Table, {
              columns,
              rows: alignChain(config.models, stats.chain, (providerId) => providerLabel(config, providerId)),
              maxRows: layout.listRows(12 + recentRows + (layout.narrow ? 1 : 0)),
            }),
          ),
          recent.length
            ? h(
                Box,
                { flexDirection: 'column', paddingTop: 1 },
                h(Text, { dimColor: true }, `  last ${recent.length} answered`),
                h(Table, { columns: RECENT_COLUMNS, rows: recent, maxRows: recentRows }),
              )
            : null,
        )
      : h(
          Box,
          { paddingTop: 1, flexDirection: 'column' },
          h(Text, { dimColor: true }, `  start the proxy to see live counters${error ? ` (${error})` : ''}`),
          h(Text, { dimColor: true }, '  counters are persisted, so they survive restarts'),
        ),
  );
}

/**
 * The outbound path, on its own line and only when it is not the plain one.
 *
 * A line saying "direct" on every screen would be noise; no line at all while
 * WARP is on would let a `direct` row below be read as the normal state. A
 * tunnel that is down while WARP is on is the one thing worth interrupting
 * somebody about, because every row after it is either a failure or a leak.
 */
function WarpLine({ warp }) {
  const up = warp.alive;
  return h(
    Text,
    { wrap: 'truncate' },
    h(Text, { dimColor: true }, '  outbound  '),
    h(Text, { color: up ? COLOR.accent : COLOR.fail }, up ? 'Cloudflare WARP' : 'Cloudflare WARP, tunnel down'),
    !up && warp.fallbackDirect ? h(Text, { color: COLOR.warn }, ' — falling back to direct') : null,
    warp.rotatedAt ? h(Text, { dimColor: true }, ` · rotated ${ago(Date.parse(warp.rotatedAt))}`) : null,
  );
}

/** Green once a model is answering, red once it mostly is not, nothing to judge yet at zero. */
function reliabilityColor(row) {
  const decided = row.successes + row.failures;
  if (!decided) return undefined;
  if (!row.failures) return COLOR.ok;
  return row.successes / decided < 0.5 ? COLOR.fail : COLOR.warn;
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
