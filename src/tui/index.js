import { h } from './h.js';

/**
 * Mounts the terminal UI and resolves once it exits.
 *
 * Ink and React are imported here, lazily: the `start` and `status` commands
 * never touch them, so running the proxy stays as light as the rest of the code.
 *
 * @returns {Promise<{action: 'quit'|'start-server', configFile?: string}>}
 */
export async function runTui({ configFile, initialView }) {
  const [{ render }, { App }] = await Promise.all([import('ink'), import('./app.js')]);

  let outcome = { action: 'quit' };
  const finish = (next) => {
    outcome = next;
    instance.unmount();
  };

  const instance = render(h(App, { configFile, onFinish: finish, initialView }), {
    // Ink already clears its own output; leaving the scrollback intact means a
    // crash or a log line is still readable after the UI closes.
    patchConsole: true,
    exitOnCtrlC: true,
  });

  await instance.waitUntilExit();
  return outcome;
}
