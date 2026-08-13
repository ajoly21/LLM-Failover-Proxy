import { Box, Text, useInput } from "ink";
import { useEffect, useRef, useState } from "react";
import {
  DEFAULT_TARGET_NAME,
  activeTarget,
  addTarget,
  copyTarget,
  cycleTarget,
  deleteTarget,
  describeTarget,
  getProvider,
  moveModel,
  providerLabel,
  renameTarget,
} from "../../config.js";
import { probeModel } from "../../probe.js";
import { h } from "../h.js";
import { useLayout } from "../size.js";
import { COLOR, SYMBOL, duration } from "../theme.js";
import { Frame, Hints, Table, TextField, editText } from "../widgets.js";

/** Probes are launched this far apart, but run concurrently. */
export const TEST_SPACING_MS = 5000;

const sleep = (delay) => new Promise((resolve) => setTimeout(resolve, delay));
const STATE_COLOR = { ok: COLOR.ok, fail: COLOR.fail, running: COLOR.warn, queued: undefined };

/** What the name being typed is for. */
const PROMPT_LABEL = { new: "new", copy: "copy", rename: "rename", describe: "when to use" };

/**
 * The keys that act on the whole list, as `[keys, label]` pairs.
 *
 * One source for the two places they can be written — the line under the list
 * name, and the hints at the foot of a screen too short for that line — so the
 * two can never disagree about which key does what. `long` spells the labels out
 * where there is room for it.
 */
const listHints = (listCount, long) =>
  [
    ["←→", long ? "switch list" : "list"],
    ["n", long ? "new list" : "new"],
    ["c", long ? "copy list" : "copy"],
    ["r", long ? "rename list" : "rename"],
    ["w", long ? "when to use" : "when"],
    // Never the last one: something has to be served.
    listCount > 1 ? ["x", long ? "delete list" : "delete"] : null,
  ].filter(Boolean);

export function ModelsScreen({ config, update, notify, navigate, onBack, spacingMs }) {
  const spacing = spacingMs ?? TEST_SPACING_MS;
  const [cursor, setCursor] = useState(0);
  // What a `y` would delete: the model under the cursor, or the whole list.
  const [confirming, setConfirming] = useState(null);
  // Holding a model: plain arrows move it instead of the cursor. `⇧↑` needs a
  // modifier no phone keyboard sends, and `J`/`K` need a shift of their own.
  const [holding, setHolding] = useState(false);
  const [tests, setTests] = useState({});
  const [running, setRunning] = useState(false);
  // Naming a list, in place: `{ mode: 'new' | 'rename', value }`.
  const [prompt, setPrompt] = useState(null);
  const runRef = useRef(0);
  const layout = useLayout();

  useEffect(
    () => () => {
      runRef.current += 1; // ignore probe results that land after unmount
    },
    [],
  );

  const models = config.models;
  const selected = models[Math.min(cursor, models.length - 1)];
  const { target: list, index: listIndex, total: listCount } = activeTarget(config);

  /** A different chain: results measured on the previous one describe nothing here. */
  const resetTests = () => {
    runRef.current += 1; // and probes still in flight stop reporting
    setTests({});
    setRunning(false);
  };

  const switchList = (delta) => {
    if (listCount < 2) return;
    update((draft) => cycleTarget(draft, delta));
    setCursor(0);
    resetTests();
  };

  const saveName = () => {
    const name = prompt.value.trim();
    // A note is the one thing here that may be emptied: clearing a note that no
    // longer describes the chain is as useful as writing it was.
    if (prompt.mode === "describe") {
      update((draft) => describeTarget(draft, draft.activeListId, name));
      notify(name ? "saved what this list is for" : "cleared the note");
      setPrompt(null);
      return;
    }
    // Kept open rather than saved blank: two unnamed lists cannot be told apart.
    if (!name) return;
    if (prompt.mode === "rename") {
      update((draft) => renameTarget(draft, draft.activeListId, name));
      notify(`renamed list to ${name}`);
    } else {
      // Both land on a new list, so both start over from its first row.
      update((draft) => (prompt.mode === "copy" ? copyTarget(draft, name) : addTarget(draft, name)));
      setCursor(0);
      resetTests();
      notify(`added list ${name}`);
    }
    setPrompt(null);
  };

  const deleteList = () => {
    const gone = list?.name;
    update((draft) => deleteTarget(draft, draft.activeListId));
    setCursor(0);
    resetTests();
    notify(`removed list ${gone}`);
  };

  /**
   * Launches one probe per chat model, `spacingMs` apart, all running in
   * parallel: a slow provider only delays its own row.
   */
  const runTests = () => {
    const entries = models.filter((entry) => entry.kind === "chat");
    if (!entries.length) {
      notify("no chat model to test", COLOR.warn);
      return;
    }
    const runId = ++runRef.current;
    setRunning(true);
    setTests(Object.fromEntries(entries.map((entry) => [entry.id, { state: "queued" }])));

    const probes = entries.map(async (entry, index) => {
      await sleep(index * spacing);
      if (runRef.current !== runId) return;
      setTests((previous) => ({ ...previous, [entry.id]: { state: "running" } }));

      const provider = getProvider(config, entry.providerId);
      const result = provider ? await probeModel(config, entry, provider) : { ok: false, message: "provider not found" };
      if (runRef.current !== runId) return;
      setTests((previous) => ({ ...previous, [entry.id]: { state: result.ok ? "ok" : "fail", ...result } }));
    });

    Promise.all(probes).then(() => {
      if (runRef.current === runId) setRunning(false);
    });
  };

  useInput((input, key) => {
    // Naming a list: every key belongs to the field until it is saved or dropped.
    if (prompt) {
      if (key.escape) setPrompt(null);
      else if (key.return) saveName();
      else setPrompt({ ...prompt, value: editText(prompt.value, input, key) });
      return;
    }

    if (confirming) {
      if (input === "y" && confirming === "list") deleteList();
      else if (input === "y") {
        update((draft) => {
          draft.models = draft.models.filter((entry) => entry.id !== selected.id);
        });
        notify(`removed ${selected.alias}`);
        setCursor(0);
      }
      setConfirming(null);
      return;
    }

    const total = Math.max(1, models.length);
    const move = (delta) => {
      if (!moveable(models, cursor, delta)) return;
      update((draft) => moveModel(draft, cursor, delta));
      setCursor(cursor + delta);
    };

    // Holding one: the arrows carry it, and any of the three ways out drops it.
    if (holding) {
      if (key.upArrow || input === "k") move(-1);
      else if (key.downArrow || input === "j") move(1);
      // Dropped where it stands: the order is already saved on every step, so
      // there is nothing to confirm or undo here.
      else if (key.escape || key.return || input === "m" || input === " ") setHolding(false);
      return;
    }

    // Shift+arrows and J/K stay for desktop terminals that do send them.
    if ((key.shift && key.upArrow) || input === "K") move(-1);
    else if ((key.shift && key.downArrow) || input === "J") move(1);
    else if (key.escape || input === "q") onBack();
    else if (key.upArrow || input === "k") setCursor((previous) => (previous - 1 + total) % total);
    else if (key.downArrow || input === "j") setCursor((previous) => (previous + 1) % total);
    // The lists sit side by side, so they are reached sideways.
    else if (key.leftArrow) switchList(-1);
    else if (key.rightArrow) switchList(1);
    else if (input === "n") setPrompt({ mode: "new", value: "" });
    // `c`, not `N`: a shifted `n` reads as a variant of "new list" and got pressed
    // for one. Prefilled, so the copy is one keypress away and still gets a name
    // of its own.
    else if (input === "c") setPrompt({ mode: "copy", value: `${list?.name ?? DEFAULT_TARGET_NAME} copy` });
    else if (input === "r") setPrompt({ mode: "rename", value: list?.name ?? "" });
    // Prefilled with what is there, so a note is corrected rather than retyped.
    else if (input === "w") setPrompt({ mode: "describe", value: list?.description ?? "" });
    else if (input === "x" && listCount > 1) setConfirming("list");
    else if (input === "m" && models.length > 1) setHolding(true);
    else if (input === "a") navigate({ name: "model-form" });
    else if (input === "e" && selected) navigate({ name: "model-form", modelId: selected.id });
    else if (input === " " && selected) {
      update((draft) => {
        const target = draft.models.find((entry) => entry.id === selected.id);
        target.enabled = !target.enabled;
      });
    } else if (input === "d" && selected) setConfirming("model");
    else if (input === "t") runTests();
  });

  // `drop` is the order in which a narrowing terminal gives columns up; the
  // model name shortens instead, since the alias already identifies the row.
  const columns = [
    { key: "priority", label: "#", align: "right", width: 2, text: (row) => String(row.index + 1) },
    // The alias is what a client sends, so it is the last text to go, and the
    // one that shortens: everything else around it is a fixed few characters.
    { key: "alias", label: "ALIAS", flex: true },
    { key: "provider", label: "PROVIDER", drop: 2, text: (row) => providerLabel(config, row.providerId) },
    { key: "model", label: "MODEL", drop: 1 },
    {
      key: "enabled",
      label: "ON",
      text: (row) => (row.enabled ? SYMBOL.on : SYMBOL.off),
      color: (row) => (row.enabled ? COLOR.ok : COLOR.fail),
    },
    {
      key: "state",
      label: "",
      width: 1,
      text: (row) => glyph(tests[row.id]),
      color: (row) => STATE_COLOR[tests[row.id]?.state],
    },
    { key: "ttft", label: "TTFT", align: "right", width: 7, drop: 3, text: (row) => (tests[row.id]?.ok ? duration(tests[row.id].ttftMs) : "-") },
    {
      key: "rate",
      label: "TOK/S",
      align: "right",
      width: 6,
      drop: 4,
      text: (row) => (tests[row.id]?.tokensPerSecond ? tests[row.id].tokensPerSecond.toFixed(1) : "-"),
    },
  ];

  const rows = models.map((entry, index) => ({ ...entry, index, key: entry.id }));
  const detail = tests[selected?.id];
  const done = Object.values(tests).filter((test) => test.state === "ok" || test.state === "fail").length;

  // Keys that act on the list rather than on a model. They belong next to the
  // list they act on, so they are written under its name — and only there, which
  // leaves the hints at the foot of the screen to the chain itself. `x` is offered
  // only where it leads somewhere: the last list cannot go.
  const listKeys = listHints(listCount, !layout.narrow);
  const barItems = prompt
    ? [
        ["enter", "saves it"],
        ["esc", "cancels"],
      ]
    : listKeys;
  // What this list is for, on the line under its name — the question `←→` raises
  // and a name alone cannot answer. Shown only once somebody has written it, so a
  // list with nothing to say costs no row; while the note is being typed the field
  // is on the name line, so the line below it would only repeat the old text.
  const note = prompt ? "" : list?.description || "";
  // Rows this screen needs around the table: the frame, the title, the hints, the
  // list bar and its blank line, the note, the detail line. Both hint lines wrap on
  // a narrow terminal — by one line more once `x delete list` has joined them.
  const reserved = (holding ? 9 : 11) + (layout.short ? 1 : 3) + (layout.narrow ? (listCount > 1 ? 3 : 2) : 0) + (note ? 1 : 0);
  const bar = h(
    Box,
    { flexDirection: "column", marginBottom: layout.short ? 0 : 1 },
    h(
      Text,
      { wrap: "truncate" },
      h(Text, { dimColor: true }, "  list  "),
      prompt
        ? h(
            Text,
            null,
            h(Text, { dimColor: true }, `${PROMPT_LABEL[prompt.mode]}: `),
            h(TextField, {
              value: prompt.value,
              focused: true,
              placeholder: prompt.mode === "describe" ? "when should this list be the one serving?" : "name this list",
            }),
          )
        : h(
            Text,
            null,
            // The arrows are drawn only where they lead somewhere.
            h(Text, { color: COLOR.accent }, listCount > 1 ? "‹ " : ""),
            h(Text, { bold: true }, list?.name ?? DEFAULT_TARGET_NAME),
            h(Text, { color: COLOR.accent }, listCount > 1 ? " ›" : ""),
            h(Text, { dimColor: true }, `  ${listIndex + 1}/${listCount}`),
          ),
    ),
    // Truncated, never wrapped: it is one line by definition, and a note that
    // wrapped would push a model off the screen to say something optional.
    note ? h(Text, { dimColor: true, italic: true, wrap: "truncate" }, `  ${note}`) : null,
    // Drawn by the same widget as the hints under the frame, so a key looks the
    // same wherever it is written: the glyph in the accent colour, the words
    // around it dimmed.
    //
    // Wrapped on a narrow terminal on purpose: while this line is shown it is the
    // only place the list keys are written, so cutting its tail would lose them.
    layout.short ? null : h(Text, { wrap: layout.narrow ? "wrap" : "truncate" }, "  ", h(Hints, { items: barItems })),
  );

  return h(
    Frame,
    {
      title: "Models lists",
      subtitle: holding ? `moving ${selected?.alias ?? ""}` : `${models.length} in the chain · order = failover priority`,
      footer: h(Hints, {
        items: prompt
          ? [
              ["enter", prompt.mode === "describe" ? "save the note" : "save the name"],
              ["esc", "cancel"],
            ]
          : holding
            ? [
                ["↑↓", "move it"],
                ["enter", "drop it here"],
              ]
            : // The chain, and nothing else: what acts on a list is written above
              // the table, on the line naming the list it would act on. Unless
              // that line had to go — a short screen spends its rows on models —
              // in which case the list keys fall back here rather than vanish.
              [
                ...(layout.short ? listKeys : []),
                ["↑↓", "move"],
                ["m", "reorder"],
                ["a", "add"],
                ["e", "edit"],
                ["space", "enable"],
                ["d", "delete"],
                ["t", "test all"],
                ["esc", "back"],
                ["⇧↑⇧↓ / J K", "reorder too", { optional: true }],
              ],
      }),
    },
    h(
      Box,
      { paddingTop: 1, flexDirection: "column" },
      bar,
      h(Table, {
        columns,
        rows,
        cursor,
        maxRows: layout.listRows(reserved),
        cursorGlyph: holding ? SYMBOL.grab : SYMBOL.cursor,
        empty: "no model yet, press a to add one",
      }),
    ),
    h(
      Box,
      { minHeight: 2, paddingTop: 1, flexDirection: "column" },
      holding ? h(Text, { color: COLOR.accent, wrap: "truncate" }, `  ↑↓ moves this model, enter drops it at #${cursor + 1}`) : null,
      confirming === "list"
        ? h(
            Text,
            { color: COLOR.warn, wrap: "truncate" },
            // Said out loud: this is the one delete on this screen that takes
            // more than the row under the cursor with it.
            `  delete list ${list?.name} and its ${models.length} model(s)? `,
            h(Text, { bold: true }, "y/n"),
          )
        : null,
      confirming === "model" ? h(Text, { color: COLOR.warn }, `  delete ${selected.alias}? `, h(Text, { bold: true }, "y/n")) : null,
      !confirming && running ? h(Text, { dimColor: true }, `  testing… ${done}/${Object.keys(tests).length} done, launched ${spacing / 1000}s apart, running in parallel`) : null,
      !confirming && !running && detail?.message
        ? h(
            Text,
            { wrap: "truncate" },
            h(Text, { color: detail.ok ? COLOR.ok : COLOR.fail }, `  ${detail.ok ? SYMBOL.ok : SYMBOL.fail} `),
            h(Text, { dimColor: true }, detail.message),
          )
        : null,
    ),
  );
}

function moveable(models, index, delta) {
  const target = index + delta;
  return target >= 0 && target < models.length;
}

function glyph(test) {
  if (!test) return " ";
  if (test.state === "queued") return SYMBOL.queued;
  if (test.state === "running") return SYMBOL.running;
  return test.state === "ok" ? SYMBOL.ok : SYMBOL.fail;
}
