import { Box, Text, useInput } from "ink";
import { useEffect, useRef, useState } from "react";
import { describeKey } from "../../config.js";
import { probeProvider } from "../../probe.js";
import { h } from "../h.js";
import { COLOR, SYMBOL, duration } from "../theme.js";
import { Frame, Hints, Table } from "../widgets.js";

const STATE_COLOR = { ok: COLOR.ok, fail: COLOR.fail, running: COLOR.warn, queued: undefined };
/** Green: resolved from the environment. Red: referenced but not set. Yellow: still inside config.json. */
const KEY_COLOR = { env: COLOR.ok, missing: COLOR.fail, inline: COLOR.warn, none: undefined };

export function ProvidersScreen({ config, update, notify, navigate, onBack }) {
  const [cursor, setCursor] = useState(0);
  const [confirming, setConfirming] = useState(false);
  const [tests, setTests] = useState({});
  const runRef = useRef(0);

  useEffect(
    () => () => {
      runRef.current += 1; // ignore probe results that land after unmount
    },
    [],
  );

  const providers = config.providers;
  const selected = providers[Math.min(cursor, providers.length - 1)];

  const runTests = () => {
    if (!providers.length) return;
    const runId = ++runRef.current;
    setTests(Object.fromEntries(providers.map((provider) => [provider.id, { state: "queued" }])));
    for (const provider of providers) {
      (async () => {
        setTests((previous) => ({ ...previous, [provider.id]: { state: "running" } }));
        const result = await probeProvider(provider);
        if (runRef.current !== runId) return;
        setTests((previous) => ({
          ...previous,
          [provider.id]: { state: result.ok ? "ok" : "fail", ...result },
        }));
      })();
    }
  };

  useInput((input, key) => {
    if (confirming) {
      if (input === "y") {
        const linked = config.models.filter((entry) => entry.providerId === selected.id).length;
        update((draft) => {
          draft.providers = draft.providers.filter((provider) => provider.id !== selected.id);
          draft.models = draft.models.filter((entry) => entry.providerId !== selected.id);
        });
        notify(`removed ${selected.name}${linked ? ` and ${linked} linked model(s)` : ""}`);
        setCursor(0);
      }
      setConfirming(false);
      return;
    }

    if (key.escape || input === "q") onBack();
    else if (key.upArrow || input === "k") setCursor((previous) => (previous - 1 + providers.length) % Math.max(1, providers.length));
    else if (key.downArrow || input === "j") setCursor((previous) => (previous + 1) % Math.max(1, providers.length));
    else if (input === "a") navigate({ name: "provider-form" });
    else if (input === "e" && selected) navigate({ name: "provider-form", providerId: selected.id });
    else if (input === " " && selected) {
      update((draft) => {
        const target = draft.providers.find((provider) => provider.id === selected.id);
        target.enabled = !target.enabled;
      });
    } else if (input === "d" && selected) setConfirming(true);
    else if (input === "t") runTests();
  });

  const columns = [
    { key: "name", label: "NAME" },
    { key: "type", label: "PROTOCOL" },
    { key: "baseUrl", label: "BASE URL" },
    {
      key: "apiKey",
      label: "API KEY",
      text: (row) => describeKey(row.apiKey).text,
      color: (row) => KEY_COLOR[describeKey(row.apiKey).state],
    },
    {
      key: "enabled",
      label: "ON",
      text: (row) => (row.enabled ? SYMBOL.on : SYMBOL.off),
      color: (row) => (row.enabled ? COLOR.ok : COLOR.fail),
    },
    {
      key: "test",
      label: "TEST",
      text: (row) => describe(tests[row.id]),
      color: (row) => STATE_COLOR[tests[row.id]?.state],
    },
  ];

  const rows = providers.map((provider) => ({ ...provider, key: provider.id }));
  const detail = tests[selected?.id];

  return h(
    Frame,
    {
      title: "Providers",
      subtitle: `${providers.length} configured · keys are stored in .env`,
      footer: h(Hints, {
        items: [
          ["↑↓", "move"],
          ["a", "add"],
          ["e", "edit"],
          ["space", "enable"],
          ["d", "delete"],
          ["t", "test all"],
          ["esc", "back"],
        ],
      }),
    },
    h(Box, { paddingTop: 1, flexDirection: "column" }, h(Table, { columns, rows, cursor, empty: "no provider yet, press a to add one" })),
    h(
      Box,
      { minHeight: 2, paddingTop: 1, flexDirection: "column" },
      confirming ? h(Text, { color: COLOR.warn }, `  delete ${selected.name} and its models? `, h(Text, { bold: true }, "y/n")) : null,
      !confirming && detail?.message ? h(Text, { dimColor: true, wrap: "truncate" }, `  ${selected.name}: ${detail.message}`) : null,
    ),
  );
}

function describe(test) {
  if (!test) return "-";
  if (test.state === "queued") return SYMBOL.queued;
  if (test.state === "running") return SYMBOL.running;
  if (test.state === "ok") return `${SYMBOL.ok} ${duration(test.latencyMs)}`;
  return SYMBOL.fail;
}
