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
import { statsFile as currentStatsFile, enableStatsPersistence, snapshot, stateFor, statsSince } from "./state.js";

const MAX_BODY = 32 * 1024 * 1024;

const SSE_HEADERS = {
  "content-type": "text/event-stream; charset=utf-8",
  "cache-control": "no-cache, no-transform",
  connection: "keep-alive",
  "x-accel-buffering": "no", // stop nginx-style buffering from delaying chunks
};

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

function statsPayload(config) {
  const snap = snapshot();
  const now = Date.now();
  const totals = { requests: 0, successes: 0, failures: 0, cancelled: 0, tokens: 0 };
  return {
    uptimeSec: Math.round(process.uptime()),
    // Counters are persisted, so they usually predate this process.
    statsSince: statsSince(),
    totals,
    providers: config.providers.map((p) => ({ id: p.id, name: p.name, type: p.type, baseUrl: p.baseUrl, enabled: p.enabled })),
    chain: config.models.map((entry, index) => {
      const state = snap[entry.id] || stateFor(entry.id);
      totals.requests += state.requests;
      totals.successes += state.successes;
      totals.failures += state.failures;
      totals.cancelled += state.cancelled;
      totals.tokens += state.tokens;
      return {
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

  const reload = (why) => {
    try {
      config = loadConfig(configFile);
      setLogLevel(config.server.logLevel);
      log.info(c.cyan("config reloaded"), c.gray(`(${why})`), `— ${config.models.length} model(s), ${config.providers.length} provider(s)`);
    } catch (err) {
      log.error(`could not reload config: ${err.message}`);
    }
  };

  const server = http.createServer(async (req, res) => {
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

  // Hot reload when the CLI rewrites the config.
  let debounce = null;
  try {
    const watcher = fs.watch(config.__file, () => {
      clearTimeout(debounce);
      debounce = setTimeout(() => app.reload("file changed"), 250);
    });
    app.server.once("close", () => watcher.close());
  } catch {
    log.debug("config file watching unavailable");
  }

  // Same for the keys: a background service is started long before the user
  // pastes a key, so the `.env` next to the config is watched as well.
  let envDebounce = null;
  const envFile = envPathFor(config.__file);
  try {
    const watcher = fs.watch(path.dirname(envFile), (_event, name) => {
      if (name && path.basename(name) !== path.basename(envFile)) return;
      clearTimeout(envDebounce);
      envDebounce = setTimeout(() => {
        const { keys } = loadEnvFiles({ configFile: config.__file });
        log.info(c.cyan("keys reloaded"), c.gray(`(${envFile})`), `— ${keys.length} variable(s)`);
      }, 250);
    });
    app.server.once("close", () => watcher.close());
  } catch {
    log.debug(".env watching unavailable");
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

  return { ...app, port: actualPort, host: wantedHost, url: base };
}
