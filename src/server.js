import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { getProvider, loadConfig, resolveSecret, statsPathFor } from "./config.js";
import { clearRuntime, writeRuntime } from "./daemon.js";
import { envPathFor, loadEnvFiles } from "./env.js";
import { openAIError } from "./errors.js";
import { c, log, setLogLevel } from "./logger.js";
import { findAvailablePort } from "./net.js";
import { failureFrames, listModels, run } from "./router.js";
import { createGoneSignal } from "./signal.js";
import { statsFile as currentStatsFile, enableStatsPersistence, recentCalls, snapshot, stateFor, statsSince } from "./state.js";

const MAX_BODY = 32 * 1024 * 1024;

const SSE_HEADERS = {
  "content-type": "text/event-stream; charset=utf-8",
  "cache-control": "no-cache, no-transform",
  connection: "keep-alive",
  "x-accel-buffering": "no", // stop nginx-style buffering from delaying chunks
};

/**
 * Path to hand to `fs.watch`, resolved to its real long form.
 *
 * On Windows, libuv compares the path it gets back from the OS with the one it
 * was given, and *asserts* when they differ — which is what an 8.3 short name
 * (`C:\Users\RUNNER~1\…`) or an unusual casing produces. That assertion is an
 * abort, not an exception: the whole process dies, so no try/catch can save it.
 * Resolving first keeps the two spellings identical.
 */
export function watchPath(target) {
  try {
    return fs.realpathSync.native(target);
  } catch {
    return target; // does not exist (yet): let fs.watch report it normally
  }
}

/**
 * "Is this still the same file as last time", for the price of one stat.
 *
 * `fs.watch` is the OS volunteering to tell us, and it does not always volunteer:
 * a network share or a container bind mount may report nothing at all. Comparing
 * the file's own timestamp and size costs no read and no parse, and asks nobody
 * for a favour. `null` when the file is gone, which is a change like any other.
 */
export function fingerprint(file) {
  try {
    const info = fs.statSync(file);
    return `${info.mtimeMs}:${info.size}`;
  } catch {
    return null;
  }
}

/** Compact, locale-independent timestamp: `2026-07-31 09:41`. */
const isoMinutes = (value) => new Date(value).toISOString().replace("T", " ").slice(0, 16);

function corsHeaders(config) {
  if (!config.server.cors) return {};
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "authorization, content-type, x-api-key, anthropic-version, openai-organization",
    "access-control-max-age": "86400",
  };
}

function sendJson(res, config, status, payload, extraHeaders = {}) {
  const data = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(data),
    ...corsHeaders(config),
    ...extraHeaders,
  });
  res.end(data);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error("request body too large"), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function presentedKey(req) {
  const auth = req.headers.authorization || "";
  if (auth.toLowerCase().startsWith("bearer ")) return auth.slice(7).trim();
  if (req.headers["x-api-key"]) return String(req.headers["x-api-key"]).trim();
  return null;
}

function authorized(config, req) {
  // `env:NAME` is honoured here too, so the proxy's own key can live in .env.
  const expected = resolveSecret(config.server.apiKey);
  if (!expected) return true;
  const given = presentedKey(req);
  if (!given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function unauthorized(res, config) {
  sendJson(
    res,
    config,
    401,
    openAIError("Missing or invalid proxy API key.", {
      type: "invalid_request_error",
      code: "invalid_api_key",
    }),
  );
}

/** SSE sink: headers are only sent once a usable chunk exists. */
function createSink(res, config) {
  return {
    committed: false,
    commit(meta) {
      if (this.committed) return;
      this.committed = true;
      res.writeHead(200, {
        ...SSE_HEADERS,
        ...corsHeaders(config),
        "x-llm-proxy-provider": meta.provider,
        "x-llm-proxy-model": meta.model,
        "x-llm-proxy-attempt": String(meta.attempt),
        // Speculative attempts still running when this one won the race.
        "x-llm-proxy-racing": String(Math.max(0, meta.racing ?? 0)),
      });
      if (typeof res.flushHeaders === "function") res.flushHeaders();
    },
    /** Opens the stream for a failure notice: no provider to attribute it to. */
    commitFailure() {
      if (this.committed) return;
      this.committed = true;
      res.writeHead(200, { ...SSE_HEADERS, ...corsHeaders(config), "x-llm-proxy-failed": "true" });
      if (typeof res.flushHeaders === "function") res.flushHeaders();
    },
    write(text) {
      if (!res.writableEnded) res.write(text);
    },
    end() {
      if (!res.writableEnded) res.end();
    },
  };
}

/** The last answered requests, named: ids mean nothing to a reader. */
function recentPayload(config) {
  return recentCalls().map(({ id, at, ttftMs }) => {
    const entry = config.models.find((model) => model.id === id);
    return {
      id,
      at,
      ttftMs: ttftMs ?? null,
      provider: entry ? (getProvider(config, entry.providerId)?.name ?? null) : null,
      model: entry?.model ?? null,
      alias: entry?.alias ?? null,
    };
  });
}

function statsPayload(config) {
  const snap = snapshot();
  const now = Date.now();
  const totals = { requests: 0, successes: 0, failures: 0, cancelled: 0, tokens: 0 };
  return {
    uptimeSec: Math.round(process.uptime()),
    // Counters are persisted, so they usually predate this process.
    statsSince: statsSince(),
    totals,
    recent: recentPayload(config),
    providers: config.providers.map((p) => ({ id: p.id, name: p.name, type: p.type, baseUrl: p.baseUrl, enabled: p.enabled })),
    chain: config.models.map((entry, index) => {
      const state = snap[entry.id] || stateFor(entry.id);
      totals.requests += state.requests;
      totals.successes += state.successes;
      totals.failures += state.failures;
      totals.cancelled += state.cancelled;
      totals.tokens += state.tokens;
      return {
        // The id lets a reader line these counters up with its own configuration
        // rather than trusting this order, which is only ours.
        id: entry.id,
        priority: index + 1,
        alias: entry.alias,
        model: entry.model,
        kind: entry.kind,
        provider: getProvider(config, entry.providerId)?.name ?? null,
        enabled: entry.enabled,
        requests: state.requests,
        successes: state.successes,
        failures: state.failures,
        cancelled: state.cancelled,
        lastLatencyMs: state.lastLatencyMs,
        lastUsedAt: state.lastUsedAt ?? null,
        tokens: state.tokens,
        coolingDown: state.cooldownUntil > now,
        cooldownMsLeft: Math.max(0, state.cooldownUntil - now),
        lastError: state.lastError,
      };
    }),
  };
}

/**
 * Builds the HTTP server without listening, so tests can drive it on an
 * ephemeral port.
 */
export function createServer({ configFile, statsFile } = {}) {
  let config = loadConfig(configFile);
  setLogLevel(config.server.logLevel);

  // Counters and cooldowns are restored from disk; `statsFile: null` explicitly
  // unbinds any previous file and keeps everything in memory.
  enableStatsPersistence(statsFile === null ? null : statsFile || statsPathFor(config.__file), {
    knownIds: new Set(config.models.map((entry) => entry.id)),
  });

  // Both files are also checked when a request arrives, so `stamp` has to be
  // refreshed here too or the watcher's reload would be repeated once more.
  let configStamp = fingerprint(config.__file);
  let envStamp = fingerprint(envPathFor(config.__file));

  const reload = (why) => {
    try {
      config = loadConfig(configFile);
      configStamp = fingerprint(config.__file);
      setLogLevel(config.server.logLevel);
      log.info(c.cyan("config reloaded"), c.gray(`(${why})`), `— ${config.models.length} model(s), ${config.providers.length} provider(s)`);
    } catch (err) {
      log.error(`could not reload config: ${err.message}`);
    }
  };

  const reloadKeys = (why) => {
    const envFile = envPathFor(config.__file);
    envStamp = fingerprint(envFile);
    const { keys } = loadEnvFiles({ configFile: config.__file });
    log.info(c.cyan("keys reloaded"), c.gray(`(${why})`), `— ${keys.length} variable(s)`);
  };

  /**
   * What the watcher cannot promise: that this request is answered with what is
   * on disk. A missed event, or a filesystem that reports none, and the chain in
   * memory stays quietly the old one — while the person who just reordered it has
   * no way to tell. One stat per file per request, and a read only when something
   * actually changed, which for a configuration is close to never.
   */
  const refresh = () => {
    if (fingerprint(config.__file) !== configStamp) reload("file changed");
    if (fingerprint(envPathFor(config.__file)) !== envStamp) reloadKeys("file changed");
  };

  const server = http.createServer(async (req, res) => {
    refresh();
    const requestId = crypto.randomBytes(3).toString("hex");
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    const route = url.pathname.replace(/\/+$/, "") || "/";
    const endpoint = route.startsWith("/v1/") ? route.slice(3) : route;

    if (req.method === "OPTIONS") {
      res.writeHead(204, corsHeaders(config));
      res.end();
      return;
    }

    try {
      if (req.method === "GET" && (endpoint === "/" || endpoint === "/health")) {
        sendJson(res, config, 200, {
          status: "ok",
          service: "llm-failover-proxy",
          endpoints: ["/v1/models", "/v1/chat/completions", "/v1/embeddings", "/stats", "/health"],
          chatModels: config.models.filter((m) => m.kind === "chat" && m.enabled).length,
          providers: config.providers.filter((p) => p.enabled).length,
        });
        return;
      }

      if (req.method === "GET" && endpoint === "/stats") {
        if (!authorized(config, req)) return unauthorized(res, config);
        sendJson(res, config, 200, statsPayload(config));
        return;
      }

      if (req.method === "GET" && endpoint === "/models") {
        if (!authorized(config, req)) return unauthorized(res, config);
        sendJson(res, config, 200, { object: "list", data: listModels(config) });
        return;
      }

      if (req.method === "POST" && (endpoint === "/chat/completions" || endpoint === "/embeddings")) {
        if (!authorized(config, req)) return unauthorized(res, config);
        const kind = endpoint === "/embeddings" ? "embedding" : "chat";

        let body;
        try {
          const raw = await readBody(req);
          body = raw.length ? JSON.parse(raw.toString("utf8")) : {};
        } catch (err) {
          sendJson(
            res,
            config,
            err.status || 400,
            openAIError(`Invalid request body: ${err.message}`, {
              type: "invalid_request_error",
            }),
          );
          return;
        }
        if (kind === "chat" && !Array.isArray(body.messages)) {
          sendJson(
            res,
            config,
            400,
            openAIError("The `messages` field is required.", {
              type: "invalid_request_error",
              param: "messages",
            }),
          );
          return;
        }

        const clientGone = createGoneSignal();
        res.on("close", () => {
          if (!res.writableFinished) clientGone.trigger();
        });

        const wantsStream = kind === "chat" && Boolean(body.stream);
        const sink = wantsStream ? createSink(res, config) : null;
        const startedAt = Date.now();
        log.info(`[${requestId}] ${c.bold(kind === "embedding" ? "embeddings" : "chat")} model=${c.cyan(body.model || "auto")}` + `${wantsStream ? c.gray(" stream") : ""}`);

        let result;
        try {
          result = await run({ config, body, kind, sink, clientGone, requestId });
        } catch (err) {
          if (err?.name === "ClientGoneError") {
            log.warn(`[${requestId}] client disconnected after ${Date.now() - startedAt}ms`);
            if (!res.writableEnded) res.end();
            return;
          }
          throw err;
        }

        if (result.type === "stream") return; // already written through the sink
        if (result.type === "json") {
          sendJson(res, config, 200, result.json, {
            "x-llm-proxy-provider": result.provider.name,
            "x-llm-proxy-model": result.entry.model,
            "x-llm-proxy-fallbacks": String(result.attempts.length),
            "x-llm-proxy-cancelled": String(result.cancelled ?? 0),
          });
          return;
        }

        // Every provider failed.
        const payload = openAIError(result.message, {
          type: result.errorType,
          code: "all_providers_failed",
          extra: { requestId, attempts: result.attempts },
        });
        log.error(`[${requestId}] ${c.red("all providers failed")} after ${result.attempts.length} attempt(s)`);

        if (sink?.committed) {
          sink.write(`data: ${JSON.stringify(payload)}\n\n`);
          sink.write("data: [DONE]\n\n");
          sink.end();
        } else if (sink && config.failover.streamErrorAsMessage) {
          // Tell the person waiting, in the stream they are already reading.
          sink.commitFailure();
          for (const frame of failureFrames(result, body.model)) sink.write(`data: ${JSON.stringify(frame)}\n\n`);
          sink.write("data: [DONE]\n\n");
          sink.end();
        } else {
          sendJson(res, config, result.status, payload);
        }
        return;
      }

      sendJson(
        res,
        config,
        404,
        openAIError(`Unknown route: ${req.method} ${route}`, {
          type: "invalid_request_error",
          code: "unknown_route",
        }),
      );
    } catch (err) {
      log.error(`[${requestId}] internal error: ${err.stack || err.message}`);
      if (!res.headersSent) sendJson(res, config, 500, openAIError(`Internal proxy error: ${err.message}`));
      else if (!res.writableEnded) res.end();
    }
  });

  server.keepAliveTimeout = 65000;
  server.headersTimeout = 70000;
  server.requestTimeout = 0; // deadlines are handled by the failover engine

  return {
    server,
    get config() {
      return config;
    },
    reload,
    reloadKeys,
  };
}

/** Starts the proxy, picking a free port and printing the effective chain. */
export async function startServer({ configFile, statsFile, port, host } = {}) {
  const app = createServer({ configFile, statsFile });
  const config = app.config;
  const wantedHost = host || config.server.host || "127.0.0.1";
  const wantedPort = Number(port || config.server.port || 0);
  const chosenPort = await findAvailablePort(wantedPort, wantedHost);

  await new Promise((resolve, reject) => {
    const onError = (err) => reject(err);
    app.server.once("error", onError);
    app.server.listen(chosenPort, wantedHost, () => {
      app.server.removeListener("error", onError);
      app.server.on("error", (err) => log.error(`server error: ${err.message}`));
      resolve();
    });
  });

  const actualPort = app.server.address().port;
  const base = `http://${wantedHost}:${actualPort}`;
  if (wantedPort && actualPort !== wantedPort) log.warn(`port ${wantedPort} unavailable → using ${actualPort}`);

  log.raw("");
  log.raw(`  ${c.bold(c.green("llm-failover-proxy"))} listening on ${c.bold(c.cyan(base))}`);
  log.raw(`  ${c.gray("client base URL")}  ${base}/v1`);
  log.raw(`  ${c.gray("proxy API key  ")}  ${resolveSecret(config.server.apiKey) ? "required" : c.yellow("not required (open on localhost)")}`);
  log.raw(`  ${c.gray("config         ")}  ${config.__file}`);
  const envFiles = loadEnvFiles({ configFile: config.__file }).files;
  if (envFiles.length) log.raw(`  ${c.gray("keys           ")}  ${envFiles.join(", ")}`);
  const statsPath = currentStatsFile();
  if (statsPath) {
    log.raw(`  ${c.gray("stats          ")}  ${statsPath} ${c.gray(`(since ${isoMinutes(statsSince())})`)}`);
  }
  log.raw("");

  const chain = config.models.filter((entry) => entry.enabled);
  if (!chain.length) {
    log.raw(`  ${c.yellow("no model enabled")}, add a provider then a model with ${c.bold("npx llm-failover-proxy")}`);
  } else {
    log.raw(`  ${c.gray("priority order:")}`);
    chain.forEach((entry, index) => {
      const provider = getProvider(config, entry.providerId);
      log.raw(
        `   ${String(index + 1).padStart(2)}. ${c.bold(entry.alias || entry.model)} ` +
          c.gray(`→ ${provider?.name}/${entry.model}${entry.kind === "embedding" ? " [embedding]" : ""}`),
      );
    });
  }
  log.raw("");

  // Every request already checks both files, so nothing here is what makes a
  // change take effect — this only makes it take effect *now* rather than on the
  // next request, which is what an idle proxy and a live log need.
  //
  // The *directory* is watched, never the two files. `saveConfig` writes a
  // temporary file and renames it over the target, and on Linux a watch placed on
  // a file follows the inode: the rename reports once, then the watch is left on
  // the replaced inode and every later save is lost in silence.
  const envFile = envPathFor(config.__file);
  const configName = path.basename(config.__file);
  const envName = path.basename(envFile);
  /** Collapses the burst a single save produces into one reload. */
  const debounced = (run) => {
    let timer = null;
    return () => {
      clearTimeout(timer);
      timer = setTimeout(run, 250);
    };
  };
  const reloadConfig = debounced(() => app.reload("file changed"));
  const reloadKeys = debounced(() => app.reloadKeys(envFile));
  try {
    const watcher = fs.watch(watchPath(path.dirname(config.__file)), (_event, name) => {
      // The temporary file a save goes through, the stats and the log all live
      // here too; only these two are worth acting on. A platform that reports no
      // name at all leaves us guessing, so both run.
      const changed = name ? path.basename(name) : null;
      if (!changed || changed === configName) reloadConfig();
      if (!changed || changed === envName) reloadKeys();
    });
    app.server.once("close", () => watcher.close());
  } catch {
    log.debug("config watching unavailable");
  }

  // Lets `status`, `stop` and the login entry find this instance and its port.
  writeRuntime(config.__file, {
    pid: process.pid,
    host: wantedHost,
    port: actualPort,
    url: base,
    startedAt: new Date().toISOString(),
    daemon: process.env.LLM_PROXY_DAEMON === "1",
  });
  const dropRuntime = () => clearRuntime(config.__file);
  app.server.once("close", dropRuntime);
  process.once("exit", dropRuntime);

  // Spreading `app` would copy the value of its `config` getter once and freeze
  // it, so a caller reading `app.config` after a hot reload would get the old
  // chain. Forward the getter instead.
  return {
    server: app.server,
    reload: app.reload,
    get config() {
      return app.config;
    },
    port: actualPort,
    host: wantedHost,
    url: base,
  };
}
