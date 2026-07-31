import http from 'node:http';

const sleep = (delay) => new Promise((resolve) => setTimeout(resolve, delay));

function readAll(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function json(res, status, payload, headers = {}) {
  const data = JSON.stringify(payload);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data), ...headers });
  res.end(data);
}

function sseHead(res) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
}

const chunk = (payload) => `data: ${JSON.stringify(payload)}\n\n`;

const completion = (name, model, content) => ({
  id: `cmpl-${name}`,
  object: 'chat.completion',
  created: 1,
  model: `${name}:${model}`,
  choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
});

const embedding = (name, model) => ({
  object: 'list',
  model: `${name}:${model}`,
  data: [{ object: 'embedding', index: 0, embedding: [0.1, 0.2, 0.3] }],
  usage: { prompt_tokens: 3, total_tokens: 3 },
});

const anthropicMessage = (name, model) => ({
  id: 'msg_1',
  type: 'message',
  role: 'assistant',
  model: `${name}:${model}`,
  content: [{ type: 'text', text: `hello from ${name}` }],
  stop_reason: 'end_turn',
  usage: { input_tokens: 7, output_tokens: 4 },
});

/**
 * Configurable fake provider.
 * `behavior` is a string, or a `(body, state) => string` function to vary the
 * answer per call.
 */
export async function startMock(behavior, { name = 'mock', delayMs = 0 } = {}) {
  const state = { calls: 0, requests: [], behavior };

  const server = http.createServer(async (req, res) => {
    // Speculative requests get aborted mid-flight: writing to a dead socket must
    // not take the mock down, exactly like a real provider.
    res.on('error', () => {});
    req.on('error', () => {});
    if (req.method === 'GET' && req.url.endsWith('/models')) {
      json(res, 200, { data: [{ id: `${name}-model-a` }, { id: `${name}-model-b` }] });
      return;
    }

    const raw = await readAll(req);
    let body = {};
    try {
      body = raw ? JSON.parse(raw) : {};
    } catch {
      /* ignore */
    }
    state.calls += 1;
    state.requests.push({ path: req.url, body, headers: req.headers });
    if (delayMs) await sleep(delayMs); // simulates a slow provider

    const isAnthropic = req.url.includes('/messages');
    const isEmbedding = req.url.includes('/embeddings');
    const streaming = Boolean(body.stream);
    const kind = typeof state.behavior === 'function' ? state.behavior(body, state) : state.behavior;

    try {
      switch (kind) {
      case 'hang':
        return; // never answers: triggers the proxy deadline

      case 'error500':
        json(res, 500, { error: { message: `${name} is down`, type: 'server_error' } });
        return;

      case 'rate-limit':
        json(res, 429, { error: { message: `${name} rate limited`, type: 'rate_limit_error' } }, { 'retry-after': '1' });
        return;

      case 'auth-error':
        json(res, 401, { error: { message: 'invalid key', type: 'invalid_request_error' } });
        return;

      case 'error400':
        json(res, 400, { error: { message: 'unsupported parameter', type: 'invalid_request_error' } });
        return;

      case 'invalid-json':
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('<html>gateway error</html>');
        return;

      case 'error-200':
        json(res, 200, { error: { message: `${name} application error` } });
        return;

      case 'empty':
        if (!streaming) {
          json(res, 200, completion(name, body.model, ''));
          return;
        }
        sseHead(res);
        res.write(chunk({ id: 'x', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] }));
        res.write(chunk({ id: 'x', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }));
        res.write('data: [DONE]\n\n');
        res.end();
        return;

      case 'content-filter':
        json(res, 200, {
          ...completion(name, body.model, ''),
          choices: [{ index: 0, message: { role: 'assistant', content: '' }, finish_reason: 'content_filter' }],
        });
        return;

      case 'mid-stream-error':
        sseHead(res);
        res.write(chunk({ id: 'x', object: 'chat.completion.chunk', model: name, choices: [{ index: 0, delta: { content: 'start' }, finish_reason: null }] }));
        await sleep(10);
        res.write(chunk({ error: { message: 'upstream dropped the stream' } }));
        res.end();
        return;

      case 'anthropic':
        if (!streaming) {
          json(res, 200, anthropicMessage(name, body.model));
          return;
        }
        sseHead(res);
        res.write(`event: message_start\n${chunk({ type: 'message_start', message: { id: 'msg_1', model: `${name}:${body.model}`, usage: { input_tokens: 7 } } })}`);
        res.write(`event: content_block_start\n${chunk({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })}`);
        for (const piece of ['hello ', 'from ', name]) {
          res.write(`event: content_block_delta\n${chunk({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: piece } })}`);
          await sleep(5);
        }
        res.write(`event: content_block_stop\n${chunk({ type: 'content_block_stop', index: 0 })}`);
        res.write(`event: message_delta\n${chunk({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 4 } })}`);
        res.write(`event: message_stop\n${chunk({ type: 'message_stop' })}`);
        res.end();
        return;

      case 'ok':
      default:
        if (isEmbedding) {
          json(res, 200, embedding(name, body.model));
          return;
        }
        if (isAnthropic) {
          json(res, 200, anthropicMessage(name, body.model));
          return;
        }
        if (!streaming) {
          json(res, 200, completion(name, body.model, `hello from ${name}`));
          return;
        }
        sseHead(res);
        res.write(chunk({
          id: 'x',
          object: 'chat.completion.chunk',
          model: `${name}:${body.model}`,
          choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }],
        }));
        for (const piece of ['hello ', 'from ', name]) {
          res.write(chunk({
            id: 'x',
            object: 'chat.completion.chunk',
            model: `${name}:${body.model}`,
            choices: [{ index: 0, delta: { content: piece }, finish_reason: null }],
          }));
          await sleep(5);
        }
        res.write(chunk({
          id: 'x',
          object: 'chat.completion.chunk',
          model: `${name}:${body.model}`,
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          // Like real OpenAI-compatible providers: usage only when asked for.
          ...(body.stream_options?.include_usage ? { usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } } : {}),
        }));
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }
    } catch {
      // Client hung up mid-response (an aborted speculative request).
    }
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  return {
    name,
    state,
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
    set behavior(value) {
      state.behavior = value;
    },
    get calls() {
      return state.calls;
    },
    async close() {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
