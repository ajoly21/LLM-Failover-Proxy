import { spawn } from "node:child_process";
import fs from "node:fs";
import {
  activeTarget,
  configExists,
  configPath,
  describeKey,
  describeTarget,
  inlineKeys,
  loadConfig,
  providerLabel,
  resolveSecret,
  saveConfig,
  statsPathFor,
  switchTarget,
} from "./config.js";
import { autostartHealth, autostartInstalled, autostartTarget, daemonStatus } from "./daemon.js";
import { envPathFor } from "./env.js";
import { describeInstall, pathAdvice } from "./install.js";
import { checkForUpdate, updateCommand, updateCommandLine } from "./update.js";
import { c, compact, ESC, ago, ms, percent } from "./logger.js";
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
  // The last column is never padded: nothing lines up after it, and a column
  // holding a sentence would otherwise trail spaces to the width of the longest.
  const cell = (value, index) => (index === widths.length - 1 ? String(value ?? "") : pad(String(value ?? ""), widths[index]));
  say(`  ${headers.map((header, index) => c.gray(cell(header, index))).join("  ")}`);
  for (const row of rows) say(`  ${row.map(cell).join("  ")}`);
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
  const { target: list, total: lists } = activeTarget(config);
  say("");
  say(`  ${c.bold(c.green("llm-failover-proxy"))} ${c.gray("— OpenAI-compatible proxy with provider failover")}`);
  say(
    `  ${c.gray("config:")} ${config.__file}   ${c.gray("listen:")} http://${config.server.host}:${config.server.port}` +
      `   ${c.gray("providers:")} ${config.providers.length}   ${c.gray("models:")} ${config.models.length}` +
      // Which of several chains these numbers describe, so a chain that looks
      // wrong reads as "the other list is live" rather than as lost models.
      (lists > 1 ? `   ${c.gray("list:")} ${list.name} ${c.gray(`(${lists} in all)`)}` : ""),
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
      say(`  ${c.yellow(`${inline.length} key(s) still stored in the configuration file`)} ` + c.gray("— retype it in the UI and it is saved to the .env instead"));
    }
  }

  say("");
  say(
    `${c.bold("Model chain")}${lists > 1 ? ` ${c.gray("— list")} ${list.name}` : ""} ${c.gray("(order = failover priority)")}` +
      // Where the other lists are, and how to serve one, since this report shows
      // the live chain only.
      (lists > 1 ? `   ${c.gray("·")} ${c.cyan("llmfp lists")} ${c.gray("for the others")}` : ""),
  );
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
 * Model lists without the UI: `lists`, `describe` and `use`           *
 * ------------------------------------------------------------------ */

/** How lists are typed on a command line, and printed when one is not found. */
const listMenu = (targets) => targets.map((entry, index) => `${index + 1}. ${entry.name}`).join("   ");

/** The lists of a config, whatever shape the object is in. */
const listsOf = (config) => (Array.isArray(config.modelLists) ? config.modelLists : []);

/** A name as it has to be typed back: quoted only when it would not survive a shell. */
const asArgument = (name) => (/^[A-Za-z0-9._-]+$/.test(name) ? name : `"${name}"`);

/**
 * Which list a `use <name|index>` argument means.
 *
 * Three ways to say it, tried in that order: the number the `lists` table prints,
 * the exact name, or enough of the name to be unambiguous — `cheap` for
 * `cheap-and-fast` is the point of a shorthand. Anything matching two lists is
 * refused rather than guessed at: the wrong guess serves the wrong chain.
 *
 * Returns `{ target }` or `{ error }`, never throws: the caller decides whether
 * that becomes a message or a JSON payload.
 */
export function findTarget(targets, selector) {
  const query = String(selector ?? "").trim();
  if (!query) return { error: "which list? give a name or a number" };

  if (/^\d+$/.test(query)) {
    const index = Number(query) - 1;
    const target = targets[index];
    return target ? { target } : { error: `there is no list ${query}, only ${targets.length}` };
  }

  const wanted = query.toLowerCase();
  const exact = targets.find((entry) => entry.name.toLowerCase() === wanted);
  if (exact) return { target: exact };

  const partial = targets.filter((entry) => entry.name.toLowerCase().includes(wanted));
  if (partial.length === 1) return { target: partial[0] };
  if (partial.length > 1) return { error: `"${query}" matches ${partial.map((entry) => entry.name).join(", ")} — say which one` };
  return { error: `no list called "${query}"` };
}

/**
 * The lists in this configuration, and which one the proxy serves. The `←→` of
 * the UI, for a shell: the numbers printed here are what `use` accepts, and the
 * order is the order the arrows cycle through.
 *
 * `WHEN TO USE` is what makes this report answer the question it is opened with —
 * not "what lists are there" but "which one do I want now". A list nobody has
 * described says so, and says which key writes it.
 */
export function showLists(config, { json = false } = {}) {
  const targets = listsOf(config);
  const rows = targets.map((entry, index) => ({
    index: index + 1,
    name: entry.name,
    active: entry.id === config.activeListId,
    description: entry.description || "",
    // The active list mirrors `config.models`, so both read the same numbers.
    models: entry.models.length,
    enabled: entry.models.filter((model) => model.enabled).length,
  }));

  if (json) {
    const live = rows.find((row) => row.active) ?? null;
    process.stdout.write(`${JSON.stringify({ active: live?.name ?? null, activeIndex: live?.index ?? null, total: rows.length, lists: rows }, null, 2)}\n`);
    return;
  }

  say("");
  say(`  ${c.bold("Model lists")} ${c.gray("— the active one is the chain the proxy serves")}`);
  if (!rows.length) say(c.gray("  (none)"));
  else {
    table(
      ["#", "NAME", "MODELS", "ON", "ACTIVE", "WHEN TO USE"],
      rows.map((row) => [
        row.index,
        row.active ? c.bold(row.name) : row.name,
        row.models,
        row.enabled,
        row.active ? c.green("yes") : c.gray("-"),
        row.description ? row.description : c.gray("-"),
      ]),
    );
  }
  say("");
  say(`  ${c.gray("switch with")} ${c.cyan("llmfp use <name|index>")}   ${c.gray("· the chain itself is in")} ${c.cyan("llmfp status")}`);
  if (rows.some((row) => !row.description)) {
    say(`  ${c.gray("a list with no note is one you will have to open to understand — press")} ${c.cyan("w")} ${c.gray("on Models lists to write it")}`);
  }
  say("");
}

/* ------------------------------------------------------------------ *
 * `describe`: what each list is for, for whoever has to choose        *
 * ------------------------------------------------------------------ */

/**
 * Reads or writes what a list is for, by how many words it is given:
 *
 *   describe                        every list, its note, and the command to serve it
 *   describe <name|index>           that list's note, on its own, ready to be piped
 *   describe <name|index> <text>    says when that list should be the one serving
 *   describe <name|index> ""        takes the note back
 *
 * The no-argument form is the one written for an agent rather than for a person:
 * a name means nothing to something that did not build these chains, so the note
 * is what it has to choose by, and the command that acts on the choice is printed
 * under each one. It reads the same on a terminal, so there is one thing to learn.
 */
export function describeList(config, args = [], { json = false } = {}) {
  const words = args.filter((word) => word !== undefined);
  if (!words.length) return listPurposes(config, { json });

  const found = findTarget(listsOf(config), words[0]);
  if (found.error) {
    refuse(found.error, listsOf(config), { json });
    return;
  }
  // Two words in means the rest is the note, even when the rest is empty: that is
  // how a note is taken back, and it has to be told apart from asking to read one.
  if (words.length < 2) return readNote(found.target, { json });
  return writeNote(config, found.target, words.slice(1).join(" "), { json });
}

/** Shared refusal: same message, same exit code, whichever form was used. */
function refuse(error, targets, { json }) {
  if (json) {
    process.stdout.write(`${JSON.stringify({ ok: false, error, lists: targets.map((entry) => entry.name) }, null, 2)}\n`);
  } else {
    say("");
    say(`  ${c.red(error)}`);
    say(`  ${c.gray("lists:")} ${listMenu(targets)}`);
    say("");
  }
  process.exitCode = 1;
}

/** Every list, purpose first. One block each, so nothing has to be lined up to be read. */
function listPurposes(config, { json }) {
  const targets = listsOf(config);
  const rows = targets.map((entry, index) => ({
    index: index + 1,
    name: entry.name,
    description: entry.description || "",
    models: entry.models.length,
    enabled: entry.models.filter((model) => model.enabled).length,
    active: entry.id === config.activeListId,
    // Spelled out rather than left to be assembled: a caller that reads this has
    // one less thing to get wrong, quoting included.
    use: `llmfp use ${asArgument(entry.name)}`,
  }));

  if (json) {
    const live = rows.find((row) => row.active) ?? null;
    process.stdout.write(`${JSON.stringify({ active: live?.name ?? null, total: rows.length, lists: rows }, null, 2)}\n`);
    return;
  }

  say("");
  say(`  ${c.bold("Model lists")} ${c.gray("— what each one is for. Pick by the note, then run the command under it.")}`);
  if (!rows.length) say(c.gray("  (none)"));
  for (const row of rows) {
    say("");
    say(
      `  ${c.bold(row.name)} ${c.gray(`(${row.index}/${rows.length} · ${row.models} model(s), ${row.enabled} enabled)`)}` +
        (row.active ? `   ${c.green("serving now")}` : ""),
    );
    // A list nobody has explained says so, and says what would fix it: the note is
    // the whole point of this report, so its absence is the news.
    if (row.description) say(`    ${row.description}`);
    else say(`    ${c.yellow("no note yet")} ${c.gray(`— ${c.cyan(`llmfp describe ${asArgument(row.name)} "when this list should serve"`)}`)}`);
    if (!row.active) say(`    ${c.cyan(row.use)}`);
  }
  say("");
}

/** One note, and nothing else: `NOTE=$(llmfp describe cheap)` has to work. */
function readNote(target, { json }) {
  if (json) {
    process.stdout.write(`${JSON.stringify({ name: target.name, description: target.description || "" }, null, 2)}\n`);
    return;
  }
  process.stdout.write(`${target.description || ""}\n`);
}

function writeNote(config, target, description, { json }) {
  describeTarget(config, target.id, description);
  saveConfig(config);
  const saved = target.description;

  if (json) {
    process.stdout.write(`${JSON.stringify({ ok: true, name: target.name, description: saved }, null, 2)}\n`);
    return;
  }
  say("");
  if (saved) {
    say(`  ${c.green("saved")} ${c.gray("what")} ${c.bold(target.name)} ${c.gray("is for")}`);
    say(`    ${saved}`);
  } else {
    say(`  ${c.gray("cleared the note on")} ${c.bold(target.name)}`);
  }
  say("");
}

/**
 * Serves another list, from a script or a shell. Exactly what `←→` does in the
 * UI: the chain is swapped in the file, and a proxy already running picks it up
 * through its config watcher, so nothing has to be restarted.
 *
 * Exits non-zero when the argument names no list, so a script can branch on it.
 */
export function useList(config, selector, { json = false } = {}) {
  const targets = listsOf(config);
  const found = findTarget(targets, selector);

  if (found.error) {
    refuse(found.error, targets, { json });
    return;
  }

  // Already live: saving would rewrite the file for nothing, and a watcher would
  // reload for nothing with it.
  const already = found.target.id === config.activeListId;
  if (!already) {
    switchTarget(config, found.target.id);
    saveConfig(config);
  }

  const { index, total } = activeTarget(config);
  const enabled = config.models.filter((entry) => entry.enabled).length;

  if (json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          ok: true,
          changed: !already,
          active: found.target.name,
          description: found.target.description || "",
          index: index + 1,
          total,
          models: config.models.length,
          enabled,
        },
        null,
        2,
      )}\n`,
    );
    return;
  }

  say("");
  say(
    `  ${already ? c.gray("already serving") : c.green("now serving")} ${c.bold(found.target.name)} ` +
      `${c.gray(`(${index + 1}/${total})`)}   ${c.gray(`${config.models.length} model(s), ${enabled} enabled`)}`,
  );
  // What this list is for, echoed back: the one line that says whether the switch
  // was the one meant, which a name matched on a fragment cannot.
  if (found.target.description) say(`  ${c.gray(found.target.description)}`);
  // Said only when there is something to reassure: the switch reached a proxy
  // that is already serving, and no restart is coming.
  const service = already ? null : daemonStatus(config.__file);
  if (service?.running) {
    say(`  ${c.gray(`the background proxy (pid ${service.pid}) reads the file on every request, so this is already live`)}`);
  }
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
    // has to read in the order of ours, the same as every other screen. Anything
    // it reported beyond our chain — another model list, or another config file
    // altogether — is counted and left out, since these are the live list's stats.
    const aligned = alignChain(config.models, payload.chain, (id) => providerLabel(config, id));
    return { ...payload, chain: aligned.slice(0, config.models.length), elsewhere: aligned.length - config.models.length, source: "server" };
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
        ttftMs: call.ttftMs == null ? null : num(call.ttftMs),
        provider: entry ? providerLabel(config, entry.providerId) : null,
        model: entry?.model ?? null,
        alias: entry?.alias ?? null,
      };
    });

  const total = (key) => chain.reduce((sum, row) => sum + row[key], 0);
  // Counters kept for models this list does not have: the other lists' history,
  // which is read from the same file but is not this list's to report.
  const own = new Set(config.models.map((entry) => entry.id));
  const elsewhere = Object.keys(saved).filter((id) => !own.has(id)).length;
  return {
    source: "file",
    file,
    elsewhere,
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
  if (stats.elsewhere > 0) {
    say(c.gray(`  ${stats.elsewhere} more model(s) served, in another list or another config — not counted above`));
  }

  printRecent(stats.recent);
}

/** Rows shown of the last answered requests. */
const RECENT_ROWS = 5;

/**
 * The last answered requests. The counters say how much each model has served
 * over the whole history; this says what is happening now, which model took it,
 * and how long the wait was — the questions the totals cannot answer, since an
 * average hides the one call that took eight seconds.
 */
function printRecent(recent, limit = RECENT_ROWS) {
  const calls = (Array.isArray(recent) ? recent : []).slice(0, limit);
  if (!calls.length) return;
  say("");
  say(`  ${c.gray(`last ${calls.length} answered`)}`);
  table(
    ["WHEN", "MODEL", "TTFT"],
    calls.map((call) => [
      ago(call.at),
      call.model ? `${call.provider}/${call.model}` : c.gray(`${call.id} (no longer configured)`),
      // A non-streamed answer arrives whole: its first token is its whole latency.
      ms(call.ttftMs),
    ]),
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
export async function showDoctor(config, { json = false, pathOnly = false } = {}) {
  const install = describeInstall();
  const envFile = envPathFor(config.__file);
  const service = daemonStatus(config.__file);
  const login = autostartHealth(config.__file);
  const missingKeys = config.providers.filter((provider) => describeKey(provider.apiKey).state === "missing").map((provider) => provider.name);
  // Not for --path: that one runs inside `npm install`, where asking the registry
  // about the version being installed would be both slow and absurd.
  const update = pathOnly ? null : await checkForUpdate({ configFile: config.__file, config });

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
          update,
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
  row(
    "update",
    update?.available
      ? `${c.yellow(`${update.latest} available`)} ${c.gray(`— ${updateCommandLine()}`)}`
      : update?.disabled
        ? c.gray("not checked (turned off)")
        : update?.offline
          ? c.gray("could not reach the registry")
          : c.gray("up to date"),
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
    return;
  }

  if (outcome?.action === "update") await runUpdate(outcome.release);
}

/**
 * Installs the published release, in the terminal the UI just released.
 *
 * Run here rather than from inside the UI on purpose: npm prints its own
 * progress, asks its own questions, and its install hook restarts the background
 * proxy on the new version. None of that works behind a full-screen renderer.
 */
async function runUpdate(release) {
  const { command, args } = updateCommand();
  say("");
  say(`  ${c.gray(`${release?.current ?? "installed"} → ${release?.latest ?? "latest"}`)}   ${c.cyan(`${command} ${args.join(" ")}`)}`);
  say("");

  const status = await new Promise((resolve) => {
    const child = spawn(command, args, { stdio: "inherit", shell: process.platform === "win32" });
    child.on("error", () => resolve(null));
    child.on("close", (code) => resolve(code));
  });

  say("");
  if (status === 0) say(`  ${c.green("updated")} ${c.gray("— the background proxy was restarted on the new version")}`);
  else {
    // A global install needs write access to npm's prefix, which is exactly what
    // fails on a system-wide Node. Say what to run rather than guess at sudo.
    say(`  ${c.red("the update did not go through")} ${c.gray(`(${status === null ? "npm not found" : `exit ${status}`})`)}`);
    say(`  ${c.gray("run it yourself, with the rights your npm prefix needs:")} ${c.cyan(`${command} ${args.join(" ")}`)}`);
    process.exitCode = 1;
  }
  say("");
}

/** Kept for callers that only need the current config on screen. */
export async function reportStatus(configFile) {
  await showStatus(loadConfig(configFile));
}
