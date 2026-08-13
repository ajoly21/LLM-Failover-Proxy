#!/usr/bin/env node
import { applyCatalog, loadCatalog } from "./catalog.js";
import { openInterface, showDoctor, showStats, showStatus, warpCommand } from "./cli.js";
import { DEFAULT_PORT, configExists, configPath, loadConfig, resolveSecret, saveConfig } from "./config.js";
import { installAutostart, logPathFor, logTail, orphaned, removeAutostart, removeServiceCopy, restartDaemon, startDaemon, stopDaemon } from "./daemon.js";
import { envPathFor, loadEnvFiles } from "./env.js";
import { packageVersion } from "./install.js";
import { c, log } from "./logger.js";
import { startServer } from "./server.js";
import { flushStats } from "./state.js";
import { stopTunnel } from "./warp/index.js";

const HELP = `
  ${c.bold("llm-failover-proxy")}, one OpenAI-compatible endpoint, many providers, automatic failover

  ${c.bold("Usage")}
    llm-failover-proxy [command] [options]
    npx llm-failover-proxy [command] [options]

  ${c.bold("Commands")}
    (none)          open the terminal UI: providers, models, keys, live tests, stats
    setup           run the setup wizard again (default chain, or start from scratch)
    start           run the proxy in this terminal
    start -d        run it in the background
    stop            stop the background proxy
    restart         restart the background proxy
    enable          run in the background now, and at every login
    disable         remove the login entry and stop the background proxy
    status          configuration, failover order, counters, service state
    stats           just the counters table, then back to the shell (--json to pipe it)
    warp            where provider requests go out from ${c.gray("(status by default)")}
                    ${c.gray("`warp on|off` routes through Cloudflare WARP or straight out")}
                    ${c.gray("`warp rotate` forces a new WARP exit IP · `warp up|down` the tunnel")}
    logs            show the end of the background log
    doctor          check this install: PATH, paths in the login entry, keys, service
    help, version

  ${c.bold("Options")}
    --config <path>  configuration file (default: $LLM_PROXY_CONFIG, ./llm-proxy.config.json,
                     or the per-user config directory)
    --port <n>       listen port (default: ${DEFAULT_PORT}; a free port is picked if taken)
    --host <addr>    listen address (default: 127.0.0.1)
    --lines <n>      how many log lines ${c.gray("(logs, default 40)")}
    --json           machine-readable output ${c.gray("(stats, doctor, warp)")}
    --path           only the PATH check ${c.gray("(doctor; what the installer runs)")}

  ${c.bold("Without a terminal")}
    Every command above works in a pipe, a script or a cron job, and none of them
    needs the UI. ${c.bold("doctor")} exits non-zero when the command is not on PATH.

  ${c.bold("Keys")}
    API keys live in a ${c.bold(".env")} next to the configuration file, never inside it.
    See .env.example for the variables the default chain expects.

  ${c.bold("Endpoints")}
    POST /v1/chat/completions   streaming and non-streaming
    POST /v1/embeddings
    GET  /v1/models
    GET  /stats · GET /health
`;

function parseArgs(argv) {
  // `args` holds the words after the command, for the ones that take arguments of
  // their own: `warp <up|down|rotate|…>`.
  const options = { command: null, args: [], configFile: undefined, port: undefined, host: undefined, daemon: false, lines: 40, json: false, pathOnly: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--config" || arg === "-c") options.configFile = argv[++i];
    else if (arg === "--port" || arg === "-p") options.port = Number(argv[++i]);
    else if (arg === "--host") options.host = argv[++i];
    else if (arg === "--lines" || arg === "-n") options.lines = Number(argv[++i]) || 40;
    else if (arg === "--daemon" || arg === "--background" || arg === "-d") options.daemon = true;
    else if (arg === "--json") options.json = true;
    else if (arg === "--path") options.pathOnly = true;
    else if (arg === "--help" || arg === "-h") options.command = "help";
    else if (arg === "--version" || arg === "-v") options.command = "version";
    // A word, not a flag: the command, then whatever the command takes.
    else if (!arg.startsWith("-")) {
      if (!options.command) options.command = arg;
      else options.args.push(arg);
    }
  }
  return options;
}

const say = (...args) => process.stdout.write(`${args.join(" ")}\n`);

/**
 * First run on a machine: write the default catalogue so the proxy has a chain
 * to work with. Never touches an existing file.
 */
function ensureConfig(file) {
  if (configExists(file)) return loadConfig(file);
  const config = loadConfig(file);
  try {
    const added = applyCatalog(config, loadCatalog());
    saveConfig(config, file);
    log.info(`no configuration yet, wrote the default chain (${added.providers.length} provider(s), ` + `${added.models.length} model(s)) to ${file}`);
  } catch (err) {
    log.warn(`no configuration at ${file}, and the default catalogue is unusable: ${err.message}`);
    return config;
  }

  const missing = config.providers
    .map((provider) => (typeof provider.apiKey === "string" && provider.apiKey.startsWith("env:") ? provider.apiKey.slice(4) : null))
    .filter((name) => name && !resolveSecret(`env:${name}`));
  if (missing.length) {
    log.warn(`missing API keys: ${missing.join(", ")}`);
    log.warn(`add them to ${envPathFor(file)} or run \`llm-failover-proxy\` to paste them in`);
  }
  return config;
}

/**
 * Takes the WARP tunnel down with the proxy that was using it.
 *
 * What this tool started, it stops: a tunnel left running after the proxy it
 * served is gone is a background process nobody asked for and nobody thinks to
 * look for. Best effort on purpose — a configuration that no longer parses must
 * not stop `stop` from stopping things.
 */
async function stopWarpTunnel(configFile) {
  try {
    return await stopTunnel(loadConfig(configFile));
  } catch {
    return { status: "not-running" };
  }
}

/** Shared reporting for the service commands, so every path says where to look. */
function reportStart(result) {
  if (result.status === "already-running") {
    say(`  ${c.yellow("already running")} ${c.gray(`(pid ${result.pid})`)} on ${c.cyan(result.url)}`);
    return true;
  }
  if (result.status === "started") {
    say(`  ${c.green("running in the background")} ${c.gray(`(pid ${result.pid})`)}`);
    say(`  ${c.gray("client base URL")}  ${c.cyan(`${result.url}/v1`)}`);
    say(`  ${c.gray("log            ")}  ${result.logFile}`);
    return true;
  }
  say(`  ${c.red("could not start the background proxy")}`);
  if (result.detail) say(result.detail.replace(/^/gm, "    "));
  say(`  ${c.gray("log:")} ${result.logFile}`);
  process.exitCode = 1;
  return false;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const command = options.command || "ui";

  if (command !== "help" && command !== "version") {
    options.configFile = options.configFile || configPath();
    // Keys first: everything downstream resolves `env:NAME` through this.
    loadEnvFiles({ configFile: options.configFile });
  }

  switch (command) {
    case "help": {
      process.stdout.write(`${HELP}\n`);
      return;
    }

    case "version": {
      process.stdout.write(`${packageVersion()}\n`);
      return;
    }

    case "start":
    case "serve": {
      ensureConfig(options.configFile);
      if (options.daemon) {
        say("");
        reportStart(await startDaemon({ configFile: options.configFile }));
        say("");
        return;
      }

      const app = await startServer({ configFile: options.configFile, port: options.port, host: options.host });
      const shutdown = () => {
        log.raw("");
        log.info("shutting down…");
        flushStats(); // persist counters before waiting on in-flight requests
        app.server.close(() => process.exit(0));
        setTimeout(() => process.exit(0), 1500).unref();
      };
      // SIGBREAK covers Ctrl+Break on Windows; a hard kill cannot be caught there.
      for (const signal of ["SIGINT", "SIGTERM", "SIGBREAK"]) process.on(signal, shutdown);
      return;
    }

    // Used by the login entry: start in the background, then exit.
    case "daemon": {
      // The package may have been uninstalled since the entry was written. The
      // background copy would still run, so it takes itself out instead.
      if (orphaned(options.configFile)) {
        removeAutostart();
        await stopDaemon({ configFile: options.configFile });
        removeServiceCopy(options.configFile);
        log.warn("llm-failover-proxy is no longer installed, removed its start-at-login entry");
        return;
      }
      ensureConfig(options.configFile);
      reportStart(await startDaemon({ configFile: options.configFile }));
      return;
    }

    case "stop": {
      const result = await stopDaemon({ configFile: options.configFile });
      const tunnel = await stopWarpTunnel(options.configFile);
      say("");
      if (result.status === "stopped") say(`  ${c.green("stopped")} ${c.gray(`(pid ${result.pid})`)}`);
      else if (result.status === "not-running") say(`  ${c.gray("nothing running in the background")}`);
      else {
        say(`  ${c.red(`could not stop pid ${result.pid}`)}: ${result.error}`);
        process.exitCode = 1;
      }
      if (tunnel.status === "stopped") say(`  ${c.green("warp tunnel stopped")} ${c.gray(`(pid ${tunnel.pid})`)}`);
      say("");
      return;
    }

    case "restart": {
      ensureConfig(options.configFile);
      say("");
      reportStart(await restartDaemon({ configFile: options.configFile }));
      say("");
      return;
    }

    case "enable": {
      ensureConfig(options.configFile);
      say("");
      const entry = installAutostart({ configFile: options.configFile });
      if (entry.installed) {
        say(`  ${c.green("starts at login")} ${c.gray(`(${entry.label}: ${entry.file})`)}`);
        // Writing the file is not the same as the service manager accepting it,
        // and the difference only shows up at the next login, too late to be useful.
        if (!entry.activated) say(`  ${c.yellow("the service manager did not take it")} ${c.gray(`— ${entry.hint}`)}`);
      } else {
        say(`  ${c.red("could not register the login entry")}: ${entry.error}`);
        process.exitCode = 1;
      }
      // Restart rather than start: on an upgrade this is what swaps the running
      // proxy for the version that was just installed.
      reportStart(await restartDaemon({ configFile: options.configFile }));
      say("");
      return;
    }

    case "disable": {
      say("");
      const entry = removeAutostart();
      say(entry.removed ? `  ${c.green("login entry removed")} ${c.gray(entry.file)}` : `  ${c.gray("no login entry to remove")} ${c.gray(`(${entry.file})`)}`);
      const stopped = await stopDaemon({ configFile: options.configFile });
      say(stopped.status === "stopped" ? `  ${c.green("stopped")} ${c.gray(`(pid ${stopped.pid})`)}` : `  ${c.gray("nothing running in the background")}`);
      const tunnel = await stopWarpTunnel(options.configFile);
      if (tunnel.status === "stopped") say(`  ${c.green("warp tunnel stopped")} ${c.gray(`(pid ${tunnel.pid})`)}`);
      // Only once it is stopped: a running process holds its own script open.
      removeServiceCopy(options.configFile);
      say("");
      return;
    }

    case "logs": {
      const file = logPathFor(options.configFile);
      const tail = logTail(options.configFile, options.lines);
      say("");
      say(`  ${c.gray(file)}`);
      say("");
      say(tail ? tail : `  ${c.gray("(empty, the proxy has not run in the background yet)")}`);
      say("");
      return;
    }

    case "status":
    case "list": {
      await showStatus(loadConfig(options.configFile));
      return;
    }

    // One shot, then the shell is yours again, the UI screen is the live one.
    case "stats":
    case "counters": {
      await showStats(loadConfig(options.configFile), { json: options.json });
      return;
    }

    // The outbound path: which address the providers see, and how to change it.
    // Every subcommand is non-interactive, so a cron job can rotate the exit IP.
    case "warp": {
      await warpCommand(loadConfig(options.configFile), options.args, { json: options.json });
      return;
    }


    case "doctor":
    case "check": {
      await showDoctor(loadConfig(options.configFile), { json: options.json, pathOnly: options.pathOnly });
      return;
    }

    case "setup":
    case "ui":
    case "cli":
    case "menu":
    case "config": {
      const file = options.configFile;
      if (options.port || options.host) {
        const config = loadConfig(file);
        if (options.port) config.server.port = options.port;
        if (options.host) config.server.host = options.host;
        saveConfig(config, file);
      }
      await openInterface({ configFile: file, view: command === "setup" ? { name: "setup" } : undefined });
      return;
    }

    default: {
      process.stderr.write(`Unknown command: ${command}\n${HELP}\n`);
      process.exitCode = 1;
    }
  }
}

main().catch((err) => {
  log.error(err?.stack || err?.message || String(err));
  process.exit(1);
});
