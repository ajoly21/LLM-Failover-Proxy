import crypto from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { log } from "../logger.js";
import { extractFromTarGz } from "./archive.js";
import { downloads } from "./platform.js";
import { warpPaths } from "./paths.js";

const run = promisify(execFile);

/** Generous: these are 10-20 MB downloads, sometimes over a slow uplink. */
const DOWNLOAD_TIMEOUT_MS = 120000;

/**
 * How the WARP tunnel gets onto this machine.
 *
 * Two executables are downloaded from their upstream releases on first use, into
 * the configuration folder, and never again. Both are verified against the
 * `checksums.txt` published beside them: this code downloads something and then
 * runs it, so "did I get the file the project published" has to be answered
 * before it is made executable, not after.
 */

async function get(url, { timeoutMs = DOWNLOAD_TIMEOUT_MS } = {}) {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(timeoutMs),
    // Straight to the release host: the tunnel is what is being installed here,
    // so it cannot be what carries the download.
    headers: { "user-agent": "llm-failover-proxy" },
    redirect: "follow",
  });
  if (!response.ok) throw new Error(`${url} answered HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

const sha256 = (buffer) => crypto.createHash("sha256").update(buffer).digest("hex");

/**
 * The digest `asset` is published under, from a `sha256sum`-style list.
 *
 * Both projects publish `<hex>  <filename>` lines. A missing entry is a hard
 * failure rather than a skipped check: an unlisted asset is exactly the case
 * where verification matters.
 */
export function digestFor(checksums, asset) {
  for (const line of String(checksums).split(/\r?\n/)) {
    const match = /^([0-9a-f]{64})\s+\*?(\S+)$/i.exec(line.trim());
    if (match && match[2].split("/").pop() === asset) return match[1].toLowerCase();
  }
  return null;
}

async function install(spec, target, { timeoutMs } = {}) {
  const [payload, checksums] = await Promise.all([get(spec.url, { timeoutMs }), get(spec.checksums, { timeoutMs })]);

  const expected = digestFor(checksums, spec.asset);
  if (!expected) throw new Error(`${spec.asset} is not listed in ${spec.checksums}, refusing to run it`);
  const actual = sha256(payload);
  if (actual !== expected) {
    throw new Error(`checksum mismatch for ${spec.asset}: expected ${expected}, got ${actual}`);
  }

  let binary = payload;
  if (spec.archive) {
    // The name inside the archive has no version or platform in it.
    const stem = spec.binary.replace(/\.exe$/i, "");
    binary = extractFromTarGz(payload, (name) => name === stem || name === `${stem}.exe`);
    if (!binary) throw new Error(`${spec.asset} does not contain a ${stem} executable`);
  }

  fs.mkdirSync(path.dirname(target), { recursive: true });
  // Written under a temporary name and renamed: a half-downloaded executable
  // that already has its final name would be run on the next start.
  const tmp = `${target}.${process.pid}.part`;
  fs.writeFileSync(tmp, binary, { mode: 0o755 });
  fs.renameSync(tmp, target);
  return { file: target, bytes: binary.length, sha256: actual };
}

/**
 * Makes sure both executables are present, downloading whichever is missing.
 *
 * @returns {Promise<{installed: string[], paths: ReturnType<typeof warpPaths>}>}
 */
export async function ensureBinaries(configFile, { timeoutMs } = {}) {
  const plan = downloads(); // throws UnsupportedPlatformError on an unbuilt platform
  const paths = warpPaths(configFile, plan);
  const installed = [];

  for (const [name, spec] of [
    ["wgcf", plan.wgcf],
    ["wireproxy", plan.wireproxy],
  ]) {
    const target = paths[name];
    if (fs.existsSync(target)) continue;
    log.info(`warp: downloading ${name} ${spec.asset}`);
    const result = await install(spec, target, { timeoutMs });
    log.debug(`warp: ${name} verified (sha256 ${result.sha256.slice(0, 12)}…, ${Math.round(result.bytes / 1024)} kB)`);
    installed.push(name);
  }

  // A profile generated for one machine's keys is meaningless on another, and a
  // copied config folder is a normal thing to do. Keeping the executables
  // world-unreadable costs nothing and the identity beside them is a secret.
  try {
    fs.chmodSync(paths.dir, 0o700);
  } catch {
    /* no-op on Windows */
  }
  return { installed, paths };
}

/* ------------------------------------------------------------------ *
 * WARP identity                                                       *
 * ------------------------------------------------------------------ */

/**
 * Registers a free WARP account when there is none, then turns it into a
 * WireGuard profile.
 *
 * `--accept-tos` is not a decision made on the user's behalf: enabling this
 * feature is the decision, and Cloudflare's terms are what the WARP consumer
 * service is offered under. The account is a throwaway device registration — it
 * carries no personal data and `warp rotate` replaces it wholesale.
 */
export async function ensureIdentity(configFile, { plan = null, force = false } = {}) {
  const paths = warpPaths(configFile, plan);
  fs.mkdirSync(paths.dir, { recursive: true });

  if (force) {
    for (const file of [paths.account, paths.profile]) fs.rmSync(file, { force: true });
  }

  let registered = false;
  if (!fs.existsSync(paths.account)) {
    log.info("warp: registering a new Cloudflare WARP device");
    await wgcf(paths, ["register", "--accept-tos"]);
    registered = true;
    try {
      fs.chmodSync(paths.account, 0o600); // it holds the account's private key
    } catch {
      /* no-op on Windows */
    }
  }
  if (registered || !fs.existsSync(paths.profile)) {
    await wgcf(paths, ["generate", "--profile", paths.profile]);
  }
  return { registered, paths };
}

async function wgcf(paths, args) {
  if (!paths.wgcf) throw new Error("no wgcf build for this platform");
  try {
    // `--config` on every call: wgcf otherwise reads and writes
    // `wgcf-account.toml` in the current directory.
    await run(paths.wgcf, [...args, "--config", paths.account], { cwd: paths.dir, timeout: 60000, windowsHide: true });
  } catch (err) {
    const detail = [err.stdout, err.stderr].filter(Boolean).join(" ").trim();
    throw new Error(`wgcf ${args[0]} failed: ${detail || err.message}`);
  }
}

/* ------------------------------------------------------------------ *
 * wireproxy configuration                                             *
 * ------------------------------------------------------------------ */

/**
 * The fields of a wgcf profile that the tunnel needs.
 *
 * Only the IPv4 address is carried over. A WARP profile also assigns an IPv6
 * one, and on a host with no IPv6 route the tunnel would offer a path that
 * silently black-holes half the requests.
 */
export function parseProfile(text) {
  const values = new Map();
  for (const line of String(text).split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("[")) continue;
    const at = trimmed.indexOf("=");
    if (at < 0) continue;
    values.set(trimmed.slice(0, at).trim(), trimmed.slice(at + 1).trim());
  }

  const address = (values.get("Address") || "")
    .split(",")
    .map((part) => part.trim())
    .find((part) => part && !part.includes(":"));
  const privateKey = values.get("PrivateKey");
  const publicKey = values.get("PublicKey");
  if (!privateKey || !publicKey || !address) throw new Error("wgcf profile is missing a key or an IPv4 address");
  return { privateKey, publicKey, address };
}

/**
 * Writes the tunnel configuration. Both proxies are exposed: SOCKS5 for anything
 * the user points at it by hand, HTTP for this proxy's own outbound requests,
 * since an HTTP `CONNECT` tunnel is what Node can speak without a dependency.
 */
export function writeTunnelConfig(configFile, warp, { plan = null } = {}) {
  const paths = warpPaths(configFile, plan);
  const profile = parseProfile(fs.readFileSync(paths.profile, "utf8"));
  const contents = [
    "# Generated by llm-failover-proxy. Edits are overwritten on the next start.",
    "[Interface]",
    `PrivateKey = ${profile.privateKey}`,
    `Address = ${profile.address}`,
    "DNS = 1.1.1.1",
    // WARP's own MTU. Larger values produce packets the tunnel has to fragment.
    "MTU = 1280",
    "",
    "[Peer]",
    `PublicKey = ${profile.publicKey}`,
    "AllowedIPs = 0.0.0.0/0",
    `Endpoint = ${warp.endpoint}`,
    "PersistentKeepalive = 25",
    "",
    "[Socks5]",
    `BindAddress = 127.0.0.1:${warp.socksPort}`,
    "",
    "[http]",
    `BindAddress = 127.0.0.1:${warp.httpPort}`,
    "",
  ].join("\n");

  fs.mkdirSync(paths.dir, { recursive: true });
  fs.writeFileSync(paths.conf, contents, { mode: 0o600 });
  return paths.conf;
}
