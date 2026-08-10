import assert from "node:assert/strict";
import test from "node:test";
import { assemble, backend, postJson, readStream, startProxy } from "./helpers.js";
import { startMock } from "./mock-provider.js";

const CHAT = { messages: [{ role: "user", content: "hi" }] };

/** Spins up N mocks plus a proxy whose chain follows the given order. */
async function scenario(specs, config = {}) {
  const mocks = [];
  for (const spec of specs) mocks.push(await startMock(spec.behavior, { name: spec.name }));
  const backends = mocks.map((mock, index) => backend(mock, { ...specs[index].options }));
  const proxy = await startProxy({ ...assemble(backends), ...config });
  return {
    mocks,
    proxy,
    chat: (body = CHAT, headers) => postJson(`${proxy.url}/v1/chat/completions`, body, headers),
    stream: (body = CHAT, headers) => readStream(`${proxy.url}/v1/chat/completions`, { ...body, stream: true }, headers),
    async close() {
      await proxy.close();
      await Promise.all(mocks.map((mock) => mock.close()));
    },
  };
}

test("non-stream: falls over on 500 then 429, succeeds on the third provider", async () => {
  const s = await scenario([
    { name: "p1", behavior: "error500" },
    { name: "p2", behavior: "rate-limit" },
    { name: "p3", behavior: "ok" },
  ]);
  try {
    const res = await s.chat();
    assert.equal(res.status, 200);
    assert.match(res.json.choices[0].message.content, /hello from p3/);
    assert.equal(res.headers.get("x-llm-proxy-provider"), "p3");
    assert.equal(res.headers.get("x-llm-proxy-fallbacks"), "2");
    assert.equal(s.mocks[0].calls, 1);
    assert.equal(s.mocks[1].calls, 1);
    assert.equal(s.mocks[2].calls, 1);
  } finally {
    await s.close();
  }
});

test("non-stream: an empty answer counts as unusable", async () => {
  const s = await scenario([
    { name: "blank", behavior: "empty" },
    { name: "full", behavior: "ok" },
  ]);
  try {
    const res = await s.chat();
    assert.equal(res.status, 200);
    assert.match(res.json.model, /^full:/);
    assert.equal(res.headers.get("x-llm-proxy-provider"), "full");
  } finally {
    await s.close();
  }
});

test("non-stream: invalid JSON, error-in-200 and content_filter all fall over", async () => {
  for (const bad of ["invalid-json", "error-200", "content-filter"]) {
    const s = await scenario([
      { name: "bad", behavior: bad },
      { name: "good", behavior: "ok" },
    ]);
    try {
      const res = await s.chat();
      assert.equal(res.status, 200, `behavior ${bad}`);
      assert.equal(res.headers.get("x-llm-proxy-provider"), "good", `behavior ${bad}`);
    } finally {
      await s.close();
    }
  }
});

test("non-stream: a response deadline triggers failover", async () => {
  const s = await scenario(
    [
      { name: "silent", behavior: "hang" },
      { name: "alive", behavior: "ok" },
    ],
    { failover: { requestTimeoutMs: 400, firstTokenTimeoutMs: 400 } },
  );
  try {
    const res = await s.chat();
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("x-llm-proxy-provider"), "alive");
  } finally {
    await s.close();
  }
});

test("a deadline is reported as `timeout`, not as a network error", async () => {
  const s = await scenario([{ name: "silent", behavior: "hang" }], {
    failover: { requestTimeoutMs: 300, firstTokenTimeoutMs: 300 },
  });
  try {
    const res = await s.chat();
    assert.equal(res.status, 502);
    assert.equal(res.json.error.proxy.attempts[0].reason, "timeout");
    assert.match(res.json.error.proxy.attempts[0].message, /no response within 300ms/);

    const streamed = await s.stream();
    // Streaming failures are explained in the stream itself (see below).
    assert.equal(streamed.status, 200);
    assert.equal(streamed.error.proxy.attempts[0].reason, "timeout");
    assert.match(streamed.content, /no token within 300ms/);
  } finally {
    await s.close();
  }
});

test("every provider fails: OpenAI-shaped 502 listing each attempt", async () => {
  const s = await scenario([
    { name: "a", behavior: "error500" },
    { name: "b", behavior: "rate-limit" },
  ]);
  try {
    const res = await s.chat();
    assert.equal(res.status, 502);
    assert.equal(res.json.error.code, "all_providers_failed");
    assert.equal(res.json.error.proxy.attempts.length, 2);
    assert.deepEqual(
      res.json.error.proxy.attempts.map((attempt) => attempt.reason),
      ["upstream_error", "rate_limited"],
    );
  } finally {
    await s.close();
  }
});

test("streaming: a total failure is explained inside the stream", async () => {
  const s = await scenario([
    { name: "first", behavior: "error500" },
    { name: "second", behavior: "rate-limit" },
  ]);
  try {
    const res = await s.stream();

    // Not a 502: a streaming client would render that as an empty answer.
    assert.equal(res.status, 200);
    assert.match(res.contentType, /text\/event-stream/);
    assert.equal(res.headers.get("x-llm-proxy-failed"), "true", "machine-readable marker");
    assert.equal(res.done, true);
    assert.equal(res.finishReason, "stop", "a well-formed stream, so clients close it cleanly");

    // The person waiting gets told what happened, provider by provider.
    assert.match(res.content, /no provider could answer/i);
    assert.match(res.content, /first\/test-model, upstream_error: HTTP 500/);
    assert.match(res.content, /second\/test-model, rate_limited: HTTP 429/);

    // And the error object rides along for programmatic callers.
    assert.equal(res.error.code, "all_providers_failed");
    assert.deepEqual(
      res.error.proxy.attempts.map((attempt) => attempt.reason),
      ["upstream_error", "rate_limited"],
    );
  } finally {
    await s.close();
  }
});

test("streamErrorAsMessage: false keeps the bare 502 for streams", async () => {
  const s = await scenario([{ name: "broken", behavior: "error500" }], { failover: { streamErrorAsMessage: false } });
  try {
    const res = await s.stream();
    assert.equal(res.status, 502);
    assert.equal(JSON.parse(res.raw).error.code, "all_providers_failed");
  } finally {
    await s.close();
  }
});

test("streaming: failover stays silent as long as no token was sent", async () => {
  const s = await scenario([
    { name: "s1", behavior: "empty" },
    { name: "s2", behavior: "error500" },
    { name: "s3", behavior: "ok" },
  ]);
  try {
    const res = await s.stream();
    assert.equal(res.status, 200);
    assert.match(res.contentType, /text\/event-stream/);
    assert.equal(res.content, "hello from s3");
    assert.equal(res.done, true);
    assert.equal(res.error, null);
    assert.equal(res.finishReason, "stop");
    assert.equal(res.headers.get("x-llm-proxy-provider"), "s3");
    // No fragment from a failing provider may show up in the stream.
    assert.ok(!res.models.some((model) => model.startsWith("s1") || model.startsWith("s2")));
  } finally {
    await s.close();
  }
});

test("streaming: a drop after the first token ends the stream cleanly, without replay", async () => {
  const s = await scenario([
    { name: "dropped", behavior: "mid-stream-error" },
    { name: "backup", behavior: "ok" },
  ]);
  try {
    const res = await s.stream();
    assert.equal(res.status, 200);
    assert.equal(res.content, "start");
    assert.equal(res.error?.code, "stream_interrupted");
    assert.equal(res.done, true);
    // No replay: the client never receives two concatenated answers.
    assert.equal(s.mocks[1].calls, 0);
  } finally {
    await s.close();
  }
});

test("streaming: a first-token deadline falls over to the next provider", async () => {
  const s = await scenario(
    [
      { name: "silent", behavior: "hang" },
      { name: "fast", behavior: "ok" },
    ],
    { failover: { firstTokenTimeoutMs: 400 } },
  );
  try {
    const res = await s.stream();
    assert.equal(res.content, "hello from fast");
    assert.equal(res.headers.get("x-llm-proxy-provider"), "fast");
  } finally {
    await s.close();
  }
});

test("a 429 benches the provider: the next request does not call it again", async () => {
  const s = await scenario([
    { name: "limited", behavior: "rate-limit" },
    { name: "steady", behavior: "ok" },
  ]);
  try {
    await s.chat();
    assert.equal(s.mocks[0].calls, 1);

    const second = await s.chat();
    assert.equal(second.status, 200);
    assert.equal(second.headers.get("x-llm-proxy-provider"), "steady");
    assert.equal(second.headers.get("x-llm-proxy-fallbacks"), "0", "a benched provider is skipped without an attempt");
    assert.equal(s.mocks[0].calls, 1);
  } finally {
    await s.close();
  }
});

test("priority order is honoured and the first healthy provider wins", async () => {
  const s = await scenario([
    { name: "first", behavior: "ok" },
    { name: "second", behavior: "ok" },
  ]);
  try {
    const res = await s.chat();
    assert.equal(res.headers.get("x-llm-proxy-provider"), "first");
    assert.equal(s.mocks[1].calls, 0);
  } finally {
    await s.close();
  }
});

test("a provider becomes usable again after a success (failure streak reset)", async () => {
  const s = await scenario([
    { name: "flaky", behavior: "error500" },
    { name: "backup", behavior: "ok" },
  ]);
  try {
    await s.chat(); // flaky fails once, not benched yet, threshold is 2
    s.mocks[0].behavior = "ok";
    const res = await s.chat();
    assert.equal(res.headers.get("x-llm-proxy-provider"), "flaky");
    assert.equal(s.mocks[0].calls, 2);
  } finally {
    await s.close();
  }
});

test("an explicitly requested model is tried first, then the rest of the chain", async () => {
  const mocks = [await startMock("error500", { name: "slow" }), await startMock("ok", { name: "quick" })];
  const backends = [backend(mocks[0], { model: "slow-model", alias: "slow" }), backend(mocks[1], { model: "quick-model", alias: "quick" })];
  const proxy = await startProxy(assemble(backends));
  try {
    const res = await postJson(`${proxy.url}/v1/chat/completions`, { ...CHAT, model: "slow" });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("x-llm-proxy-provider"), "quick");

    const direct = await postJson(`${proxy.url}/v1/chat/completions`, { ...CHAT, model: "quick/quick-model" });
    assert.equal(direct.status, 200);
    assert.equal(direct.headers.get("x-llm-proxy-provider"), "quick");
    assert.equal(direct.headers.get("x-llm-proxy-fallbacks"), "0");
  } finally {
    await proxy.close();
    await Promise.all(mocks.map((mock) => mock.close()));
  }
});

test("crossModelFallback disabled: no failover outside the requested model", async () => {
  const mocks = [await startMock("error500", { name: "only" }), await startMock("ok", { name: "other" })];
  const backends = [backend(mocks[0], { model: "m-a", alias: "a" }), backend(mocks[1], { model: "m-b", alias: "b" })];
  const proxy = await startProxy({ ...assemble(backends), failover: { crossModelFallback: false } });
  try {
    const res = await postJson(`${proxy.url}/v1/chat/completions`, { ...CHAT, model: "a" });
    assert.equal(res.status, 502);
    assert.equal(mocks[1].calls, 0);
  } finally {
    await proxy.close();
    await Promise.all(mocks.map((mock) => mock.close()));
  }
});

test("Anthropic provider: request and response translated to the OpenAI shape", async () => {
  const mock = await startMock("anthropic", { name: "claude" });
  const proxy = await startProxy(assemble([backend(mock, { model: "claude-x", alias: "claude", type: "anthropic" })]));
  try {
    const res = await postJson(`${proxy.url}/v1/chat/completions`, {
      messages: [
        { role: "system", content: "Be brief." },
        { role: "user", content: "hi" },
      ],
      max_tokens: 50,
    });
    assert.equal(res.status, 200);
    assert.equal(res.json.object, "chat.completion");
    assert.match(res.json.choices[0].message.content, /hello from claude/);
    assert.equal(res.json.choices[0].finish_reason, "stop");
    assert.equal(res.json.usage.total_tokens, 11);

    const upstream = mock.state.requests.at(-1);
    assert.match(upstream.path, /\/messages$/);
    assert.equal(upstream.body.system, "Be brief.");
    assert.equal(upstream.body.max_tokens, 50);
    assert.equal(upstream.headers["x-api-key"], "sk-test");
    assert.equal(upstream.headers["anthropic-version"], "2023-06-01");

    const streamed = await readStream(`${proxy.url}/v1/chat/completions`, { messages: CHAT.messages, stream: true });
    assert.equal(streamed.content, "hello from claude");
    assert.equal(streamed.finishReason, "stop");
    assert.equal(streamed.done, true);
  } finally {
    await proxy.close();
    await mock.close();
  }
});

test("embeddings: failover works and the payload shape is preserved", async () => {
  const mocks = [await startMock("error500", { name: "e1" }), await startMock("ok", { name: "e2" })];
  const backends = [backend(mocks[0], { model: "emb-1", alias: "emb", kind: "embedding" }), backend(mocks[1], { model: "emb-2", alias: "emb", kind: "embedding" })];
  const proxy = await startProxy(assemble(backends));
  try {
    const res = await postJson(`${proxy.url}/v1/embeddings`, { model: "emb", input: "hello" });
    assert.equal(res.status, 200);
    assert.equal(res.json.data[0].embedding.length, 3);
    assert.equal(res.headers.get("x-llm-proxy-provider"), "e2");
  } finally {
    await proxy.close();
    await Promise.all(mocks.map((mock) => mock.close()));
  }
});

test("model probe measures time to first token and generation speed", async () => {
  const mock = await startMock("ok", { name: "measured" });
  const { probeModel } = await import("../src/probe.js");
  const { provider, model } = backend(mock, { model: "m-1", alias: "a" });
  const config = { failover: { firstTokenTimeoutMs: 5000 } };
  try {
    const result = await probeModel(config, model, provider);
    assert.equal(result.ok, true, result.message);
    assert.ok(result.ttftMs >= 0 && result.ttftMs <= result.totalMs, "TTFT within the total duration");
    assert.equal(result.tokens, 3, "completion tokens come from the usage chunk");
    assert.equal(result.tokensApprox, false);
    assert.ok(result.tokensPerSecond > 0, "a generation speed is reported");
    assert.match(result.message, /hello from measured/);
    // The usage hint is opt-in on the request, and asked for by default.
    assert.deepEqual(mock.state.requests.at(-1).body.stream_options, { include_usage: true });
    assert.equal(mock.state.requests.at(-1).body.stream, true);
  } finally {
    await mock.close();
  }
});

test("model probe retries without the usage hint when a provider rejects it", async () => {
  // Fails only while `stream_options` is present, succeeds on the retry.
  const mock = await startMock((body) => (body.stream_options ? "error400" : "ok"), { name: "picky" });
  const { probeModel } = await import("../src/probe.js");
  const { provider, model } = backend(mock, { model: "m-1", alias: "a" });
  try {
    const result = await probeModel({ failover: { firstTokenTimeoutMs: 5000 } }, model, provider);
    assert.equal(result.ok, true, result.message);
    assert.equal(mock.calls, 2, "one rejected attempt, then one clean retry");
    assert.equal(mock.state.requests.at(-1).body.stream_options, undefined);
    assert.equal(result.tokensApprox, true, "without usage, tokens are counted from chunks");
    assert.equal(result.tokens, 3);
  } finally {
    await mock.close();
  }
});

test("model probe reports an empty stream as a failure", async () => {
  const mock = await startMock("empty", { name: "silent" });
  const { probeModel } = await import("../src/probe.js");
  const { provider, model } = backend(mock, { model: "m-1", alias: "a" });
  try {
    const result = await probeModel({ failover: { firstTokenTimeoutMs: 5000 } }, model, provider);
    assert.equal(result.ok, false);
    assert.equal(result.ttftMs, null);
    assert.match(result.message, /empty answer/);
  } finally {
    await mock.close();
  }
});

test("utility endpoints: /v1/models, /health, /stats and an unknown route", async () => {
  const mock = await startMock("ok", { name: "single" });
  const proxy = await startProxy(assemble([backend(mock, { model: "m-1", alias: "primary" })]));
  try {
    const models = await (await fetch(`${proxy.url}/v1/models`)).json();
    assert.equal(models.object, "list");
    // One id per alias, without the provider/model form that would duplicate it.
    assert.deepEqual(
      models.data.map((entry) => entry.id),
      ["auto", "primary"],
    );
    assert.equal(models.data[1].owned_by, "single");

    const health = await (await fetch(`${proxy.url}/health`)).json();
    assert.equal(health.status, "ok");
    assert.equal(health.chatModels, 1);

    await postJson(`${proxy.url}/v1/chat/completions`, CHAT);
    const stats = await (await fetch(`${proxy.url}/stats`)).json();
    assert.equal(stats.chain[0].successes, 1);
    assert.equal(stats.chain[0].priority, 1);

    const unknown = await fetch(`${proxy.url}/v1/nope`, { method: "POST" });
    assert.equal(unknown.status, 404);
  } finally {
    await proxy.close();
    await mock.close();
  }
});

test("the proxy API key is enforced once configured", async () => {
  const mock = await startMock("ok", { name: "p" });
  const proxy = await startProxy({ ...assemble([backend(mock)]), server: { apiKey: "sk-proxy-secret" } });
  try {
    const anonymous = await postJson(`${proxy.url}/v1/chat/completions`, CHAT);
    assert.equal(anonymous.status, 401);
    assert.equal(anonymous.json.error.code, "invalid_api_key");

    const authenticated = await postJson(`${proxy.url}/v1/chat/completions`, CHAT, {
      authorization: "Bearer sk-proxy-secret",
    });
    assert.equal(authenticated.status, 200);
  } finally {
    await proxy.close();
    await mock.close();
  }
});

test("invalid request: missing messages", async () => {
  const mock = await startMock("ok", { name: "p" });
  const proxy = await startProxy(assemble([backend(mock)]));
  try {
    const res = await postJson(`${proxy.url}/v1/chat/completions`, { model: "auto" });
    assert.equal(res.status, 400);
    assert.equal(res.json.error.param, "messages");
  } finally {
    await proxy.close();
    await mock.close();
  }
});

test("no model configured: explicit 503", async () => {
  const proxy = await startProxy({ providers: [], models: [] });
  try {
    const res = await postJson(`${proxy.url}/v1/chat/completions`, CHAT);
    assert.equal(res.status, 503);
    assert.match(res.json.error.message, /No chat model configured/);
  } finally {
    await proxy.close();
  }
});

test("unknown model in strict mode: 404", async () => {
  const mock = await startMock("ok", { name: "p" });
  const proxy = await startProxy({
    ...assemble([backend(mock, { alias: "known" })]),
    failover: { strictModelMatch: true },
  });
  try {
    const res = await postJson(`${proxy.url}/v1/chat/completions`, { ...CHAT, model: "nope" });
    assert.equal(res.status, 404);
    assert.equal(mock.calls, 0);
  } finally {
    await proxy.close();
    await mock.close();
  }
});

test("unresolved API key (missing env var): entry skipped without any network call", async () => {
  const mocks = [await startMock("ok", { name: "keyless" }), await startMock("ok", { name: "keyed" })];
  const backends = [backend(mocks[0], { model: "m-1", alias: "a", apiKey: "env:MISSING_KEY_FOR_TEST" }), backend(mocks[1], { model: "m-2", alias: "b" })];
  const proxy = await startProxy(assemble(backends));
  try {
    const res = await postJson(`${proxy.url}/v1/chat/completions`, CHAT);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("x-llm-proxy-provider"), "keyed");
    assert.equal(mocks[0].calls, 0);
  } finally {
    await proxy.close();
    await Promise.all(mocks.map((mock) => mock.close()));
  }
});
