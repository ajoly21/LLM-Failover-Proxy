import { adapterFor } from "./adapters/index.js";
import { inspectCompletion } from "./adapters/openai.js";
import { resolveSecret } from "./config.js";
import { ms } from "./logger.js";
import { createSseParser } from "./sse.js";

/** Long enough to produce several tokens, short enough to stay cheap. */
const DEFAULT_PROMPT = "In one short sentence, say what an HTTP proxy does.";
const DEFAULT_MAX_TOKENS = 64;

/**
 * How long a single test may take, from the request to the last token.
 *
 * One deadline for the whole probe rather than one per phase: a test either
 * finishes in time or it does not, and "how long am I willing to wait for a
 * benchmark" is a different question from "how long may a real request take".
 */
export function probeTimeout(config) {
  return Math.max(1000, Number(config?.probe?.timeoutMs) || 15000);
}

function deadline(timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("timed out")), timeoutMs);
  return { signal: controller.signal, clear: () => clearTimeout(timer) };
}

const reason = (err) => err?.timeoutReason || err?.cause?.code || err?.message || "unknown error";

function shortError(text) {
  try {
    const parsed = JSON.parse(text);
    return String(parsed?.error?.message || parsed?.message || text).slice(0, 200);
  } catch {
    return text.slice(0, 200);
  }
}

/** Checks that a provider is reachable, through its `/models` endpoint. */
export async function probeProvider(provider, timeoutMs = probeTimeout()) {
  const adapter = adapterFor(provider);
  const url = `${provider.baseUrl.replace(/\/+$/, "")}/models`;
  const { signal, clear } = deadline(timeoutMs);
  const startedAt = Date.now();
  try {
    const response = await fetch(url, { headers: adapter.headers(provider, resolveSecret(provider.apiKey)), signal });
    const text = await response.text();
    if (!response.ok) {
      return { ok: false, latencyMs: Date.now() - startedAt, message: `HTTP ${response.status}, ${shortError(text)}` };
    }
    let ids = [];
    try {
      const json = JSON.parse(text);
      ids = (json.data || json.models || []).map((m) => m.id || m.name).filter(Boolean);
    } catch {
      /* non-standard payload */
    }
    return { ok: true, latencyMs: Date.now() - startedAt, models: ids, message: `${ids.length} model(s) advertised` };
  } catch (err) {
    return { ok: false, latencyMs: Date.now() - startedAt, message: reason(err) };
  } finally {
    clear();
  }
}

/**
 * Sends one real streaming request through a chain entry and measures it.
 *
 * @returns {Promise<{
 *   ok: boolean, message: string, status?: number,
 *   ttftMs: number|null,        time to first usable token
 *   totalMs: number,            whole request
 *   tokens: number|null,        completion tokens
 *   tokensApprox: boolean,      true when counted from chunks instead of usage
 *   tokensPerSecond: number|null generation speed, first token excluded
 * }>}
 */
export async function probeModel(config, entry, provider, options = {}) {
  const first = await streamProbe(config, entry, provider, { ...options, includeUsage: true });
  // Providers that reject the (optional) usage hint get one clean retry without it.
  if (!first.ok && first.retryWithoutUsage) {
    return streamProbe(config, entry, provider, { ...options, includeUsage: false });
  }
  return first;
}

async function streamProbe(config, entry, provider, { prompt = DEFAULT_PROMPT, maxTokens = DEFAULT_MAX_TOKENS, includeUsage = true } = {}) {
  const adapter = adapterFor(provider);
  const limit = probeTimeout(config);

  const controller = new AbortController();
  let timer = null;

  const body = {
    model: entry.model,
    messages: [{ role: "user", content: prompt }],
    max_tokens: maxTokens,
    stream: true,
  };
  if (includeUsage) body.stream_options = { include_usage: true };

  const startedAt = Date.now();
  let ttftMs = null;
  let contentChunks = 0;
  let usage = null;
  let text = "";

  const measure = () => {
    const totalMs = Date.now() - startedAt;
    const tokens = usage?.completion_tokens ?? (contentChunks || null);
    const generationMs = ttftMs == null ? 0 : totalMs - ttftMs;
    // Speed excludes the wait for the first token, the usual reading of tok/s.
    const tokensPerSecond = tokens && tokens > 1 && generationMs > 0 ? (tokens / generationMs) * 1000 : null;
    return {
      ttftMs,
      totalMs,
      tokens,
      tokensApprox: usage?.completion_tokens == null,
      tokensPerSecond,
    };
  };

  try {
    // Armed once for the whole test, never re-armed: the message says which
    // phase ran out of time, but the budget covers all of them.
    timer = setTimeout(() => {
      const why = ttftMs == null ? `no token within ${ms(limit)}` : `answer unfinished after ${ms(limit)}`;
      const err = new Error(why);
      err.name = "TimeoutError";
      err.timeoutReason = why;
      controller.abort(err);
    }, limit);

    const response = await fetch(adapter.chatEndpoint(provider), {
      method: "POST",
      headers: adapter.headers(provider, resolveSecret(provider.apiKey)),
      body: JSON.stringify(adapter.buildChatBody(body, entry)),
      signal: controller.signal,
    });

    if (!response.ok) {
      const raw = await response.text();
      return {
        ok: false,
        status: response.status,
        message: `HTTP ${response.status}, ${shortError(raw)}`,
        // A 4xx while sending the usage hint is likely about that extra field.
        retryWithoutUsage: includeUsage && response.status >= 400 && response.status < 500,
        ...measure(),
      };
    }
    if (!response.body) return { ok: false, message: "response has no body", ...measure() };

    // Some providers ignore `stream: true` and answer with plain JSON.
    if ((response.headers.get("content-type") || "").includes("application/json")) {
      const normalized = adapter.normalizeChatResponse(await response.json());
      const verdict = inspectCompletion(normalized, config?.failover);
      if (!verdict.ok) return { ok: false, message: `${verdict.reason}, ${verdict.message}`, ...measure() };
      ttftMs = Date.now() - startedAt; // no streaming: first token == whole answer
      usage = normalized.usage || null;
      text = String(normalized.choices?.[0]?.message?.content || "");
      return { ok: true, message: summarize(text), ...measure() };
    }

    const parser = createSseParser();
    const translator = adapter.createStreamTranslator({ entry });
    const reader = response.body.getReader();
    let done = false;

    for (;;) {
      const { value, done: streamDone } = await reader.read();
      if (streamDone) break;
      for (const event of parser.push(value)) {
        const out = translator.push(event);
        for (const frame of out.frames) {
          if (frame.usage) usage = frame.usage;
          if (!frame.hasContent) continue;
          if (ttftMs == null) ttftMs = Date.now() - startedAt;
          contentChunks += 1;
          const delta = JSON.parse(frame.data).choices?.[0]?.delta;
          if (typeof delta?.content === "string") text += delta.content;
        }
        if (out.done) done = true;
      }
      if (done) break;
    }
    try {
      await reader.cancel();
    } catch {
      /* already closed */
    }

    if (ttftMs == null) return { ok: false, message: "empty answer (no usable token)", ...measure() };
    return { ok: true, message: summarize(text), ...measure() };
  } catch (err) {
    return { ok: false, message: reason(err), ...measure() };
  } finally {
    clearTimeout(timer);
  }
}

function summarize(text) {
  const clean = String(text).replace(/\s+/g, " ").trim();
  if (!clean) return "(tool call or reasoning only)";
  return clean.length > 90 ? `${clean.slice(0, 89)}…` : clean;
}
