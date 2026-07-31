import net from 'node:net';
import { DEFAULT_PORT } from './config.js';

/** Ports to avoid: too often already taken by other dev services. */
const COMMON = new Set([
  80, 443, 3000, 3001, 4000, 4200, 5000, 5173, 5432, 6379, 7860, 8000, 8080, 8081, 8443, 8888, 9000, 9090, 11434, 27017,
]);

function isPortFree(port, host) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => server.close(() => resolve(true)));
    server.listen({ port, host, exclusive: true });
  });
}

/**
 * Returns `preferred` when it is free, otherwise scans upwards, then tries
 * pseudo-random ports in a high, rarely used range.
 */
export async function findAvailablePort(preferred, host = '127.0.0.1') {
  const base = preferred > 0 ? preferred : DEFAULT_PORT;
  const candidates = [];
  if (!COMMON.has(base)) candidates.push(base);
  for (let i = 1; i <= 40; i += 1) {
    const port = base + i;
    if (port < 65535 && !COMMON.has(port)) candidates.push(port);
  }
  for (let i = 0; i < 40; i += 1) {
    const port = 40000 + Math.floor(Math.random() * 20000);
    if (!COMMON.has(port)) candidates.push(port);
  }
  for (const port of candidates) {
    if (await isPortFree(port, host)) return port;
  }
  return 0; // let the OS pick
}
