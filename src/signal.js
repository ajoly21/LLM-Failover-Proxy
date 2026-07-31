/** Minimal "the client hung up" signal: synchronous read plus subscription. */
export function createGoneSignal() {
  const listeners = new Set();
  let fired = false;
  return {
    get value() {
      return fired;
    },
    trigger() {
      if (fired) return;
      fired = true;
      for (const listener of listeners) {
        try {
          listener();
        } catch {
          /* ignore */
        }
      }
      listeners.clear();
    },
    /** @returns {() => void} unsubscribe */
    subscribe(listener) {
      if (fired) {
        listener();
        return () => {};
      }
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
