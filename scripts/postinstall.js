#!/usr/bin/env node
/**
 * Runs after `npm install`. Puts the proxy in the background so it is ready to
 * answer right away, and — for a global install — brings it back at every login.
 *
 * Deliberately conservative: it does nothing at all for `npx`, for CI, or when
 * the repository's own dependencies are being installed. It also never fails the
 * install, whatever happens.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(packageDir, 'dist', 'index.js');

const say = (text) => process.stdout.write(`${text}\n`);

const isGlobal = process.env.npm_config_global === 'true';
const isNpx = process.env.npm_command === 'exec' || packageDir.includes('_npx');
// A source checkout installing its own dependencies. `src/` never ships, so its
// presence is the reliable signal; INIT_CWD alone depends on the package manager.
const isSelf =
  fs.existsSync(path.join(packageDir, 'src')) || path.resolve(process.env.INIT_CWD || '.') === packageDir;
const optedOut = Boolean(process.env.LLM_PROXY_NO_AUTOSTART);
const isCI = Boolean(process.env.CI);

try {
  if (isNpx || isSelf) process.exit(0);

  if (optedOut || isCI) {
    say(`llm-failover-proxy: not starting the background service (${optedOut ? 'LLM_PROXY_NO_AUTOSTART' : 'CI'} is set).`);
    say('  start it yourself with: llm-failover-proxy enable');
    process.exit(0);
  }

  // `enable` also registers the login entry; a local dependency only gets the
  // background process, because its path disappears with node_modules.
  const command = isGlobal ? 'enable' : 'daemon';
  const result = spawnSync(process.execPath, [cli, command], { stdio: 'inherit' });

  if (result.status !== 0) {
    say('llm-failover-proxy: could not start the background service.');
    say('  run `llm-failover-proxy enable` to see why.');
    process.exit(0);
  }

  if (!isGlobal) say('  (login entry skipped for a local install — `llm-failover-proxy enable` adds it)');
  say('  configure it with: llm-failover-proxy   ·   disable it with: llm-failover-proxy disable');
} catch (err) {
  say(`llm-failover-proxy: skipping the background service (${err.message}).`);
}

process.exit(0); // an install must never fail because of this
