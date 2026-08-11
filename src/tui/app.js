import { useCallback, useEffect, useRef, useState } from 'react';
import { Box, Text } from 'ink';
import { h } from './h.js';
import { COLOR } from './theme.js';
import { Notice } from './widgets.js';
import { isFirstRun, loadConfig, saveConfig } from '../config.js';
import { checkForUpdate } from '../update.js';
import { HomeScreen } from './screens/home.js';
import { ProvidersScreen } from './screens/providers.js';
import { ModelsScreen } from './screens/models.js';
import { SettingsScreen } from './screens/settings.js';
import { StatusScreen } from './screens/status.js';
import { SetupScreen } from './screens/setup.js';
import { ModelForm, ProviderForm } from './screens/forms.js';

const MESSAGE_TTL_MS = 4000;

/**
 * Root component: owns the config, the current screen, and the transient
 * message line. Every mutation is written to disk immediately, so a running
 * server picks it up through its config watcher.
 */
export function App({ configFile, onFinish, initialView, checkUpdate = checkForUpdate }) {
  const [config, setConfig] = useState(() => loadConfig(configFile));
  // Nothing configured: open on the wizard rather than on an empty menu.
  const [view, setView] = useState(() => initialView ?? (isFirstRun(config) ? { name: 'setup' } : { name: 'home' }));
  const [message, setMessage] = useState(null);
  const [release, setRelease] = useState(null);
  const configRef = useRef(config);
  const messageTimer = useRef(null);

  useEffect(
    () => () => {
      if (messageTimer.current) clearTimeout(messageTimer.current);
    },
    [],
  );

  // Asked once per mount, and never waited on: the menu is already drawn by the
  // time the registry answers, and if it never does, nothing is said.
  useEffect(() => {
    let cancelled = false;
    checkUpdate({ configFile, config: configRef.current })
      .then((result) => {
        if (!cancelled && result?.available) setRelease(result);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [configFile, checkUpdate]);

  const notify = useCallback((text, tone = COLOR.ok) => {
    setMessage({ text: `  ${text}`, tone });
    if (messageTimer.current) clearTimeout(messageTimer.current);
    messageTimer.current = setTimeout(() => setMessage(null), MESSAGE_TTL_MS);
    messageTimer.current.unref?.();
  }, []);

  /** Applies `mutator` to a copy of the config, persists it, then re-renders. */
  const update = useCallback((mutator) => {
    const next = JSON.parse(JSON.stringify(configRef.current));
    mutator(next);
    try {
      saveConfig(next, next.__file);
    } catch (err) {
      notify(`could not save: ${err.message}`, COLOR.fail);
      return;
    }
    configRef.current = next;
    setConfig(next);
  }, [notify]);

  const navigate = useCallback((next) => setView(next), []);
  const goHome = useCallback(() => setView({ name: 'home' }), []);
  const shared = { config, update, notify, navigate };

  switch (view.name) {
    case 'providers':
      return h(ProvidersScreen, { ...shared, onBack: goHome });
    case 'models':
      // spacingMs / fetchStats are overridable so tests can drive the real
      // screens without waiting on 5s staggering or a live server.
      return h(ModelsScreen, { ...shared, onBack: goHome, spacingMs: view.spacingMs });
    case 'settings':
      return h(SettingsScreen, { ...shared, onBack: goHome });
    case 'status':
      return h(StatusScreen, { ...shared, onBack: goHome, fetchStats: view.fetchStats, pollMs: view.pollMs });
    case 'setup':
      return h(SetupScreen, { ...shared, onDone: goHome, catalog: view.catalog });
    case 'provider-form':
      return h(ProviderForm, { ...shared, providerId: view.providerId, onDone: () => setView({ name: 'providers' }) });
    case 'model-form':
      return h(ModelForm, { ...shared, modelId: view.modelId, onDone: () => setView({ name: 'models' }) });
    case 'home':
      return h(HomeScreen, {
        config,
        message,
        release,
        onSelect: (choice) => {
          if (choice === 'quit') onFinish({ action: 'quit' });
          else if (choice === 'start') onFinish({ action: 'start-server', configFile: config.__file });
          // Installing a package while running from it is the shell's job, not
          // this screen's: the UI closes first, then npm has the terminal.
          else if (choice === 'update') onFinish({ action: 'update', release });
          else setView({ name: choice });
        },
      });
    default:
      return h(Notice, { title: 'Unknown screen', message: view.name, onBack: goHome });
  }
}

/** Rendered instead of the app when the config file cannot be parsed. */
export function LoadError({ file, error }) {
  return h(
    Box,
    { flexDirection: 'column', borderStyle: 'round', borderColor: COLOR.fail, paddingX: 1 },
    h(Text, { color: COLOR.fail, bold: true }, 'Cannot open the configuration'),
    h(Text, { dimColor: true }, file),
    h(Text, null, error),
  );
}
