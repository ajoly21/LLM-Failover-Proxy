# llm-failover-proxy

**One local endpoint for all your LLM providers. When a model fails, the next one answers, your app never notices.**

Point any OpenAI-compatible app at `http://127.0.0.1:47821/v1` and forget about it. Behind that address sits a chain of models you ordered by preference. A model that errors, hits a rate limit, returns an empty answer or simply goes quiet is skipped, and the next one takes over mid-request, invisibly.

Slow counts as broken too: if your favourite model has not started answering after 5 seconds, the next one is asked **in parallel** and the first usable answer wins. Your order still matters, but one sluggish provider no longer sets your latency.

```bash
npm i -g llm-failover-proxy      # installs it, starts it, keeps it running
llm-failover-proxy               # paste your API keys
llmfp                            # …or type this instead, it is the same command
```

Needs [Node.js](https://nodejs.org) 22 or newer. Downloads **one package, ~190 kB**, no dependency tree.

`llmfp` is a shorter alias for `llm-failover-proxy`: both names are installed, they point at the same file, and **every command in this README works with either one.** The long name is used below because it says what it is; `llmfp status`, `llmfp stats`, `llmfp doctor` are what you will actually type.

---

## Why this exists

**Some of the best models around are free.** Providers hand out real free tiers — NVIDIA NIM, OpenRouter, opencode, Groq, Gemini — and a few of them serve frontier-grade models at no cost. The catch is that a free tier is never quite there when you need it: quota already spent, rate limit hit after a handful of requests, endpoint saturated at peak hours, model retired overnight, or a very long wait before the first token. Great model, unreliable access.

So a single free key cannot be _the_ backend of an app. A dozen of them, put in order, can. That is the whole idea: **you rank the models by preference, and the proxy answers with the best one that is actually reachable right now.** Your first choice is tried first on every request; when it is out of quota, benched or silent, the next one answers and your app never learns that anything happened. Ten free tiers behind one address behave like one endpoint that is always up — and you get to spend all of them, instead of exhausting one and waiting for the reset.

**It is meant for free models in particular, and the racing is why.** When your favourite model has not started answering after 5 seconds, the next one is asked in parallel and the first usable answer wins. That costs tokens twice — a price worth paying precisely when the tokens are free. The same trick that would be wasteful on a metered key is what makes a pile of free ones feel fast, and it stays adjustable (`hedgeDelayMs`, `maxInFlight`) for the day you point the chain at something you pay for.

## Install

```bash
npm i -g llm-failover-proxy
```

That single command:

1. checks that your shell can actually find the `llmfp` command, and tells you what to add to `PATH` if it cannot,
2. writes a **default chain** of models (see [`defaults/catalog.json`](defaults/catalog.json)) so there is something to serve,
3. **starts the proxy in the background**, no terminal to keep open,
4. registers it to **start again at every login** (Startup folder on Windows, LaunchAgent on macOS, systemd user unit on Linux),
5. tells you which API keys are still missing.

npm collects what install scripts print and only shows it on failure, so those lines are written straight to your terminal instead. If you piped the install, or ran it from a script, `llm-failover-proxy doctor` says the same thing afterwards.

Then run the wizard to paste your keys:

```bash
llm-failover-proxy
```

```
╭──────────────────────────────────────────────────────────────────────╮
│ Welcome to llm-failover-proxy  one endpoint, several providers       │
│                                                                      │
│ ▸ 1. Use the default chain    11 models across 3 providers           │
│   2. Start from scratch       add your own providers and models      │
│                                                                      │
│   the default chain, in order:                                       │
│     1. nvidia/z-ai/glm-5.2                                           │
│     2. nvidia/nvidia/nemotron-3-super-120b-a12b                      │
│     3. opencode/big-pickle                                           │
│     4. nvidia/minimaxai/minimax-m3                                   │
│     5. openrouter/nvidia/nemotron-3-ultra-550b-a55b:free             │
│     6. opencode/deepseek-v4-flash-free                               │
│        … and 5 more                                                  │
│   keys are stored in .env, never in the configuration file           │
╰──────────────────────────────────────────────────────────────────────╯
 ↑↓ move · enter choose · esc skip
```

It then asks for one key per provider, showing where to get each one. **Press enter to skip any of them**, a provider with no key is simply stepped over in the chain. Keys are saved to a `.env`; the configuration file only ever stores the _name_ of the variable, so it stays safe to share.

Nothing to install permanently? Use `npx llm-failover-proxy` instead, same tool, no background service and no login entry.

### `llmfp: command not found`

The proxy itself is fine — it runs from absolute paths and needs no `PATH` at all. The _command_ does, and npm links it into a directory your shell may not look in. This happens with **nvm, fnm, volta**, or after `npm config set prefix`. Ask where it went:

```bash
llm-failover-proxy doctor        # or, if that is the command you cannot run:
npm bin -g
```

Then add that directory once, and open a new terminal — a running shell keeps the `PATH` it started with:

| Shell                | Once, and for good                                                                                    |
| -------------------- | ----------------------------------------------------------------------------------------------------- |
| PowerShell / cmd     | `[Environment]::SetEnvironmentVariable('Path', [Environment]::GetEnvironmentVariable('Path','User') + ';<dir>', 'User')` |
| bash                 | `echo 'export PATH="<dir>:$PATH"' >> ~/.profile`                                                      |
| zsh                  | `echo 'export PATH="<dir>:$PATH"' >> ~/.zprofile`                                                     |
| fish                 | `fish_add_path <dir>`                                                                                 |

Cron jobs and systemd units read none of those files: give those the absolute command, which `doctor` prints for you.

### Updating

**The menu tells you when a release is out, and `u` installs it.**

```
│  ● update available 1.2.0 → 1.3.0   press u to install it                    │
╰──────────────────────────────────────────────────────────────────────────────╯
 ↑↓ move · enter open · 1-7 jump · u update · q quit
```

The UI closes first, then npm runs in your terminal with its own output — and its install hook restarts the background proxy on the new version. Nothing to do by hand.

Or, at any time:

```bash
npm i -g llm-failover-proxy@latest
```

Your configuration, keys and counters live outside the package and are never touched by an update.

<details>
<summary>What that check does, exactly</summary>

- It runs **only when you open the UI** or run `llmfp doctor` — never in the background, and the proxy itself never checks. It asks the npm registry for one thing, `dist-tags`, a few dozen bytes.
- The answer is cached next to your configuration in `update.json` for five minutes. That is not there to ration how often you may look: it is so that a script calling `doctor` in a loop cannot turn into traffic.
- It is the **only outbound request** this tool makes on its own behalf. Everything else goes to the providers you configured.
- It never delays anything: the menu is drawn first, and if the registry does not answer within a couple of seconds, nothing is said. Offline is not an error.
- `u` only appears for a **global install**. From a checkout or an `npm link`, installing the release would replace the copy you are running, so the command is printed instead of offered.
- Turn it off in **Settings → check for updates**, or per run with `LLM_PROXY_NO_UPDATE_CHECK=1`. `llmfp doctor` also reports what it knows.
</details>

<details>
<summary>Not installing globally, or would rather nothing started on its own</summary>

- `npm i llm-failover-proxy` (as a project dependency) starts the background proxy but **does not** add a login entry: the path would vanish with `node_modules`. Add it yourself with `llm-failover-proxy enable`.
- **pnpm** blocks install scripts by default, so nothing starts on its own, run `llm-failover-proxy enable` (or `pnpm approve-builds`) when you do want it.
- `LLM_PROXY_NO_AUTOSTART=1 npm i -g llm-failover-proxy` installs the command and touches nothing else.
- `CI=1` (set automatically by every CI provider) also skips it.
- `llm-failover-proxy disable` undoes everything: no login entry, no running process.
- On a **headless Linux** box, `systemctl --user` needs a live user session. `enable` says so when the unit could not be activated; `loginctl enable-linger $USER` makes the service survive logout.
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

Both names do the same thing, on every line below: **`llm-failover-proxy`, or `llmfp` for short.**

```
llm-failover-proxy              open the terminal UI
llmfp                           exactly the same, and so for every command below
llm-failover-proxy setup        run the setup wizard again
llm-failover-proxy status       what is configured, what is running, live counters
llm-failover-proxy stats        just the counters table, then back to the shell
llm-failover-proxy lists        the model lists, and which one is being served
llm-failover-proxy describe     what each list is for, and how to serve it
llm-failover-proxy use <name>   serve another model list, by name or by its number
llm-failover-proxy warp         which address the providers see, and how to change it
llm-failover-proxy logs         end of the background log
llm-failover-proxy stop         stop the background proxy
llm-failover-proxy restart      restart it
llm-failover-proxy enable       run in the background now, and at every login
llm-failover-proxy disable      remove the login entry and stop it
llm-failover-proxy start        run in this terminal instead (ctrl+c to stop)
llm-failover-proxy start -d     run in the background
llm-failover-proxy doctor       is this install usable from any shell?
```

Add `--config <path>` to work on another configuration, `--port`/`--host` to change where it listens. Both apply whichever of the two names you typed.

**None of these needs a terminal.** Piped, scripted, or run from a cron job, every command prints plain text and exits — including `llmfp` on its own, which reports instead of opening the menus when there is nothing to draw on. `doctor` exits non-zero when the command is not on `PATH`, so an install script can branch on it, and `doctor --json` / `stats --json` give the same facts as machine-readable output.

`stats` prints once and returns, the _Status & stats_ screen of the UI is the live one, refreshing every two seconds until you leave it. Use `stats` in a script or when you just want a number back, and `stats --json` to pipe it somewhere. Counters are read from the running proxy when there is one, and from the file on disk when there is not, so the numbers are there even after a restart:

```
$ llmfp stats
Persisted counters (nothing running, read from disk)
  kept since 2026-08-10 09:12 · 9 request(s), 4 ok, 1 failed, 4 cancelled, 51.9k token(s)
  PRIO  TARGET                       REQ  OK  KO  CX  USE  UPTIME  TOKENS  LAST USED  LAST ERROR
  1     nvidia/z-ai/glm-5.2          5    1   1   3   25%  50%     12.1k   14min ago  empty: no content
  2     opencode/laguna-s-2.1-free   4    3   0   1   75%  100%    39.8k   23s ago    -

  last 4 answered
  WHEN       MODEL                       TTFT   VIA
  23s ago    opencode/laguna-s-2.1-free  431ms  direct
  2min ago   opencode/laguna-s-2.1-free  1.20s  direct
  14min ago  nvidia/z-ai/glm-5.2         2.84s  direct
  1h ago     opencode/laguna-s-2.1-free  680ms  direct
```

| Column       | Reads as                                                                                              |
| ------------ | ----------------------------------------------------------------------------------------------------- |
| `REQ`        | times this model was asked, racing attempts included                                                  |
| `OK` / `KO`  | answers it delivered / attempts that failed                                                           |
| `CX`         | attempts dropped because a faster model had already answered — this is why `REQ` can exceed `OK + KO` |
| `USE`        | its share of the answers you actually got: how much of your traffic this model really serves           |
| `UPTIME`     | availability: of the attempts it was allowed to finish, how many it answered                           |
| `TOKENS`     | tokens it has produced, accumulated across restarts                                                   |
| `LAST USED`  | how long since it last answered. An entry nothing ever reaches reads `-`                              |
| `LAST ERROR` | why it failed the last time, if it has                                                                |

Both percentages ignore the dropped races, so neither punishes a model for being fast enough to be raced against. `USE` at `0%` means this model has never served an answer: either it sits far enough down the chain never to be reached, or it fails when it is — `UPTIME` tells you which.

The rows are always in **your** priority order, the same as the _Models lists_ screen, even when the proxy answering is a background instance still serving an older file. And `last N answered` is the one thing totals cannot tell you: whether anything is being served right now, and by which model — with `TTFT`, the wait before that answer started, and `VIA`, the way it left. That last column reads `direct` when the request went straight out from this machine and `warp` when it went through the tunnel; see [Cloudflare WARP](#cloudflare-warp-which-address-the-providers-see).

**The counters shown are those of the model list in use, and only those.** The models of your other lists keep their own history on disk — switching away from a list does not lose it, and switching back shows it again — but they are never mixed into the list you are reading. If the answering proxy reports models this list does not have, they are counted on a line of their own rather than added to the table: `2 more model(s) served, in another list or another config`.

### The terminal UI

```
╭──────────────────────────────────────────────────────────────────────────╮
│ llm-failover-proxy  OpenAI-compatible proxy with provider failover       │
│  listening on 127.0.0.1:47821   providers 3   models 10                  │
│  background running (pid 24188)                                          │
│                                                                          │
│ ▸ 1. Providers         endpoints, API keys, protocol                     │
│   2. Models lists      failover chains, switch them, live tests          │
│   3. Settings          port, timeouts, failover policy                   │
│   4. Status & stats    persisted counters and cooldowns                  │
│   5. Setup wizard      add the default chain, paste keys                 │
│   6. Start the server  closes this screen                                │
│   7. Quit                                                                │
╰──────────────────────────────────────────────────────────────────────────╯
 ↑↓ move · enter open · 1-7 jump · q quit
```

Everything is keyboard driven: `↑↓` move, `a` add, `e` edit, `space` enable/disable, `d` delete, `t` test, `esc` back. Changes are saved immediately, and a proxy already running in the background picks them up, no restart, not even for a key you just pasted.

**It fits the terminal it is given**, down to a phone over SSH. Tables give up their least useful columns rather than wrapping — a 40-column screen keeps the priority number, the name and the on/off mark — long names shorten with a `…`, and lists take only the rows the window has. Resize the window and it follows.

**Providers**, ready-made entries for OpenAI, Anthropic, OpenRouter, Groq, Mistral, DeepSeek, Together, Fireworks, Cerebras, xAI, Gemini, Azure, Ollama and LM Studio, or any custom endpoint. Keys are masked everywhere and stored in the `.env`; the table shows whether each one resolves (`env:GROQ_API_KEY` in green) or is missing (red).

**Models lists**, the chain, in failover order. To move a model, press `m` to pick it up, `↑↓` to carry it, `enter` to drop it. No modifier is involved, because phone keyboards and several SSH clients cannot send one — `⇧↑`/`⇧↓` and `J`/`K` still work where they do.

**Adding a model asks the provider what it serves.** Pick the provider and the model id field fills itself from that provider's own `/models` list — so you type what you remember rather than what you can quote. The match is on any part of the name, not its start: with nvidia selected, `glm` offers `z-ai/glm-5.2`, and several words narrow it further (`glm free`). `↑↓` walks the list — scrolling through the matches that do not fit, the count below says where you are — `enter` takes one, `tab` moves to the next field, and models already in your chain are marked as such. A provider that cannot be reached — no key yet, or offline — says so and leaves the field a plain text box, so nothing here can stop you typing an id by hand.

```
▸ model id  glm
            z-ai/glm-5.2
          ▸ z-ai/glm-4.7-air   already in the chain
            z-ai/glm-5.2-free
```

**One chain is rarely enough.** A model list is a named chain, and you can keep several: a cheap one for everyday work, a long one for the day the cheap providers are down, one holding nothing but local models. The line above the table says which one is live, and the keys to the rest are on it:

```
  list  ‹ cheap-and-fast ›  2/3
  everyday work — free tiers first, nothing metered in the chain
  ←→ switch list · n new list · c copy list · r rename list · w when to use · x delete list
```

Every key that acts on a list is written **there**, under the name of the list it acts on — the hints at the foot of the screen are the chain's own keys, and the two are never mixed. `←→` switches the list being served, `n` starts a new empty one, `c` copies the one you are on, `r` renames it, `x` removes it — the name is typed straight into that line, no form, no second screen. The list you switch to becomes the chain the proxy answers with immediately: a background instance picks it up through its config watcher, with no restart, so switching lists **is** how you compare them under real traffic. The other lists sit in the config file untouched until you come back to them.

| Key  | Does                                                                                                                       |
| ---- | -------------------------------------------------------------------------------------------------------------------------- |
| `←→` | serve the previous / next list, wrapping at both ends                                                                      |
| `n`  | a new **empty** list, to fill with `a`                                                                                     |
| `c`  | a **copy** of this list — same models, same order — for trying a variant. The copies are new entries, so the copy's counters start at zero rather than inheriting traffic it never served |
| `r`  | rename this list                                                                                                           |
| `w`  | **when to use** this list: one line saying what it is for, shown under its name and everywhere a list is picked. Blank clears it |
| `x`  | delete this list, after a `y/n`. Never offered for the last one: something has to be served. Deleting the live list hands the chain to the list that takes its place |

`c` rather than a shifted `n`: `N` reads as a second way to say "new list", and got pressed for one.

### Say when each list should be the one serving

A name is not a reason. Three months after building `fast-2`, `cheap-and-fast` and `local`, the question you have in front of the switcher is not *which lists exist* — it is **which one do I want right now**, and no name answers that on its own.

So a list carries one line of your own words, the same way an MCP server carries a description telling a model when to call it: `w`, type it, `enter`. It is shown under the list name while you switch, in `llmfp lists`, and echoed back by `llmfp use` so a name matched on a fragment confirms itself.

```
  1  free-only       11  11  -    everyday work — free tiers first, nothing metered
  2  paid-fallback    4   4  yes  the day every free tier is out of quota, and it has to answer
  3  local-only       2   2  -    on the plane, or when nothing may leave the machine
```

Write it for the version of you who has forgotten why the list exists. A copy inherits the note, because a variant is tried for the same job as the list it came from — and a note that stopped being true is worse than none, so blank clears it.

### `llmfp describe`: the report something else chooses by

The notes are worth writing because something other than you reads them. `llmfp describe` prints every list purpose-first, with the command that serves it underneath — which is all an agent, a deploy script or a colleague needs to pick the right chain without opening the config:

```
$ llmfp describe
  Model lists — what each one is for. Pick by the note, then run the command under it.

  free-only (1/3 · 11 model(s), 11 enabled)
    everyday work — free tiers first, nothing metered
    llmfp use free-only

  paid-fallback (2/3 · 4 model(s), 4 enabled)   serving now
    the day every free tier is out of quota, and it has to answer

  on the plane (3/3 · 2 model(s), 2 enabled)
    no note yet — llmfp describe "on the plane" "when this list should serve"
    llmfp use "on the plane"
```

The same command writes them, so whatever built a chain can explain it in the same breath:

```bash
llmfp describe                              # every list, its note, and how to serve it
llmfp describe free-only                    # just that note, on its own line, ready to pipe
llmfp describe free-only "everyday work"    # says when that list should be the one serving
llmfp describe free-only ""                 # takes the note back
llmfp describe --json                        # the same, with a ready-to-run `use` per list
```

Reading and writing are told apart by how many words arrive, not by the note being blank — which is what leaves `""` free to mean *clear it*. A name that would not survive a shell is quoted in every command the report prints, so the line can be pasted as it stands. An unknown name exits non-zero, the same as `use`.

**None of this needs the UI**, for a script or a shell you want back: `llmfp lists` prints the lists with their notes and marks the one being served, `llmfp use <name|index>` switches to another — by its number, its name, or enough of the name to be unambiguous.

```
$ llmfp lists
Model lists — the active one is the chain the proxy serves
  #  NAME            MODELS  ON  ACTIVE  WHEN TO USE
  1  default         11      11  -       everything, in failover order
  2  cheap-and-fast  4       3   yes     everyday work — free tiers first, nothing metered

$ llmfp use default
  now serving default (1/2)   11 model(s), 11 enabled
  everything, in failover order
  the background proxy (pid 24188) reads the file on every request, so this is already live
```

`use` exits non-zero when the name matches no list, or two, so a deploy script can branch on it; `lists --json` and `use --json` give the same facts as machine-readable output, the note included, which is what a shell picker needs to offer more than bare names.

**Press `t` to test every model for real.** Probes start 5 seconds apart to keep rate limits happy, but run in parallel, a model taking 30 seconds only delays its own row. Each one gives up after `probe.timeoutMs` (15 s), which you can raise from the Settings screen without touching what production waits for.

```
  #  ALIAS  PROVIDER    MODEL                ON     TTFT   TOK/S
▸ 1  fast   groq        llama-3.3-70b        ●   ✓   412ms   85.3
  2  big    openrouter  nemotron-3-ultra     ●   ⋯       -       -
  3  local  ollama      qwen3:8b             ●   ✗       -       -
```

The same screen on a 40-column phone, holding the first model to move it:

```
   #  ALIAS                    ON
⇅  1  nvidia/nemotron-3-ultr…  ●
   2  laguna-s-2.1-free        ●
   3  big-pickle               ●
```

`TTFT` is the wait before the first token, `TOK/S` the speed after it — the two numbers that tell you whether a model is worth its place in the chain. Token totals live in the counters (`llmfp stats`), where they add up over time.

## Cloudflare WARP: which address the providers see

By default, nothing here changes: a request leaves from this machine's own address, and the provider rate-limits that address. Turn WARP on and every provider request goes through a Cloudflare WARP tunnel instead, so what the provider sees — and counts against — is a Cloudflare address you can replace on demand.

**It is off by default, and off costs nothing.** No binary is downloaded, no process runs, and no extra request is ever made. Upgrading into this version changes nothing at all until you turn it on.

```
llmfp warp              where requests go out from right now
llmfp warp on           route them through Cloudflare WARP
llmfp warp off          back to going straight out
llmfp warp on-429       go out directly, and retry a rate-limited model through WARP
llmfp warp always       put every request through it (what `on` gives you)
llmfp warp rotate       new tunnel session, hence probably a new exit address
llmfp warp reset-identity   throw the WARP device registration away (for a leak)
llmfp warp up / down    start or stop the tunnel without changing the routing
```

Or set it in the UI, under `3. Settings` → _How it reaches the providers_ → **what goes through WARP**, which has the three answers this whole section is about:

| Answer | What happens |
| ------ | ------------ |
| `nothing` | requests go straight out, no tunnel runs, nothing is retried through one |
| `only 429s` | requests go straight out, and a model the provider rate-limited is retried through the tunnel |
| `everything` | every provider request leaves through the tunnel |

Either way a proxy that is already running picks the change up within a second or two — there is nothing to restart.

### Turning it on

```
$ llmfp warp on
  routing through WARP
  routing   through Cloudflare WARP
  tunnel    running pid 20712 · http http://127.0.0.1:25345 · socks5://127.0.0.1:25344
  endpoint  162.159.192.1:2408 (UDP, must be allowed outbound)
  files     ~/.config/llm-failover-proxy/warp
```

The first time, this downloads two small executables next to your configuration and registers a free WARP device — about seven seconds in total, once per machine:

- [**wgcf**](https://github.com/ViRb3/wgcf) registers the WARP account and turns it into a WireGuard profile.
- [**wireproxy**](https://github.com/whyvl/wireproxy) runs that profile as a **userspace** tunnel exposing two local proxies.

Both are pinned to a version and verified against the SHA-256 list published beside them in their own release; a download that does not match, or that the release does not attest at all, is refused rather than run. Nothing needs root, no network interface is created, and nothing about the rest of your machine's traffic changes — only this proxy's outbound requests go through the tunnel.

The one requirement is **outbound UDP to port 2408**. That is what a restrictive corporate network tends to block, and it is the usual reason the tunnel does not come up.

### Keeping the tunnel in reserve, for the models that need it

Routing everything through WARP costs a hop on every request, including the ones nobody is rate-limiting. Set `warp.mode` to `on-rate-limit` (_what goes through WARP_ → `only 429s` in Settings) and the tunnel is held back for the case it actually solves:

```
    chain: openrouter/kimi-k2 → groq/llama-3.3 → deepseek/chat
                    ↓
    1. openrouter/kimi-k2 leaves directly            → HTTP 429
    2. openrouter/kimi-k2 asked again, through WARP   → answers
```

The model that was throttled is retried **as itself**, from another address, before the chain gives up on it and falls to the next model. Which is the point: falling over to a weaker model costs you the answer you asked for, and a rate limit by address is the one failure where the same request from somewhere else plausibly succeeds.

**It is decided per model and per attempt.** Several models are routinely in flight at once here — the chain hedges — and one of them escalating does not touch the others: they keep going out directly, they are not cut, and the first usable answer still wins whichever way it arrived. A model going through the tunnel is one model's decision, never the request's.

The 429 is also **remembered**, for as long as the provider's `Retry-After` asked (a short window otherwise). The next request for that model starts on the tunnel rather than spending another 429 to rediscover the same quota — and when the window passes it tries directly again, because quotas refill. A model inside its window is *not* benched: it stays exactly where it is in the chain and merely leaves by a different door.

Two things stay deliberately out of this:

- **Only a `429` escalates.** A 5xx, a rejected parameter or a bad key would fail identically from any address, and retrying would only spend the tokens twice. `403` is the tempting case — "not available in your country" is exactly what a tunnel fixes — but an invalid key is also a `403`, and the status does not say which, so it is left alone.
- **A stream that has already started is never replayed.** Once bytes have reached the client, sending the request again from another address would splice two different answers together. In practice a `429` always arrives before the first byte, so this costs nothing.

If the tunnel cannot be had when a 429 arrives, the rate limit simply stands and is reported — the request is never handed to a port with nothing behind it. Both modes start the tunnel when the proxy starts, so the first rate-limited attempt does not wait for one to come up; an idle wireproxy with nothing going through it is one dormant process.

### Which way each request left

`llmfp stats` and the UI's _Status & stats_ screen gain a `VIA` column: for each of the last answered requests, whether it went through the tunnel or straight out.

```
  last 3 answered
  WHEN     MODEL                        TTFT   VIA
  19s ago  openrouter/liquid/lfm-2.5    1.68s  warp
  2min ago openrouter/liquid/lfm-2.5    1.97s  warp
  6min ago openrouter/liquid/lfm-2.5    2.10s  direct
```

`direct` means that one left from this machine. A row like the third one, while WARP is on in `always` mode, is worth noticing: it is a request that went around the tunnel. Under `on-rate-limit` the reading is the other way round — `direct` is the ordinary state, and a `warp` row is a model that hit its quota and got round it.

This is recorded from the outbound decision itself — the proxy knows which connection it dialled — so it costs nothing and asks nobody. No address appears in this column, because it would be the same address on every row: see below for why, and for the one place an address *is* reported.

### Changing the exit address

**A new tunnel session is what moves your address. A new identity does nothing.** That is not what you would guess from the names, so here are the measurements, taken on one machine at one Cloudflare colo:

| Action | Sample | Exit address changed |
| ------ | ------ | -------------------- |
| Nothing — just send more requests | 10 | **0 / 10** |
| Restart the tunnel, same identity | 10 | **7 / 10** |
| Re-register the WARP device | 2 | **0 / 2** |

Cloudflare picks which address a WARP session egresses from when the session is **established**, at whichever colo your UDP handshake lands on — and the colo follows anycast routing from your own network, which a new identity does not change. So the address is fixed for the life of a session, drawn again by the next one, and the device registration is beside the point.

Two things follow. Sending more requests will never get you a different address, however many you send. And `llmfp warp rotate` restarts the session and leaves the identity alone:

```
$ llmfp warp rotate
  rotated    now leaving from 104.28.243.187 (was 104.28.211.192)
```

Because roughly three restarts in ten come back on the address they left, this **checks** rather than assumes: one request to Cloudflare's own `/cdn-cgi/trace` before and after, and up to `warp.rotate.attempts` restarts spent trying to actually land somewhere else. `--json` carries `changed`, `before` and `after`; `changed` is `true`, `false`, or `null` when the address could not be confirmed — which is not the same as a change, and is not reported as one.

The pool at a given colo is small — five distinct addresses across eleven samples above — so `changed: false` is an ordinary outcome and not a fault.

### Doing it without cutting anything

A restart kills the wireproxy process, and that closes its sockets whatever the connection pool does. So the proxy rotates **only when nothing is going through the tunnel**:

```
warp: new tunnel session (the provider rate-limited this address) — now leaving from 104.28.243.190 (was 104.28.211.192)
```

The gate is the tunnel being unused, not the proxy being idle — and under `mode: "on-rate-limit"` those are very different. The tunnel there carries only the attempts that were rate-limited, so it sits unused almost all the time even while the proxy is busy, and a window is never hard to find. Nothing is ever forced: a tunnel that stays busy is simply not rotated.

What asks for a rotation, by default, is **a `429` that came back through the tunnel** — the exit address itself being throttled, which no other model and no cooldown can fix. A clock rotates when nothing needed it and sits still when something does, so the clock is optional (`warp.rotate.everyMs`) and off by default.

| Key                          | Default  | What it does                                                                                         |
| ---------------------------- | -------- | ---------------------------------------------------------------------------------------------------- |
| `warp.rotate.everyMs`        | `0`      | also get a new session once the current one is this old. `0` = only when the address is rate-limited  |
| `warp.rotate.minIntervalMs`  | `600000` | never twice inside this, whatever asks                                                               |
| `warp.rotate.attempts`       | `3`      | restarts to spend trying to actually land on a different address                                      |

`llmfp warp rotate` typed in a terminal is the override, and it is honest about the cost: it runs in its own process, so it cannot see what the serving proxy has in flight, and it says so.

### Retiring an identity that leaked

The identity — device id, access token, licence key, private key, all in `warp/wgcf-account.toml` — has its own command, because it is its own problem:

```
$ llmfp warp reset-identity
  re-registered  a new WARP device; the old token, licence key and private key are dead
```

Use it if that file has been exposed. Do **not** reach for it to change your address; `warp rotate` is what does that.

### When the tunnel is not there

WARP on and the tunnel down is the case that matters, because the wrong answer leaks the address you turned WARP on to hide. So by default **the request fails**, with a message saying what to do:

```
Cloudflare WARP is enabled, but its tunnel is not answering on 127.0.0.1:25345.
Start it with `llm-failover-proxy warp up` …
```

Set `warp.fallbackDirect` (_if the WARP tunnel is down_ in Settings) to send it from this machine's own address instead. Nothing is hidden either way: the `VIA` column says `direct` for every request that went out that way.

**Local providers always bypass the tunnel**, whatever the setting. Ollama on `127.0.0.1`, or an inference box on your LAN, cannot be reached from inside a tunnel that egresses on the internet — so loopback, private and `.local` addresses go straight out, the way every HTTP client treats `NO_PROXY`.

### Where it lives, and one thing to know

Everything sits in a `warp/` folder beside your configuration: the two executables, the WireGuard identity, the generated tunnel config, and `wireproxy.log` — which is where `warp status` points you when a tunnel does not come up.

**That folder holds a private key.** It is `0600` and the folder `0700` where the OS supports it, and it must never be committed; the repository's own `.gitignore` covers `warp/`.

Two other things worth stating plainly: the tunnel goes down with the proxy (`llmfp stop` stops both), and registering free WARP devices — a fortiori rotating them to get around a rate limit — is outside what Cloudflare's terms cover. That is your call to make, not this tool's.

## Where your settings live

Two files, side by side, **configuration** and **secrets** are deliberately kept apart:

| File                                    | Contents                                                                                                                                | Commit it?               |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| `config.json`                           | providers, models, priority order, model lists and what each is for, timeouts. Keys appear only as `env:NVIDIA_API_KEY` references                          | yes, if you want         |
| `.env`                                  | the actual API keys, one per line, `0600`                                                                                               | **never**                |
| `.env.example`                          | the variables the default chain expects, with links to get each key                                                                     | shipped with the package |
| `<config>.stats.json`                   | counters and cooldowns, so they survive restarts                                                                                        | no                       |
| `daemon.log`, `daemon.json`, `service/` | the background proxy: its output, its pid and port, and the copy of the CLI it runs (so uninstalling is never blocked by a file in use) | no                       |
| `warp/`                                 | only if you turn WARP on: the two downloaded executables, its log — and the **WireGuard private key**, `0600` inside a `0700` folder    | **never**                |

The configuration file is looked up in this order: `--config <path>`, `$LLM_PROXY_CONFIG`, `./llm-proxy.config.json` or `./config.json`, then `%APPDATA%\llm-failover-proxy\config.json` (Windows) / `${XDG_CONFIG_HOME:-~/.config}/llm-failover-proxy/config.json`.

The `.env` is read from the current directory **and** from the folder holding the configuration file, so both a project-local and a machine-wide setup work. A real environment variable always wins over the file, handy in Docker or CI, where you can skip the `.env` entirely and just pass `NVIDIA_API_KEY=…`.

Every screen that takes a key writes it to the `.env` and stores only an `env:NAME` reference, so there is nothing to migrate and no command to run. A key left inside `config.json` by an older version keeps working; `status` points it out, and retyping it in the UI is what moves it.

### Model lists in the file

`models` is always the chain being served — the array the proxy reads, and the only one it reads. `modelLists` holds the named lists beside it, and `activeListId` says which of them the live chain belongs to:

```jsonc
{
  "models": [ /* the chain in use, in priority order */ ],
  "activeListId": "lst_9f3c1a20",
  "modelLists": [
    {
      "id": "lst_1b7e04d5",
      "name": "default",
      "description": "everything, in failover order", // what `w` writes: when to use this one
      "models": [ /* parked */ ]
    },
    {
      "id": "lst_9f3c1a20",
      "name": "cheap-and-fast",
      "description": "everyday work — free tiers first, nothing metered",
      "models": [ /* mirrors `models` above */ ]
    }
  ]
}
```

So the active entry in `modelLists` is a mirror, refreshed on every save, and `models` wins whenever the two disagree. Editing `models` by hand is therefore always safe and always takes effect; editing the *active* list instead would be overwritten. A file written before model lists existed gets one called `default` on first load, holding the chain it already had.

**A file from 1.6 or earlier calls these `targets`, `activeTargetId` and `tgt_…`.** It is read as it is, renamed on the way in, and written back under the names above the next time anything is saved — nothing to run, and nothing to lose: the id keeps its random half, so the list that was being served still is, and the counters were never keyed on a list id in the first place.

Counters are kept per model entry, and pruned on startup against **every** list rather than just the live one — so a chain you switched away from still has its history when you come back to it.

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

| Key               | Default     | What it does                                                                                                                    |
| ----------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `server.host`     | `127.0.0.1` | `127.0.0.1` = this machine only. `0.0.0.0` exposes it to your network — **set `server.apiKey` first**                           |
| `server.port`     | `47821`     | the port your apps point at. If it is taken, the next free one is used and printed at startup                                   |
| `server.apiKey`   | none        | key your own apps must send. Empty means no check, which is fine on `127.0.0.1`. `env:LLM_PROXY_API_KEY` keeps it in the `.env` |
| `server.cors`     | `true`      | whether a web page may call the proxy straight from the browser                                                                 |
| `server.logLevel` | `info`      | `debug` prints every attempt and its timing                                                                                     |

### How it reaches the providers

Off means straight out from this machine, which is what every version before this one did. [Cloudflare WARP](#cloudflare-warp-which-address-the-providers-see) explains the rest.

| Key                   | Default              | What it does                                                                                                        |
| --------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `warp.enabled`        | `false`              | reach the providers through a Cloudflare WARP tunnel instead of from this machine                                    |
| `warp.mode`           | `always`             | what goes through it: `always` every request, `on-rate-limit` only a model the provider answered `429` to            |
| `warp.fallbackDirect` | `false`              | WARP is on but its tunnel is not answering: `false` fails the request, `true` sends it from this machine's address   |
| `warp.socksPort`      | `25344`              | the SOCKS5 proxy the tunnel exposes, for whatever else you want to point at it                                      |
| `warp.httpPort`       | `25345`              | the HTTP proxy this proxy's own outbound requests go through                                                        |
| `warp.endpoint`       | `162.159.192.1:2408` | Cloudflare's WARP endpoint. Needs outbound **UDP** to that port                                                     |

Change either port if something else on the machine already uses it — including a second configuration with its own tunnel, since two of them cannot share one port. A tunnel is only ever adopted when this proxy started it: a port answering for some other reason is reported as taken, not used.

### While one request is in flight

There are several timers because "too slow" means different things before, during and after an answer starts. They all belong to **one** request, and they all end the same way: that attempt is dropped and the next model is tried.

```
  ask model 1 ────────────────────────────────────────────►
              │                    │
              │ hedgeDelayMs (5s)  │ nothing usable yet?
              │                    └─► also ask model 2, in parallel
              │
              ├─ streaming?     firstTokenTimeoutMs (15s) until the first token
              │                 then idleTimeoutMs (60s) between any two tokens
              └─ not streaming? requestTimeoutMs (15s) for the whole answer
```

| Key                   | Default | Expires when                                                                                                                             |
| --------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `firstTokenTimeoutMs` | 15000   | a streamed answer has not **started**                                                                                                    |
| `idleTimeoutMs`       | 60000   | a started stream has gone **quiet** that long                                                                                            |
| `requestTimeoutMs`    | 15000   | a non-streamed answer has not arrived **complete**                                                                                       |
| `hedgeDelayMs`        | 5000    | your favourite model has had that long alone — the next one is asked too, and the first usable answer wins. `0` = strictly one at a time |
| `maxInFlight`         | 3       | how many models may work on that request at once. `1` disables racing. Every loser still generated tokens you may be billed for          |
| `maxAttempts`         | 0       | how many models to try before giving up. `0` = the whole chain                                                                           |

Only one of the first three applies to a given request: the first two if the client asked for a stream, the third otherwise.

### Afterwards, for the next requests

A **cooldown is not a timeout.** A timeout ends one attempt; a cooldown decides how long a model that keeps failing is _skipped by the requests that follow_, so a dead provider is not retried on every single call.

| Key                           | Default        | What it does                                                                                                                                                                 |
| ----------------------------- | -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cooldown.failuresBeforeTrip` | 2              | consecutive failures that put a model aside. A `429` or an auth error puts it aside immediately, whatever this says                                                          |
| `cooldown.baseMs` / `maxMs`   | 15000 / 300000 | how long it stays aside: `baseMs` the first time, doubling with each new failure, capped at `maxMs`. A `Retry-After` from the provider wins over both. Any success clears it |

A model set aside is still tried as a **last resort** when nothing else is available, and the time it has left shows up in the `COOLDOWN` column of `llmfp stats`.

### Tests you run yourself

| Key               | Default | Expires when                                                                                                                               |
| ----------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `probe.timeoutMs` | 15000   | a test **you** started (`t` on Models lists, `t` on Providers) has not finished. One budget for the whole probe, first token included |

Deliberately separate from the deadlines above: letting a slow model finish a benchmark should not make every real request wait longer.

| Key            | Default | What it does                                                                                                          |
| -------------- | ------- | --------------------------------------------------------------------------------------------------------------------- |
| `update.check` | `true`  | ask the npm registry once a day whether a release is out, and say so on the menu. See [Updating](#updating) for what that involves, and `LLM_PROXY_NO_UPDATE_CHECK=1` to skip it for one run |

### When to substitute, and when to refuse

These four decide whether the client gets _an_ answer or _the_ answer. This is where a proxy can help you or lie to you, so they are worth a minute.

| Key                           | Default | The question it answers                                                                                                                                                            |
| ----------------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `strictModelMatch`            | `false` | A client asks for a model that is **nowhere in your chain**. `false`: the whole chain answers anyway — apps that hardcode `gpt-4o` just work. `true`: `404`, no provider is called |
| `crossModelFallback`          | `true`  | The requested model is **known but failing**. `true`: the rest of the chain takes over. `false`: the request fails rather than switch model                                        |
| `treatContentFilterAsFailure` | `true`  | A provider cut the answer for content reasons. `true`: try another model. `false`: hand the refusal back as it came                                                                |
| `streamErrorAsMessage`        | `true`  | Every model failed on a streamed request. `true`: the reason is streamed as a readable answer. `false`: a bare `502`, which most chat apps render as an empty reply                |

The first two are often confused. They act at different moments:

```
client asks for "typo-3.5"          →  strictModelMatch decides    (unknown name)
client asks for "fast", fast is 500 →  crossModelFallback decides  (known, failing)
```

So for **"never serve me anything other than what I asked for"**, you need both: `strictModelMatch: true` _and_ `crossModelFallback: false`. With the defaults, the opposite is true — something always tries to answer, and the `x-llm-proxy-model` header tells you who actually did.

## Troubleshooting

**Every answer says "no provider could answer".** No usable key. Run `llm-failover-proxy status`: providers whose key is missing are shown in red. Paste keys with `llm-failover-proxy` (wizard, or Providers → `e`), or write them into the `.env`, a running proxy picks them up within a second.

**Is it actually running?** `llm-failover-proxy status` shows the process, its port and its counters; `curl http://127.0.0.1:47821/health` answers `200`. If a port was taken, the real one is in `status` and in `daemon.json`.

**It did not come back after a reboot.** `llm-failover-proxy enable` (re-)registers it. The entry is a plain file you can inspect or delete: `…\Start Menu\Programs\Startup\llm-failover-proxy.vbs` on Windows, `~/Library/LaunchAgents/com.llm-failover-proxy.plist` on macOS, `~/.config/systemd/user/llm-failover-proxy.service` on Linux. On Linux, a user service normally waits for your first login, `loginctl enable-linger $USER` starts it at boot instead.

**Something went wrong in the background.** `llm-failover-proxy logs` prints the end of the log (`daemon.log`, next to the configuration).

**I want it gone.** `llm-failover-proxy disable`, then `npm rm -g llm-failover-proxy`. Either order works, uninstalling never fails because the proxy is running, and a login entry left behind by an uninstalled package removes itself the next time it fires. Your configuration and keys stay where they are.

**A provider needs a special header, or a fixed `max_tokens`.** Both are supported per provider and per model in `config.json` (`headers`, `params`).

**I rotated and the address did not change.** Expected about three times in ten: the pool at a colo is small, and `warp rotate` already spends up to `warp.rotate.attempts` restarts trying. It reports `changed: false` rather than pretending. Re-registering the device (`reset-identity`) will not help — the identity has no bearing on the address.

**The WARP tunnel does not come up.** `llmfp warp status` says what it found and prints the end of `wireproxy.log` when something failed. Two causes cover almost all of it: **outbound UDP to port 2408 is blocked**, which a corporate network or a locked-down VPS often does — the tunnel then handshakes and carries nothing — or the local port is already taken, which `warp status` reports as such rather than using it. `llmfp warp down && llmfp warp up` re-reads everything; `llmfp warp reset-identity` also re-registers the device from scratch, which is worth trying if the profile itself looks wrong.

**Requests fail with `warp_unavailable`.** WARP is on in `always` mode and its tunnel is not answering, and failing is the deliberate default — sending the request anyway would reveal the address WARP was turned on to hide. Bring the tunnel up, turn WARP off, or set `warp.fallbackDirect` if you would rather it went out directly. `warp.mode: "on-rate-limit"` never produces this: the tunnel is a second chance there, so a request that cannot have it is answered by whatever the direct route said.

**A model keeps being rate-limited even through WARP.** The failure report says so in as many words (`retried through Cloudflare WARP, same answer`), and it is worth reading as the answer it is: the quota is on the account or the key, not on this machine's address, so no amount of rotating will move it. `llmfp warp rotate` is for the other case.

## For developers

```bash
git clone <this repo> && cd llm-failover-proxy
pnpm install
pnpm test              # 88 tests, no network access
node src/index.js      # run from source, no build step
pnpm run build         # bundle dist/index.js
pnpm run demo          # live failover demo against three fake providers
```

Releases are cut from a tag, because an npm version can never be published twice:

```bash
npm version patch          # bumps package.json, commits, tags v1.0.1
git push --follow-tags     # the tag is what triggers the publish
```

[`.github/workflows/ci.yml`](.github/workflows/ci.yml) tests every push and pull request on Linux and Windows, against Node 22 and 24. [`.github/workflows/release.yml`](.github/workflows/release.yml) reacts to a `v*` tag: it refuses a tag that disagrees with `package.json`, runs the tests, publishes to npm with build provenance, and opens the matching GitHub release. Nothing is published from a laptop, and no npm token is stored in the repository — npm authenticates the workflow itself through OIDC.

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
