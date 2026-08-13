import { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { h } from './h.js';
import { COLOR, SYMBOL, cell, windowAround } from './theme.js';
import { useLayout } from './size.js';
import { daemonStatus } from '../daemon.js';

/**
 * Bordered panel with a title and an optional status line. The subtitle is
 * truncated rather than wrapped: it is context, and it must never push the
 * content of the screen down a line on a narrow terminal.
 */
export function Frame({ title, subtitle, children, footer }) {
  const layout = useLayout();
  return h(
    Box,
    { flexDirection: 'column' },
    h(
      Box,
      { borderStyle: 'round', borderColor: COLOR.accent, flexDirection: 'column', paddingX: 1 },
      h(
        Box,
        null,
        // The title never gives up a character: without `flexShrink: 0` the
        // subtitle squeezes it, and "Providers" comes out as "Provide" + "s".
        h(Box, { flexShrink: 0 }, h(Text, { bold: true, color: COLOR.title }, title)),
        subtitle && !layout.narrow ? h(Text, { dimColor: true, wrap: 'truncate' }, `  ${subtitle}`) : null,
      ),
      // Too narrow to share a line: the subtitle takes its own rather than
      // wrapping into the title.
      subtitle && layout.narrow ? h(Text, { dimColor: true, wrap: 'truncate' }, subtitle) : null,
      children,
    ),
    footer ? h(Box, { paddingX: 1 }, footer) : null,
  );
}

/**
 * `key label · key label` hint line.
 *
 * An item may be `[keys, label, { optional: true }]`, which is dropped on a
 * narrow terminal: on a phone these hints wrap over three lines and eat the rows
 * they are meant to explain. Whatever is not optional always shows, so the way
 * out of a screen is never the thing that disappears.
 */
export function Hints({ items }) {
  const layout = useLayout();
  const parts = [];
  items
    .filter(Boolean)
    .filter(([, , options]) => !(layout.narrow && options?.optional))
    .forEach(([keys, label], index) => {
      if (index > 0) parts.push(h(Text, { key: `sep-${index}`, dimColor: true }, ' · '));
      parts.push(h(Text, { key: `k-${index}`, color: COLOR.accent }, keys));
      parts.push(h(Text, { key: `l-${index}`, dimColor: true }, ` ${label}`));
    });
  return h(Text, null, ...parts);
}

const GAP = 2; // spaces between two columns
const GUTTER = 2; // the cursor mark and its space, ahead of the first column

/** Width a flexible column shortens to willingly, before anything is dropped. */
const SOFT_MIN = 24;
/** And what it accepts once there is nothing left to drop. */
const HARD_MIN = 12;

/**
 * Chooses which columns to show, and how wide, for the width on offer.
 *
 * A column may declare `drop`: a higher number is given up sooner when room runs
 * out. One column may declare `flex`: the long text — a model name, a URL — which
 * shortens rather than taking a whole column down with it. A column with neither
 * always shows at its natural width, which is how the priority number, the on/off
 * mark and the counters stay put on a phone.
 *
 * The flexible column shortens to `soft` first, because a name cut to twelve
 * characters identifies nothing; only when every droppable column is gone does it
 * go down to `min`.
 */
export function fitColumns(columns, rows, available) {
  const natural = (column) => {
    if (column.width) return column.width;
    const values = rows.map((row) => String((column.text ? column.text(row) : row[column.key]) ?? '').length);
    return Math.max(column.label.length, ...values);
  };

  const spent = (list) => list.reduce((sum, column) => sum + column.size, 0) + GAP * Math.max(0, list.length - 1) + GUTTER;

  /** Gives the flexible column whatever the others left, within its two floors. */
  const shape = (list, floor) => {
    const flex = list.find((column) => column.flex);
    if (!flex) return list;
    const room = available - (spent(list) - flex.size);
    flex.size = Math.max(floor(flex), Math.min(natural(flex), room));
    return list;
  };

  const soft = (flex) => Math.min(natural(flex), flex.soft ?? SOFT_MIN);
  const hard = (flex) => flex.min ?? HARD_MIN;

  let kept = columns.map((column) => ({ ...column, size: natural(column) }));
  for (;;) {
    shape(kept, soft);
    if (spent(kept) <= available) return kept;

    const victim = kept.filter((column) => column.drop).sort((a, b) => b.drop - a.drop)[0];
    if (!victim) return shape(kept, hard); // last resort, then the rows truncate
    kept = kept.filter((column) => column !== victim);
  }
}

/**
 * Table with a highlighted cursor row, sized to the terminal.
 * A column is `{ key, label, width?, align?, text?, color?, drop?, flex?, min? }`;
 * `text` and `color` receive the row so a cell can render its own state.
 */
export function Table({ columns, rows, cursor = -1, maxRows, empty = 'nothing here yet', cursorGlyph = SYMBOL.cursor }) {
  const layout = useLayout();
  if (!rows.length) return h(Box, { paddingY: 1 }, h(Text, { dimColor: true }, `  ${empty}`));

  const shown = fitColumns(columns, rows, layout.inner);
  const limit = maxRows ?? Math.min(12, layout.listRows(14));
  const { start, end } = windowAround(rows.length, cursor, limit);
  const header = shown.map((column) => cell(column.label, column.size, column.align)).join('  ');

  const lines = [];
  for (let index = start; index < end; index += 1) {
    const row = rows[index];
    const selected = index === cursor;
    const parts = [];
    shown.forEach((column, columnIndex) => {
      if (columnIndex > 0) parts.push('  ');
      const text = cell(column.text ? column.text(row) : row[column.key], column.size, column.align);
      const color = column.color?.(row);
      parts.push(color ? h(Text, { key: column.key, color }, text) : text);
    });
    lines.push(
      h(
        Text,
        { key: row.key ?? index, inverse: selected, wrap: 'truncate' },
        `${selected ? cursorGlyph : ' '} `,
        ...parts,
      ),
    );
  }

  return h(
    Box,
    { flexDirection: 'column' },
    // Truncated like the rows: a header that wraps would shift every row below it.
    h(Text, { dimColor: true, wrap: 'truncate' }, `  ${header}`),
    ...lines,
    end < rows.length || start > 0
      ? h(Text, { dimColor: true }, `  … showing ${start + 1}-${end} of ${rows.length}`)
      : null,
  );
}

/** Single-line editor: append, backspace and clear. Optionally masked. */
export function TextField({ value, focused, masked, placeholder = '' }) {
  const shown = masked ? '•'.repeat(value.length) : value;
  if (!shown) {
    return h(
      Text,
      null,
      focused ? h(Text, { inverse: true }, ' ') : null,
      h(Text, { dimColor: true }, placeholder),
    );
  }
  return h(Text, null, shown, focused ? h(Text, { inverse: true }, ' ') : null);
}

/** Applies a keypress to a text buffer. Returns the new value. */
export function editText(value, input, key) {
  if (key.backspace || key.delete) return value.slice(0, -1);
  if (key.ctrl && input === 'u') return '';
  if (key.ctrl || key.meta || key.escape || key.return || key.tab) return value;
  if (key.upArrow || key.downArrow || key.leftArrow || key.rightArrow) return value;
  // Ignore control characters; keep everything printable, including spaces.
  const printable = [...input].filter((char) => char >= ' ').join('');
  return value + printable;
}

/**
 * Candidates that contain what has been typed, best first.
 *
 * The match is a substring, not a prefix: a model is looked for by the part of
 * its name the user remembers, and typing `glm` has to find `z-ai/glm-5.2`.
 * Several words narrow it down further — each one must appear, in any order,
 * so `glm free` finds `z-ai/glm-5.2-free` without caring which comes first.
 *
 * Ranking is by how much of a name the first word was. An id is usually
 * `vendor/name`, and what gets typed is nearly always the start of the name,
 * so `z-ai/glm-5.2` has to come out ahead of `my-glmodel` for `glm` even
 * though both contain it. Hence three tiers: the id or its name part starts
 * with the word, some word inside it starts with it, or it is buried in the
 * middle of one. Then the earliest match, the shortest id, and alphabetical
 * order, so the list never reshuffles between two keystrokes.
 *
 * An item is a string or `{ value, hint }`.
 */
export function matchSuggestions(items, query) {
  const terms = String(query ?? '')
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  if (!terms.length) return [];

  const [first] = terms;
  const scored = [];
  for (const item of items) {
    const value = String(typeof item === 'string' ? item : item.value);
    const haystack = value.toLowerCase();
    if (!terms.every((term) => haystack.includes(term))) continue;

    let at = haystack.indexOf(first);
    let tier = 2;
    if (haystack.startsWith(first) || haystack.slice(haystack.lastIndexOf('/') + 1).startsWith(first)) {
      tier = 0;
    } else {
      // Not the first occurrence but the first useful one: in `xglm-glm-5` the
      // one that opens a word is what the typing was aiming at.
      for (let index = at; index !== -1; index = haystack.indexOf(first, index + 1)) {
        if (!/[a-z0-9]/.test(haystack[index - 1])) {
          tier = 1;
          at = index;
          break;
        }
      }
    }
    scored.push({ item, value, tier, at });
  }

  scored.sort((a, b) => a.tier - b.tier || a.at - b.at || a.value.length - b.value.length || (a.value < b.value ? -1 : 1));
  return scored.map((entry) => entry.item);
}

/** Dead-end screen with a single way out, so Esc always works. */
export function Notice({ title, message, tone = COLOR.warn, onBack }) {
  useInput((input, key) => {
    if (key.escape || key.return || input === 'q') onBack();
  });
  return h(
    Frame,
    { title, footer: h(Hints, { items: [['esc', 'back']] }) },
    h(Box, { paddingTop: 1 }, h(Text, { color: tone }, `  ${message}`)),
  );
}

export function Banner({ config, message }) {
  // Read once per mount: coming back to the menu refreshes it.
  const [service] = useState(() => daemonStatus(config.__file));
  const layout = useLayout();

  const counts = h(
    Text,
    { key: 'counts', wrap: 'truncate' },
    h(Text, { dimColor: true }, layout.narrow ? 'providers ' : '   providers '),
    h(Text, null, String(config.providers.length)),
    h(Text, { dimColor: true }, '   models '),
    h(Text, null, String(config.models.length)),
    h(Text, { dimColor: true }, '   '),
    service.running ? h(Text, { color: COLOR.ok }, `up (pid ${service.pid})`) : h(Text, { dimColor: true }, 'stopped'),
  );

  return h(
    Box,
    { flexDirection: 'column', paddingX: 1 },
    // One line where there is room for one, two where there is not: wrapping
    // this by accident is what pushes the menu off a phone screen.
    h(
      Text,
      { wrap: 'truncate' },
      layout.narrow ? null : h(Text, { dimColor: true }, 'listening on '),
      h(Text, { color: COLOR.accent }, `${config.server.host}:${config.server.port}`),
      layout.narrow ? null : counts,
    ),
    layout.narrow ? counts : null,
    // The path is the first thing to go on a short screen: it is the least
    // useful line here, and it is one of the longest.
    layout.short ? null : h(Text, { dimColor: true, wrap: 'truncate-middle' }, config.__file),
    message ? h(Text, { color: message.tone ?? COLOR.ok, wrap: 'truncate' }, message.text) : null,
  );
}
