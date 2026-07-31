/** Well-known providers offered by the CLI. `type` is the upstream protocol. */
export const PRESETS = [
  { key: 'openai', name: 'openai', type: 'openai', baseUrl: 'https://api.openai.com/v1', env: 'OPENAI_API_KEY', sample: 'gpt-4o-mini' },
  { key: 'anthropic', name: 'anthropic', type: 'anthropic', baseUrl: 'https://api.anthropic.com/v1', env: 'ANTHROPIC_API_KEY', sample: 'claude-sonnet-4-5' },
  { key: 'openrouter', name: 'openrouter', type: 'openai', baseUrl: 'https://openrouter.ai/api/v1', env: 'OPENROUTER_API_KEY', sample: 'meta-llama/llama-3.3-70b-instruct' },
  { key: 'groq', name: 'groq', type: 'openai', baseUrl: 'https://api.groq.com/openai/v1', env: 'GROQ_API_KEY', sample: 'llama-3.3-70b-versatile' },
  { key: 'mistral', name: 'mistral', type: 'openai', baseUrl: 'https://api.mistral.ai/v1', env: 'MISTRAL_API_KEY', sample: 'mistral-large-latest' },
  { key: 'deepseek', name: 'deepseek', type: 'openai', baseUrl: 'https://api.deepseek.com/v1', env: 'DEEPSEEK_API_KEY', sample: 'deepseek-chat' },
  { key: 'together', name: 'together', type: 'openai', baseUrl: 'https://api.together.xyz/v1', env: 'TOGETHER_API_KEY', sample: 'meta-llama/Llama-3.3-70B-Instruct-Turbo' },
  { key: 'fireworks', name: 'fireworks', type: 'openai', baseUrl: 'https://api.fireworks.ai/inference/v1', env: 'FIREWORKS_API_KEY', sample: 'accounts/fireworks/models/llama-v3p3-70b-instruct' },
  { key: 'cerebras', name: 'cerebras', type: 'openai', baseUrl: 'https://api.cerebras.ai/v1', env: 'CEREBRAS_API_KEY', sample: 'llama-3.3-70b' },
  { key: 'xai', name: 'xai', type: 'openai', baseUrl: 'https://api.x.ai/v1', env: 'XAI_API_KEY', sample: 'grok-3' },
  { key: 'gemini', name: 'gemini', type: 'openai', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', env: 'GEMINI_API_KEY', sample: 'gemini-2.5-flash' },
  { key: 'azure', name: 'azure-openai', type: 'openai', baseUrl: 'https://<resource>.openai.azure.com/openai/v1', env: 'AZURE_OPENAI_API_KEY', sample: 'gpt-4o-mini' },
  { key: 'ollama', name: 'ollama', type: 'openai', baseUrl: 'http://127.0.0.1:11434/v1', env: null, sample: 'llama3.2' },
  { key: 'lmstudio', name: 'lmstudio', type: 'openai', baseUrl: 'http://127.0.0.1:1234/v1', env: null, sample: 'local-model' },
  { key: 'custom', name: '', type: 'openai', baseUrl: '', env: null, sample: '' },
];
