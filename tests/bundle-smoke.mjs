/**
 * Boots the *bundled* CLI with a faked terminal and prints one rendered frame.
 *
 * Not a test file on its own (it is spawned by bundle.test.js): mounting Ink
 * needs a process whose stdin/stdout look like a TTY, which cannot be faked
 * inside the test runner's own process.
 *
 *   node tests/bundle-smoke.mjs <config-file> <bundle-file>
 */
const [configFile, bundleFile] = process.argv.slice(2);

process.env.LLM_PROXY_CONFIG = configFile;
process.env.NO_COLOR = '1';

process.stdin.isTTY = true;
process.stdin.setRawMode = () => process.stdin;
process.stdout.isTTY = true;
process.stdout.columns = 110;
process.stdout.rows = 30;

let captured = '';
const realWrite = process.stdout.write.bind(process.stdout);
process.stdout.write = (chunk) => {
  captured += typeof chunk === 'string' ? chunk : chunk.toString();
  return true;
};

// The bundle runs its own main() on import; no command means "open the UI".
process.argv = [process.argv[0], bundleFile];
await import(new URL(`file:///${bundleFile.replaceAll('\\', '/')}`));

setTimeout(() => {
  process.stdout.write = realWrite;
  const escape = String.fromCharCode(27);
  const plain = captured.replaceAll(new RegExp(`${escape}\\[[0-9;?]*[a-zA-Z]`, 'g'), '');
  realWrite(plain);
  process.exit(0);
}, 1200);
