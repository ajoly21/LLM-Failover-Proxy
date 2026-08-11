import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { fakeBinDir } from "./helpers.js";

const run = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BUNDLE = path.join(ROOT, "dist", "index.js");

// The bundle is a build artifact: skip rather than fail on a fresh clone.
const options = { skip: existsSync(BUNDLE) ? false : "dist/index.js is missing, run `pnpm run build`" };

async function withConfig(body) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "llm-proxy-bundle-"));
  const file = path.join(dir, "config.json");
  await fs.writeFile(
    file,
    JSON.stringify({
      server: { host: "127.0.0.1", port: 47821 },
      providers: [
        {
          id: "prov_1",
          name: "groq",
          type: "openai",
          baseUrl: "https://api.groq.com/openai/v1",
          apiKey: "sk-secret-1234567890",
          headers: {},
          enabled: true,
        },
      ],
      models: [{ id: "mdl_1", providerId: "prov_1", model: "llama-3.3-70b", alias: "fast", kind: "chat", enabled: true, params: {} }],
    }),
  );
  try {
    await body(file);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

const env = { ...process.env, NO_COLOR: "1" };

test("the bundle declares no runtime dependencies", options, async () => {
  const pkg = JSON.parse(await fs.readFile(path.join(ROOT, "package.json"), "utf8"));
  assert.deepEqual(pkg.dependencies, {}, "users must download the bundle only");
  assert.deepEqual(pkg.files, [
    "dist",
    "defaults", // the default chain is read at runtime, so it must ship
    "scripts/postinstall.js",
    "scripts/preuninstall.js",
    ".env.example",
    "README.md",
    "LICENSE",
  ]);
  assert.equal(pkg.bin["llm-failover-proxy"], "dist/index.js");
  assert.equal(pkg.scripts.postinstall, "node scripts/postinstall.js");

  const bundle = await fs.readFile(BUNDLE, "utf8");
  assert.ok(bundle.startsWith("#!/usr/bin/env node\n"), "the hashbang must stay on line 1");
  // React and Ink require() Node builtins at runtime; without this the UI dies.
  assert.match(bundle, /createRequire/, "the CommonJS interop preamble is present");
  // `defaults/` sits next to both src/ and dist/, so the same relative path works.
  assert.match(bundle, /defaults\/catalog\.json/, "the catalogue is still read from disk");
  assert.ok(existsSync(path.join(ROOT, "defaults", "catalog.json")));
  assert.ok(existsSync(path.join(ROOT, ".env.example")));
});

test("nothing machine-specific can leave this machine", async () => {
  // Two ways out of here, git and npm, and neither may carry the local
  // configuration, the keys, or the counters of whoever built the package.
  const ignored = (await fs.readFile(path.join(ROOT, ".gitignore"), "utf8")).split(/\r?\n/).map((line) => line.trim());
  for (const pattern of [".env", ".env.*", "*.stats.json", "config.json", "llm-proxy.config.json", "daemon.json", "daemon.log", "service/", "dist/", "node_modules/"]) {
    assert.ok(ignored.includes(pattern), `.gitignore must keep ${pattern} out of git`);
  }
  assert.ok(ignored.includes("!.env.example"), "the example file is the one exception");

  const pkg = JSON.parse(await fs.readFile(path.join(ROOT, "package.json"), "utf8"));
  for (const entry of pkg.files) {
    assert.doesNotMatch(entry, /(^|\/)config|stats|daemon|^\.env$/, `published files must not include ${entry}`);
  }
});

test("the bundled text commands work", options, async () => {
  await withConfig(async (file) => {
    const version = await run(process.execPath, [BUNDLE, "--version"], { env });
    assert.match(version.stdout.trim(), /^\d+\.\d+\.\d+$/);

    const help = await run(process.execPath, [BUNDLE, "help"], { env });
    assert.match(help.stdout, /OpenAI-compatible endpoint/);
    assert.match(help.stdout, /POST \/v1\/chat\/completions/);
    assert.match(help.stdout, /enable\s+run in the background/, "the service commands are documented");

    const status = await run(process.execPath, [BUNDLE, "status", "--config", file], { env });
    assert.match(status.stdout, /Model chain/);
    assert.match(status.stdout, /llama-3\.3-70b/);
    assert.doesNotMatch(status.stdout, /sk-secret-1234567890/, "keys stay masked");
  });
});

test("with no terminal, the bundled UI reports instead of opening menus", options, async () => {
  await withConfig(async (file) => {
    // `execFile` gives the child pipes: the same thing a script or a CI job does.
    const { stdout } = await run(process.execPath, [BUNDLE, "--config", file], { env, cwd: path.dirname(file) });
    assert.match(stdout, /no terminal attached/);
    assert.match(stdout, /Effective failover order/, "and what it prints is the report, not a refusal");
  });
});

test("the bundled install check runs from the tarball, and can fail", options, async () => {
  // The command has to be findable for the healthy case, and unfindable for the
  // other: both are supplied here rather than left to the machine.
  const bin = await fakeBinDir();
  await withConfig(async (file) => {
    const { stdout } = await run(process.execPath, [BUNDLE, "doctor", "--config", file], { env: { ...env, PATH: bin }, cwd: path.dirname(file) });
    assert.match(stdout, /command\s+/, "the PATH check is what the installer calls");
    assert.match(stdout, /node\s+/);

    // An empty PATH is the whole point of the check: node is found by absolute path.
    await assert.rejects(
      () => run(process.execPath, [BUNDLE, "doctor", "--path", "--config", file], { env: { ...env, PATH: path.dirname(file) }, cwd: path.dirname(file) }),
      (err) => {
        assert.equal(err.code, 1);
        assert.match(err.stdout, /is not on your PATH/);
        return true;
      },
    );
  });
  await fs.rm(bin, { recursive: true, force: true });
});

test("the bundled UI mounts and renders its home screen", options, async () => {
  await withConfig(async (file) => {
    const smoke = path.join(ROOT, "tests", "bundle-smoke.mjs");
    const { stdout } = await run(process.execPath, [smoke, file, BUNDLE], { env, timeout: 30000 });

    // Guards the whole Ink/React graph inside the bundle: a broken `require`
    // shim or a missing dependency shows up here and nowhere else.
    assert.match(stdout, /llm-failover-proxy/);
    assert.match(stdout, /Models & priority/);
    assert.match(stdout, /Start the server/);
    assert.match(stdout, /providers 1/);
    assert.doesNotMatch(stdout, /sk-secret-1234567890/, "keys stay masked in the UI too");
  });
});
