/** Incremental SSE parser, tolerant to arbitrary chunk boundaries. */
export function createSseParser() {
  const decoder = new TextDecoder('utf-8');
  let buffer = '';

  function drain(events) {
    let index;
    // An event ends on a blank line (\n\n or \r\n\r\n).
    while ((index = buffer.search(/\r?\n\r?\n/)) !== -1) {
      const separator = buffer.slice(index).match(/^\r?\n\r?\n/)[0];
      const block = buffer.slice(0, index);
      buffer = buffer.slice(index + separator.length);
      const event = parseBlock(block);
      if (event) events.push(event);
    }
  }

  return {
    push(chunk) {
      const events = [];
      buffer += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
      drain(events);
      return events;
    },
    /** Trailing block that was not terminated by a blank line. */
    flush() {
      const events = [];
      buffer += decoder.decode();
      drain(events);
      const rest = buffer.trim();
      buffer = '';
      if (rest) {
        const event = parseBlock(rest);
        if (event) events.push(event);
      }
      return events;
    },
  };
}

function parseBlock(block) {
  let event = null;
  const data = [];
  for (const line of block.split(/\r?\n/)) {
    if (!line || line.startsWith(':')) continue; // comment / keep-alive
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') event = value;
    else if (field === 'data') data.push(value);
  }
  if (event === null && data.length === 0) return null;
  return { event, data: data.join('\n') };
}

export const SSE_DONE = 'data: [DONE]\n\n';
