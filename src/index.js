#!/usr/bin/env node
import fs from 'node:fs';
import { DEFAULT_PORT, configExists, configPath, loadConfig, migrateKeys, resolveSecret, saveConfig } from './config.js';
import { envPathFor, loadEnvFiles } from './env.js';
import { applyCatalog, loadCatalog } from './catalog.js';
import {
  installAutostart,
  logPathFor,
  logTail,
  orphaned,
  removeAutostart,
  removeServiceCopy,
  restartDaemon,
  startDaemon,
  stopDaemon,
} from './daemon.js';
import { startServer } from './server.js';
import { flushStats } from './state.js';
import { openInterface, showStatus } from './cli.js';
import { c, log } from './logger.js';

const HELP = `
  ${c.bold('llm-failover-proxy')} — one OpenAI-compatible endpoint, many providers, automatic failover

  ${c.bold('Usage')}
    llm-failover-proxy [command] [options]
    npx llm-failover-proxy [command] [options]

  ${c.bold('Commands')}
    (none)          open the terminal UI: providers, models, keys, live tests, stats
    setup           run the setup wizard again (default chain, or start from scratch)
    start           run the proxy in this terminal
    start -d        run it in the background
    stop            stop the background proxy
    restart         restart the background proxy
    enable          run in the background now, and at every login
    disable         remove the login entry and stop the background proxy
    status          configuration, failover order, live counters, service state
    logs            show the end of the background log
    migrate         move keys out of the configuration file into the .env
    help, version

  ${c.bold('Options')}
    --config <path>  configuration file (default: $LLM_PROXY_CONFIG, ./llm-proxy.config.json,
                     or the per-user config directory)
    --port <n>       listen port (default: ${DEFAULT_PORT}; a free port is picked if taken)
    --host <addr>    listen address (default: 127.0.0.1)
    --lines <n>      how many log lines ${c.gray('(logs, default 40)')}

  ${c.bold('Keys')}
    API keys live in a ${c.bold('.env')} next to the configuration file, never inside it.
    See .env.example for the variables the default chain expects.

  ${c.bold('Endpoints')}
    POST /v1/chat/completions   streaming and non-streaming
    POST /v1/embeddings
    GET  /v1/models
    GET  /stats · GET /health
`;

function parseArgs(argv) {
  const options = { command: null, configFile: undefined, port: undefined, host: undefined, daemon: false, lines: 40 };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--config' || arg === '-c') options.configFile = argv[++i];
    else if (arg === '--port' || arg === '-p') options.port = Number(argv[++i]);
    else if (arg === '--host') options.host = argv[++i];
    else if (arg === '--lines' || arg === '-n') options.lines = Number(argv[++i]) || 40;
    else if (arg === '--daemon' || arg === '--background' || arg === '-d') options.daemon = true;
    else if (arg === '--help' || arg === '-h') options.command = 'help';
    else if (arg === '--version' || arg === '-v') options.command = 'version';
    else if (!arg.startsWith('-') && !options.command) options.command = arg;
  }
  return options;
}

const say = (...args) => process.stdout.write(`${args.join(' ')}\n`);

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
    log.info(
      `no configuration yet — wrote the default chain (${added.providers.length} provider(s), ` +
        `${added.models.length} model(s)) to ${file}`,
    );
  } catch (err) {
    log.warn(`no configuration at ${file}, and the default catalogue is unusable: ${err.message}`);
    return config;
  }

  const missing = config.providers
    .map((provider) => (typeof provider.apiKey === 'string' && provider.apiKey.startsWith('env:') ? provider.apiKey.slice(4) : null))
    .filter((name) => name && !resolveSecret(`env:${name}`));
  if (missing.length) {
    log.warn(`missing API keys: ${missing.join(', ')}`);
    log.warn(`add them to ${envPathFor(file)} or run \`llm-failover-proxy\` to paste them in`);
  }
  return config;
}

/** Shared reporting for the service commands, so every path says where to look. */
function reportStart(result) {
  if (result.status === 'already-running') {
    say(`  ${c.yellow('already running')} ${c.gray(`(pid ${result.pid})`)} on ${c.cyan(result.url)}`);
    return true;
  }
  if (result.status === 'started') {
    say(`  ${c.green('running in the background')} ${c.gray(`(pid ${result.pid})`)}`);
    say(`  ${c.gray('client base URL')}  ${c.cyan(`${result.url}/v1`)}`);
    say(`  ${c.gray('log            ')}  ${result.logFile}`);
    return true;
  }
  say(`  ${c.red('could not start the background proxy')}`);
  if (result.detail) say(result.detail.replace(/^/gm, '    '));
  say(`  ${c.gray('log:')} ${result.logFile}`);
  process.exitCode = 1;
  return false;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const command = options.command || 'ui';

  if (command !== 'help' && command !== 'version') {
    options.configFile = options.configFile || configPath();
    // Keys first: everything downstream resolves `env:NAME` through this.
    loadEnvFiles({ configFile: options.configFile });
  }

  switch (command) {
    case 'help': {
      process.stdout.write(`${HELP}\n`);
      return;
    }

    case 'version': {
      // Read rather than import: JSON import attributes are not available on every supported Node.
      const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
      process.stdout.write(`${pkg.version}\n`);
      return;
    }

    case 'start':
    case 'serve': {
      ensureConfig(options.configFile);
      if (options.daemon) {
        say('');
        reportStart(await startDaemon({ configFile: options.configFile }));
        say('');
        return;
      }

      const app = await startServer({ configFile: options.configFile, port: options.port, host: options.host });
      const shutdown = () => {
        log.raw('');
        log.info('shutting down…');
        flushStats(); // persist counters before waiting on in-flight requests
        app.server.close(() => process.exit(0));
        setTimeout(() => process.exit(0), 1500).unref();
      };
      // SIGBREAK covers Ctrl+Break on Windows; a hard kill cannot be caught there.
      for (const signal of ['SIGINT', 'SIGTERM', 'SIGBREAK']) process.on(signal, shutdown);
      return;
    }

    // Used by the login entry: start in the background, then exit.
    case 'daemon': {
      // The package may have been uninstalled since the entry was written. The
      // background copy would still run, so it takes itself out instead.
      if (orphaned(options.configFile)) {
        removeAutostart();
        await stopDaemon({ configFile: options.configFile });
        removeServiceCopy(options.configFile);
        log.warn('llm-failover-proxy is no longer installed — removed its start-at-login entry');
        return;
      }
      ensureConfig(options.configFile);
      reportStart(await startDaemon({ configFile: options.configFile }));
      return;
    }

    case 'stop': {
      const result = await stopDaemon({ configFile: options.configFile });
      say('');
      if (result.status === 'stopped') say(`  ${c.green('stopped')} ${c.gray(`(pid ${result.pid})`)}`);
      else if (result.status === 'not-running') say(`  ${c.gray('nothing running in the background')}`);
      else {
        say(`  ${c.red(`could not stop pid ${result.pid}`)}: ${result.error}`);
        process.exitCode = 1;
      }
      say('');
      return;
    }

    case 'restart': {
      ensureConfig(options.configFile);
      say('');
      reportStart(await restartDaemon({ configFile: options.configFile }));
      say('');
      return;
    }

    case 'enable': {
      ensureConfig(options.configFile);
      say('');
      const entry = installAutostart({ configFile: options.configFile });
      if (entry.installed) say(`  ${c.green('starts at login')} ${c.gray(`(${entry.label}: ${entry.file})`)}`);
      else {
        say(`  ${c.red('could not register the login entry')}: ${entry.error}`);
        process.exitCode = 1;
      }
      // Restart rather than start: on an upgrade this is what swaps the running
      // proxy for the version that was just installed.
      reportStart(await restartDaemon({ configFile: options.configFile }));
      say('');
      return;
    }

    case 'disable': {
      say('');
      const entry = removeAutostart();
      say(
        entry.removed
          ? `  ${c.green('login entry removed')} ${c.gray(entry.file)}`
          : `  ${c.gray('no login entry to remove')} ${c.gray(`(${entry.file})`)}`,
      );
      const stopped = await stopDaemon({ configFile: options.configFile });
      say(
        stopped.status === 'stopped'
          ? `  ${c.green('stopped')} ${c.gray(`(pid ${stopped.pid})`)}`
          : `  ${c.gray('nothing running in the background')}`,
      );
      // Only once it is stopped: a running process holds its own script open.
      removeServiceCopy(options.configFile);
      say('');
      return;
    }

    case 'logs': {
      const file = logPathFor(options.configFile);
      const tail = logTail(options.configFile, options.lines);
      say('');
      say(`  ${c.gray(file)}`);
      say('');
      say(tail ? tail : `  ${c.gray('(empty — the proxy has not run in the background yet)')}`);
      say('');
      return;
    }

    case 'status':
    case 'list': {
      await showStatus(loadConfig(options.configFile));
      return;
    }

    case 'migrate':
    case 'migrate-keys': {
      const { moved, envFile } = migrateKeys(loadConfig(options.configFile));
      say('');
      if (!moved.length) say(`  ${c.green('nothing to move')} ${c.gray('— no key is stored in the configuration file')}`);
      else {
        say(`  ${c.green(`moved ${moved.length} key(s)`)} to ${envFile}`);
        for (const entry of moved) say(`    ${c.gray(entry.target)} → ${entry.envVar}`);
        say(`  ${c.gray('the configuration file now only holds env:NAME references')}`);
      }
      say('');
      return;
    }

    case 'setup':
    case 'ui':
    case 'cli':
    case 'menu':
    case 'config': {
      const file = options.configFile;
      if (options.port || options.host) {
        const config = loadConfig(file);
        if (options.port) config.server.port = options.port;
        if (options.host) config.server.host = options.host;
        saveConfig(config, file);
      }
      await openInterface({ configFile: file, view: command === 'setup' ? { name: 'setup' } : undefined });
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
