import { AttemptError, REASONS } from '../errors.js';

const join = (base, suffix) => `${String(base).replace(/\/+$/, '')}${suffix}`;

/** Proxy-only fields, never forwarded upstream. */
const STRIP = new Set(['x_proxy']);

function upstreamBody(body, entry) {
  const out = {};
  for (const [key, value] of Object.entries(body)) if (!STRIP.has(key)) out[key] = value;
  out.model = entry.model;
  // Entry params are set by the operator, so they win over the client body.
  for (const [key, value] of Object.entries(entry.params || {})) out[key] = value;
  return out;
}

/**
 * Plain OpenAI-compatible upstream. Requests and responses pass through
 * untouched, which keeps `tools`, `response_format`, vision, and any
 * provider-specific extension working without changes here.
 */
export const openaiAdapter = {
  id: 'openai',
  supportsEmbeddings: true,

  headers(provider, apiKey) {
    const headers = {
      'content-type': 'application/json',
      accept: 'application/json',
      ...(provider.headers || {}),
    };
    if (apiKey) headers.authorization = `Bearer ${apiKey}`;
    return headers;
  },

  chatEndpoint(provider) {
    return join(provider.baseUrl, '/chat/completions');
  },

  embeddingEndpoint(provider) {
    return join(provider.baseUrl, '/embeddings');
  },

  buildChatBody(body, entry) {
    return upstreamBody(body, entry);
  },

  buildEmbeddingBody(body, entry) {
    return upstreamBody(body, entry);
  },

  normalizeChatResponse(json) {
    return json;
  },

  normalizeEmbeddingResponse(json) {
    return json;
  },

  createStreamTranslator() {
    return {
      /** @returns {{frames: {data: string, hasContent: boolean, usage: object|null}[], done: boolean}} */
      push(event) {
        const data = event.data;
        if (data === undefined || data === '') return { frames: [], done: false };
        if (data.trim() === '[DONE]') return { frames: [], done: true };

        let parsed;
        try {
          parsed = JSON.parse(data);
        } catch {
          // Non-JSON fragment: ignore it rather than break the stream.
          return { frames: [], done: false };
        }
        if (parsed && parsed.error) {
          throw new AttemptError(REASONS.UPSTREAM, `error mid-stream: ${describeError(parsed.error)}`);
        }
        return { frames: [{ data, hasContent: chunkHasContent(parsed), usage: parsed.usage || null }], done: false };
      },
      flush() {
        return { frames: [], done: false };
      },
    };
  },
};

function describeError(error) {
  if (typeof error === 'string') return error;
  return error?.message || JSON.stringify(error).slice(0, 300);
}

/** A "usable" payload holds non-blank text, a tool call, or reasoning content. */
export function chunkHasContent(payload) {
  const choices = payload?.choices;
  if (!Array.isArray(choices) || choices.length === 0) return false;
  for (const choice of choices) {
    const delta = choice.delta ?? choice.message ?? {};
    if (typeof delta.content === 'string' && delta.content.trim() !== '') return true;
    if (Array.isArray(delta.content) && delta.content.some((part) => (part?.text ?? '').trim() !== '')) return true;
    if (Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0) return true;
    if (delta.function_call) return true;
    if (typeof delta.reasoning_content === 'string' && delta.reasoning_content.trim() !== '') return true;
    if (typeof delta.reasoning === 'string' && delta.reasoning.trim() !== '') return true;
  }
  return false;
}

/** Is a non-streamed completion usable? */
export function inspectCompletion(json, { treatContentFilterAsFailure = true } = {}) {
  if (!json || typeof json !== 'object') return { ok: false, reason: REASONS.MALFORMED, message: 'response body is not JSON' };
  if (json.error) return { ok: false, reason: REASONS.UPSTREAM, message: describeError(json.error) };
  const choice = json.choices?.[0];
  if (!choice) return { ok: false, reason: REASONS.MALFORMED, message: 'response has no `choices`' };
  if (treatContentFilterAsFailure && choice.finish_reason === 'content_filter') {
    return { ok: false, reason: REASONS.CONTENT_FILTER, message: 'answer filtered by the provider' };
  }
  if (!chunkHasContent(json)) return { ok: false, reason: REASONS.EMPTY, message: 'empty answer (no text, no tool call)' };
  return { ok: true };
}

export function inspectEmbedding(json) {
  if (!json || typeof json !== 'object') return { ok: false, reason: REASONS.MALFORMED, message: 'response body is not JSON' };
  if (json.error) return { ok: false, reason: REASONS.UPSTREAM, message: describeError(json.error) };
  const first = json.data?.[0];
  if (!Array.isArray(json.data) || !first || !Array.isArray(first.embedding) || first.embedding.length === 0) {
    return { ok: false, reason: REASONS.EMPTY, message: 'no vector in response' };
  }
  return { ok: true };
}
