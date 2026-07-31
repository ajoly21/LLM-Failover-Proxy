import { openaiAdapter } from './openai.js';
import { anthropicAdapter } from './anthropic.js';

const ADAPTERS = {
  openai: openaiAdapter,
  anthropic: anthropicAdapter,
};

/** Unknown or missing type falls back to the OpenAI protocol. */
export function adapterFor(provider) {
  return ADAPTERS[provider?.type] || openaiAdapter;
}
