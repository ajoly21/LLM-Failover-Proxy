import { Box, Text, useInput } from "ink";
import { useState } from "react";
import { applyCatalog, catalogKeys, loadCatalog } from "../../catalog.js";
import { envPathFor, upsertEnv } from "../../env.js";
import { h } from "../h.js";
import { COLOR, SYMBOL, cell } from "../theme.js";
import { Frame, Hints, TextField, editText } from "../widgets.js";

const PREVIEW_ROWS = 6;

/**
 * First-run wizard: either take the chain shipped with the package and paste the
 * keys for it, or start with nothing.
 *
 * Keys are written to the `.env` next to the config file, the config itself only
 * ever stores `env:NAME`, so it stays shareable. Everything here is additive, so
 * the wizard can be re-run from the home menu without losing anything.
 */
export function SetupScreen({ config, update, notify, onDone, catalog: injected }) {
  const [catalog] = useState(() => {
    try {
      return injected ?? loadCatalog();
    } catch (err) {
      return { providers: [], models: [], error: err.message };
    }
  });

  const [step, setStep] = useState("choice");
  const [cursor, setCursor] = useState(0);
  const [queue, setQueue] = useState([]);
  const [index, setIndex] = useState(0);
  const [draft, setDraft] = useState("");
  const [entered, setEntered] = useState({});
  const [summary, setSummary] = useState(null);

  const usable = catalog.models.length > 0;
  const choices = [
    usable
      ? {
          key: "default",
          label: "Use the default chain",
          hint: `${catalog.models.length} models across ${catalog.providers.length} providers`,
        }
      : null,
    { key: "scratch", label: "Start from scratch", hint: "add your own providers and models" },
  ].filter(Boolean);

  const current = queue[index];

  /** Writes the keys, merges the catalogue, then shows what happened. */
  const finish = (values) => {
    const envFile = envPathFor(config.__file);
    let written = [];
    try {
      ({ written } = upsertEnv(envFile, values));
    } catch (err) {
      notify(`could not write ${envFile}: ${err.message}`, COLOR.fail);
    }

    let added = { providers: [], models: [] };
    update((next) => {
      added = applyCatalog(next, catalog);
    });

    // Recomputed after the write: `set` now reflects the keys just pasted.
    const keys = catalogKeys(catalog);
    setSummary({
      envFile,
      written,
      added,
      ready: keys.filter((entry) => entry.set).map((entry) => entry.name),
      missing: keys.filter((entry) => !entry.set),
    });
    setStep("done");
  };

  const pick = (choice) => {
    if (choice === "scratch") {
      update(() => {}); // creates the config file, so this is not a first run any more
      notify("empty configuration created, start with the Providers screen");
      onDone();
      return;
    }
    const pending = catalogKeys(catalog).filter((entry) => !entry.set);
    if (!pending.length) {
      finish({});
      return;
    }
    setQueue(pending);
    setIndex(0);
    setStep("keys");
  };

  useInput((input, key) => {
    if (step === "choice") {
      if (key.escape || input === "q") onDone();
      else if (key.upArrow || input === "k") setCursor((previous) => (previous - 1 + choices.length) % choices.length);
      else if (key.downArrow || input === "j") setCursor((previous) => (previous + 1) % choices.length);
      else if (key.return) pick(choices[cursor].key);
      else {
        // The list is numbered, so the digits have to work, same as the home menu.
        const index = Number(input) - 1;
        if (Number.isInteger(index) && index >= 0 && index < choices.length) pick(choices[index].key);
      }
      return;
    }

    if (step === "keys") {
      // Both keys keep what is already typed, losing a pasted key to a
      // mis-remembered shortcut would be the worst possible outcome here.
      const withDraft = () => (draft.trim() ? { ...entered, [current.envVar]: draft.trim() } : entered);

      if (key.escape) {
        finish(withDraft()); // skip every remaining provider
        return;
      }
      if (key.return) {
        const values = withDraft();
        setEntered(values);
        setDraft("");
        if (index + 1 >= queue.length) finish(values);
        else setIndex(index + 1);
        return;
      }
      setDraft(editText(draft, input, key));
      return;
    }

    onDone(); // summary: any key leaves
  });

  if (step === "keys") return h(KeyStep, { current, index, total: queue.length, draft });
  if (step === "done") return h(DoneStep, { summary, configFile: config.__file });

  return h(
    Frame,
    {
      title: "Welcome to llm-failover-proxy",
      subtitle: "one endpoint, several providers, automatic failover",
      footer: h(Hints, {
        items: [["↑↓", "move"], ["enter", "choose"], choices.length > 1 ? [`1-${choices.length}`, "jump"] : null, ["esc", "skip"]],
      }),
    },
    h(
      Box,
      { flexDirection: "column", paddingTop: 1 },
      ...choices.map((choice, position) =>
        h(
          Text,
          { key: choice.key, inverse: position === cursor },
          `${position === cursor ? SYMBOL.cursor : " "} ${position + 1}. `,
          cell(choice.label, 22),
          h(Text, { dimColor: position !== cursor }, `  ${choice.hint}`),
        ),
      ),
    ),
    catalog.error ? h(Box, { paddingTop: 1 }, h(Text, { color: COLOR.fail }, `  default chain unavailable: ${catalog.error}`)) : h(ChainPreview, { catalog }),
  );
}

function ChainPreview({ catalog }) {
  const shown = catalog.models.slice(0, PREVIEW_ROWS);
  const rest = catalog.models.length - shown.length;
  return h(
    Box,
    { flexDirection: "column", paddingTop: 1 },
    h(Text, { dimColor: true }, "  the default chain, in order:"),
    ...shown.map((entry, position) =>
      h(Text, { key: entry.model, dimColor: true }, `   ${String(position + 1).padStart(2)}. `, h(Text, { color: COLOR.accent }, entry.provider), `/${entry.model}`),
    ),
    rest > 0 ? h(Text, { dimColor: true }, `       … and ${rest} more`) : null,
    h(Text, { dimColor: true }, "  keys are stored in .env, never in the configuration file"),
  );
}

function KeyStep({ current, index, total, draft }) {
  return h(
    Frame,
    {
      title: `API key ${index + 1}/${total}, ${current.name}`,
      subtitle: "paste it, or press enter to skip this provider",
      footer: h(Hints, {
        items: [
          ["enter", index + 1 >= total ? "save & finish" : "save & next"],
          ["ctrl+u", "clear"],
          ["esc", "save & skip the rest"],
        ],
      }),
    },
    h(
      Box,
      { flexDirection: "column", paddingTop: 1 },
      h(Text, { dimColor: true }, `  ${current.baseUrl}`),
      current.note ? h(Text, { dimColor: true }, `  ${current.note}`) : null,
      current.keyUrl ? h(Text, null, h(Text, { dimColor: true }, "  get a key: "), h(Text, { color: COLOR.accent }, current.keyUrl)) : null,
      current.models.length ? h(Text, { dimColor: true, wrap: "truncate" }, `  used by: ${current.models.join(", ")}`) : null,
    ),
    h(
      Box,
      { paddingTop: 1 },
      h(Text, { color: COLOR.accent }, `  ${current.envVar}  `),
      h(TextField, { value: draft, focused: true, masked: true, placeholder: "paste the key (hidden)" }),
    ),
    h(Box, { paddingTop: 1 }, h(Text, { dimColor: true }, "  skipping is fine: the chain steps over a provider with no key")),
  );
}

function DoneStep({ summary, configFile }) {
  const { added, ready, missing, envFile, written } = summary;
  return h(
    Frame,
    {
      title: "Ready",
      subtitle: "press any key to open the menu",
      footer: h(Hints, { items: [["enter", "continue"]] }),
    },
    h(
      Box,
      { flexDirection: "column", paddingTop: 1 },
      h(Text, null, h(Text, { color: COLOR.ok }, `  ${SYMBOL.ok} `), `${added.models.length} model(s) and ${added.providers.length} provider(s) added`),
      h(Text, { dimColor: true }, `     ${configFile}`),
      written.length ? h(Text, null, h(Text, { color: COLOR.ok }, `  ${SYMBOL.ok} `), `${written.length} key(s) saved to `, h(Text, { dimColor: true }, envFile)) : null,
      ready.length ? h(Text, { color: COLOR.ok }, `  ${SYMBOL.ok} keys found for: ${ready.join(", ")}`) : null,
      ...missing.map((entry) =>
        h(Text, { key: entry.envVar, color: COLOR.warn }, `  ${SYMBOL.off} ${entry.name}: no key, set ${entry.envVar}${entry.keyUrl ? ` (${entry.keyUrl})` : ""}`),
      ),
    ),
    h(
      Box,
      { flexDirection: "column", paddingTop: 1 },
      // Screens are named, never numbered: the menu order is free to change.
      h(
        Text,
        null,
        h(Text, { dimColor: true }, "  next: "),
        h(Text, { color: COLOR.accent }, "Models & priority"),
        h(Text, { dimColor: true }, " tests every model live, then "),
        h(Text, { color: COLOR.accent }, "Start the server"),
      ),
      h(Text, { dimColor: true }, "  keys can be added later from Providers, or straight in .env"),
    ),
  );
}
