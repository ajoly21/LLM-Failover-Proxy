import { AttemptError, REASONS } from '../errors.js';

const join = (base, suffix) => `${String(base).replace(/\/+$/, '')}${suffix}`;
const nowSec = () => Math.floor(Date.now() / 1000);

/**
 * Anthropic Messages API adapter: translates both ways so clients only ever
 * see the OpenAI shape.
 */
export const anthropicAdapter = {
  id: 'anthropic',
  supportsEmbeddings: false,

  headers(provider, apiKey) {
    const headers = {
      'content-type': 'application/json',
      accept: 'application/json',
      'anthropic-version': '2023-06-01',
      ...(provider.headers || {}),
    };
    if (apiKey) headers['x-api-key'] = apiKey;
    return headers;
  },

  chatEndpoint(provider) {
    return join(provider.baseUrl, '/messages');
  },

  buildChatBody(body, entry) {
    const params = entry.params || {};
    const { system, messages } = convertMessages(body.messages || []);
    const payload = {
      model: entry.model,
      // Required by the Messages API, unlike OpenAI's.
      max_tokens: body.max_tokens ?? body.max_completion_tokens ?? params.max_tokens ?? 4096,
      messages,
    };
    if (system) payload.system = system;
    if (body.temperature != null) payload.temperature = body.temperature;
    if (body.top_p != null) payload.top_p = body.top_p;
    if (body.stop != null) payload.stop_sequences = Array.isArray(body.stop) ? body.stop : [body.stop];
    if (body.stream) payload.stream = true;

    const tools = convertTools(body.tools, body.functions);
    if (tools.length) payload.tools = tools;
    const toolChoice = convertToolChoice(body.tool_choice ?? body.function_call);
    if (toolChoice) payload.tool_choice = toolChoice;

    for (const [key, value] of Object.entries(params)) payload[key] = value;
    return payload;
  },

  normalizeChatResponse(json) {
    const toolCalls = [];
    let text = '';
    let reasoning = '';
    for (const block of json?.content || []) {
      if (block.type === 'text') text += block.text || '';
      else if (block.type === 'thinking') reasoning += block.thinking || '';
      else if (block.type === 'tool_use') {
        toolCalls.push({
          id: block.id,
          type: 'function',
          function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) },
        });
      }
    }
    const message = { role: 'assistant', content: text || null };
    if (reasoning) message.reasoning_content = reasoning;
    if (toolCalls.length) message.tool_calls = toolCalls;

    const usage = json?.usage || {};
    return {
      id: json?.id || `chatcmpl-${nowSec()}`,
      object: 'chat.completion',
      created: nowSec(),
      model: json?.model,
      choices: [
        {
          index: 0,
          message,
          logprobs: null,
          finish_reason: mapStopReason(json?.stop_reason, toolCalls.length > 0),
        },
      ],
      usage: {
        prompt_tokens: usage.input_tokens ?? 0,
        completion_tokens: usage.output_tokens ?? 0,
        total_tokens: (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0),
      },
    };
  },

  createStreamTranslator() {
    const state = {
      id: `chatcmpl-${nowSec()}`,
      model: null,
      created: nowSec(),
      blocks: new Map(), // content block index -> { type, toolIndex }
      nextToolIndex: 0,
      promptTokens: 0,
    };

    const frame = (delta, { finish = null, usage = null, hasContent = false } = {}) => {
      const chunk = {
        id: state.id,
        object: 'chat.completion.chunk',
        created: state.created,
        model: state.model,
        choices: [{ index: 0, delta, logprobs: null, finish_reason: finish }],
      };
      if (usage) chunk.usage = usage;
      return { data: JSON.stringify(chunk), hasContent, usage };
    };

    return {
      push(event) {
        let payload;
        try {
          payload = event.data ? JSON.parse(event.data) : null;
        } catch {
          return { frames: [], done: false };
        }
        if (!payload) return { frames: [], done: false };

        switch (payload.type || event.event) {
          case 'message_start': {
            state.id = payload.message?.id || state.id;
            state.model = payload.message?.model ?? state.model;
            state.promptTokens = payload.message?.usage?.input_tokens ?? 0;
            return { frames: [frame({ role: 'assistant', content: '' })], done: false };
          }
          case 'content_block_start': {
            const block = payload.content_block || {};
            if (block.type === 'tool_use') {
              const toolIndex = state.nextToolIndex++;
              state.blocks.set(payload.index, { type: 'tool_use', toolIndex });
              return {
                frames: [
                  frame(
                    {
                      tool_calls: [
                        { index: toolIndex, id: block.id, type: 'function', function: { name: block.name, arguments: '' } },
                      ],
                    },
                    { hasContent: true },
                  ),
                ],
                done: false,
              };
            }
            state.blocks.set(payload.index, { type: block.type });
            return { frames: [], done: false };
          }
          case 'content_block_delta': {
            const delta = payload.delta || {};
            if (delta.type === 'text_delta') {
              const text = delta.text || '';
              return { frames: [frame({ content: text }, { hasContent: text.trim() !== '' })], done: false };
            }
            if (delta.type === 'input_json_delta') {
              const toolIndex = state.blocks.get(payload.index)?.toolIndex ?? 0;
              return {
                frames: [
                  frame({ tool_calls: [{ index: toolIndex, function: { arguments: delta.partial_json || '' } }] }, { hasContent: true }),
                ],
                done: false,
              };
            }
            if (delta.type === 'thinking_delta') {
              const thinking = delta.thinking || '';
              return { frames: [frame({ reasoning_content: thinking }, { hasContent: thinking.trim() !== '' })], done: false };
            }
            return { frames: [], done: false };
          }
          case 'message_delta': {
            const finish = mapStopReason(payload.delta?.stop_reason, state.nextToolIndex > 0);
            const completionTokens = payload.usage?.output_tokens ?? 0;
            return {
              frames: [
                frame(
                  {},
                  {
                    finish,
                    usage: {
                      prompt_tokens: state.promptTokens,
                      completion_tokens: completionTokens,
                      total_tokens: state.promptTokens + completionTokens,
                    },
                  },
                ),
              ],
              done: false,
            };
          }
          case 'message_stop':
            return { frames: [], done: true };
          case 'error':
            throw new AttemptError(REASONS.UPSTREAM, `error mid-stream: ${payload.error?.message || 'unknown'}`);
          default:
            return { frames: [], done: false }; // ping, content_block_stop, unknown events
        }
      },
      flush() {
        return { frames: [], done: false };
      },
    };
  },
};

function mapStopReason(reason, hasTools) {
  if (hasTools && (reason === 'tool_use' || reason == null)) return 'tool_calls';
  switch (reason) {
    case 'end_turn':
    case 'stop_sequence':
      return 'stop';
    case 'max_tokens':
      return 'length';
    case 'tool_use':
      return 'tool_calls';
    case 'refusal':
      return 'content_filter';
    default:
      return reason ? 'stop' : null;
  }
}

function textOf(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((part) => (typeof part === 'string' ? part : part?.type === 'text' ? part.text || '' : '')).join('');
  }
  return '';
}

function toBlocks(content) {
  if (typeof content === 'string') return content ? [{ type: 'text', text: content }] : [];
  if (!Array.isArray(content)) return [];
  const blocks = [];
  for (const part of content) {
    if (typeof part === 'string') {
      if (part) blocks.push({ type: 'text', text: part });
      continue;
    }
    if (part?.type === 'text' && part.text) {
      blocks.push({ type: 'text', text: part.text });
    } else if (part?.type === 'image_url') {
      const url = part.image_url?.url || '';
      const dataUrl = /^data:([^;]+);base64,(.*)$/s.exec(url);
      if (dataUrl) blocks.push({ type: 'image', source: { type: 'base64', media_type: dataUrl[1], data: dataUrl[2] } });
      else if (url) blocks.push({ type: 'image', source: { type: 'url', url } });
    }
  }
  return blocks;
}

function convertMessages(messages) {
  const systemParts = [];
  const out = [];

  const push = (role, blocks) => {
    if (!blocks.length) return;
    const last = out[out.length - 1];
    // The Messages API wants alternating roles: merge consecutive same-role messages.
    if (last && last.role === role) last.content.push(...blocks);
    else out.push({ role, content: blocks });
  };

  for (const message of messages) {
    if (!message || typeof message !== 'object') continue;

    if (message.role === 'system' || message.role === 'developer') {
      const text = textOf(message.content);
      if (text) systemParts.push(text);
      continue;
    }
    if (message.role === 'tool' || message.role === 'function') {
      push('user', [
        {
          type: 'tool_result',
          tool_use_id: message.tool_call_id || message.name || 'unknown',
          content: textOf(message.content) || '',
        },
      ]);
      continue;
    }
    if (message.role === 'assistant') {
      const blocks = toBlocks(message.content);
      for (const call of message.tool_calls || []) {
        blocks.push({
          type: 'tool_use',
          id: call.id || `call_${blocks.length}`,
          name: call.function?.name || 'tool',
          input: safeParse(call.function?.arguments),
        });
      }
      push('assistant', blocks);
      continue;
    }
    push('user', toBlocks(message.content));
  }

  return { system: systemParts.join('\n\n'), messages: out };
}

function convertTools(tools, functions) {
  const list = [];
  for (const tool of tools || []) {
    const fn = tool?.type === 'function' ? tool.function : tool;
    if (!fn?.name) continue;
    list.push({
      name: fn.name,
      description: fn.description || '',
      input_schema: fn.parameters || { type: 'object', properties: {} },
    });
  }
  for (const fn of functions || []) {
    if (!fn?.name) continue;
    list.push({
      name: fn.name,
      description: fn.description || '',
      input_schema: fn.parameters || { type: 'object', properties: {} },
    });
  }
  return list;
}

function convertToolChoice(choice) {
  if (!choice) return null;
  if (choice === 'auto') return { type: 'auto' };
  if (choice === 'none') return { type: 'none' };
  if (choice === 'required' || choice === 'any') return { type: 'any' };
  const name = choice?.function?.name || choice?.name;
  return name ? { type: 'tool', name } : null;
}

function safeParse(json) {
  if (json == null) return {};
  if (typeof json === 'object') return json;
  try {
    return JSON.parse(json);
  } catch {
    return {};
  }
}
