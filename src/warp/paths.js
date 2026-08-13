import path from "node:path";
import { downloads } from "./platform.js";

/**
 * Everything WARP owns lives in one folder beside the configuration, the same
 * way `daemon.json`, `daemon.log` and `service/` already do. Nothing is ever
 * written into the package directory: under `npx` that directory is disposable,
 * so a tunnel installed there would be re-downloaded on every run.
 */
export function warpDir(configFile) {
  return path.join(path.dirname(path.resolve(configFile)), "warp");
}

/**
 * @param {string} configFile
 * @param {ReturnType<typeof downloads>} [plan] resolved once by the caller when
 *        it already has it, so the platform is not detected twice
 */
export function warpPaths(configFile, plan = null) {
  const dir = warpDir(configFile);
  const bin = path.join(dir, "bin");
  const names = plan ?? safeDownloads();
  return {
    dir,
    bin,
    // `null` when this platform has no build: the caller reports that, rather
    // than pointing at a file that can never exist.
    wgcf: names ? path.join(bin, names.wgcf.binary) : null,
    wireproxy: names ? path.join(bin, names.wireproxy.binary) : null,
    account: path.join(dir, "wgcf-account.toml"),
    profile: path.join(dir, "wgcf-profile.conf"),
    conf: path.join(dir, "wireproxy.conf"),
    log: path.join(dir, "wireproxy.log"),
    state: path.join(dir, "state.json"),
  };
}

/** The plan for this machine, or null on a platform neither tool builds for. */
function safeDownloads() {
  try {
    return downloads();
  } catch {
    return null;
  }
}
