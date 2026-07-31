#!/usr/bin/env node
/**
 * Runs before `npm uninstall`: stops the background proxy and removes the login
 * entry, so nothing is left pointing at files that are about to disappear.
 *
 * npm does not guarantee this hook, hence `llm-failover-proxy disable` staying
 * documented as the manual equivalent.
 */
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

try {
  spawnSync(process.execPath, [path.join(packageDir, 'dist', 'index.js'), 'disable'], { stdio: 'inherit' });
} catch {
  /* nothing left to clean up */
}

process.exit(0);
