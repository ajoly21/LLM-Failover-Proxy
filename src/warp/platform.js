/**
 * Which prebuilt binaries this machine needs, and where to fetch them.
 *
 * Two upstream projects do the work: `wgcf` registers a free Cloudflare WARP
 * account and turns it into a WireGuard profile, `wireproxy` runs that profile
 * as a userspace tunnel exposing a local SOCKS5/HTTP proxy. Nothing is shipped
 * inside this package: a published npm tarball is one artefact for every
 * platform, and these are per-platform executables of ~10-20 MB each.
 *
 * The versions are pinned rather than resolved from "latest", which is what
 * makes the checksums below verifiable at all: a floating version would mean
 * trusting whatever the release page serves on the day.
 */

export const WGCF_VERSION = "2.2.32";
export const WIREPROXY_VERSION = "1.1.3";

const WGCF_BASE = `https://github.com/ViRb3/wgcf/releases/download/v${WGCF_VERSION}`;
const WIREPROXY_BASE = `https://github.com/whyvl/wireproxy/releases/download/v${WIREPROXY_VERSION}`;

/**
 * A platform one of the two projects does not build for.
 *
 * Carries the reason rather than a generic failure: "no wgcf build for
 * linux/riscv64" is actionable, "WARP could not start" is not.
 */
export class UnsupportedPlatformError extends Error {
  constructor(message) {
    super(message);
    this.name = "UnsupportedPlatformError";
  }
}

/**
 * Node's own platform names translated to the Go ones both projects release
 * under. Returns the *canonical* arch; each project then maps it to whatever it
 * happens to call that build, because the two do not agree (`mips_softfloat`
 * against `mips`, `armv7` against a single `arm`).
 */
export function detect(platform = process.platform, arch = process.arch) {
  const os = { win32: "windows", linux: "linux", darwin: "darwin", freebsd: "freebsd" }[platform];
  if (!os) throw new UnsupportedPlatformError(`Cloudflare WARP support does not cover ${platform}`);

  const table = { x64: "amd64", ia32: "386", arm64: "arm64", s390x: "s390x", riscv64: "riscv64", mips: "mips", mipsel: "mipsle" };
  let cpu = table[arch];
  // 32-bit ARM is three incompatible ABIs and `process.arch` says only "arm".
  // Node was itself built for one of them and remembers which, which is a better
  // guess than a fixed default on a Raspberry Pi 1 or Zero.
  if (arch === "arm") cpu = `armv${process.config?.variables?.arm_version || "7"}`;
  if (!cpu) throw new UnsupportedPlatformError(`Cloudflare WARP support does not cover the ${arch} architecture`);

  return { os, arch: cpu };
}

/** Windows executables need the extension, and it is part of the asset name. */
const exeSuffix = (os) => (os === "windows" ? ".exe" : "");

function wgcfAsset({ os, arch }) {
  if (os === "windows" || os === "darwin") {
    if (!["386", "amd64", "arm64"].includes(arch)) throw new UnsupportedPlatformError(`no wgcf build for ${os}/${arch}`);
    if (os === "darwin" && arch === "386") throw new UnsupportedPlatformError("no wgcf build for darwin/386");
    return `wgcf_${WGCF_VERSION}_${os}_${arch}${exeSuffix(os)}`;
  }
  if (arch === "riscv64") throw new UnsupportedPlatformError("wgcf publishes no riscv64 build");
  // Its MIPS builds are the soft-float ones, and say so in the file name.
  const named = { mips: "mips_softfloat", mipsle: "mipsle_softfloat" }[arch] ?? arch;
  return `wgcf_${WGCF_VERSION}_${os}_${named}`;
}

function wireproxyAsset({ os, arch }) {
  if (os === "freebsd") throw new UnsupportedPlatformError("wireproxy publishes no FreeBSD build");
  let named = arch;
  // One `arm` build covers every 32-bit ARM ABI, so the armv5/6/7 split above
  // collapses back here.
  if (arch.startsWith("armv")) named = "arm";
  // No windows/arm64 release. The amd64 one runs under the emulation layer that
  // every arm64 Windows ships with, which beats refusing to start.
  if (os === "windows" && !["386", "amd64"].includes(named)) named = "amd64";
  if (os === "darwin" && !["amd64", "arm64"].includes(named)) named = "all"; // universal binary
  return `wireproxy_${os}_${named}.tar.gz`;
}

/**
 * Everything needed to install both tools on this machine: what to download,
 * which checksum list attests it, and what the executable ends up being called.
 *
 * `binary` is the name on disk, deliberately stable across versions and
 * platforms — the rest of the code should never have to know it came from
 * `wgcf_2.2.32_linux_amd64`.
 */
export function downloads(target = detect()) {
  const suffix = exeSuffix(target.os);
  const wgcf = wgcfAsset(target);
  const wireproxy = wireproxyAsset(target);
  return {
    target,
    wgcf: {
      asset: wgcf,
      url: `${WGCF_BASE}/${wgcf}`,
      checksums: `${WGCF_BASE}/checksums.txt`,
      binary: `wgcf${suffix}`,
      archive: false,
    },
    wireproxy: {
      asset: wireproxy,
      url: `${WIREPROXY_BASE}/${wireproxy}`,
      checksums: `${WIREPROXY_BASE}/checksums.txt`,
      binary: `wireproxy${suffix}`,
      archive: true,
    },
  };
}

/** Whether this machine can run the WARP tunnel at all, and why not when it cannot. */
export function supported(platform = process.platform, arch = process.arch) {
  try {
    downloads(detect(platform, arch));
    return { ok: true, reason: null };
  } catch (err) {
    if (err instanceof UnsupportedPlatformError) return { ok: false, reason: err.message };
    throw err;
  }
}
