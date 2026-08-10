import { adapterFor } from "./adapters/index.js";
import { inspectCompletion, inspectEmbedding } from "./adapters/openai.js";
import { getProvider, resolveSecret } from "./config.js";
import { AttemptError, classifyStatus, ClientGoneError, parseRetryAfter, REASONS } from "./errors.js";
import { c, compact, log, ms } from "./logger.js";
import { createSseParser, SSE_DONE } from "./sse.js";
import { cooldownRemaining, isCoolingDown, recordCancelled, recordFailure, recordStart, recordSuccess } from "./state.js";

const norm = (value) =>
  String(value || "")
    .trim()
    .toLowerCase();

/** Abort reason for an attempt that lost the race, not a provider failure. */
class RaceLost extends Error {
  constructor() {
    super("another provider answered first");
    this.name = "RaceLost";
  }
}

/* ------------------------------------------------------------------ *
 * Chain resolution                                                    *
 * ------------------------------------------------------------------ */

function usableEntries(config, kind) {
  return config.models.filter((entry) => {
    if (entry.kind !== kind || !entry.enabled) return false;
    const provider = getProvider(config, entry.providerId);
    return Boolean(provider && provider.enabled && provider.baseUrl);
  });
}

/**
 * Builds the ordered attempt list for a requested `model`.
 * The order of `config.models` IS the priority order.
 */
export function resolveChain(config, requestedModel, kind = "chat") {
  const pool = usableEntries(config, kind);
  const requested = String(requestedModel || "").trim();
  const isAuto = !requested || ["auto", "default", "proxy"].includes(norm(requested));

  if (isAuto) return { entries: pool, matched: "auto", notFound: false };

  const byAlias = pool.filter((entry) => norm(entry.alias) === norm(requested));
  const byModel = pool.filter((entry) => norm(entry.model) === norm(requested));
  const byPath = pool.filter((entry) => {
    const provider = getProvider(config, entry.providerId);
    return norm(`${provider?.name}/${entry.model}`) === norm(requested) || norm(`${provider?.name}:${entry.model}`) === norm(requested);
  });

  const primary = byAlias.length ? byAlias : byModel.length ? byModel : byPath;

  if (!primary.length) {
    if (config.failover.strictModelMatch) return { entries: [], matched: requested, notFound: true };
    return { entries: pool, matched: `${requested} (unknown → default chain)`, notFound: false };
  }
  const rest = config.failover.crossModelFallback ? pool.filter((entry) => !primary.includes(entry)) : [];
  return { entries: [...primary, ...rest], matched: requested, notFound: false };
}

/** Ready entries first; benched ones kept as a last resort. */
function orderByAvailability(entries) {
  const now = Date.now();
  const ready = [];
  const cooling = [];
  for (const entry of entries) (isCoolingDown(entry.id, now) ? cooling : ready).push(entry);
  return [...ready, ...cooling];
}

/**
 * Catalogue exposed to clients: `auto`, then one id per alias, in priority
 * order. The `provider/model` form stays accepted as input (see
 * `resolveChain`) but is not listed: it would duplicate the alias, and produce
 * unreadable ids when the model name already contains a slash
 * (e.g. `openrouter/nvidia/nemotron-3:free`).
 */
export function listModels(config) {
  const seen = new Map(); // normalized key -> exposed entry (case-insensitive dedupe)
  for (const entry of usableEntries(config, "chat").concat(usableEntries(config, "embedding"))) {
    const id = (entry.alias || entry.model || "").trim();
    if (!id || seen.has(norm(id))) continue;
    seen.set(norm(id), {
      id,
      object: "model",
      created: 0,
      owned_by: getProvider(config, entry.providerId)?.name || "llm-proxy",
    });
  }
  return [{ id: "auto", object: "model", created: 0, owned_by: "llm-proxy" }, ...seen.values()];
}

/* ------------------------------------------------------------------ *
 * Shared attempt plumbing                                             *
 * ------------------------------------------------------------------ */

function label(config, entry) {
  return `${getProvider(config, entry.providerId)?.name || "?"}/${entry.model}`;
}

function toAttemptError(err) {
  if (err instanceof AttemptError) return err;
  if (err?.name === "TimeoutError" || err?.name === "AbortError") {
    return new AttemptError(REASONS.TIMEOUT, err.timeoutReason || "deadline exceeded");
  }
  const code = err?.cause?.code || err?.code;
  return new AttemptError(REASONS.NETWORK, code ? `${code}: ${err.message}` : err?.message || "network failure");
}

function tokensOf(usage) {
  return usage?.total_tokens ?? (usage?.prompt_tokens ?? 0) + (usage?.completion_tokens ?? 0);
}

async function upstreamFailure(response) {
  let text = "";
  try {
    text = (await response.text()).slice(0, 800);
  } catch {
    text = "(unreadable body)";
  }
  let message = text;
  try {
    const parsed = JSON.parse(text);
    message = parsed?.error?.message || parsed?.message || text;
  } catch {
    /* plain text */
  }
  return new AttemptError(classifyStatus(response.status), `HTTP ${response.status}, ${message}`, {
    status: response.status,
    retryAfterMs: parseRetryAfter(response.headers.get("retry-after")),
  });
}

/** Re-armable deadline that aborts the upstream request. */
function createWatchdog(controller) {
  let timer = null;
  return {
    arm(delay, why) {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        const err = new Error(why);
        // `fetch` rejects with the abort reason as-is, so tag it: without this a
        // deadline would be reported as a plain network error.
        err.name = "TimeoutError";
        err.timeoutReason = why;
        controller.abort(err);
      }, delay);
    },
    clear() {
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}

async function attemptJson({ config, entry, provider, adapter, body, kind, controller, claim }) {
  const watchdog = createWatchdog(controller);
  watchdog.arm(config.failover.requestTimeoutMs, `no response within ${ms(config.failover.requestTimeoutMs)}`);

  try {
    const url = kind === "embedding" ? adapter.embeddingEndpoint(provider) : adapter.chatEndpoint(provider);
    const payload = kind === "embedding" ? adapter.buildEmbeddingBody(body, entry) : adapter.buildChatBody(body, entry);
    const response = await fetch(url, {
      method: "POST",
      headers: adapter.headers(provider, resolveSecret(provider.apiKey)),
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!response.ok) throw await upstreamFailure(response);

    let json;
    try {
      json = await response.json();
    } catch (err) {
      throw new AttemptError(REASONS.MALFORMED, `invalid JSON response: ${err.message}`);
    }

    const normalized = kind === "embedding" ? adapter.normalizeEmbeddingResponse(json) : adapter.normalizeChatResponse(json);
    const verdict = kind === "embedding" ? inspectEmbedding(normalized) : inspectCompletion(normalized, config.failover);
    if (!verdict.ok) throw new AttemptError(verdict.reason, verdict.message);

    // Only now is this answer worth delivering, so only now do we race for it.
    if (!claim()) return { kind: "cancelled" };
    return { kind: "win", json: normalized, usage: normalized.usage };
  } finally {
    watchdog.clear();
  }
}

/**
 * Streaming attempt. Nothing reaches the client before the first usable chunk:
 * until that point the attempt can still lose the race, or be replaced by the
 * next provider, without the client ever noticing.
 */
async function attemptStream({ config, entry, provider, adapter, body, sink, controller, claim, meta }) {
  const watchdog = createWatchdog(controller);
  watchdog.arm(config.failover.firstTokenTimeoutMs, `no token within ${ms(config.failover.firstTokenTimeoutMs)}`);

  const buffered = [];
  let committed = false;
  let lastUsage = null;
  let done = false;

  const emit = (data) => {
    const text = `data: ${data}\n\n`;
    if (committed) sink.write(text);
    else buffered.push(text);
  };

  /** @returns {boolean} false when another provider got there first */
  const commit = () => {
    if (committed) return true;
    if (!claim()) return false;
    committed = true;
    sink.commit(meta());
    for (const text of buffered) sink.write(text);
    buffered.length = 0;
    return true;
  };

  const handleFrames = (frames) => {
    for (const frame of frames) {
      emit(frame.data);
      if (frame.usage) lastUsage = frame.usage;
      if (!frame.hasContent) continue;
      if (!commit()) throw new RaceLost();
      watchdog.arm(config.failover.idleTimeoutMs, `stream stalled (silent for ${ms(config.failover.idleTimeoutMs)})`);
    }
  };

  try {
    const response = await fetch(adapter.chatEndpoint(provider), {
      method: "POST",
      headers: adapter.headers(provider, resolveSecret(provider.apiKey)),
      body: JSON.stringify({ ...adapter.buildChatBody(body, entry), stream: true }),
      signal: controller.signal,
    });
    if (!response.ok) throw await upstreamFailure(response);
    if (!response.body) throw new AttemptError(REASONS.MALFORMED, "response has no body");

    // Some providers answer with plain JSON despite `stream: true`: convert it.
    if ((response.headers.get("content-type") || "").includes("application/json")) {
      const normalized = adapter.normalizeChatResponse(await response.json());
      const verdict = inspectCompletion(normalized, config.failover);
      if (!verdict.ok) throw new AttemptError(verdict.reason, verdict.message);
      handleFrames(framesFromCompletion(normalized));
      lastUsage = normalized.usage || lastUsage;
      done = true;
    } else {
      const parser = createSseParser();
      const translator = adapter.createStreamTranslator({ entry });
      const reader = response.body.getReader();

      for (;;) {
        const { value, done: streamDone } = await reader.read();
        if (streamDone) break;
        for (const event of parser.push(value)) {
          const out = translator.push(event);
          handleFrames(out.frames);
          if (out.done) done = true;
        }
        if (done) break;
      }
      if (!done) {
        for (const event of parser.flush()) {
          const out = translator.push(event);
          handleFrames(out.frames);
          if (out.done) done = true;
        }
      }
      try {
        await reader.cancel();
      } catch {
        /* already closed */
      }
    }

    if (!committed) {
      throw new AttemptError(REASONS.EMPTY, done ? "stream ended without usable content" : "stream closed early");
    }
    sink.write(SSE_DONE);
    sink.end();
    return { kind: "win", usage: lastUsage };
  } catch (err) {
    if (err?.name === "ClientGoneError") throw err; // client cancelled: not the provider's fault
    if (err?.name === "RaceLost" || controller.signal.reason?.name === "RaceLost") return { kind: "cancelled" };

    if (committed) {
      // The client already holds part of the answer: replaying elsewhere would
      // corrupt it. Close cleanly and report the incident instead.
      const info = toAttemptError(err);
      sink.write(
        `data: ${JSON.stringify({
          error: {
            message: `stream interrupted by ${provider?.name}/${entry.model}: ${info.message}`,
            type: info.reason,
            code: "stream_interrupted",
          },
        })}\n\n`,
      );
      sink.write(SSE_DONE);
      sink.end();
      return { kind: "win", usage: lastUsage, degraded: true, error: info };
    }
    throw err;
  } finally {
    watchdog.clear();
  }
}

/** Splits a full completion into the equivalent streaming frames. */
function framesFromCompletion(json) {
  const choice = json.choices?.[0] || {};
  const message = choice.message || {};
  const base = { id: json.id, object: "chat.completion.chunk", created: json.created, model: json.model };
  const frame = (delta, finish, hasContent, usage) => ({
    data: JSON.stringify({
      ...base,
      choices: [{ index: 0, delta, logprobs: null, finish_reason: finish }],
      ...(usage ? { usage } : {}),
    }),
    hasContent,
    usage: usage || null,
  });

  const frames = [frame({ role: "assistant", content: "" }, null, false)];
  if (message.content) frames.push(frame({ content: message.content }, null, true));
  if (message.tool_calls?.length) {
    frames.push(frame({ tool_calls: message.tool_calls.map((call, index) => ({ index, ...call })) }, null, true));
  }
  frames.push(frame({}, choice.finish_reason ?? "stop", false, json.usage || null));
  return frames;
}

/* ------------------------------------------------------------------ *
 * Total failure, told to the client                                   *
 * ------------------------------------------------------------------ */

/** Human-readable account of why nothing could answer, one line per attempt. */
export function failureMessage(result) {
  const lines = [`⚠️  llm-failover-proxy: no provider could answer this request.`, ""];
  result.attempts.forEach((attempt, index) => {
    lines.push(`  ${index + 1}. ${attempt.provider}/${attempt.model}, ${attempt.reason}: ${attempt.message}`);
  });
  if (!result.attempts.length) lines.push("  (no provider was even eligible, check the chain configuration)");
  lines.push("");
  lines.push(`Run \`llm-failover-proxy status\` or read the proxy logs for the full picture.`);
  return lines.join("\n");
}

/**
 * Turns a total failure into a normal-looking stream.
 *
 * A `502` is correct for a plain request, but a streaming client often shows
 * nothing at all for one: the answer window just stays empty. Streaming the
 * explanation as assistant content puts it in front of the person waiting,
 * while the `error` object rides along in the final chunk so programmatic
 * callers can still detect it (`x-llm-proxy-failed` says so in the headers too).
 */
export function failureFrames(result, requestedModel) {
  const message = failureMessage(result);
  const base = {
    id: `chatcmpl-proxy-${Date.now().toString(36)}`,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: requestedModel || "llm-failover-proxy",
  };
  const chunk = (delta, finish = null, extra = null) => ({
    ...base,
    choices: [{ index: 0, delta, logprobs: null, finish_reason: finish }],
    ...(extra || {}),
  });

  const frames = [chunk({ role: "assistant", content: "" })];
  // Line by line, so a chat UI renders it progressively like any other answer.
  for (const line of message.split("\n")) frames.push(chunk({ content: `${line}\n` }));
  frames.push(
    chunk({}, "stop", {
      error: {
        message: result.message,
        type: result.errorType,
        code: "all_providers_failed",
        proxy: { attempts: result.attempts },
      },
    }),
  );
  return frames;
}

/* ------------------------------------------------------------------ *
 * Hedged execution                                                    *
 * ------------------------------------------------------------------ */

/** Races the given promises against a delay. `null` delay = no timer. */
async function raceWithTimer(promises, delayMs) {
  if (delayMs == null) return { type: "settled", value: await Promise.race(promises) };
  let timer = null;
  const hedge = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ type: "hedge" }), delayMs);
  });
  try {
    return await Promise.race([...promises.map((promise) => promise.then((value) => ({ type: "settled", value }))), hedge]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Walks the chain until one provider delivers something usable.
 *
 * Attempts are **staggered, not serialised**: the highest-priority model is
 * asked first, and if it has not produced a usable answer within
 * `hedgeDelayMs`, the next one is asked too, while the first keeps going.
 * The first usable answer wins, every other in-flight attempt is aborted, and
 * only the winner ever reaches the client. That keeps the configured order
 * meaningful without letting one slow provider dictate the response time.
 *
 * A failure does not wait for the timer: the next candidate starts at once.
 * Set `hedgeDelayMs: 0` for strictly sequential failover.
 *
 * @returns {Promise<{type: 'json'|'stream'|'error'} & Record<string, any>>}
 */
export async function run({ config, body, kind = "chat", sink = null, clientGone, requestId = "-" }) {
  const { entries, matched, notFound } = resolveChain(config, body.model, kind);

  if (notFound) {
    return {
      type: "error",
      status: 404,
      message: `Unknown model "${body.model}". See GET /v1/models.`,
      errorType: "invalid_request_error",
      attempts: [],
    };
  }
  if (!entries.length) {
    return {
      type: "error",
      status: 503,
      message: `No ${kind} model configured or enabled. Run the CLI to add one (\`npx llm-failover-proxy\`).`,
      errorType: "no_backend",
      attempts: [],
    };
  }

  const order = orderByAvailability(entries);
  const limit = config.failover.maxAttempts > 0 ? Math.min(config.failover.maxAttempts, order.length) : order.length;
  const hedgeDelayMs = Math.max(0, Number(config.failover.hedgeDelayMs) || 0);
  const maxInFlight = Math.max(1, Number(config.failover.maxInFlight) || 1);
  const streaming = Boolean(body.stream) && Boolean(sink);

  const attempts = []; // failures, reported when everything fails
  const inFlight = new Map(); // position -> { entry, provider, controller, promise, startedAt }
  let cancelled = 0;
  let launched = 0;
  let claimed = null; // position of the winner
  // Siblings still in flight when the winner claimed: exactly the attempts that
  // get aborted. Counting settled cancellations instead would always read 0,
  // since the winner is served before the losers finish unwinding.
  let dropped = 0;

  const releaseClientWatch = clientGone.subscribe(() => {
    for (const task of inFlight.values()) task.controller.abort(new ClientGoneError());
  });

  /** First attempt to call this owns the client response. */
  const claimFor = (position) => () => {
    if (claimed !== null) return false;
    claimed = position;
    dropped = Math.max(0, inFlight.size - 1);
    for (const [other, task] of inFlight) {
      if (other === position) continue;
      // Counted here, not when the loser unwinds: the client is served before
      // that happens, and /stats must already tell the truth.
      recordCancelled(task.entry.id);
      task.controller.abort(new RaceLost());
    }
    return true;
  };

  /** Starts the next candidate, skipping ones that cannot be tried at all. */
  const launch = () => {
    while (launched < limit) {
      const position = launched;
      launched += 1;
      const entry = order[position];
      const provider = getProvider(config, entry.providerId);
      const adapter = adapterFor(provider);

      if (kind === "embedding" && !adapter.supportsEmbeddings) {
        attempts.push({
          provider: provider?.name,
          model: entry.model,
          reason: REASONS.SKIPPED,
          message: `the ${adapter.id} adapter does not support embeddings`,
        });
        continue;
      }
      if (provider.apiKey && resolveSecret(provider.apiKey) == null) {
        attempts.push({
          provider: provider.name,
          model: entry.model,
          reason: REASONS.AUTH,
          message: `API key could not be resolved (${provider.apiKey})`,
        });
        log.warn(`[${requestId}] skipping ${label(config, entry)}: API key could not be resolved (${provider.apiKey})`);
        continue;
      }

      const cooling = cooldownRemaining(entry.id);
      if (cooling > 0) log.debug(`[${requestId}] ${label(config, entry)} is benched (${ms(cooling)}), tried as a last resort`);

      const controller = new AbortController();
      const startedAt = Date.now();
      recordStart(entry.id);

      const task = { entry, provider, controller, startedAt };
      const meta = () => ({
        provider: provider.name,
        model: entry.model,
        alias: entry.alias,
        attempt: position + 1,
        racing: inFlight.size - 1,
        requestId,
      });

      const settle = (async () => {
        try {
          const shared = { config, entry, provider, adapter, body, controller, claim: claimFor(position) };
          return streaming ? await attemptStream({ ...shared, sink, meta }) : await attemptJson({ ...shared, kind });
        } catch (err) {
          if (err?.name === "ClientGoneError") return { kind: "gone" };
          if (err?.name === "RaceLost" || controller.signal.reason?.name === "RaceLost") return { kind: "cancelled" };
          if (controller.signal.reason?.name === "ClientGoneError") return { kind: "gone" };
          return { kind: "fail", error: toAttemptError(err) };
        }
      })();

      task.promise = settle.then((outcome) => ({ position, outcome }));
      inFlight.set(position, task);
      return true;
    }
    return false;
  };

  const finishTask = (position) => {
    const task = inFlight.get(position);
    inFlight.delete(position);
    return task;
  };

  try {
    if (!launch() && !inFlight.size) {
      return {
        type: "error",
        status: 502,
        message: `No provider could be tried (${attempts.length} skipped) for "${matched}".`,
        errorType: "all_providers_failed",
        attempts,
      };
    }

    while (inFlight.size > 0) {
      const canHedge = hedgeDelayMs > 0 && claimed === null && launched < limit && inFlight.size < maxInFlight;
      const raced = await raceWithTimer(
        [...inFlight.values()].map((task) => task.promise),
        canHedge ? hedgeDelayMs : null,
      );

      if (raced.type === "hedge") {
        const waiting = [...inFlight.values()].map((task) => label(config, task.entry)).join(", ");
        if (launch()) {
          const started = order[launched - 1];
          log.info(`[${requestId}] ${c.cyan("hedge")} → ${label(config, started)} ` + c.gray(`(nothing usable from ${waiting} in ${ms(hedgeDelayMs)})`));
        }
        continue;
      }

      const { position, outcome } = raced.value;
      const task = finishTask(position);
      const latency = Date.now() - task.startedAt;
      const target = label(config, task.entry);
      const place = `${position + 1}/${limit}`;

      if (outcome.kind === "gone") throw new ClientGoneError();

      if (outcome.kind === "cancelled") {
        cancelled += 1;
        log.debug(`[${requestId}] ${c.gray("cancelled")} ${target} after ${ms(latency)}, another provider answered first`);
        continue;
      }

      if (outcome.kind === "fail") {
        const info = outcome.error;
        const pause = recordFailure(task.entry.id, {
          reason: info.reason,
          message: info.message,
          retryAfterMs: info.retryAfterMs,
          cooldown: config.failover.cooldown,
        });
        attempts.push({
          provider: task.provider.name,
          model: task.entry.model,
          reason: info.reason,
          status: info.status,
          message: info.message,
          latencyMs: latency,
        });
        // A failure frees its slot immediately: no need to wait for the timer.
        const replaced = claimed === null ? launch() : false;
        log.warn(
          `[${requestId}] ${c.yellow("failed")} ${target} [${info.reason}] ${info.message}` +
            `${pause ? c.gray(` (benched ${ms(pause)})`) : ""}` +
            c.gray(replaced ? ` → trying ${label(config, order[launched - 1])}` : inFlight.size ? " → waiting on the others" : " → no backup left"),
        );
        continue;
      }

      // Winner.
      if (outcome.degraded) {
        recordFailure(task.entry.id, {
          reason: outcome.error.reason,
          message: outcome.error.message,
          cooldown: config.failover.cooldown,
        });
        log.warn(`[${requestId}] ${c.yellow("degraded stream")} ${target} after ${ms(latency)}: ${outcome.error.message}`);
      } else {
        recordSuccess(task.entry.id, { latencyMs: latency, tokens: tokensOf(outcome.usage) });
        log.info(
          `[${requestId}] ${c.green("ok")} ${target} (${place}${streaming ? ", stream" : ""}) ${ms(latency)}` +
            `${outcome.usage ? ` ${compact(tokensOf(outcome.usage))} tok` : ""}` +
            `${dropped ? c.gray(` · ${dropped} speculative attempt(s) dropped`) : ""}`,
        );
      }

      return streaming
        ? { type: "stream", entry: task.entry, provider: task.provider, attempts, cancelled: dropped, degraded: Boolean(outcome.degraded) }
        : { type: "json", json: outcome.json, entry: task.entry, provider: task.provider, attempts, cancelled: dropped };
    }

    return {
      type: "error",
      status: 502,
      message: `No provider could answer (${attempts.length} attempt(s) for "${matched}").`,
      errorType: "all_providers_failed",
      attempts,
    };
  } finally {
    releaseClientWatch();
    // Never leave a speculative request running once the client is served.
    for (const task of inFlight.values()) task.controller.abort(new RaceLost());
  }
}
