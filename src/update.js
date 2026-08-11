/**
 * Is a newer version published? Asked when someone is looking, never in the way.
 *
 * Someone who installed months ago has no way of learning that a release fixed
 * the crash they are hitting: nothing in the tool ever mentions it. So the UI
 * asks the registry, in the background, and says so on the menu.
 *
 * Three rules hold everywhere below. The answer is cached next to the
 * configuration — not to ration how often a person may look, but so that a script
 * calling `doctor` in a loop cannot hammer the registry. A failure — offline,
 * blocked, a proxy in the way — is not an error and is never shown: this is a
 * courtesy, not a feature to fail. And nothing here ever blocks a command; the
 * caller decides whether to wait, and for how long.
 */
import fs from "node:fs";
import path from "node:path";
import { PACKAGE_NAME, installScope, packageVersion } from "./install.js";

/**
 * How long an answer stays good enough to reuse.
 *
 * The check only fires when a person opens the UI or runs `doctor`, which happens
 * a handful of times a day at most — so a long cache would mostly mean learning
 * about a release the day after. Short enough to be current whenever someone
 * actually looks, long enough that a loop cannot turn into traffic.
 */
export const CHECK_TTL_MS = 5 * 60 * 1000;

/** Just the tags, a few dozen bytes, rather than a version's whole manifest. */
const DIST_TAGS_URL = `https://registry.npmjs.org/-/package/${PACKAGE_NAME}/dist-tags`;

/** The answer lives beside the configuration, like every other bit of state. */
export const updateCachePath = (configFile) => path.join(path.dirname(path.resolve(configFile)), "update.json");

/**
 * `1.10.0` is newer than `1.9.0`, and `1.2.0` newer than `1.2.0-beta.1`: numbers
 * compare as numbers, and a prerelease loses to the release it leads to.
 */
export function compareVersions(a, b) {
  const parse = (value) => {
    const [core = "", pre = ""] = String(value ?? "").trim().split("-", 2);
    return { parts: core.split(".").map((part) => Number.parseInt(part, 10) || 0), pre };
  };
  const left = parse(a);
  const right = parse(b);
  for (let index = 0; index < 3; index += 1) {
    const difference = (left.parts[index] ?? 0) - (right.parts[index] ?? 0);
    if (difference !== 0) return difference > 0 ? 1 : -1;
  }
  if (left.pre === right.pre) return 0;
  if (!left.pre) return 1; // a release beats its own prereleases
  if (!right.pre) return -1;
  return left.pre > right.pre ? 1 : -1;
}

export const isNewer = (candidate, current) => Boolean(candidate) && compareVersions(candidate, current) > 0;

/** The version npm would install as `@latest`, or null if the registry is unreachable. */
export async function latestVersion({ timeoutMs = 2500, url = DIST_TAGS_URL } = {}) {
  try {
    const response = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) return null;
    const tags = await response.json();
    return typeof tags?.latest === "string" ? tags.latest : null;
  } catch {
    return null; // offline, blocked, slow: none of it is worth a word
  }
}

function readCache(file) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    return { checkedAt: Number(raw?.checkedAt) || 0, latest: typeof raw?.latest === "string" ? raw.latest : null };
  } catch {
    return null;
  }
}

function writeCache(file, data) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
  } catch {
    /* a cache that cannot be written only costs another request tomorrow */
  }
}

/** Off by setting, or by environment for a single run. */
export function checkDisabled(config) {
  return Boolean(process.env.LLM_PROXY_NO_UPDATE_CHECK) || config?.update?.check === false;
}

/**
 * `{ current, latest, available }`, from the cache when it is fresh enough.
 *
 * `offline: true` says the registry could not be reached *and* nothing was
 * cached, which is different from "up to date" and must not be shown as such.
 */
export async function checkForUpdate({
  configFile,
  config,
  current = packageVersion(),
  now = Date.now(),
  ttlMs = CHECK_TTL_MS,
  fetchLatest = latestVersion,
  timeoutMs,
} = {}) {
  // Only a global install can be replaced by a global install: from a checkout
  // or an `npm link`, installing the release would swap the copy being run.
  const installable = installScope() === "global";
  const idle = { current, latest: null, available: false, checked: false, installable };
  if (checkDisabled(config)) return { ...idle, disabled: true };

  const file = configFile ? updateCachePath(configFile) : null;
  const cached = file ? readCache(file) : null;
  if (cached && now - cached.checkedAt < ttlMs) {
    return { current, latest: cached.latest, available: isNewer(cached.latest, current), checked: true, fromCache: true, installable };
  }

  const latest = await fetchLatest({ timeoutMs });
  if (!latest) return { ...idle, latest: cached?.latest ?? null, available: isNewer(cached?.latest, current), offline: true };

  if (file) writeCache(file, { checkedAt: now, latest });
  return { current, latest, available: isNewer(latest, current), checked: true, fromCache: false, installable };
}

/** What to run to get it. `npm`, because that is where this is published. */
export function updateCommand() {
  return { command: "npm", args: ["install", "--global", `${PACKAGE_NAME}@latest`] };
}

export const updateCommandLine = () => {
  const { command, args } = updateCommand();
  return `${command} ${args.join(" ")}`;
};
