#!/usr/bin/env node
/**
 * Regenerates `.env.example` from `defaults/catalog.json`, so the two can never
 * drift. A test asserts the file on disk matches this output.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCatalog, renderEnvExample } from '../src/catalog.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const file = path.join(root, '.env.example');

await fs.writeFile(file, renderEnvExample(loadCatalog()));
process.stdout.write(`${path.relative(root, file)} written\n`);
