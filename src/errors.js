/** Attempt failure reasons — they drive both failover and cooldowns. */
export const REASONS = {
  NETWORK: 'network_error',
  TIMEOUT: 'timeout',
  RATE_LIMIT: 'rate_limited',
  AUTH: 'auth_error',
  UPSTREAM: 'upstream_error',
  EMPTY: 'empty_response',
  CONTENT_FILTER: 'content_filter',
  MALFORMED: 'malformed_response',
  SKIPPED: 'skipped',
};

export class AttemptError extends Error {
  constructor(reason, message, { status = null, retryAfterMs = null } = {}) {
    super(message);
    this.name = 'AttemptError';
    this.reason = reason;
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

export class ClientGoneError extends Error {
  constructor() {
    super('client disconnected');
    this.name = 'ClientGoneError';
  }
}

/**
 * 429 / 5xx / network / timeout: fail over. Plain 4xx too — a provider may
 * reject a parameter that the next one accepts.
 */
export function classifyStatus(status) {
  if (status === 429) return REASONS.RATE_LIMIT;
  if (status === 401 || status === 403) return REASONS.AUTH;
  return REASONS.UPSTREAM;
}

export function parseRetryAfter(headerValue) {
  if (!headerValue) return null;
  const seconds = Number(headerValue);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(headerValue);
  if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  return null;
}

/** OpenAI-shaped error envelope. */
export function openAIError(message, { type = 'proxy_error', code = null, param = null, extra = null } = {}) {
  return { error: { message, type, code, param, ...(extra ? { proxy: extra } : {}) } };
}
