import { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { h } from '../h.js';
import { useLayout } from '../size.js';
import { COLOR, SYMBOL, cell } from '../theme.js';
import { Banner, Frame, Hints } from '../widgets.js';
import { updateCommandLine } from '../../update.js';

const ITEMS = [
  { key: 'providers', label: 'Providers', hint: 'endpoints, API keys, protocol' },
  { key: 'models', label: 'Models & priority', hint: 'failover chain, live latency tests' },
  { key: 'settings', label: 'Settings', hint: 'port, timeouts, failover policy' },
  { key: 'status', label: 'Status & stats', hint: 'persisted counters and cooldowns' },
  { key: 'setup', label: 'Setup wizard', hint: 'add the default chain, paste keys' },
  { key: 'start', label: 'Start the server', hint: 'closes this screen' },
  { key: 'quit', label: 'Quit', hint: '' },
];

export function HomeScreen({ config, message, release, onSelect }) {
  const [cursor, setCursor] = useState(0);
  const layout = useLayout();
  const width = Math.max(...ITEMS.map((item) => item.label.length));
  const installable = Boolean(release?.available && release.installable);

  useInput((input, key) => {
    if (key.upArrow || input === 'k') setCursor((previous) => (previous - 1 + ITEMS.length) % ITEMS.length);
    else if (key.downArrow || input === 'j') setCursor((previous) => (previous + 1) % ITEMS.length);
    else if (key.return) onSelect(ITEMS[cursor].key);
    else if (input === 'u' && installable) onSelect('update');
    else if (input === 'q' || key.escape) onSelect('quit');
    else {
      const index = Number(input) - 1;
      if (Number.isInteger(index) && index >= 0 && index < ITEMS.length) onSelect(ITEMS[index].key);
    }
  });

  return h(
    Frame,
    {
      title: 'llm-failover-proxy',
      subtitle: 'OpenAI-compatible proxy with provider failover',
      footer: h(Hints, {
        items: [
          ['↑↓', 'move'],
          ['enter', 'open'],
          ['1-7', 'jump'],
          installable ? ['u', 'update'] : null,
          ['q', 'quit'],
        ],
      }),
    },
    h(Banner, { config, message }),
    release?.available
      ? h(
          Box,
          { paddingX: 1 },
          h(
            Text,
            { wrap: 'truncate' },
            h(Text, { color: COLOR.warn }, `${SYMBOL.on} update available `),
            h(Text, { dimColor: true }, `${release.current} → `),
            h(Text, { bold: true }, release.latest),
            installable
              ? h(Text, { dimColor: true }, '   press u to install it')
              : h(Text, { dimColor: true }, `   ${updateCommandLine()}`),
          ),
        )
      : null,
    h(
      Box,
      { flexDirection: 'column', paddingTop: 1 },
      ...ITEMS.map((item, index) =>
        h(
          Text,
          { key: item.key, inverse: index === cursor, wrap: 'truncate' },
          `${index === cursor ? SYMBOL.cursor : ' '} ${index + 1}. `,
          cell(item.label, width),
          // The hint doubles the width of every line: on a phone the label and
          // the number are enough to choose by, and wrapping would double the
          // height of the menu as well.
          layout.narrow ? null : h(Text, { dimColor: index !== cursor, color: index === cursor ? undefined : COLOR.accent }, `  ${item.hint}`),
        ),
      ),
    ),
  );
}
