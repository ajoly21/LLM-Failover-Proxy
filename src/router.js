import { adapterFor } from "./adapters/index.js";
import { inspectCompletion, inspectEmbedding } from "./adapters/openai.js";
import { DEFAULT_TARGET_NAME, getProvider, resolveSecret } from "./config.js";
import { AttemptError, classifyStatus, ClientGoneError, parseRetryAfter, REASONS } from "./errors.js";
import { c, compact, log, ms } from "./logger.js";
import { createSseParser, SSE_DONE } from "./sse.js";
import { cooldownRemaining, isCoolingDown, markRateLimited, recordCancelled, recordFailure, recordStart, recordSuccess } from "./state.js";
import { holdTunnel, noteTunnelRateLimited, planEgress, worthEscalating } from "./warp/index.js";

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

/** Entries of a chain that can actually be tried for `kind`, in its own order. */
function usableFrom(config, models, kind) {
  return (Array.isArray(models) ? models : []).filter((entry) => {
    if (entry.kind !== kind || !entry.enabled) return false;
    const provider = getProvider(config, entry.providerId);
    return Boolean(provider && provider.enabled && provider.baseUrl);
  });
}

/** The same, for the chain being served: `config.models`, the live one. */
function usableEntries(config, kind) {
  return usableFrom(config, config.models, kind);
}

/** What `auto` on its own means, and the other words clients send for it. */
const AUTO_WORDS = ["auto", "default", "proxy"];

/**
 * The id a model list is served under, and the one `GET /v1/models` shows,
 * with the pattern that reads it back — clients rewrite ids more than they
 * admit, so every separator they are likely to leave behind is accepted.
 */
const AUTO_ID = /^auto(?:\s*[-–:/|]\s*|\s+)(.+)$/;
export const autoModelId = (name) => `auto - ${name}`;

/** A name as a client is likely to hand it back: `Cheap and Fast` → `cheapandfast`. */
const slug = (value) => norm(value).replace(/[^a-z0-9]+/g, "");

/**
 * Every chain this proxy can be asked for: the one being served first, then the
 * lists parked beside it.
 *
 * The live chain is read from `config.models` and never from its own entry in
 * `modelLists`: that entry is a mirror refreshed on load and save (see
 * `syncTargets`), and `models` is what the rest of the proxy serves. A config
 * assembled by hand — a test, or a file older than model lists — holds no lists
 * at all, and its chain is still one chain, under the name a migration gives it.
 */
export function servedLists(config) {
  const lists = Array.isArray(config.modelLists) ? config.modelLists : [];
  if (!lists.length) {
    return [{ listId: config.activeListId ?? null, name: DEFAULT_TARGET_NAME, description: "", active: true, models: config.models }];
  }
  const activeIndex = Math.max(0, lists.findIndex((list) => list.id === config.activeListId));
  const ordered = [lists[activeIndex], ...lists.filter((_, index) => index !== activeIndex)];
  return ordered.map((list) => ({
    listId: list.id,
    name: list.name,
    description: list.description || "",
    active: list.id === config.activeListId,
    models: list.id === config.activeListId ? config.models : list.models,
  }));
}

/**
 * One chain, named and counted: the id it answers to, and how many of its
 * entries could actually be tried for each endpoint.
 *
 * The counts are the whole point — a list can hold ten models and answer
 * nothing, because they are disabled, or their provider is. This is what says
 * so, and what a health check reports.
 */
export function describeChain(config, list) {
  return {
    id: autoModelId(list.name),
    listId: list.listId,
    name: list.name,
    description: list.description,
    active: list.active,
    chat: usableFrom(config, list.models, "chat").length,
    embedding: usableFrom(config, list.models, "embedding").length,
  };
}

/**
 * The chains a client can name, and what each one has to offer.
 *
 * A list holding nothing usable is left out: an id that can only answer `503`
 * is worse than one line less in a model picker.
 */
export function servedChains(config) {
  return servedLists(config)
    .map((list) => describeChain(config, list))
    .filter((chain) => chain.chat || chain.embedding);
}

/**
 * The list an outside caller means, by any of the names it could know it under:
 * the `auto - <name>` id it is served under, the bare name, or the `lst_…` id
 * from the configuration file. Nothing, or `auto`, means the one being served.
 *
 * Names win over the words `auto`, `default` and `proxy` here, the other way
 * round from `resolveChain`: as a *model*, those words have always meant "the
 * chain being served", while a caller asking about a *list* means the list —
 * and `default` is the name every fresh install gives its first one.
 *
 * `null` when no list goes by that name, which is an answer in itself: it is
 * what tells a monitor its client is configured with an id nothing answers to,
 * rather than letting the fallback chain report somebody else's health.
 */
export function findChain(config, wanted) {
  const lists = servedLists(config);
  const raw = String(wanted ?? "").trim();
  const value = norm(raw);

  const byId = lists.find((list) => list.listId && list.listId === raw);
  if (byId) return byId;

  const named = AUTO_ID.exec(value);
  const key = named ? named[1].trim() : value;
  if (key) {
    const match = lists.find((list) => norm(list.name) === key) ?? lists.find((list) => slug(list.name) === slug(key));
    if (match) return match;
  }
  // `auto` on its own, or nothing at all: whichever list is being served.
  if (!named && (!value || AUTO_WORDS.includes(value))) return lists.find((list) => list.active) ?? lists[0] ?? null;
  return null;
}

/**
 * Reads a requested model as the name of a chain.
 *
 * `auto` alone is the list being served, which is what it has always meant.
 * `auto - embeddings` is the list of that name, served whether or not it is the
 * active one — which is what lets one client ask for the chat chain while
 * another asks for the embedding one, with nothing switched in between. Clients
 * rewrite ids more than they admit, so the separator is loose and the names are
 * compared on their letters and digits.
 *
 * `null` when this is not one of our ids, an unknown list name included: an
 * alias may perfectly well start with `auto-`, and the caller goes on to match
 * it as one.
 */
function readListId(config, requested) {
  const value = norm(requested);
  if (!value || AUTO_WORDS.includes(value)) return { list: null };
  const named = AUTO_ID.exec(value);
  if (!named) return null;
  const wanted = named[1].trim();
  const lists = servedLists(config);
  const list = lists.find((entry) => norm(entry.name) === wanted) ?? lists.find((entry) => slug(entry.name) === slug(wanted)) ?? null;
  return list ? { list } : null;
}

/**
 * Builds the ordered attempt list for a requested `model`.
 * The order of a chain IS its priority order.
 */
export function resolveChain(config, requestedModel, kind = "chat") {
  const requested = String(requestedModel || "").trim();
  const asChain = readListId(config, requested);

  if (asChain?.list) {
    return {
      entries: usableFrom(config, asChain.list.models, kind),
      matched: autoModelId(asChain.list.name),
      notFound: false,
      list: asChain.list.name,
    };
  }

  const pool = usableEntries(config, kind);
  if (asChain) return { entries: pool, matched: "auto", notFound: false, list: null };

  const byAlias = pool.filter((entry) => norm(entry.alias) === norm(requested));
  const byModel = pool.filter((entry) => norm(entry.model) === norm(requested));
  const byPath = pool.filter((entry) => {
    const provider = getProvider(config, entry.providerId);
    return norm(`${provider?.name}/${entry.model}`) === norm(requested) || norm(`${provider?.name}:${entry.model}`) === norm(requested);
  });

  const primary = byAlias.length ? byAlias : byModel.length ? byModel : byPath;

  if (!primary.length) {
    if (config.failover.strictModelMatch) return { entries: [], matched: requested, notFound: true, list: null };
    return { entries: pool, matched: `${requested} (unknown → default chain)`, notFound: false, list: null };
  }
  const rest = config.failover.crossModelFallback ? pool.filter((entry) => !primary.includes(entry)) : [];
  return { entries: [...primary, ...rest], matched: requested, notFound: false, list: null };
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
 * Catalogue exposed to clients: one `auto - <list>` per model list, the one
 * being served first, then one id per alias of that live chain, in priority
 * order.
 *
 * A list carries an id of its own so the choice of chain belongs to the client:
 * an agent asks `auto - embeddings` for what it embeds with and `auto - default`
 * for what it talks to, and neither has to be the list the UI calls active.
 * `auto` on its own is still accepted as input, it is simply not advertised any
 * more — it names no chain, so a client showing it says nothing about which one
 * answered.
 *
 * The `provider/model` form stays accepted as input too (see `resolveChain`)
 * but is not listed: it would duplicate the alias, and produce unreadable ids
 * when the model name already contains a slash
 * (e.g. `openrouter/nvidia/nemotron-3:free`).
 */
export function listModels(config) {
  const seen = new Map(); // normalized id -> exposed entry (case-insensitive dedupe)

  for (const chain of servedChains(config)) {
    if (seen.has(norm(chain.id))) continue; // two lists of one name: the served one wins
    seen.set(norm(chain.id), {
      id: chain.id,
      object: "model",
      created: 0,
      owned_by: "llm-proxy",
      // The list's own note, the line `llmfp describe` prints: what something
      // that did not build these chains has to pick by.
      ...(chain.description ? { description: chain.description } : {}),
    });
  }

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

  return [...seen.values()];
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

/**
 * A controller for one try, tied to the attempt's own.
 *
 * An attempt that is retried through the tunnel makes two upstream requests, and
 * they cannot share a controller: the deadline that ended the first one already
 * aborted it, so the second would leave with a signal that is aborted before it
 * starts. What must still carry across is everything decided from the outside —
 * another provider winning the race, the client hanging up — so the outer signal
 * is forwarded to whichever try is current.
 */
function linkedController(outer) {
  const inner = new AbortController();
  if (outer.signal.aborted) {
    inner.abort(outer.signal.reason);
    return { controller: inner, release() {} };
  }
  const forward = () => inner.abort(outer.signal.reason);
  outer.signal.addEventListener("abort", forward, { once: true });
  return {
    controller: inner,
    // Dropped as soon as the try is over: an attempt that escalates would
    // otherwise leave a listener per try on a signal that outlives both.
    release: () => outer.signal.removeEventListener("abort", forward),
  };
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

async function attemptJson({ config, entry, provider, adapter, body, kind, controller, claim, send }) {
  const watchdog = createWatchdog(controller);
  watchdog.arm(config.failover.requestTimeoutMs, `no response within ${ms(config.failover.requestTimeoutMs)}`);

  try {
    const url = kind === "embedding" ? adapter.embeddingEndpoint(provider) : adapter.chatEndpoint(provider);
    const payload = kind === "embedding" ? adapter.buildEmbeddingBody(body, entry) : adapter.buildChatBody(body, entry);
    const response = await send(url, {
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
async function attemptStream({ config, entry, provider, adapter, body, sink, controller, claim, meta, send }) {
  const watchdog = createWatchdog(controller);
  watchdog.arm(config.failover.firstTokenTimeoutMs, `no token within ${ms(config.failover.firstTokenTimeoutMs)}`);

  const buffered = [];
  let committed = false;
  let committedAt = null;
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
    // The first chunk carrying content: this, and nothing else, is the moment the
    // wait ends for whoever is reading the answer.
    committedAt = Date.now();
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
    const response = await send(adapter.chatEndpoint(provider), {
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
    return { kind: "win", usage: lastUsage, committedAt };
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
      return { kind: "win", usage: lastUsage, degraded: true, error: info, committedAt };
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
    // A model that was retried through the tunnel and failed anyway is a quota on
    // the account rather than on this machine's address: saying so here is what
    // stops the next hour being spent on the wrong fix.
    const route = attempt.escalated ? " (retried through Cloudflare WARP, same answer)" : "";
    lines.push(`  ${index + 1}. ${attempt.provider}/${attempt.model}, ${attempt.reason}: ${attempt.message}${route}`);
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
 * @param plan an egress plan to use instead of asking the configuration for one.
 *             Only tests pass it: escalation cannot be exercised against a
 *             loopback provider, which is precisely the target `isLocalTarget`
 *             refuses to send through a tunnel.
 * @returns {Promise<{type: 'json'|'stream'|'error'} & Record<string, any>>}
 */
export async function run({ config, body, kind = "chat", sink = null, clientGone, requestId = "-", plan = null }) {
  const { entries, matched, notFound, list } = resolveChain(config, body.model, kind);

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
      // Which chain came up empty, when the client named one: a list of embedding
      // models asked for a chat answer is a real mix-up, and its name is the clue.
      message: `No ${kind} model configured or enabled${list ? ` in the model list "${list}"` : ""}. Run the CLI to add one (\`npx llm-failover-proxy\`).`,
      errorType: "no_backend",
      attempts: [],
    };
  }

  /**
   * How each attempt in this chain is allowed to leave.
   *
   * Under `warp.mode: "always"` this is one decision for the whole request, which
   * is what lets `/stats` answer "where did this leave from" with one word. Under
   * `on-rate-limit` it is a decision per model: the plan hands each attempt its
   * own route, and a rate-limited one can move itself onto the tunnel without
   * touching the models racing beside it.
   */
  const egress = plan ?? (await planEgress(config));
  if (egress.unavailable) {
    // Failing here rather than in every attempt: the chain is irrelevant, one
    // clear sentence about the tunnel is the whole answer.
    return {
      type: "error",
      status: 503,
      message:
        `Cloudflare WARP is enabled, but its tunnel is not answering on 127.0.0.1:${config.warp.httpPort}. ` +
        "Start it with `llm-failover-proxy warp up`, `warp status` says why it did not come up, " +
        "and Settings can let requests go out directly instead.",
      errorType: "warp_unavailable",
      attempts: [],
    };
  }
  if (egress.degraded) {
    log.warn(`[${requestId}] ${c.yellow("warp tunnel down")} → going out directly instead, as configured`);
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

      /** One upstream request, on the given route, with its own deadline. */
      const tryOnce = async (route) => {
        const { controller: own, release } = linkedController(controller);
        // Held for as long as this attempt is travelling through the tunnel,
        // streaming included: it is what stops a rotation replacing the tunnel
        // underneath an answer that is still arriving.
        const drop = route.via === "warp" ? holdTunnel() : null;
        try {
          const shared = { config, entry, provider, adapter, body, controller: own, claim: claimFor(position), send: route.send };
          // The route is only known here, and the headers are written at commit:
          // a streamed answer says which way it came in for the same reason a
          // non-streamed one does.
          const describe = () => ({ ...meta(), via: route.via, escalated: route.via === "warp" });
          return streaming ? await attemptStream({ ...shared, sink, meta: describe }) : await attemptJson({ ...shared, kind });
        } catch (err) {
          if (err?.name === "ClientGoneError") return { kind: "gone" };
          const reason = own.signal.reason ?? controller.signal.reason;
          if (err?.name === "RaceLost" || reason?.name === "RaceLost") return { kind: "cancelled" };
          if (reason?.name === "ClientGoneError") return { kind: "gone" };
          return { kind: "fail", error: toAttemptError(err) };
        } finally {
          release();
          drop?.();
        }
      };

      /**
       * The attempt, and the second chance a rate limit earns it.
       *
       * All of it inside this one promise, which is what keeps the escalation to
       * itself: the loop below is not waiting on it, the hedge timer keeps
       * running, the models already in flight keep going out the way they were,
       * and whichever of them produces something usable first still wins. This
       * one just takes a little longer and arrives from somewhere else.
       */
      const settle = (async () => {
        const first = await egress.routeFor(entry.id, requestId);
        let outcome = await tryOnce(first);
        let via = first.via;
        let escalated = first.preferred === true;

        // Not once this attempt is over anyway: the client hung up, or another
        // model has already answered. Escalating then would ask for a tunnel
        // nobody is waiting for, and send a request only to abort it.
        const worthIt = outcome.kind === "fail" && !controller.signal.aborted && claimed === null && first.via !== "warp";

        if (worthIt && worthEscalating(outcome.error)) {
          const tunnel = await egress.escalate(requestId);
          // Only once a tunnel was actually had. Remembering a rate limit the
          // tunnel could not do anything about would send the next request at a
          // port with nothing behind it, and trade a 429 for a network error.
          if (tunnel) {
            markRateLimited(entry.id, { retryAfterMs: outcome.error.retryAfterMs, cooldown: config.failover.cooldown });
            log.info(
              `[${requestId}] ${c.yellow("rate limited")} ${label(config, entry)} ` +
                c.gray(`→ trying the same model again through ${c.cyan("WARP")}`),
            );
            outcome = await tryOnce(tunnel);
            via = tunnel.via;
            escalated = true;
          }
        }

        // A 429 that came back *through* the tunnel is the exit address being
        // throttled, not this model: no other model will do better from the same
        // address, and no cooldown fixes it. It is the signal to draw a new
        // session, which happens at the next moment nothing is using the tunnel.
        if (via === "warp" && outcome.kind === "fail" && worthEscalating(outcome.error)) noteTunnelRateLimited();

        return { ...outcome, via, escalated };
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
          // Which way this attempt gave up from. Worth saying: a rate limit that
          // survived the tunnel too is a quota on the account, not on the address,
          // and that is the difference between "wait" and "change something".
          via: outcome.via,
          escalated: outcome.escalated,
        });
        // A failure frees its slot immediately: no need to wait for the timer.
        const replaced = claimed === null ? launch() : false;
        log.warn(
          `[${requestId}] ${c.yellow("failed")} ${target} [${info.reason}] ${info.message}` +
            `${outcome.escalated ? c.gray(" (through WARP too)") : ""}` +
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
        // A non-streamed answer has no first token of its own: the whole body
        // arrives at once, so the wait that ended is the request's own latency.
        const ttft = outcome.committedAt ? outcome.committedAt - task.startedAt : latency;
        // The way this attempt left, which is the winner's own and not the
        // chain's: under `on-rate-limit` the model that answered may be the one
        // that escalated while the others were still going out directly.
        recordSuccess(task.entry.id, {
          latencyMs: latency,
          ttftMs: ttft,
          tokens: tokensOf(outcome.usage),
          via: outcome.via,
          escalated: outcome.escalated,
        });
        log.info(
          `[${requestId}] ${c.green("ok")} ${target} (${place}${streaming ? ", stream" : ""}) ${ms(latency)}` +
            `${outcome.escalated ? ` ${c.cyan("via WARP")}` : ""}` +
            `${outcome.usage ? ` ${compact(tokensOf(outcome.usage))} tok` : ""}` +
            `${dropped ? c.gray(` · ${dropped} speculative attempt(s) dropped`) : ""}`,
        );
      }

      const served = { entry: task.entry, provider: task.provider, attempts, cancelled: dropped, via: outcome.via, escalated: outcome.escalated };
      return streaming ? { type: "stream", ...served, degraded: Boolean(outcome.degraded) } : { type: "json", json: outcome.json, ...served };
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
