import fs from 'node:fs';
import { describeKey, getProvider, inlineKeys, loadConfig, providerLabel, resolveSecret } from './config.js';
import { envPathFor } from './env.js';
import { autostartInstalled, autostartTarget, daemonStatus } from './daemon.js';
import { resolveChain } from './router.js';
import { c, compact, ESC, ms } from './logger.js';
import { startServer } from './server.js';

/* ------------------------------------------------------------------ *
 * Plain-text report — used by `status`, which must stay pipeable      *
 * ------------------------------------------------------------------ */

const say = (...args) => process.stdout.write(`${args.join(' ')}\n`);
const ANSI_SGR = new RegExp(`${ESC}\\[[0-9;]*m`, 'g');

/** Column widths must ignore SGR sequences, or coloured cells break alignment. */
export const stripAnsi = (text) => String(text).replace(ANSI_SGR, '');
const pad = (text, width) => `${text}${' '.repeat(Math.max(0, width - stripAnsi(text).length))}`;

function table(headers, rows) {
  if (!rows.length) return;
  const widths = headers.map((header, index) =>
    Math.max(stripAnsi(header).length, ...rows.map((row) => stripAnsi(String(row[index] ?? '')).length)),
  );
  say(`  ${headers.map((header, index) => c.gray(pad(header, widths[index]))).join('  ')}`);
  for (const row of rows) say(`  ${row.map((cell, index) => pad(String(cell ?? ''), widths[index])).join('  ')}`);
}

const yesNo = (value) => (value ? c.green('yes') : c.red('no'));
const shortDate = (value) => new Date(value).toISOString().replace('T', ' ').slice(0, 16);

/** API keys are coloured by where they come from — and whether they resolve. */
const KEY_PAINT = { env: c.green, missing: c.red, inline: c.yellow, none: c.gray };
const keyCell = (provider) => {
  const key = describeKey(provider.apiKey);
  return KEY_PAINT[key.state](key.text);
};

export async function showStatus(config) {
  say('');
  say(`  ${c.bold(c.green('llm-failover-proxy'))} ${c.gray('— OpenAI-compatible proxy with provider failover')}`);
  say(
    `  ${c.gray('config:')} ${config.__file}   ${c.gray('listen:')} http://${config.server.host}:${config.server.port}` +
      `   ${c.gray('providers:')} ${config.providers.length}   ${c.gray('models:')} ${config.models.length}`,
  );
  const envFile = envPathFor(config.__file);
  say(`  ${c.gray('keys:')} ${envFile} ${fs.existsSync(envFile) ? c.gray('(found)') : c.yellow('(no .env yet)')}`);

  const service = daemonStatus(config.__file);
  say(
    `  ${c.gray('service:')} ${
      service.running
        ? `${c.green('running')} ${c.gray(`pid ${service.pid} · ${service.url}`)}`
        : c.gray('not running in the background')
    }   ${c.gray('at login:')} ${autostartInstalled() ? c.green('yes') : c.gray('no')} ${c.gray(`(${autostartTarget().label})`)}`,
  );

  say('');
  say(c.bold('Providers'));
  if (!config.providers.length) say(c.gray('  (none)'));
  else {
    table(
      ['#', 'NAME', 'PROTOCOL', 'BASE URL', 'API KEY', 'ENABLED'],
      config.providers.map((provider, index) => [
        index + 1,
        c.bold(provider.name),
        provider.type,
        provider.baseUrl,
        keyCell(provider),
        yesNo(provider.enabled),
      ]),
    );
    const inline = inlineKeys(config);
    if (inline.length) {
      say('');
      say(
        `  ${c.yellow(`${inline.length} key(s) still stored in the configuration file`)} ` +
          c.gray('— `llm-failover-proxy migrate` moves them to the .env'),
      );
    }
  }

  say('');
  say(`${c.bold('Model chain')} ${c.gray('(order = failover priority)')}`);
  if (!config.models.length) say(c.gray('  (none)'));
  else {
    table(
      ['PRIO', 'ALIAS', 'PROVIDER', 'UPSTREAM MODEL', 'KIND', 'ENABLED', 'PARAMS'],
      config.models.map((entry, index) => [
        c.bold(String(index + 1)),
        entry.alias || entry.model,
        providerLabel(config, entry.providerId),
        entry.model,
        entry.kind,
        yesNo(entry.enabled),
        Object.keys(entry.params || {}).length ? JSON.stringify(entry.params) : c.gray('-'),
      ]),
    );
  }

  const chain = resolveChain(config, 'auto', 'chat');
  say('');
  say(`${c.bold('Effective failover order (chat)')} ${c.gray('for model="auto"')}`);
  if (!chain.entries.length) say(c.yellow('  no usable model (provider disabled, or missing base URL?)'));
  else {
    chain.entries.forEach((entry, index) =>
      say(`  ${String(index + 1).padStart(2)}. ${providerLabel(config, entry.providerId)}/${entry.model}`),
    );
  }

  // A background instance may have landed on another port than the configured one.
  const base = service.url || `http://${config.server.host}:${config.server.port}`;
  const url = `${base}/stats`;
  const proxyKey = resolveSecret(config.server.apiKey);
  try {
    const response = await fetch(url, {
      headers: proxyKey ? { authorization: `Bearer ${proxyKey}` } : {},
      signal: AbortSignal.timeout(1500),
    });
    if (response.ok) {
      const stats = await response.json();
      say('');
      say(`${c.bold('Running server')} ${c.gray(`(uptime ${stats.uptimeSec}s)`)}`);
      say(
        c.gray(
          `  counters kept since ${shortDate(stats.statsSince)} · ${compact(stats.totals.requests)} request(s), ` +
            `${compact(stats.totals.successes)} ok, ${compact(stats.totals.failures)} failed, ` +
            `${compact(stats.totals.cancelled)} cancelled, ${compact(stats.totals.tokens)} token(s)`,
        ),
      );
      table(
        ['PRIO', 'TARGET', 'REQ', 'OK', 'KO', 'CX', 'TOKENS', 'LAST LATENCY', 'BENCHED', 'LAST ERROR'],
        stats.chain.map((row) => [
          row.priority,
          `${row.provider}/${row.model}`,
          compact(row.requests),
          c.green(compact(row.successes)),
          row.failures ? c.red(compact(row.failures)) : '0',
          row.cancelled ? c.yellow(compact(row.cancelled)) : '0',
          compact(row.tokens),
          ms(row.lastLatencyMs),
          row.coolingDown ? c.yellow(ms(row.cooldownMsLeft)) : c.gray('-'),
          row.lastError ? c.red(`${row.lastError.reason}: ${String(row.lastError.message).slice(0, 60)}`) : c.gray('-'),
        ]),
      );
    }
  } catch {
    say('');
    say(c.gray(`  (no server reachable on ${url})`));
  }
  say('');
}

/* ------------------------------------------------------------------ *
 * Interactive UI                                                      *
 * ------------------------------------------------------------------ */

/**
 * Opens the terminal UI, then honours what the user picked there — starting
 * the server is done here rather than inside the UI so the terminal is fully
 * released first.
 */
export async function openInterface({ configFile, view } = {}) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    say(c.yellow('The interactive UI needs a terminal.'));
    say(c.gray('  Use `llm-failover-proxy start` to run the proxy, or `... status` for a report.'));
    return;
  }

  let outcome;
  try {
    const { runTui } = await import('./tui/index.js');
    outcome = await runTui({ configFile, initialView: view });
  } catch (err) {
    if (err?.message?.includes('Cannot read config')) {
      say(c.red(`  ${err.message}`));
      return;
    }
    throw err;
  }

  if (outcome?.action === 'start-server') {
    await startServer({ configFile: outcome.configFile ?? configFile });
  }
}

/** Kept for callers that only need the current config on screen. */
export async function reportStatus(configFile) {
  await showStatus(loadConfig(configFile));
}
