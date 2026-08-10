# llm-failover-proxy

**One local endpoint for all your LLM providers. When a model fails, the next one answers, your app never notices.**

Point any OpenAI-compatible app at `http://127.0.0.1:47821/v1` and forget about it. Behind that address sits a chain of models you ordered by preference. A model that errors, hits a rate limit, returns an empty answer or simply goes quiet is skipped, and the next one takes over mid-request, invisibly.

Slow counts as broken too: if your favourite model has not started answering after 5 seconds, the next one is asked **in parallel** and the first usable answer wins. Your order still matters, but one sluggish provider no longer sets your latency.

```bash
npm i -g llm-failover-proxy      # installs it, starts it, keeps it running
llm-failover-proxy               # paste your API keys
```

Needs [Node.js](https://nodejs.org) 22 or newer. Downloads **one package, ~190 kB**, no dependency tree.

---

## Install

```bash
npm i -g llm-failover-proxy
```

That single command:

1. writes a **default chain** of models (see [`defaults/catalog.json`](defaults/catalog.json)) so there is something to serve,
2. **starts the proxy in the background**, no terminal to keep open,
3. registers it to **start again at every login** (Startup folder on Windows, LaunchAgent on macOS, systemd user unit on Linux),
4. tells you which API keys are still missing.

npm hides what install scripts print, so that step is silent, `llm-failover-proxy status` shows what happened (add `--foreground-scripts` to the install command to watch it live).

Then run the wizard to paste your keys:

```bash
llm-failover-proxy
```

```
╭──────────────────────────────────────────────────────────────────────╮
│ Welcome to llm-failover-proxy  one endpoint, several providers        │
│                                                                      │
│ ▸ 1. Use the default chain    10 models across 3 providers           │
│   2. Start from scratch       add your own providers and models       │
│                                                                      │
│   the default chain, in order:                                       │
│     1. nvidia/z-ai/glm-5.2                                           │
│     2. opencode/laguna-s-2.1-free                                    │
│     3. nvidia/deepseek-ai/deepseek-v4-pro                            │
│        … and 7 more                                                  │
│   keys are stored in .env, never in the configuration file            │
╰──────────────────────────────────────────────────────────────────────╯
 ↑↓ move · enter choose · esc skip
```

It then asks for one key per provider, showing where to get each one. **Press enter to skip any of them**, a provider with no key is simply stepped over in the chain. Keys are saved to a `.env`; the configuration file only ever stores the _name_ of the variable, so it stays safe to share.

Nothing to install permanently? Use `npx llm-failover-proxy` instead, same tool, no background service and no login entry.

<details>
<summary>Not installing globally, or would rather nothing started on its own</summary>

- `npm i llm-failover-proxy` (as a project dependency) starts the background proxy but **does not** add a login entry: the path would vanish with `node_modules`. Add it yourself with `llm-failover-proxy enable`.
- **pnpm** blocks install scripts by default, so nothing starts on its own, run `llm-failover-proxy enable` (or `pnpm approve-builds`) when you do want it.
- `LLM_PROXY_NO_AUTOSTART=1 npm i -g llm-failover-proxy` installs the command and touches nothing else.
- `CI=1` (set automatically by every CI provider) also skips it.
- `llm-failover-proxy disable` undoes everything: no login entry, no running process.
</details>

## Use it

The proxy speaks the OpenAI API, so anything that talks to OpenAI works unchanged, just point it at the local address and use any non-empty API key.

```bash
curl http://127.0.0.1:47821/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"auto","messages":[{"role":"user","content":"Hello"}]}'
```

```python
from openai import OpenAI
client = OpenAI(base_url="http://127.0.0.1:47821/v1", api_key="unused")

print(client.chat.completions.create(
    model="auto",
    messages=[{"role": "user", "content": "Hello"}],
).choices[0].message.content)
```

```js
import OpenAI from "openai";
const client = new OpenAI({ baseURL: "http://127.0.0.1:47821/v1", apiKey: "unused" });
```

In an app that asks for settings (Cursor, Continue, Open WebUI, Zed, LibreChat…), fill in:

| Field               | Value                                                                   |
| ------------------- | ----------------------------------------------------------------------- |
| Base URL / API host | `http://127.0.0.1:47821/v1`                                             |
| API key             | anything, e.g. `unused` (unless you set one, see [Settings](#settings)) |
| Model               | `auto`                                                                  |

Streaming, tools/function calling, vision, JSON mode and embeddings all pass straight through.

### Which model name to ask for

| You send            | What happens                                                        |
| ------------------- | ------------------------------------------------------------------- |
| `auto` (or nothing) | your whole chain, in priority order, **the usual choice**           |
| an **alias**        | entries with that alias first, then the rest of the chain as backup |
| `provider/model`    | that exact entry first, then the rest of the chain                  |
| something unknown   | falls back to the default chain                                     |

Giving several entries the same alias makes a **failover group**: `fast` can mean one provider, then another, then a local model, in that order. `GET /v1/models` lists what is available.

Every answer says who served it, in the response headers: `x-llm-proxy-provider`, `x-llm-proxy-model`, `x-llm-proxy-attempt` (position in the chain), `x-llm-proxy-fallbacks` (how many failed first).

## Manage it

```
llm-failover-proxy              open the terminal UI
llm-failover-proxy setup        run the setup wizard again
llm-failover-proxy status       what is configured, what is running, live counters
llm-failover-proxy stats        just the counters table, then back to the shell
llm-failover-proxy logs         end of the background log
llm-failover-proxy stop         stop the background proxy
llm-failover-proxy restart      restart it
llm-failover-proxy enable       run in the background now, and at every login
llm-failover-proxy disable      remove the login entry and stop it
llm-failover-proxy start        run in this terminal instead (ctrl+c to stop)
llm-failover-proxy start -d     run in the background
llm-failover-proxy migrate      move keys out of the config file into the .env
```

`llmfp` is a shorter alias for the same command. Add `--config <path>` to work on another configuration, `--port`/`--host` to change where it listens.

`stats` prints once and returns, the _Status & stats_ screen of the UI is the live one, refreshing every two seconds until you leave it. Use `stats` in a script or when you just want a number back, and `stats --json` to pipe it somewhere. Counters are read from the running proxy when there is one, and from the file on disk when there is not, so the numbers are there even after a restart:

```
$ llmfp stats
Persisted counters (nothing running, read from disk)
  kept since 2026-08-10 09:12 · 6 request(s), 3 ok, 0 failed, 3 cancelled, 51.9k token(s)
  PRIO  TARGET                       REQ  OK  KO  CX  TOKENS  LAST LATENCY  BENCHED  LAST ERROR
  1     nvidia/z-ai/glm-5.2          3    0   0   3   0       -             -        -
  2     opencode/laguna-s-2.1-free   3    3   0   0   51.9k   10.72s        -        -
```

### The terminal UI

```
╭──────────────────────────────────────────────────────────────────────────╮
│ llm-failover-proxy  OpenAI-compatible proxy with provider failover       │
│  listening on 127.0.0.1:47821   providers 3   models 10                  │
│  background running (pid 24188)                                          │
│                                                                          │
│ ▸ 1. Providers          endpoints, API keys, protocol                    │
│   2. Models & priority  failover chain, live latency tests                │
│   3. Settings           port, timeouts, failover policy                  │
│   4. Status & stats     persisted counters and cooldowns                  │
│   5. Setup wizard       add the default chain, paste keys                 │
│   6. Start the server   closes this screen                                │
│   7. Quit                                                                 │
╰──────────────────────────────────────────────────────────────────────────╯
 ↑↓ move · enter open · 1-7 jump · q quit
```

Everything is keyboard driven: `↑↓` move, `a` add, `e` edit, `space` enable/disable, `d` delete, `t` test, `esc` back. Changes are saved immediately, and a proxy already running in the background picks them up, no restart, not even for a key you just pasted.

**Providers**, ready-made entries for OpenAI, Anthropic, OpenRouter, Groq, Mistral, DeepSeek, Together, Fireworks, Cerebras, xAI, Gemini, Azure, Ollama and LM Studio, or any custom endpoint. Keys are masked everywhere and stored in the `.env`; the table shows whether each one resolves (`env:GROQ_API_KEY` in green) or is missing (red).

**Models & priority**, the chain, in failover order. `⇧↑`/`⇧↓` (or `J`/`K`) move a model up or down.

**Press `t` to test every model for real.** Probes start 5 seconds apart to keep rate limits happy, but run in parallel, a model taking 30 seconds only delays its own row.

```
  #  ALIAS  PROVIDER    MODEL                ON     TTFT   TOK/S
▸ 1  fast   groq        llama-3.3-70b        ●   ✓   412ms   85.3
  2  big    openrouter  nemotron-3-ultra     ●   ⋯       -       -
  3  local  ollama      qwen3:8b             ●   ✗       -       -
```

`TTFT` is the wait before the first token, `TOK/S` the speed after it — the two numbers that tell you whether a model is worth its place in the chain. Token totals live in the counters (`llmfp stats`), where they add up over time.

## Where your settings live

Two files, side by side, **configuration** and **secrets** are deliberately kept apart:

| File                                    | Contents                                                                                                                                | Commit it?               |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| `config.json`                           | providers, models, priority order, timeouts. Keys appear only as `env:NVIDIA_API_KEY` references                                        | yes, if you want         |
| `.env`                                  | the actual API keys, one per line, `0600`                                                                                               | **never**                |
| `.env.example`                          | the variables the default chain expects, with links to get each key                                                                     | shipped with the package |
| `<config>.stats.json`                   | counters and cooldowns, so they survive restarts                                                                                        | no                       |
| `daemon.log`, `daemon.json`, `service/` | the background proxy: its output, its pid and port, and the copy of the CLI it runs (so uninstalling is never blocked by a file in use) | no                       |

The configuration file is looked up in this order: `--config <path>`, `$LLM_PROXY_CONFIG`, `./llm-proxy.config.json` or `./config.json`, then `%APPDATA%\llm-failover-proxy\config.json` (Windows) / `${XDG_CONFIG_HOME:-~/.config}/llm-failover-proxy/config.json`.

The `.env` is read from the current directory **and** from the folder holding the configuration file, so both a project-local and a machine-wide setup work. A real environment variable always wins over the file, handy in Docker or CI, where you can skip the `.env` entirely and just pass `NVIDIA_API_KEY=…`.

Upgrading from an older version that stored keys inside `config.json`? `llm-failover-proxy migrate` moves them to the `.env` and leaves `env:` references behind. `status` reminds you if any are left.

### Changing the default chain

The chain a fresh install starts with is plain JSON in [`defaults/catalog.json`](defaults/catalog.json): providers, the variable holding each key, and the models in priority order. Edit it, run `pnpm run env:example` to refresh `.env.example`, and every new install starts from your list. Existing installs are never overwritten, re-running the wizard only _adds_ what is missing.

## When things go wrong

That is the whole point of this proxy. What counts as a failure worth switching provider for:

| Situation                   | How it is detected                                                 |
| --------------------------- | ------------------------------------------------------------------ |
| HTTP error                  | any non-2xx (429, 5xx, 401/403, plain 4xx)                         |
| Rate limit                  | `429` → benched for as long as `Retry-After` says                  |
| Network, DNS or TLS failure | connection error                                                   |
| Silence                     | no answer (15 s), no first token (15 s), stalled stream (60 s)     |
| Empty answer                | no text, no `tool_calls`, no reasoning, streaming included         |
| Unusable answer             | invalid JSON, `{"error":…}` served with a `200`, missing `choices` |
| Censorship                  | `finish_reason: content_filter` (can be turned off)                |
| Missing key                 | unresolved `env:VAR` → skipped without a network call              |

**While streaming, nothing reaches your app before the first genuinely usable chunk.** Until then, failover is completely silent: even with three attempts in flight, only one answer is ever forwarded. If a stream breaks _after_ the first token, replaying it elsewhere would produce an incoherent answer, so it is closed cleanly with an explicit error instead.

**Repeat offenders are benched.** After two consecutive failures an entry is put on a cooldown that grows with each failure (15 s → 5 min); a `429` or an auth error benches it immediately. Benched entries are skipped, but still tried as a last resort if the whole chain is down, because trying beats failing. Any success clears the record. Counters and cooldowns are on disk, so a provider benched for 5 minutes stays benched across a restart.

### Racing the slow ones

```
t=0.0s   ask preferred-slow                       (would need 7s)
t=5.0s   still nothing → also ask second-medium   (the first keeps going)
t=6.2s   second-medium answers → the other attempt is dropped
         → 6.2s instead of 7s, and the preferred model still had first go
```

`hedgeDelayMs` (5 s) controls the wait, `maxInFlight` (3) caps how many attempts can run at once. A **failure** does not wait for the timer, the next candidate starts at once. A dropped attempt is neither a success nor a failure: it says nothing about that provider, so it never counts against it (it shows up as `cancelled` in the stats).

**This costs tokens.** A provider that answers just after the winner still generated, and billed, its answer. Raise `hedgeDelayMs`, or set `maxInFlight: 1`, to trade latency for cost.

### When every model fails

Your app gets a real explanation instead of a silent error, streamed like a normal answer:

```
⚠️  llm-failover-proxy: no provider could answer this request.

  1. groq/llama-3.3-70b, rate_limited: HTTP 429, rate limit reached
  2. openrouter/nemotron-ultra, upstream_error: HTTP 500, provider is down
  3. ollama/qwen3:8b, empty_response: stream ended without usable content

Run `llm-failover-proxy status` or read the proxy logs for the full picture.
```

The response is still marked as a failure for programs (`x-llm-proxy-failed: true`, plus a machine-readable `error` object in the final chunk), and non-streamed requests get an OpenAI-shaped `502` detailing every attempt.

## Settings

Everything below is in the UI under `3. Settings`, where each line explains itself and what flipping it would do, or straight in `config.json`. The defaults are meant to be left alone — reach for these when something specific bothers you.

### Where it listens

| Key | Default | What it does |
|---|---|---|
| `server.host` | `127.0.0.1` | `127.0.0.1` = this machine only. `0.0.0.0` exposes it to your network — **set `server.apiKey` first** |
| `server.port` | `47821` | the port your apps point at. If it is taken, the next free one is used and printed at startup |
| `server.apiKey` | none | key your own apps must send. Empty means no check, which is fine on `127.0.0.1`. `env:LLM_PROXY_API_KEY` keeps it in the `.env` |
| `server.cors` | `true` | whether a web page may call the proxy straight from the browser |
| `server.logLevel` | `info` | `debug` prints every attempt and its timing |

### How long a model gets

Three different deadlines, because "too slow" means different things before and during an answer. Each one, when it expires, drops that attempt and moves to the next model.

| Key | Default | Expires when |
|---|---|---|
| `requestTimeoutMs` | 15000 | a non-streamed answer has not arrived **complete** |
| `firstTokenTimeoutMs` | 15000 | a streamed answer has not **started** |
| `idleTimeoutMs` | 60000 | a started stream has gone **quiet** for that long |

### Trying several models

| Key | Default | What it does |
|---|---|---|
| `hedgeDelayMs` | 5000 | how long your favourite model gets alone before the next one is asked **in parallel**. `0` = strictly one at a time |
| `maxInFlight` | 3 | how many models may work on the same request at once. `1` disables racing. Every loser still generated tokens you may be billed for |
| `maxAttempts` | 0 | how many models to try before giving up. `0` = the whole chain |
| `cooldown.failuresBeforeTrip` | 2 | consecutive failures before a model is set aside. A `429` or an auth error sets it aside immediately, whatever this says |
| `cooldown.baseMs` / `maxMs` | 15000 / 300000 | how long that lasts: doubling with each new failure, from the first value up to the second. A `Retry-After` from the provider wins over both. Any success resets it |

### When to substitute, and when to refuse

These four decide whether the client gets *an* answer or *the* answer. This is where a proxy can help you or lie to you, so they are worth a minute.

| Key | Default | The question it answers |
|---|---|---|
| `strictModelMatch` | `false` | A client asks for a model that is **nowhere in your chain**. `false`: the whole chain answers anyway — apps that hardcode `gpt-4o` just work. `true`: `404`, no provider is called |
| `crossModelFallback` | `true` | The requested model is **known but failing**. `true`: the rest of the chain takes over. `false`: the request fails rather than switch model |
| `treatContentFilterAsFailure` | `true` | A provider cut the answer for content reasons. `true`: try another model. `false`: hand the refusal back as it came |
| `streamErrorAsMessage` | `true` | Every model failed on a streamed request. `true`: the reason is streamed as a readable answer. `false`: a bare `502`, which most chat apps render as an empty reply |

The first two are often confused. They act at different moments:

```
client asks for "typo-3.5"          →  strictModelMatch decides    (unknown name)
client asks for "fast", fast is 500 →  crossModelFallback decides  (known, failing)
```

So for **"never serve me anything other than what I asked for"**, you need both: `strictModelMatch: true` *and* `crossModelFallback: false`. With the defaults, the opposite is true — something always tries to answer, and the `x-llm-proxy-model` header tells you who actually did.

## Troubleshooting

**Every answer says "no provider could answer".** No usable key. Run `llm-failover-proxy status`: providers whose key is missing are shown in red. Paste keys with `llm-failover-proxy` (wizard, or Providers → `e`), or write them into the `.env`, a running proxy picks them up within a second.

**Is it actually running?** `llm-failover-proxy status` shows the process, its port and its counters; `curl http://127.0.0.1:47821/health` answers `200`. If a port was taken, the real one is in `status` and in `daemon.json`.

**It did not come back after a reboot.** `llm-failover-proxy enable` (re-)registers it. The entry is a plain file you can inspect or delete: `…\Start Menu\Programs\Startup\llm-failover-proxy.vbs` on Windows, `~/Library/LaunchAgents/com.llm-failover-proxy.plist` on macOS, `~/.config/systemd/user/llm-failover-proxy.service` on Linux. On Linux, a user service normally waits for your first login, `loginctl enable-linger $USER` starts it at boot instead.

**Something went wrong in the background.** `llm-failover-proxy logs` prints the end of the log (`daemon.log`, next to the configuration).

**I want it gone.** `llm-failover-proxy disable`, then `npm rm -g llm-failover-proxy`. Either order works, uninstalling never fails because the proxy is running, and a login entry left behind by an uninstalled package removes itself the next time it fires. Your configuration and keys stay where they are.

**A provider needs a special header, or a fixed `max_tokens`.** Both are supported per provider and per model in `config.json` (`headers`, `params`).

## For developers

```bash
git clone <this repo> && cd llm-failover-proxy
pnpm install
pnpm test              # 86 tests, no network access
node src/index.js      # run from source, no build step
pnpm run build         # bundle dist/index.js
pnpm run demo          # live failover demo against three fake providers
```

The proxy itself, server, router, adapters, config, stats, is **dependency-free plain ESM**. Ink and React are used by the terminal UI only, as devDependencies: the build tree-shakes them into a single `dist/index.js`, which is why installing costs one file and no dependency tree.

Two upstream protocols are supported per provider: **`openai`** (any OpenAI-compatible API, full pass-through of `tools`, `response_format`, vision and provider extensions) and **`anthropic`** (the Messages API, translated both ways, system prompt, `tools` ↔ `input_schema`, `tool_calls` ↔ `tool_use`, images, `stop_reason` ↔ `finish_reason`, streaming events → OpenAI chunks). Clients only ever see the OpenAI shape.

```
src/index.js               commands and options
src/cli.js                 plain-text status report, UI launcher
src/config.js              config resolution, load/save, key references
src/env.js                 .env parsing, loading and safe writing
src/catalog.js             the default chain, and merging it into a config
src/daemon.js              background process and start-at-login entries
src/server.js              HTTP server, OpenAI endpoints, tracing headers
src/router.js              chain resolution, failover, racing, streaming
src/state.js               persisted counters and circuit breaker
src/probe.js               reachability, latency and throughput probes
src/adapters/              OpenAI and Anthropic protocols
src/tui/                   terminal UI (Ink): widgets, forms, screens
defaults/catalog.json      the chain a fresh install starts with
scripts/                   bundler, postinstall, .env.example generator
```

The fake providers in `tests/mock-provider.js` simulate success, `500`, `429` + `Retry-After`, `401`, `400`, empty answers (JSON and SSE), invalid JSON, error-in-`200`, `content_filter`, a mid-stream drop, total silence, slow first tokens, the Anthropic protocol and embeddings. The suite covers streamed and non-streamed failover, the circuit breaker, racing (winner selection, cancellation accounting, concurrency cap), priority and alias selection, the Anthropic translation, authentication, `.env` handling, key migration, the default catalogue, the background service (a really detached process, its login entry, and stop), stats persistence across restarts, every UI screen through `ink-testing-library`, and the published bundle itself, including mounting its UI, which is the only way a broken bundle shows up.

## License

MIT
