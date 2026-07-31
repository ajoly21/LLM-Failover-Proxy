import { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { h } from '../h.js';
import { COLOR, SYMBOL, cell } from '../theme.js';
import { Frame, Hints, Notice } from '../widgets.js';
import { Form } from '../form.js';
import { describeKey, envVarName, newId } from '../../config.js';
import { envPathFor, upsertEnv } from '../../env.js';
import { PRESETS } from '../../presets.js';

const PROTOCOLS = [
  { value: 'openai', label: 'openai', hint: 'POST {baseUrl}/chat/completions' },
  { value: 'anthropic', label: 'anthropic', hint: 'POST {baseUrl}/messages, translated' },
];

/** Simple vertical picker used before prefilling the provider form. */
function Picker({ title, subtitle, items, onPick, onCancel }) {
  const [cursor, setCursor] = useState(0);
  const width = Math.max(...items.map((item) => item.label.length));

  useInput((input, key) => {
    if (key.escape || input === 'q') onCancel();
    else if (key.upArrow || input === 'k') setCursor((previous) => (previous - 1 + items.length) % items.length);
    else if (key.downArrow || input === 'j') setCursor((previous) => (previous + 1) % items.length);
    else if (key.return) onPick(items[cursor]);
  });

  return h(
    Frame,
    {
      title,
      subtitle,
      footer: h(Hints, {
        items: [
          ['↑↓', 'move'],
          ['enter', 'pick'],
          ['esc', 'cancel'],
        ],
      }),
    },
    h(
      Box,
      { flexDirection: 'column', paddingTop: 1 },
      ...items.map((item, index) =>
        h(
          Text,
          { key: item.key ?? item.label, inverse: index === cursor },
          `${index === cursor ? SYMBOL.cursor : ' '} `,
          cell(item.label, width),
          item.hint ? h(Text, { dimColor: index !== cursor }, `  ${item.hint}`) : null,
        ),
      ),
    ),
  );
}

export function ProviderForm({ config, providerId, update, notify, onDone }) {
  const existing = providerId ? config.providers.find((provider) => provider.id === providerId) : null;
  const [preset, setPreset] = useState(existing ? { key: 'edit' } : null);

  if (!preset) {
    return h(Picker, {
      title: 'Add a provider',
      subtitle: 'pick a preset, or "custom" to type everything',
      items: PRESETS.map((entry) => ({
        key: entry.key,
        label: entry.name || 'custom',
        hint: entry.baseUrl || 'URL to enter',
        preset: entry,
      })),
      onPick: (item) => setPreset(item.preset),
      onCancel: onDone,
    });
  }

  const fields = [
    {
      name: 'name',
      label: 'name',
      type: 'text',
      required: true,
      initial: existing?.name ?? preset.name ?? '',
      placeholder: 'my-provider',
      hint: 'internal name, shown in logs and headers',
    },
    {
      name: 'baseUrl',
      label: 'base URL',
      type: 'text',
      required: true,
      initial: existing?.baseUrl ?? preset.baseUrl ?? '',
      placeholder: 'https://api.example.com/v1',
      hint: 'OpenAI root: the proxy appends /chat/completions',
    },
    {
      name: 'type',
      label: 'protocol',
      type: 'select',
      options: PROTOCOLS,
      // Defaults to openai even for the Anthropic preset: its /chat/completions
      // endpoint is OpenAI-compatible, so anthropic stays an explicit choice.
      initial: existing?.type ?? 'openai',
      hint: 'anthropic only if you want the Messages API',
    },
    {
      name: 'apiKey',
      label: 'API key',
      type: 'secret',
      initial: '',
      placeholder: existing?.apiKey ? `unchanged (${describeKey(existing.apiKey).text})` : 'empty = none',
      hint: `saved to .env as ${envVarName(existing?.name ?? preset.name ?? 'provider')} · env:MY_VAR reuses another variable`,
    },
  ];

  const submit = (values) => {
    const name = values.name.trim();
    const clash = config.providers.some(
      (provider) => provider.id !== providerId && provider.name.toLowerCase() === name.toLowerCase(),
    );
    if (clash) {
      notify(`a provider named ${name} already exists`, COLOR.fail);
      return;
    }

    // Secrets go to the .env; the config only ever holds the reference.
    const typed = values.apiKey.trim();
    let reference = null;
    let variable = null;
    if (typed.startsWith('env:')) {
      reference = typed;
    } else if (typed) {
      variable = envVarName(name);
      try {
        upsertEnv(envPathFor(config.__file), { [variable]: typed });
      } catch (err) {
        notify(`could not write .env: ${err.message}`, COLOR.fail);
        return;
      }
      reference = `env:${variable}`;
    }

    update((draft) => {
      if (providerId) {
        const target = draft.providers.find((provider) => provider.id === providerId);
        target.name = name;
        target.baseUrl = values.baseUrl.trim();
        target.type = values.type;
        // An empty field keeps the stored key rather than wiping it.
        if (reference) target.apiKey = reference;
        return;
      }
      draft.providers.push({
        id: newId('prov'),
        name,
        type: values.type,
        baseUrl: values.baseUrl.trim(),
        apiKey: reference,
        headers: {},
        enabled: true,
      });
    });
    notify(`${providerId ? 'updated' : 'added'} ${name}${variable ? ` · key saved to .env as ${variable}` : ''}`);
    onDone();
  };

  return h(Form, {
    title: providerId ? `Edit ${existing.name}` : 'Add a provider',
    subtitle: providerId ? 'leave the key empty to keep the current one' : preset.name || 'custom',
    fields,
    onSubmit: submit,
    onCancel: onDone,
  });
}

export function ModelForm({ config, modelId, update, notify, onDone }) {
  const existing = modelId ? config.models.find((entry) => entry.id === modelId) : null;

  if (!config.providers.length) {
    return h(Notice, { title: 'Add a model', message: 'add a provider first', onBack: onDone });
  }

  const providerOptions = config.providers.map((provider) => ({
    value: provider.id,
    label: provider.name,
    hint: provider.baseUrl,
  }));
  const sample = PRESETS.find((preset) => preset.name === config.providers[0].name)?.sample ?? '';

  const fields = [
    {
      name: 'providerId',
      label: 'provider',
      type: 'select',
      options: providerOptions,
      initial: existing?.providerId ?? providerOptions[0].value,
    },
    {
      name: 'model',
      label: 'model id',
      type: 'text',
      required: true,
      initial: existing?.model ?? '',
      placeholder: sample || 'upstream model id',
      hint: 'exactly as the provider names it',
    },
  ];

  if (modelId) {
    fields.push(
      {
        name: 'alias',
        label: 'alias',
        type: 'text',
        required: true,
        initial: existing.alias,
        hint: 'name clients ask for; the same alias on several entries makes a failover group',
      },
      {
        name: 'kind',
        label: 'kind',
        type: 'select',
        options: [
          { value: 'chat', label: 'chat', hint: '/v1/chat/completions' },
          { value: 'embedding', label: 'embedding', hint: '/v1/embeddings' },
        ],
        initial: existing.kind,
      },
    );
    if (Object.keys(existing.params || {}).length) {
      fields.push({
        name: 'clearParams',
        label: 'clear forced params',
        type: 'boolean',
        initial: false,
        hint: `currently ${JSON.stringify(existing.params)}`,
      });
    }
  } else {
    fields.push({
      name: 'position',
      label: 'priority',
      type: 'number',
      initial: String(config.models.length + 1),
      hint: `1 = tried first, ${config.models.length + 1} = last`,
    });
  }

  const submit = (values) => {
    update((draft) => {
      if (modelId) {
        const target = draft.models.find((entry) => entry.id === modelId);
        target.providerId = values.providerId;
        target.model = values.model.trim();
        target.alias = values.alias.trim();
        target.kind = values.kind;
        if (values.clearParams) target.params = {};
        return;
      }
      const entry = {
        id: newId('mdl'),
        providerId: values.providerId,
        model: values.model.trim(),
        // The alias mirrors the model id; rename it later from this same form.
        alias: values.model.trim(),
        kind: 'chat',
        enabled: true,
        params: {},
      };
      const position = Math.min(Math.max(1, Number(values.position) || draft.models.length + 1), draft.models.length + 1);
      draft.models.splice(position - 1, 0, entry);
    });
    notify(`${modelId ? 'updated' : 'added'} ${values.model.trim()}`);
    onDone();
  };

  return h(Form, {
    title: modelId ? `Edit ${existing.alias}` : 'Add a model',
    subtitle: modelId ? undefined : 'the alias mirrors the model id — rename it with e',
    fields,
    onSubmit: submit,
    onCancel: onDone,
  });
}
