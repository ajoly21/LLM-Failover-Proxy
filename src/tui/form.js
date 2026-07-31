import { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { h } from './h.js';
import { COLOR, SYMBOL, cell } from './theme.js';
import { Frame, Hints, TextField, editText } from './widgets.js';

/**
 * Keyboard-driven form.
 *
 * A field is `{ name, label, type, initial, options?, placeholder?, hint?,
 * required?, masked? }` with type `text | secret | number | select | boolean`.
 * ↑↓ moves between fields, ←→ changes selects and booleans, Enter advances and
 * saves on the last field, Esc cancels.
 */
export function Form({ title, subtitle, fields, onSubmit, onCancel }) {
  const [values, setValues] = useState(() => {
    const initial = {};
    for (const field of fields) initial[field.name] = field.initial ?? (field.type === 'boolean' ? false : '');
    return initial;
  });
  const [focus, setFocus] = useState(0);
  const [error, setError] = useState(null);

  const field = fields[focus];
  const labelWidth = Math.max(...fields.map((entry) => entry.label.length));

  const setValue = (name, value) => setValues((previous) => ({ ...previous, [name]: value }));

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
      onCancel();
      return;
    }
    if (key.ctrl && input === 's') {
      submit();
      return;
    }
    if (key.upArrow || (key.tab && key.shift)) {
      setFocus((previous) => (previous - 1 + fields.length) % fields.length);
      return;
    }
    if (key.downArrow || key.tab) {
      setFocus((previous) => (previous + 1) % fields.length);
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
      if (focus === fields.length - 1) submit();
      else setFocus(focus + 1);
      return;
    }
    if (field.type === 'text' || field.type === 'secret' || field.type === 'number') {
      const next = editText(String(values[field.name] ?? ''), input, key);
      if (next !== values[field.name]) {
        setError(null);
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
          ['↑↓', 'field'],
          field.type === 'select' || field.type === 'boolean' ? ['←→', 'change'] : null,
          ['enter', focus === fields.length - 1 ? 'save' : 'next'],
          ['ctrl+s', 'save'],
          ['esc', 'cancel'],
        ],
      }),
    },
    h(Box, { flexDirection: 'column', paddingTop: 1 }, ...rows),
    h(Box, { flexDirection: 'column', minHeight: 2, paddingTop: 1 }, hint, error ? h(Text, { color: COLOR.fail }, `  ${error}`) : null),
  );
}
