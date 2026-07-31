#!/usr/bin/env node
/**
 * Bundles the CLI into a single production file.
 *
 * Why bundle: Ink and React drag in ~39 packages and 18 MB of node_modules,
 * most of it TypeScript declarations, source maps, docs and unused utility
 * modules (es-toolkit alone is 13 MB). Users installing through `npx` or
 * `npm i -g` should download none of that — so the published package ships one
 * tree-shaken, minified file and declares no runtime dependencies at all.
 *
 * Ink and React therefore live in devDependencies: they are build inputs, not
 * install-time requirements.
 */
import { build } from 'esbuild';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outfile = path.join(root, 'dist', 'index.js');

/**
 * Ink statically imports `react-devtools-core`, an optional peer it only ever
 * calls when DEV_TOOLS is set. It is not installed, and pulling it in just to
 * bundle it would add megabytes for a code path users never hit — so it
 * resolves to a no-op instead. Marking it `external` would not work: the import
 * is static, so Node would fail to resolve it at load time.
 */
const stubReactDevtools = {
  name: 'stub-react-devtools',
  setup(build) {
    build.onResolve({ filter: /^react-devtools-core$/ }, () => ({ path: 'react-devtools-core', namespace: 'stub' }));
    build.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
      contents: 'const devtools = { connectToDevTools() {} };\nexport default devtools;',
      loader: 'js',
    }));
  },
};

await fs.rm(path.join(root, 'dist'), { recursive: true, force: true });

const result = await build({
  entryPoints: [path.join(root, 'src', 'index.js')],
  outfile,
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  minify: true,
  legalComments: 'none',
  metafile: true,
  // Selects React's production build and strips its development-only paths.
  define: { 'process.env.NODE_ENV': '"production"' },
  // No banner: esbuild already carries over the entry point's hashbang, and a
  // second one on line 2 is a syntax error.
  plugins: [stubReactDevtools],
});

/**
 * React and Ink ship CommonJS builds that `require()` Node builtins at runtime.
 * In an ESM bundle esbuild replaces those with a shim that throws — unless a
 * real `require` already exists in scope, which it checks for by name. So the
 * output gets a `createRequire` preamble, above every helper esbuild emits.
 *
 * The hashbang has to stay on line 1, hence the move rather than a banner.
 */
const PREAMBLE = [
  '#!/usr/bin/env node',
  'import { createRequire as __createRequire } from "node:module";',
  'var require = __createRequire(import.meta.url);',
].join('\n');

const bundled = await fs.readFile(outfile, 'utf8');
await fs.writeFile(outfile, `${PREAMBLE}\n${bundled.replace(/^#!.*\r?\n/, '')}`);

await fs.chmod(outfile, 0o755).catch(() => {});

const { bytes } = result.metafile.outputs[path.relative(root, outfile).replaceAll('\\', '/')];
const inputs = Object.keys(result.metafile.inputs).length;
process.stdout.write(`dist/index.js — ${(bytes / 1024).toFixed(0)} kB from ${inputs} modules, 0 runtime dependencies\n`);
