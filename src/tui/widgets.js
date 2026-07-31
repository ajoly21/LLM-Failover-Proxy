import { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { h } from './h.js';
import { COLOR, SYMBOL, cell, windowAround } from './theme.js';
import { daemonStatus } from '../daemon.js';

/** Bordered panel with a title and an optional status line. */
export function Frame({ title, subtitle, children, footer }) {
  return h(
    Box,
    { flexDirection: 'column' },
    h(
      Box,
      { borderStyle: 'round', borderColor: COLOR.accent, flexDirection: 'column', paddingX: 1 },
      h(
        Box,
        null,
        h(Text, { bold: true, color: COLOR.title }, title),
        subtitle ? h(Text, { dimColor: true }, `  ${subtitle}`) : null,
      ),
      children,
    ),
    footer ? h(Box, { paddingX: 1 }, footer) : null,
  );
}

/** `key label · key label` hint line. */
export function Hints({ items }) {
  const parts = [];
  items.filter(Boolean).forEach(([keys, label], index) => {
    if (index > 0) parts.push(h(Text, { key: `sep-${index}`, dimColor: true }, ' · '));
    parts.push(h(Text, { key: `k-${index}`, color: COLOR.accent }, keys));
    parts.push(h(Text, { key: `l-${index}`, dimColor: true }, ` ${label}`));
  });
  return h(Text, null, ...parts);
}

/**
 * Fixed-width table with a highlighted cursor row.
 * A column is `{ key, label, width?, align?, text?, color? }`; `text` and
 * `color` receive the row so a cell can render its own state.
 */
export function Table({ columns, rows, cursor = -1, maxRows = 12, empty = 'nothing here yet' }) {
  if (!rows.length) return h(Box, { paddingY: 1 }, h(Text, { dimColor: true }, `  ${empty}`));

  const widths = columns.map((column) => {
    if (column.width) return column.width;
    const values = rows.map((row) => String((column.text ? column.text(row) : row[column.key]) ?? '').length);
    return Math.max(column.label.length, ...values);
  });

  const { start, end } = windowAround(rows.length, cursor, maxRows);
  const header = columns.map((column, index) => cell(column.label, widths[index], column.align)).join('  ');

  const lines = [];
  for (let index = start; index < end; index += 1) {
    const row = rows[index];
    const selected = index === cursor;
    const parts = [];
    columns.forEach((column, columnIndex) => {
      if (columnIndex > 0) parts.push('  ');
      const text = cell(column.text ? column.text(row) : row[column.key], widths[columnIndex], column.align);
      const color = column.color?.(row);
      parts.push(color ? h(Text, { key: column.key, color }, text) : text);
    });
    lines.push(
      h(
        Text,
        { key: row.key ?? index, inverse: selected, wrap: 'truncate' },
        `${selected ? SYMBOL.cursor : ' '} `,
        ...parts,
      ),
    );
  }

  return h(
    Box,
    { flexDirection: 'column' },
    h(Text, { dimColor: true }, `  ${header}`),
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
  return h(
    Box,
    { flexDirection: 'column', paddingX: 1 },
    h(
      Text,
      null,
      h(Text, { dimColor: true }, 'listening on '),
      h(Text, { color: COLOR.accent }, `${config.server.host}:${config.server.port}`),
      h(Text, { dimColor: true }, '   providers '),
      h(Text, null, String(config.providers.length)),
      h(Text, { dimColor: true }, '   models '),
      h(Text, null, String(config.models.length)),
      h(Text, { dimColor: true }, '   background '),
      service.running
        ? h(Text, { color: COLOR.ok }, `running (pid ${service.pid})`)
        : h(Text, { dimColor: true }, 'stopped'),
    ),
    h(Text, { dimColor: true, wrap: 'truncate-middle' }, config.__file),
    message ? h(Text, { color: message.tone ?? COLOR.ok }, message.text) : null,
  );
}
