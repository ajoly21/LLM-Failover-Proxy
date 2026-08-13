import { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { h } from './h.js';
import { useLayout } from './size.js';
import { COLOR, SYMBOL, cell, windowAround } from './theme.js';
import { Frame, Hints, TextField, editText, matchSuggestions } from './widgets.js';

/** Suggestions shown at once where there is room; the rest are counted below. */
const SUGGEST_ROWS = 6;

/**
 * Keyboard-driven form.
 *
 * A field is `{ name, label, type, initial, options?, placeholder?, hint?,
 * required?, masked?, suggest? }` with type `text | secret | number | select |
 * boolean`. ↑↓ moves between fields, ←→ changes selects and booleans, Enter
 * advances and saves on the last field, Esc cancels.
 *
 * A text field may carry `suggest: { items, loading, note }`, where an item is
 * a string or `{ value, hint }`. Whatever is typed filters the items, and the
 * list that opens is walked with ↑↓ and accepted with Enter — so while it is
 * open those two keys belong to the list, and Tab is what still moves between
 * fields. `onChange` reports every edit, which is how the caller knows which
 * provider was selected and what to offer for it.
 */
export function Form({ title, subtitle, fields, onSubmit, onCancel, onChange }) {
  const [values, setValues] = useState(() => {
    const initial = {};
    for (const field of fields) initial[field.name] = field.initial ?? (field.type === 'boolean' ? false : '');
    return initial;
  });
  const [focus, setFocus] = useState(0);
  const [error, setError] = useState(null);
  // Which suggestion is highlighted, -1 while the cursor is still in the text.
  const [pick, setPick] = useState(-1);
  // Esc closes the list without leaving the form; the next keystroke reopens it.
  const [dismissed, setDismissed] = useState(false);

  const layout = useLayout();
  const field = fields[focus];
  const labelWidth = Math.max(...fields.map((entry) => entry.label.length));

  const query = String(values[field.name] ?? '');
  // Ranked even when the list is closed: "nothing matches this" is a fact about
  // what was typed, and it stays true whether or not the list is being shown.
  const ranked = field.suggest ? matchSuggestions(field.suggest.items ?? [], query) : [];
  // Reserved, top to bottom: the two borders, the title and its subtitle, the
  // hint line, the fields, the blank line above the list, the counter line and
  // the three rows the hint and error box always holds.
  const room = Math.max(2, Math.min(SUGGEST_ROWS, layout.listRows(10 + fields.length)));
  // What is on screen is a window, not the whole of what can be reached: `pick`
  // walks every match and the window follows it, so a match past the sixth row
  // is a few ↓ away rather than out of reach.
  const { start, end } = windowAround(ranked.length, Math.max(pick, 0), room);
  const shown = ranked.slice(start, end);
  // A single match the user has already typed in full teaches nothing.
  const open = !dismissed && ranked.length > 0 && !(ranked.length === 1 && suggestValue(ranked[0]) === query.trim());

  const setValue = (name, value) => {
    const next = { ...values, [name]: value };
    setValues(next);
    onChange?.(next);
  };

  const moveFocus = (delta) => {
    setFocus((previous) => (previous + delta + fields.length) % fields.length);
    setPick(-1);
    setDismissed(false);
  };

  const cycle = (direction) => {
    if (field.type === 'boolean') {
      setValue(field.name, !values[field.name]);
      return;
    }
    if (field.type !== 'select') return;
    const index = field.options.findIndex((option) => option.value === values[field.name]);
    const next = (index + direction + field.options.length) % field.options.length;
    setValue(field.name, field.options[next].value);
  };

  const accept = () => {
    setValue(field.name, suggestValue(ranked[pick]));
    setPick(-1);
    setDismissed(true);
    setError(null);
  };

  const submit = () => {
    const missing = fields.find((entry) => entry.required && String(values[entry.name] ?? '').trim() === '');
    if (missing) {
      setError(`${missing.label} is required`);
      setFocus(fields.indexOf(missing));
      return;
    }
    const invalid = fields.find((entry) => entry.type === 'number' && values[entry.name] !== '' && !Number.isFinite(Number(values[entry.name])));
    if (invalid) {
      setError(`${invalid.label} must be a number`);
      setFocus(fields.indexOf(invalid));
      return;
    }
    onSubmit(values);
  };

  useInput((input, key) => {
    if (key.escape) {
      // The list goes first: Esc on an open list is a change of mind about the
      // suggestion, not about the whole form.
      if (open) setDismissed(true);
      else onCancel();
      return;
    }
    if (key.ctrl && input === 's') {
      submit();
      return;
    }
    if (key.tab) {
      moveFocus(key.shift ? -1 : 1);
      return;
    }
    if (key.upArrow) {
      // -1 is the text itself, so ↑ walks back up the list and out of it.
      if (open && pick >= 0) setPick(pick - 1);
      else moveFocus(-1);
      return;
    }
    if (key.downArrow) {
      // Past the last match it comes back to the text, so ↓ never dead-ends.
      if (open) setPick(pick + 1 >= ranked.length ? -1 : pick + 1);
      else moveFocus(1);
      return;
    }
    if (key.leftArrow) {
      cycle(-1);
      return;
    }
    if (key.rightArrow || (input === ' ' && (field.type === 'boolean' || field.type === 'select'))) {
      cycle(1);
      return;
    }
    if (key.return) {
      if (open && pick >= 0) accept();
      else if (focus === fields.length - 1) submit();
      else moveFocus(1);
      return;
    }
    if (field.type === 'text' || field.type === 'secret' || field.type === 'number') {
      const next = editText(String(values[field.name] ?? ''), input, key);
      if (next !== values[field.name]) {
        setError(null);
        // Typing is always about the text, so the list follows it again.
        setPick(-1);
        setDismissed(false);
        setValue(field.name, next);
      }
    }
  });

  const rows = fields.map((entry, index) => {
    const focused = index === focus;
    const value = values[entry.name];
    let display;
    if (entry.type === 'boolean') {
      display = h(Text, { color: value ? COLOR.ok : undefined }, `${value ? SYMBOL.on : SYMBOL.off} ${value ? 'yes' : 'no'}`);
    } else if (entry.type === 'select') {
      const option = entry.options.find((candidate) => candidate.value === value) ?? entry.options[0];
      display = h(
        Text,
        null,
        h(Text, { color: COLOR.accent }, focused ? '‹ ' : '  '),
        option.label,
        h(Text, { color: COLOR.accent }, focused ? ' ›' : '  '),
        option.hint ? h(Text, { dimColor: true }, `  ${option.hint}`) : null,
      );
    } else {
      display = h(TextField, {
        value: String(value ?? ''),
        // The text keeps its caret while a suggestion is highlighted: the list
        // is a shortcut for filling that field in, and it must look like it.
        focused,
        masked: entry.type === 'secret',
        placeholder: entry.placeholder ?? '',
      });
    }

    return h(
      Box,
      { key: entry.name },
      h(Text, { color: focused ? COLOR.accent : undefined }, `${focused ? SYMBOL.cursor : ' '} `),
      h(Text, { bold: focused, dimColor: !focused }, cell(entry.label, labelWidth)),
      h(Text, null, '  '),
      display,
    );
  });

  const hint = field.hint ? h(Text, { dimColor: true }, `  ${field.hint}`) : null;

  return h(
    Frame,
    {
      title,
      subtitle,
      footer: h(Hints, {
        items: [
          open ? ['↑↓', 'suggestions'] : ['↑↓', 'field'],
          open ? ['tab', 'field'] : null,
          !open && (field.type === 'select' || field.type === 'boolean') ? ['←→', 'change'] : null,
          // Tied to what Enter would actually do, which is the same test the
          // handler makes: a failed save can move the focus off the list.
          ['enter', open && pick >= 0 ? 'use it' : focus === fields.length - 1 ? 'save' : 'next'],
          ['ctrl+s', 'save'],
          ['esc', open ? 'close list' : 'cancel'],
        ],
      }),
    },
    h(Box, { flexDirection: 'column', paddingTop: 1 }, ...rows),
    h(Suggestions, {
      suggest: field.suggest,
      shown,
      start,
      end,
      total: ranked.length,
      open,
      pick,
      query,
      // Lined up under the value it fills in, except where the screen is too
      // narrow to give ten columns away to alignment.
      indent: layout.tight ? 2 : labelWidth + 2,
      room: layout.inner,
    }),
    h(Box, { flexDirection: 'column', minHeight: 2, paddingTop: 1 }, hint, error ? h(Text, { color: COLOR.fail }, `  ${error}`) : null),
  );
}

const suggestValue = (item) => String(typeof item === 'string' ? item : item.value);
const suggestHint = (item) => (typeof item === 'string' ? null : item.hint);

/**
 * The list under a field that offers candidates, plus the one line that says
 * what state the lookup is in — still running, failed, or waiting to be
 * filtered. That line matters as much as the list: a field that quietly offers
 * nothing is indistinguishable from a provider that answered nothing.
 */
function Suggestions({ suggest, shown, start, end, total, open, pick, query, indent, room }) {
  if (!suggest) return null;
  const pad = ' '.repeat(indent);
  // Padded to the longest name so the highlight is a rectangle, but never past
  // the edge of the screen, where the padding would only force a wrap.
  const width = Math.min(Math.max(...shown.map((item) => suggestValue(item).length), 1), Math.max(8, room - indent - 2));

  let status = null;
  if (suggest.loading) status = `${SYMBOL.running} ${suggest.note ?? 'reading the model list…'}`;
  // Only a list known to be the whole catalogue may say something is not in it.
  // A partial one saying "no match" would read as "that model does not exist"
  // when all it means is that the lookup never came back.
  else if (!total && query.trim() && suggest.items?.length && !suggest.partial) status = `no match for "${query.trim()}"`;
  else if (!open && suggest.note) status = suggest.note;

  return h(
    Box,
    { flexDirection: 'column', paddingTop: 1, minHeight: 2 },
    status ? h(Text, { dimColor: true, wrap: 'truncate' }, `${pad}${status}`) : null,
    ...(open
      ? shown.map((item, index) => {
          const picked = start + index === pick;
          return h(
            Text,
            { key: suggestValue(item), wrap: 'truncate' },
            pad,
            h(Text, { color: COLOR.accent }, picked ? `${SYMBOL.cursor} ` : '  '),
            h(Text, { inverse: picked }, cell(suggestValue(item), width)),
            suggestHint(item) ? h(Text, { dimColor: true }, `  ${suggestHint(item)}`) : null,
          );
        })
      : []),
    // Worded like the tables', because it means the same thing: there is more
    // here than fits, and ↑↓ is how the rest is reached.
    open && total > shown.length
      ? h(Text, { dimColor: true, wrap: 'truncate' }, `${pad}  … showing ${start + 1}-${end} of ${total}`)
      : null,
  );
}
