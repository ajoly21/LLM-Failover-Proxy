import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createServer } from '../src/server.js';
import { resetAll } from '../src/state.js';

let counter = 0;

/**
 * Starts an isolated proxy on an ephemeral port.
 * Pass `reuse` (a config path from a previous run) to simulate a restart: the
 * config and the persisted stats file are kept, only the process state is lost.
 */
export async function startProxy({ providers = [], models = [], failover = {}, server = {}, reuse = null } = {}) {
  resetAll();
  const dir = reuse ? path.dirname(reuse) : await fs.mkdtemp(path.join(os.tmpdir(), 'llm-proxy-test-'));
  const file = reuse || path.join(dir, `config-${++counter}.json`);

  if (!reuse) {
    await fs.writeFile(
      file,
      JSON.stringify({
        server: { host: '127.0.0.1', port: 0, logLevel: 'error', cors: true, apiKey: null, ...server },
        failover: {
          requestTimeoutMs: 5000,
          firstTokenTimeoutMs: 3000,
          idleTimeoutMs: 3000,
          cooldown: { failuresBeforeTrip: 2, baseMs: 10000, maxMs: 60000 },
          ...failover,
        },
        providers,
        models,
      }),
    );
  }

  const app = createServer({ configFile: file });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));

  const stop = async () => {
    app.server.closeAllConnections?.();
    await new Promise((resolve) => app.server.close(resolve));
  };

  return {
    file,
    dir,
    url: `http://127.0.0.1:${app.server.address().port}`,
    /** Shuts the server down but keeps the config and stats on disk. */
    stop,
    async close() {
      await stop();
      await fs.rm(dir, { recursive: true, force: true });
    },
  };
}

/**
 * A directory holding the command, the way npm leaves it: the shell shim plus
 * the two Windows wrappers, since only those are executable there.
 *
 * Anything asserting that the install looks healthy has to supply this and use it
 * as the whole PATH. Otherwise the test passes on a machine that happens to have
 * `llmfp` installed and fails on a CI runner, which is the exact confusion the
 * PATH check exists to clear up.
 *
 * `.CMD` upper-case on purpose: PATHEXT is upper-case, so a lower-case name on
 * disk only resolves where the filesystem ignores case. This way the Windows
 * lookup can be exercised from a Linux runner too — the real-world lower-case
 * spelling has its own test, on Windows.
 */
export async function fakeBinDir(names = ['llmfp', 'llmfp.CMD', 'llmfp.ps1']) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'llm-proxy-bin-'));
  for (const name of names) await fs.writeFile(path.join(dir, name), '#!/bin/sh\n', { mode: 0o755 });
  return dir;
}

/** Builds a provider/model pair ready to drop into a test config. */
export function backend(
  mock,
  { id = mock.name, model = 'test-model', alias = 'chain', type = 'openai', kind = 'chat', apiKey = 'sk-test' } = {},
) {
  return {
    provider: { id: `prov_${id}`, name: id, type, baseUrl: mock.baseUrl, apiKey, enabled: true, headers: {} },
    model: { id: `mdl_${id}`, providerId: `prov_${id}`, model, alias, kind, enabled: true, params: {} },
  };
}

export function assemble(backends) {
  return { providers: backends.map((b) => b.provider), models: backends.map((b) => b.model) };
}

export async function postJson(url, body, headers = {}) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  return { status: response.status, headers: response.headers, json, text };
}

/** Consumes a whole SSE stream and extracts the concatenated content. */
export async function readStream(url, body, headers = {}) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  const raw = await response.text();
  const frames = [];
  const models = new Set();
  let content = '';
  let done = false;
  let error = null;
  let finishReason = null;

  for (const block of raw.split(/\n\n/)) {
    const line = block.split('\n').find((candidate) => candidate.startsWith('data:'));
    if (!line) continue;
    const payload = line.slice(5).trim();
    if (payload === '[DONE]') {
      done = true;
      continue;
    }
    let parsed;
    try {
      parsed = JSON.parse(payload);
    } catch {
      continue;
    }
    frames.push(parsed);
    if (parsed.error) error = parsed.error;
    if (parsed.model) models.add(parsed.model);
    const delta = parsed.choices?.[0]?.delta;
    if (typeof delta?.content === 'string') content += delta.content;
    if (parsed.choices?.[0]?.finish_reason) finishReason = parsed.choices[0].finish_reason;
  }

  return {
    status: response.status,
    headers: response.headers,
    contentType: response.headers.get('content-type'),
    frames,
    content,
    done,
    error,
    finishReason,
    models: [...models],
    raw,
  };
}
