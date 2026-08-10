/**
 * End-to-end demo, no real API key involved.
 *
 * Starts three fake providers (rate-limited, empty answer, healthy), runs the
 * real proxy in front of them, then sends one regular request and one streaming
 * request to show the failover in action.
 *
 *   node examples/demo.js
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { startServer } from "../src/server.js";
import { startMock } from "../tests/mock-provider.js";

const line = (text = "") => process.stdout.write(`${text}\n`);

const mocks = {
  limited: await startMock("rate-limit", { name: "saturated-provider" }),
  blank: await startMock("empty", { name: "empty-provider" }),
  healthy: await startMock("ok", { name: "healthy-provider" }),
};

const providers = Object.values(mocks).map((mock, index) => ({
  id: `prov_${index}`,
  name: mock.name,
  type: "openai",
  baseUrl: mock.baseUrl,
  apiKey: "sk-demo",
  enabled: true,
  headers: {},
}));

const models = providers.map((provider, index) => ({
  id: `mdl_${index}`,
  providerId: provider.id,
  model: `demo-model-${index + 1}`,
  alias: "demo",
  kind: "chat",
  enabled: true,
  params: {},
}));

const dir = await fs.mkdtemp(path.join(os.tmpdir(), "llm-proxy-demo-"));
const configFile = path.join(dir, "config.json");
await fs.writeFile(configFile, JSON.stringify({ server: { host: "127.0.0.1", port: 0, logLevel: "info" }, providers, models }, null, 2));

const app = await startServer({ configFile });
const endpoint = `${app.url}/v1/chat/completions`;
const request = (extra = {}) => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ model: "demo", messages: [{ role: "user", content: "hi" }], ...extra }),
});

line("── 1. Regular request ──────────────────────────────────────────");
const response = await fetch(endpoint, request());
const json = await response.json();
line(`   chosen provider : ${response.headers.get("x-llm-proxy-provider")} (after ${response.headers.get("x-llm-proxy-fallbacks")} fallback(s))`);
line(`   answer          : ${json.choices[0].message.content}`);
line("");

line("── 2. Streaming request ────────────────────────────────────────");
const streamed = await fetch(endpoint, request({ stream: true }));
line(`   content-type    : ${streamed.headers.get("content-type")}`);
line(`   chosen provider : ${streamed.headers.get("x-llm-proxy-provider")}`);
process.stdout.write("   tokens          : ");

const reader = streamed.body.getReader();
const decoder = new TextDecoder();
let buffer = "";
for (;;) {
  const { value, done } = await reader.read();
  if (done) break;
  buffer += decoder.decode(value, { stream: true });
  const blocks = buffer.split("\n\n");
  buffer = blocks.pop();
  for (const block of blocks) {
    const data = block.replace(/^data:\s*/, "");
    if (!data || data === "[DONE]") continue;
    const piece = JSON.parse(data).choices?.[0]?.delta?.content;
    if (piece) process.stdout.write(`[${piece}]`);
  }
}
line("\n");

line("── 3. Proxy stats ──────────────────────────────────────────────");
const stats = await (await fetch(`${app.url}/stats`)).json();
for (const row of stats.chain) {
  line(
    `   ${row.priority}. ${row.provider}/${row.model}, ${row.successes} ok / ${row.failures} ko` +
      `${row.coolingDown ? ` (benched ${Math.round(row.cooldownMsLeft / 1000)}s)` : ""}` +
      `${row.lastError ? `, last error: ${row.lastError.reason}` : ""}`,
  );
}
line("");
line(`   Calls actually received: saturated=${mocks.limited.calls}, empty=${mocks.blank.calls}, healthy=${mocks.healthy.calls}`);
line("   (the saturated provider is not called again while it is benched)");
line("");

app.server.closeAllConnections?.();
app.server.close();
await Promise.all(Object.values(mocks).map((mock) => mock.close()));
await fs.rm(dir, { recursive: true, force: true });
