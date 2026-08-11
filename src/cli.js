import fs from "node:fs";
import { configExists, configPath, describeKey, inlineKeys, loadConfig, providerLabel, resolveSecret, statsPathFor } from "./config.js";
import { autostartHealth, autostartInstalled, autostartTarget, daemonStatus } from "./daemon.js";
import { envPathFor } from "./env.js";
import { describeInstall, pathAdvice } from "./install.js";
import { c, compact, ESC, ago, percent } from "./logger.js";
import { resolveChain } from "./router.js";
import { startServer } from "./server.js";
import { alignChain } from "./state.js";

/* ------------------------------------------------------------------ *
 * Plain-text report, used by `status`, which must stay pipeable      *
 * ------------------------------------------------------------------ */

const say = (...args) => process.stdout.write(`${args.join(" ")}\n`);
const ANSI_SGR = new RegExp(`${ESC}\\[[0-9;]*m`, "g");

/** Column widths must ignore SGR sequences, or coloured cells break alignment. */
export const stripAnsi = (text) => String(text).replace(ANSI_SGR, "");
const pad = (text, width) => `${text}${" ".repeat(Math.max(0, width - stripAnsi(text).length))}`;

function table(headers, rows) {
  if (!rows.length) return;
  const widths = headers.map((header, index) => Math.max(stripAnsi(header).length, ...rows.map((row) => stripAnsi(String(row[index] ?? "")).length)));
  say(`  ${headers.map((header, index) => c.gray(pad(header, widths[index]))).join("  ")}`);
  for (const row of rows) say(`  ${row.map((cell, index) => pad(String(cell ?? ""), widths[index])).join("  ")}`);
}

const yesNo = (value) => (value ? c.green("yes") : c.red("no"));
const shortDate = (value) => new Date(value).toISOString().replace("T", " ").slice(0, 16);

/** API keys are coloured by where they come from, and whether they resolve. */
const KEY_PAINT = { env: c.green, missing: c.red, inline: c.yellow, none: c.gray };
const keyCell = (provider) => {
  const key = describeKey(provider.apiKey);
  return KEY_PAINT[key.state](key.text);
};

export async function showStatus(config) {
  say("");
  say(`  ${c.bold(c.green("llm-failover-proxy"))} ${c.gray("— OpenAI-compatible proxy with provider failover")}`);
  say(
    `  ${c.gray("config:")} ${config.__file}   ${c.gray("listen:")} http://${config.server.host}:${config.server.port}` +
      `   ${c.gray("providers:")} ${config.providers.length}   ${c.gray("models:")} ${config.models.length}`,
  );
  const envFile = envPathFor(config.__file);
  say(`  ${c.gray("keys:")} ${envFile} ${fs.existsSync(envFile) ? c.gray("(found)") : c.yellow("(no .env yet)")}`);

  const install = describeInstall();
  say(
    `  ${c.gray("command:")} ${
      install.command.onPath ? `${install.command.name} ${c.gray(`→ ${install.command.resolved}`)}` : c.yellow(`${install.command.name} is not on PATH — run \`doctor\``)
    }`,
  );

  const service = daemonStatus(config.__file);
  say(
    `  ${c.gray("service:")} ${
      service.running ? `${c.green("running")} ${c.gray(`pid ${service.pid} · ${service.url}`)}` : c.gray("not running in the background")
    }   ${c.gray("at login:")} ${autostartInstalled() ? c.green("yes") : c.gray("no")} ${c.gray(`(${autostartTarget().label})`)}`,
  );

  say("");
  say(c.bold("Providers"));
  if (!config.providers.length) say(c.gray("  (none)"));
  else {
    table(
      ["#", "NAME", "PROTOCOL", "BASE URL", "API KEY", "ENABLED"],
      config.providers.map((provider, index) => [index + 1, c.bold(provider.name), provider.type, provider.baseUrl, keyCell(provider), yesNo(provider.enabled)]),
    );
    const inline = inlineKeys(config);
    if (inline.length) {
      say("");
      say(`  ${c.yellow(`${inline.length} key(s) still stored in the configuration file`)} ` + c.gray("— `llm-failover-proxy migrate` moves them to the .env"));
    }
  }

  say("");
  say(`${c.bold("Model chain")} ${c.gray("(order = failover priority)")}`);
  if (!config.models.length) say(c.gray("  (none)"));
  else {
    table(
      ["PRIO", "ALIAS", "PROVIDER", "UPSTREAM MODEL", "KIND", "ENABLED", "PARAMS"],
      config.models.map((entry, index) => [
        c.bold(String(index + 1)),
        entry.alias || entry.model,
        providerLabel(config, entry.providerId),
        entry.model,
        entry.kind,
        yesNo(entry.enabled),
        Object.keys(entry.params || {}).length ? JSON.stringify(entry.params) : c.gray("-"),
      ]),
    );
  }

  const chain = resolveChain(config, "auto", "chat");
  say("");
  say(`${c.bold("Effective failover order (chat)")} ${c.gray('for model="auto"')}`);
  if (!chain.entries.length) say(c.yellow("  no usable model (provider disabled, or missing base URL?)"));
  else {
    chain.entries.forEach((entry, index) => say(`  ${String(index + 1).padStart(2)}. ${providerLabel(config, entry.providerId)}/${entry.model}`));
  }

  const stats = (await liveStats(config)) ?? statsFromDisk(config);
  say("");
  if (!stats) say(c.gray(`  (no counters yet, nothing has been served from this configuration)`));
  else printStats(stats);
  say("");
}

/* ------------------------------------------------------------------ *
 * Counters, `stats`, and the tail of `status`                         *
 * ------------------------------------------------------------------ */

/** Where a running proxy would answer: a background instance may hold another port. */
function statsUrl(config) {
  const base = daemonStatus(config.__file).url || `http://${config.server.host}:${config.server.port}`;
  return `${base}/stats`;
}

/** Counters of a running proxy, including what is only in memory. */
async function liveStats(config) {
  const proxyKey = resolveSecret(config.server.apiKey);
  try {
    const response = await fetch(statsUrl(config), {
      headers: proxyKey ? { authorization: `Bearer ${proxyKey}` } : {},
      signal: AbortSignal.timeout(1500),
    });
    if (!response.ok) return null;
    const payload = await response.json();
    // The answering proxy numbers the chain from its own configuration; this one
    // has to read in the order of ours, the same as every other screen.
    return { ...payload, chain: alignChain(config.models, payload.chain, (id) => providerLabel(config, id)), source: "server" };
  } catch {
    return null;
  }
}

/**
 * Same shape, read straight from the persisted file: counters outlive the
 * process, so `stats` is still useful when nothing is running.
 */
function statsFromDisk(config) {
  const file = statsPathFor(config.__file);
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
  const saved = raw?.entries && typeof raw.entries === "object" ? raw.entries : {};
  const now = Date.now();
  const num = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0);

  const chain = config.models.map((entry, index) => {
    const state = saved[entry.id] ?? {};
    return {
      priority: index + 1,
      provider: providerLabel(config, entry.providerId),
      model: entry.model,
      requests: num(state.requests),
      successes: num(state.successes),
      failures: num(state.failures),
      cancelled: num(state.cancelled),
      tokens: num(state.tokens),
      lastLatencyMs: state.lastLatencyMs ?? null,
      lastUsedAt: num(state.lastUsedAt) || null,
      coolingDown: num(state.cooldownUntil) > now,
      cooldownMsLeft: Math.max(0, num(state.cooldownUntil) - now),
      lastError: state.lastError ?? null,
    };
  });

  // Same shape the server publishes, so one renderer serves both sources.
  const named = new Map(config.models.map((entry) => [entry.id, entry]));
  const recent = (Array.isArray(raw?.recent) ? raw.recent : [])
    .filter((call) => call && typeof call.id === "string" && num(call.at) > 0)
    .map((call) => {
      const entry = named.get(call.id);
      return {
        id: call.id,
        at: num(call.at),
        provider: entry ? providerLabel(config, entry.providerId) : null,
        model: entry?.model ?? null,
        alias: entry?.alias ?? null,
      };
    });

  const total = (key) => chain.reduce((sum, row) => sum + row[key], 0);
  return {
    source: "file",
    file,
    recent,
    statsSince: Number.isFinite(raw?.since) ? raw.since : null,
    updatedAt: Number.isFinite(raw?.updatedAt) ? raw.updatedAt : null,
    totals: {
      requests: total("requests"),
      successes: total("successes"),
      failures: total("failures"),
      cancelled: total("cancelled"),
      tokens: total("tokens"),
    },
    chain,
  };
}

function printStats(stats) {
  say(
    stats.source === "server"
      ? `${c.bold("Running server")} ${c.gray(`(uptime ${stats.uptimeSec}s)`)}`
      : `${c.bold("Persisted counters")} ${c.gray("(nothing running, read from disk)")}`,
  );
  say(
    c.gray(
      `  kept since ${stats.statsSince ? shortDate(stats.statsSince) : "?"} · ${compact(stats.totals.requests)} request(s), ` +
        `${compact(stats.totals.successes)} ok, ${compact(stats.totals.failures)} failed, ` +
        `${compact(stats.totals.cancelled)} cancelled, ${compact(stats.totals.tokens)} token(s)`,
    ),
  );
  table(
    ["PRIO", "TARGET", "REQ", "OK", "KO", "CX", "USE", "UPTIME", "TOKENS", "LAST USED", "LAST ERROR"],
    // Already in the configuration's order, from whichever source produced it.
    stats.chain.map((row) => [
      row.priority,
      `${row.provider}/${row.model}`,
      compact(row.requests),
      c.green(compact(row.successes)),
      row.failures ? c.red(compact(row.failures)) : "0",
      row.cancelled ? c.yellow(compact(row.cancelled)) : "0",
      // Share of the answers served, then availability: how often it answered
      // when it was allowed to finish. Both ignore dropped races — one served
      // nothing, and losing a race is not being down.
      percent(row.successes, stats.totals.successes),
      percent(row.successes, row.successes + row.failures),
      compact(row.tokens),
      ago(row.lastUsedAt),
      row.lastError ? c.red(`${row.lastError.reason}: ${String(row.lastError.message).slice(0, 60)}`) : c.gray("-"),
    ]),
  );

  printRecent(stats.recent);
}

/** Rows shown of the last answered requests. */
const RECENT_ROWS = 5;

/**
 * The last answered requests. The counters say how much each model has served
 * over the whole history; this says what is happening now, and which model took
 * it — the question the totals cannot answer.
 */
function printRecent(recent, limit = RECENT_ROWS) {
  const calls = (Array.isArray(recent) ? recent : []).slice(0, limit);
  if (!calls.length) return;
  say("");
  say(`  ${c.gray(`last ${calls.length} answered`)}`);
  table(
    ["WHEN", "MODEL"],
    calls.map((call) => [ago(call.at), call.model ? `${call.provider}/${call.model}` : c.gray(`${call.id} (no longer configured)`)]),
  );
}

/**
 * One-shot counters report: prints and returns. The Status screen of the UI
 * polls instead, which is what you want while watching traffic, this is what
 * you want in a script, or in a shell you need back.
 */
export async function showStats(config, { json = false } = {}) {
  const stats = (await liveStats(config)) ?? statsFromDisk(config);

  if (!stats) {
    if (json) {
      process.stdout.write(`${JSON.stringify({ source: "none", totals: null, chain: [] }, null, 2)}\n`);
      return;
    }
    say("");
    say(c.gray("  no counters yet, the proxy has not served anything from this configuration"));
    say(c.gray(`  (looked for a server on ${statsUrl(config)} and for ${statsPathFor(config.__file)})`));
    say("");
    return;
  }

  if (json) {
    process.stdout.write(`${JSON.stringify(stats, null, 2)}\n`);
    return;
  }

  say("");
  printStats(stats);
  say("");
}

/* ------------------------------------------------------------------ *
 * `doctor`: would this install work from a script, or at boot?         *
 * ------------------------------------------------------------------ */

const SCOPE_NOTE = {
  local: "installed as a project dependency: the command only exists inside npm scripts, use `npx llmfp` elsewhere",
  source: "running from a checkout or an `npm link`, not from an installed package",
};

const row = (label, value, extra = "") => say(`  ${c.gray(label.padEnd(8))} ${value}${extra}`);

/** The PATH verdict, and how to fix it. Printed on its own by the installer. */
function reportCommand(install) {
  const { command } = install;
  if (command.onPath) {
    row("command", `${command.name} ${c.gray(`→ ${command.resolved}`)}`);
    if (command.shadowed) {
      say(`           ${c.yellow("this is not the copy that just ran")} ${c.gray(`— npm links into ${command.dir}, which comes later on PATH`)}`);
    }
    return true;
  }

  row("command", c.yellow(`${command.name} is not on your PATH`));
  if (command.dir) {
    say(`           ${c.gray("npm links its commands into")} ${command.dir}`);
    for (const line of pathAdvice(command.dir)) say(`           ${c.gray(line)}`);
  }
  say(`           ${c.gray("meanwhile this always works:")} ${c.cyan(`${install.fallback} status`)}`);
  return false;
}

/**
 * Everything that has to hold for the proxy to be usable without a terminal: a
 * command the shell can find, a login entry whose absolute paths still exist, a
 * config and a `.env` outside the package directory, and a service that answers.
 *
 * Exits non-zero when the command cannot be resolved, so an install script or a
 * CI job can branch on it.
 */
export function showDoctor(config, { json = false, pathOnly = false } = {}) {
  const install = describeInstall();
  const envFile = envPathFor(config.__file);
  const service = daemonStatus(config.__file);
  const login = autostartHealth(config.__file);
  const missingKeys = config.providers.filter((provider) => describeKey(provider.apiKey).state === "missing").map((provider) => provider.name);

  if (json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          ...install,
          configFile: config.__file,
          configExists: configExists(config.__file),
          envFile,
          envFileExists: fs.existsSync(envFile),
          missingKeys,
          service: { running: service.running, pid: service.pid, url: service.url, logFile: service.logFile },
          autostart: { installed: login.installed, healthy: login.healthy, missing: login.missing, kind: login.kind, file: login.file },
        },
        null,
        2,
      )}\n`,
    );
    if (!install.command.onPath) process.exitCode = 1;
    return;
  }

  say("");
  if (pathOnly) {
    if (!reportCommand(install)) process.exitCode = 1;
    say("");
    return;
  }

  say(`  ${c.bold(c.green("llm-failover-proxy"))} ${c.gray(install.version)}`);
  say("");
  const onPath = reportCommand(install);
  row("node", install.node, install.nodeManager ? c.gray(`  (${install.nodeManager})`) : "");
  row("cli", install.cli, SCOPE_NOTE[install.scope] ? `\n           ${c.yellow(SCOPE_NOTE[install.scope])}` : "");
  row("config", config.__file, configExists(config.__file) ? "" : c.yellow("  (not written yet)"));
  row("keys", envFile, fs.existsSync(envFile) ? "" : c.yellow("  (no .env yet)"));
  row(
    "service",
    service.running ? `${c.green("running")} ${c.gray(`pid ${service.pid} · ${service.url}`)}` : c.gray("not running in the background"),
  );
  row(
    "at login",
    login.installed ? `${login.healthy ? c.green("yes") : c.yellow("yes, but broken")} ${c.gray(`(${login.label})`)}` : c.gray("no"),
  );
  if (login.missing.length) {
    say(`           ${c.yellow(`the entry points at a ${login.missing.join(" and ")} that no longer exists`)}`);
    say(`           ${c.gray("run `llm-failover-proxy enable` to write it again with the current paths")}`);
  }

  say("");
  if (!onPath) say(`  ${c.yellow("the proxy runs, but the command needs a PATH entry")} ${c.gray("— the fix is above")}`);
  else if (missingKeys.length) say(`  ${c.yellow(`no API key for ${missingKeys.join(", ")}`)} ${c.gray(`— add them to ${envFile}`)}`);
  else if (!service.running) say(`  ${c.gray("ready, but nothing is serving")} ${c.gray("— `llm-failover-proxy enable` puts it in the background")}`);
  else say(`  ${c.green("ready")} ${c.gray(`— clients point at ${service.url}/v1`)}`);
  say("");

  if (!onPath) process.exitCode = 1;
}

/* ------------------------------------------------------------------ *
 * Interactive UI                                                      *
 * ------------------------------------------------------------------ */

/**
 * No terminal: the menus cannot run, so the command reports instead of doing
 * nothing. What it prints is what a script, a CI job or `llmfp > log` gets, and
 * it has to exit rather than wait for a keypress. A first run has nothing to
 * report yet, so it gets the three steps that need no menu at all.
 */
export async function showHeadless({ configFile } = {}) {
  const file = configFile ?? configPath();
  say("");
  say(`  ${c.gray("no terminal attached, so here is the report instead of the menus")}`);

  if (!configExists(file)) {
    say("");
    say(`  ${c.yellow("nothing configured yet")} ${c.gray("— everything below works without a terminal:")}`);
    say(`  ${c.gray("1.")} ${c.cyan("llm-failover-proxy start")}   ${c.gray(`writes the default chain to ${file}`)}`);
    say(`  ${c.gray("2.")} ${c.gray("add one key per provider to")} ${envPathFor(file)} ${c.gray("(see .env.example)")}`);
    say(`  ${c.gray("3.")} ${c.cyan("llm-failover-proxy enable")}  ${c.gray("runs it in the background, now and at every login")}`);
    say("");
    return;
  }

  await showStatus(loadConfig(file));
  say(`  ${c.gray("keys go in the .env above; `doctor` checks the install, `stats --json` feeds a script")}`);
  say("");
}

/**
 * Opens the terminal UI, then honours what the user picked there, starting
 * the server is done here rather than inside the UI so the terminal is fully
 * released first.
 */
export async function openInterface({ configFile, view } = {}) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    await showHeadless({ configFile });
    return;
  }

  let outcome;
  try {
    const { runTui } = await import("./tui/index.js");
    outcome = await runTui({ configFile, initialView: view });
  } catch (err) {
    if (err?.message?.includes("Cannot read config")) {
      say(c.red(`  ${err.message}`));
      return;
    }
    throw err;
  }

  if (outcome?.action === "start-server") {
    await startServer({ configFile: outcome.configFile ?? configFile });
  }
}

/** Kept for callers that only need the current config on screen. */
export async function reportStatus(configFile) {
  await showStatus(loadConfig(configFile));
}
