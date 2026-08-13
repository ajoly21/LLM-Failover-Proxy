import http from "node:http";
import https from "node:https";
import net from "node:net";
import { Readable } from "node:stream";
import tls from "node:tls";
import zlib from "node:zlib";

/**
 * Outbound HTTP through a local proxy, with the same surface as `fetch`.
 *
 * Node's `fetch` cannot be pointed at a proxy without reaching for undici's
 * `ProxyAgent`, which this package will not depend on: undici is already inside
 * Node — installing a second copy to reuse one class, or bundling its WASM HTTP
 * parser, are both worse than the ~120 lines below. An HTTP `CONNECT` tunnel is
 * a text handshake followed by ordinary TLS, and `node:https` speaks the rest.
 *
 * Only what this proxy actually sends is supported: a string or buffer body, an
 * `AbortSignal`, and a streamed response. Anything else throws rather than
 * pretending, so a future caller finds out at once.
 */

/** The local tunnel is not answering. Kept apart from a provider failure. */
export class ProxyUnreachableError extends Error {
  constructor(proxy, cause) {
    super(`Cloudflare WARP proxy is not answering on ${proxy.host}: ${cause?.message || cause}`);
    this.name = "ProxyUnreachableError";
    this.cause = cause;
  }
}

const CONNECT_TIMEOUT_MS = 10000;
const MAX_CONNECT_HEAD = 8192;

/** Headers that describe one hop and must not be republished on the next. */
const HOP_BY_HOP = new Set(["connection", "keep-alive", "proxy-connection", "proxy-authenticate", "te", "trailer", "transfer-encoding", "upgrade"]);

const abortError = () => Object.assign(new Error("The operation was aborted"), { name: "AbortError" });

/* ------------------------------------------------------------------ *
 * The tunnel                                                          *
 * ------------------------------------------------------------------ */

/**
 * An `https.Agent` whose sockets are TLS connections opened *through* an HTTP
 * proxy: `CONNECT host:443`, then TLS inside the tunnel it returns.
 *
 * Keep-alive matters here. Without it every attempt would pay for a new
 * handshake with the provider, and a chain that hedges opens several at once.
 */
class ConnectTunnelAgent extends https.Agent {
  constructor(proxy, options = {}) {
    super({ keepAlive: true, keepAliveMsecs: 30000, maxSockets: 64, ...options });
    this.proxy = proxy;
  }

  createConnection(options, callback) {
    const host = options.host;
    const port = Number(options.port) || 443;
    const socket = net.connect({ host: this.proxy.hostname, port: Number(this.proxy.port) || 80 });

    let settled = false;
    const fail = (cause) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      callback(new ProxyUnreachableError(this.proxy, cause));
    };

    socket.once("error", fail);
    socket.setTimeout(CONNECT_TIMEOUT_MS, () => fail(new Error("timed out opening the tunnel")));
    socket.once("connect", () => {
      socket.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n\r\n`);
    });

    let head = Buffer.alloc(0);
    const onData = (chunk) => {
      head = Buffer.concat([head, chunk]);
      const end = head.indexOf("\r\n\r\n");
      if (end < 0) {
        if (head.length > MAX_CONNECT_HEAD) fail(new Error("oversized CONNECT response"));
        return;
      }

      const status = Number(/^HTTP\/1\.[01] (\d{3})/.exec(head.toString("latin1", 0, end))?.[1]);
      if (status !== 200) {
        fail(new Error(`CONNECT ${host}:${port} was refused (HTTP ${status || "?"})`));
        return;
      }

      socket.removeListener("data", onData);
      socket.removeListener("error", fail);
      socket.setTimeout(0);
      settled = true;
      // Bytes past the blank line are already the peer's TLS hello: put them
      // back so the TLS layer reads them first.
      const rest = head.subarray(end + 4);
      if (rest.length) socket.unshift(rest);

      callback(
        null,
        tls.connect({
          socket,
          // An IP literal is not a valid SNI name, and sending one breaks the
          // handshake with servers that check.
          servername: net.isIP(host) ? undefined : host,
          // This client is HTTP/1.1; letting a server pick h2 would produce a
          // connection neither side could then use.
          ALPNProtocols: ["http/1.1"],
          rejectUnauthorized: options.rejectUnauthorized !== false,
        }),
      );
    };
    socket.on("data", onData);
  }
}

/**
 * Targets that must never be sent through the tunnel.
 *
 * A local model server is a first-class provider here — Ollama on `127.0.0.1`, an
 * inference box on the LAN — and WARP cannot reach either: the tunnel egresses on
 * the public internet, so `127.0.0.1` inside it means Cloudflare's loopback, not
 * this machine's, and `192.168.x.x` means nothing at all. Every HTTP client that
 * talks to a proxy carves out the same exception; `NO_PROXY` is its usual name.
 */
export function isLocalTarget(hostname) {
  // A URL keeps IPv6 literals in brackets, and those are not part of the address.
  const host = String(hostname || "")
    .toLowerCase()
    .replace(/^\[|]$/g, "");

  if (net.isIPv6(host)) {
    // Loopback, link-local (fe80::/10) and unique-local (fc00::/7).
    return host === "::1" || /^fe[89ab]/.test(host) || /^f[cd]/.test(host);
  }
  if (net.isIPv4(host)) {
    const [a, b] = host.split(".").map(Number);
    if (a === 127 || a === 10) return true; // loopback, private
    if (a === 169 && b === 254) return true; // link-local
    if (a === 172 && b >= 16 && b <= 31) return true; // private
    return a === 192 && b === 168; // private
  }
  // Names, checked last so that a host merely *starting* like an address — `fcbank.example`
  // — is not mistaken for one.
  return host === "localhost" || /\.(localhost|local|internal)$/.test(host);
}

/** One agent per proxy: the socket pool is the point, so it has to be reused. */
const agents = new Map();

function agentFor(proxy) {
  let agent = agents.get(proxy.origin);
  if (!agent) {
    agent = new ConnectTunnelAgent(proxy);
    agents.set(proxy.origin, agent);
  }
  return agent;
}

/** Drops the pooled tunnels, so nothing survives a rotation. */
export function resetTunnels() {
  for (const agent of agents.values()) agent.destroy();
  agents.clear();
}

/* ------------------------------------------------------------------ *
 * fetch, over that tunnel                                             *
 * ------------------------------------------------------------------ */

function headerObject(headers) {
  const out = {};
  if (!headers) return out;
  const entries = typeof headers.entries === "function" ? headers.entries() : Object.entries(headers);
  for (const [key, value] of entries) out[String(key).toLowerCase()] = String(value);
  return out;
}

function bodyBuffer(body) {
  if (body == null) return null;
  if (typeof body === "string") return Buffer.from(body, "utf8");
  if (Buffer.isBuffer(body)) return body;
  if (body instanceof Uint8Array) return Buffer.from(body);
  throw new TypeError(`outbound: unsupported body type ${body?.constructor?.name || typeof body}`);
}

/**
 * `node:http` hands back the bytes as they arrived, where `fetch` would already
 * have decoded them. Callers read JSON and SSE, so it is decoded here.
 */
function decoderFor(encoding) {
  switch (encoding) {
    case "gzip":
    case "x-gzip":
      return zlib.createGunzip();
    case "deflate":
      return zlib.createInflate();
    case "br":
      return zlib.createBrotliDecompress();
    default:
      return null;
  }
}

function toResponse(incoming) {
  const headers = new Headers();
  for (const [key, value] of Object.entries(incoming.headers)) {
    if (HOP_BY_HOP.has(key) || value === undefined) continue;
    for (const item of Array.isArray(value) ? value : [value]) headers.append(key, String(item));
  }

  let stream = incoming;
  const decoder = decoderFor(String(incoming.headers["content-encoding"] || "").toLowerCase());
  if (decoder) {
    // `pipe` does not carry errors forward, and a truncated body must not look
    // like a clean end of stream.
    incoming.on("error", (err) => decoder.destroy(err));
    stream = incoming.pipe(decoder);
    // They describe the bytes on the wire, which are no longer the ones handed on.
    headers.delete("content-encoding");
    headers.delete("content-length");
  }

  const bodiless = incoming.statusCode === 204 || incoming.statusCode === 205 || incoming.statusCode === 304;
  return new Response(bodiless ? null : Readable.toWeb(stream), {
    status: incoming.statusCode,
    statusText: incoming.statusMessage,
    headers,
  });
}

/**
 * A `fetch` that goes through `proxyUrl`.
 *
 * @param {string} proxyUrl e.g. `http://127.0.0.1:25345`
 */
export function proxiedFetch(proxyUrl) {
  const proxy = new URL(proxyUrl);

  return function fetchThroughProxy(input, init = {}) {
    const target = new URL(typeof input === "string" ? input : input.url);
    // Nothing local goes through the tunnel, whatever the configuration says:
    // it could not arrive, and a local provider is not what WARP was turned on
    // to hide anyway.
    if (isLocalTarget(target.hostname)) return fetch(input, init);
    const secure = target.protocol === "https:";
    const signal = init.signal ?? null;
    if (signal?.aborted) return Promise.reject(signal.reason ?? abortError());

    const headers = headerObject(init.headers);
    // Nothing here needs a compressed body, and asking for none keeps the common
    // case free of a decompression step. The decoder above covers a provider
    // that compresses anyway.
    headers["accept-encoding"] ??= "identity";
    const body = bodyBuffer(init.body);
    if (body) headers["content-length"] ??= String(body.length);

    const options = secure
      ? {
          method: (init.method || "GET").toUpperCase(),
          host: target.hostname,
          port: Number(target.port) || 443,
          path: `${target.pathname}${target.search}`,
          headers,
          agent: agentFor(proxy),
        }
      : {
          // Plain HTTP needs no tunnel: the proxy is addressed directly and the
          // whole URL goes on the request line.
          method: (init.method || "GET").toUpperCase(),
          host: proxy.hostname,
          port: Number(proxy.port) || 80,
          path: target.href,
          headers: { ...headers, host: target.host },
        };

    return new Promise((resolve, reject) => {
      const request = (secure ? https : http).request(options);
      let done = false;

      /**
       * The signal is honoured by hand rather than passed to `http.request`,
       * which would reject with a generic `AbortError` and lose the reason.
       * `fetch` rejects with the reason itself, and the failover engine reads it
       * to tell a deadline from a client that hung up.
       */
      const onAbort = () => request.destroy(signal.reason ?? abortError());
      signal?.addEventListener("abort", onAbort, { once: true });
      // Kept until the body has been consumed, not just until the headers
      // arrive: aborting mid-stream has to cut the stream.
      const release = () => signal?.removeEventListener("abort", onAbort);

      request.once("response", (incoming) => {
        done = true;
        incoming.once("end", release);
        incoming.once("close", release);
        incoming.once("error", release);
        resolve(toResponse(incoming));
      });
      request.once("error", (err) => {
        release();
        if (!done) reject(err);
      });

      if (body) request.end(body);
      else request.end();
    });
  };
}
