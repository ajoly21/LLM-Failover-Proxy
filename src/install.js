/**
 * Is this installation usable from any shell, including the ones nobody types in?
 *
 * The proxy itself never depends on the answer: the background process and the
 * login entries are written with an absolute node path and an absolute script
 * path, so they run with an empty PATH. The *commands* do depend on it, and a
 * global npm bin directory is only reachable when something put it there. With
 * nvm, fnm, volta, or a custom `npm config set prefix`, that something is a line
 * in an interactive shell profile — and `sh -c`, cron, systemd units and CI
 * runners never read those. So the check belongs to the install, out loud, on
 * every platform, with a command that works either way as a fallback.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Both names npm links. `llmfp` is the short one, and what we report on. */
export const BIN_NAMES = ["llmfp", "llm-failover-proxy"];

/** What this is called on the registry, which is also its longer command name. */
export const PACKAGE_NAME = "llm-failover-proxy";

/**
 * The CLI file to run when the command is not on PATH. Resolves next to this
 * module from source, and to the bundle itself once published.
 */
export const CLI_ENTRY = fileURLToPath(new URL("./index.js", import.meta.url));

const isWindows = (platform) => platform === "win32";

/** Read rather than imported: JSON import attributes are not on every supported Node. */
export function packageVersion() {
  try {
    return JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
  } catch {
    return "unknown";
  }
}

/** Windows compares paths case-insensitively and mixes separators. */
export function samePath(a, b, platform = process.platform) {
  if (!a || !b) return false;
  const norm = (value) => path.resolve(value).replace(/[\\/]+$/, "");
  return isWindows(platform) ? norm(a).toLowerCase() === norm(b).toLowerCase() : norm(a) === norm(b);
}

/** `path.relative` already ignores case on Windows, which is what we need here. */
const within = (child, parent) => {
  if (!child || !parent) return false;
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
};

/**
 * PATH lookup without spawning anything. `which` is missing on Windows, `where`
 * is missing in some minimal images, and a subprocess would inherit the very
 * environment we are trying to make a claim about.
 */
export function whichSync(name, { pathValue = process.env.PATH, pathExt = process.env.PATHEXT, platform = process.platform } = {}) {
  const separator = isWindows(platform) ? ";" : ":";
  // npm links `llmfp`, `llmfp.cmd` and `llmfp.ps1` side by side, and only the
  // ones in PATHEXT are executable on Windows: those come first, so what gets
  // reported is what the shell would actually run. The bare name stays as a last
  // resort rather than being ruled out.
  const extensions = isWindows(platform) ? [...String(pathExt || ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean), ""] : [""];

  for (const raw of String(pathValue || "").split(separator)) {
    const dir = raw.replace(/^"|"$/g, "").trim();
    if (!dir) continue;
    for (const extension of extensions) {
      const candidate = path.join(dir, name + extension);
      try {
        // A directory named like the command must not count as a hit.
        if (!fs.statSync(candidate).isFile()) continue;
        if (!isWindows(platform)) fs.accessSync(candidate, fs.constants.X_OK);
      } catch {
        continue;
      }
      // PATHEXT is upper-case while the file on disk is not, and a path printed
      // in the wrong case does not match what `where` reports. Only the file name
      // is corrected: resolving the whole path would rewrite the directory too,
      // and a PATH entry reached by its 8.3 short name has to stay the one the
      // user actually has. On POSIX there is nothing to correct.
      if (!isWindows(platform)) return candidate;
      try {
        const wanted = path.basename(candidate).toLowerCase();
        const real = fs.readdirSync(dir).find((entry) => entry.toLowerCase() === wanted);
        return real ? path.join(dir, real) : candidate;
      } catch {
        return candidate;
      }
    }
  }
  return null;
}

/**
 * Where npm links global commands, most authoritative first.
 * `npm_config_global_prefix` is set inside an npm lifecycle script. Outside one,
 * node's own directory is the prefix's bin directory everywhere except Windows,
 * where global links go to `%APPDATA%\npm` instead.
 */
export function globalBinCandidates({ env = process.env, platform = process.platform, execPath = process.execPath } = {}) {
  const fromPrefix = (prefix) => (isWindows(platform) ? prefix : path.join(prefix, "bin"));
  const dirs = [];
  for (const name of ["npm_config_global_prefix", "npm_config_prefix"]) if (env[name]) dirs.push(fromPrefix(env[name]));
  if (isWindows(platform) && env.APPDATA) dirs.push(path.join(env.APPDATA, "npm"));
  dirs.push(path.dirname(execPath));
  return [...new Set(dirs.map((dir) => path.resolve(dir)))];
}

/** The candidate that actually holds the command, or the most likely one. */
export function globalBinDir(options = {}) {
  const candidates = globalBinCandidates(options);
  for (const dir of candidates) {
    for (const name of BIN_NAMES) if (whichSync(name, { ...options, pathValue: dir })) return dir;
  }
  return candidates[0] ?? null;
}

/** Global node_modules for each bin directory, used to tell the installs apart. */
function globalRoots(options = {}) {
  const platform = options.platform ?? process.platform;
  return globalBinCandidates(options).map((dir) => (isWindows(platform) ? path.join(dir, "node_modules") : path.join(path.dirname(dir), "lib", "node_modules")));
}

/**
 * The project a `node_modules` in this path belongs to, if there is one.
 *
 * A manifest sitting beside the `node_modules` that holds us is what tells an
 * application's dependency apart from a package manager's global store, which
 * has no manifest of its own. Walks outwards, because a nested `node_modules`
 * still belongs to the project above it.
 */
function projectAbove(entry, exists = fs.existsSync) {
  const separator = entry.includes("\\") ? "\\" : "/";
  const parts = entry.split(/[\\/]/);
  for (let at = parts.lastIndexOf("node_modules"); at > 0; at = parts.lastIndexOf("node_modules", at - 1)) {
    const root = parts.slice(0, at).join(separator);
    if (root && exists(`${root}${separator}package.json`)) return root;
  }
  return null;
}

/**
 * How this copy got here, because the advice differs:
 *   global — `npm i -g`, the command should be on PATH
 *   local  — a project dependency, the command only exists inside npm scripts
 *   source — a checkout or `npm link`, whatever the developer wired up
 *
 * The prefixes above are guesses: `npm_config_global_prefix` is only set inside
 * an npm script, so outside one all we have is where node itself lives. That
 * misses every install whose prefix is somewhere else — a user-level prefix set
 * to avoid sudo, pnpm's global store, or nvm once the node on PATH is a
 * different version than the one that installed this. Those are global installs
 * too, and the manifest test is what recognises them.
 */
export function installScope(options = {}) {
  const entry = options.entry ?? CLI_ENTRY;
  if (!entry.split(/[\\/]/).includes("node_modules")) return "source";
  if (globalRoots(options).some((root) => within(entry, root))) return "global";
  return projectAbove(entry, options.exists) ? "local" : "global";
}

/**
 * Version managers keep node under a per-version directory, and every login
 * entry records the absolute path of the node that wrote it. Switching or
 * removing that version leaves the entry pointing at nothing, silently.
 */
export function nodeManager(execPath = process.execPath) {
  const lower = execPath.replace(/\\/g, "/").toLowerCase();
  const markers = [
    ["/.nvm/", "nvm"],
    ["/nvm/", "nvm"],
    ["/.fnm", "fnm"],
    ["/fnm_multishells/", "fnm"],
    ["/.volta/", "volta"],
    ["/.asdf/", "asdf"],
    ["/nodenv/", "nodenv"],
  ];
  for (const [marker, name] of markers) if (lower.includes(marker)) return name;
  return null;
}

/**
 * What the shell would run for `llmfp` right now.
 *   onPath   — something would run
 *   shadowed — something would run, but from another installation than this one
 */
export function commandStatus(options = {}) {
  const platform = options.platform ?? process.platform;
  const dir = globalBinDir(options);
  let name = null;
  let resolved = null;
  for (const candidate of BIN_NAMES) {
    resolved = whichSync(candidate, options);
    if (resolved) {
      name = candidate;
      break;
    }
  }
  return {
    dir,
    name: name ?? BIN_NAMES[0],
    resolved,
    onPath: Boolean(resolved),
    shadowed: Boolean(resolved && dir && !samePath(path.dirname(resolved), dir, platform)),
  };
}

/**
 * A command line that works with no PATH at all, for scripts and for cron.
 * Both paths are quoted unconditionally, and on Windows it carries PowerShell's
 * call operator: a quoted first token is a string literal there, not a command.
 */
export function fallbackCommand(execPath = process.execPath, entry = CLI_ENTRY, platform = process.platform) {
  return `${isWindows(platform) ? "& " : ""}"${execPath}" "${entry}"`;
}

/**
 * How to put `dir` on PATH for good — including for the shells that read no
 * profile at all, since that is the case that bites in scripts and at boot.
 */
export function pathAdvice(dir, { platform = process.platform, env = process.env } = {}) {
  if (isWindows(platform)) {
    return [
      "add it to your account's PATH (PowerShell, once):",
      `  [Environment]::SetEnvironmentVariable('Path', [Environment]::GetEnvironmentVariable('Path','User') + ';${dir}', 'User')`,
      "then open a new terminal: a running shell keeps the PATH it started with.",
    ];
  }
  const shell = path.basename(env.SHELL || "");
  if (shell === "fish") {
    return [`add it to PATH: fish_add_path ${dir}`, "cron jobs and systemd units read no profile at all, give those the absolute path."];
  }
  const profile = shell === "zsh" ? "~/.zprofile" : "~/.profile";
  return [
    `add it to PATH: echo 'export PATH="${dir}:$PATH"' >> ${profile}`,
    `${profile} is read by login shells; cron jobs and systemd units read nothing, give those the absolute path.`,
    "then open a new terminal: a running shell keeps the PATH it started with.",
  ];
}

/** Everything the `doctor` command and the installer need, in one shape. */
export function describeInstall(options = {}) {
  const execPath = options.execPath ?? process.execPath;
  return {
    version: packageVersion(),
    node: execPath,
    nodeManager: nodeManager(execPath),
    cli: options.entry ?? CLI_ENTRY,
    scope: installScope(options),
    command: commandStatus(options),
    fallback: fallbackCommand(execPath, options.entry ?? CLI_ENTRY),
  };
}
