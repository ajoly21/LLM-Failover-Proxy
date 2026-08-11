import { useStdout } from 'ink';
import { useEffect, useState } from 'react';

/**
 * How much terminal there is, and what that means for a screen.
 *
 * The UI has to be usable on a phone over SSH — Termius on a 40-column screen is
 * a real place this runs — and on a 200-column desktop without looking empty. So
 * no screen hard-codes a width or a row count: they ask here, and the answer
 * follows the window as it is resized.
 */

/** When nothing says otherwise: the smallest terminal anyone still ships. */
const FALLBACK = { columns: 80, rows: 24 };

const liveSize = (stdout) => ({
  columns: stdout?.columns || FALLBACK.columns,
  rows: stdout?.rows || FALLBACK.rows,
});

/** The terminal's own size, kept current as the window is resized. */
function useTerminalSize() {
  const { stdout } = useStdout();
  const [size, setSize] = useState(() => liveSize(stdout));

  useEffect(() => {
    if (typeof stdout?.on !== 'function') return undefined;
    const onResize = () => setSize(liveSize(stdout));
    stdout.on('resize', onResize);
    return () => stdout.removeListener('resize', onResize);
  }, [stdout]);

  return size;
}

/**
 * `narrow` is where a table has to start dropping columns, `tight` where only
 * the essentials still fit, `short` where vertical room has to be rationed.
 * `listRows(reserved)` is how many rows a list may take once everything else on
 * the screen — frame, title, hints, detail line — has been paid for.
 */
export function useLayout() {
  const { columns, rows } = useTerminalSize();

  return {
    columns,
    rows,
    // Inside the rounded frame: one border column and one of padding each side.
    inner: Math.max(24, columns - 4),
    narrow: columns < 80,
    tight: columns < 56,
    short: rows < 24,
    listRows: (reserved) => Math.max(3, rows - reserved),
  };
}
