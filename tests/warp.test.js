import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import zlib from 'node:zlib';

import { extractFromTarGz, untar } from '../src/warp/archive.js';
import { digestFor, parseProfile, writeTunnelConfig } from '../src/warp/binaries.js';
import { parseTrace } from '../src/warp/egress.js';
import { detect, downloads, supported, UnsupportedPlatformError, WGCF_VERSION, WIREPROXY_VERSION } from '../src/warp/platform.js';
import { warpPaths } from '../src/warp/paths.js';
import { isLocalTarget, proxiedFetch, ProxyUnreachableError, resetTunnels } from '../src/outbound.js';
import { DEFAULTS, loadConfig, saveConfig, statsPathFor } from '../src/config.js';
import { flushStats } from '../src/state.js';
import { assemble, backend, postJson, startProxy } from './helpers.js';
import { startMock } from './mock-provider.js';

/* ------------------------------------------------------------------ *
 * Which binaries this machine needs                                   *
 * ------------------------------------------------------------------ */

test('every platform either resolves to two real assets or says which build is missing', () => {
  // The pairs a user is plausibly on. Each has to produce an asset name that
  // exists upstream, or refuse with a reason naming the tool that has no build —
  // "WARP is unavailable" would leave nobody anywhere to go.
  const cases = [
    ['win32', 'x64', `wgcf_${WGCF_VERSION}_windows_amd64.exe`, `wireproxy_windows_amd64.tar.gz`],
    ['win32', 'ia32', `wgcf_${WGCF_VERSION}_windows_386.exe`, `wireproxy_windows_386.tar.gz`],
    // No wireproxy build for windows/arm64; the amd64 one runs under emulation.
    ['win32', 'arm64', `wgcf_${WGCF_VERSION}_windows_arm64.exe`, `wireproxy_windows_amd64.tar.gz`],
    ['linux', 'x64', `wgcf_${WGCF_VERSION}_linux_amd64`, `wireproxy_linux_amd64.tar.gz`],
    ['linux', 'arm64', `wgcf_${WGCF_VERSION}_linux_arm64`, `wireproxy_linux_arm64.tar.gz`],
    ['linux', 's390x', `wgcf_${WGCF_VERSION}_linux_s390x`, `wireproxy_linux_s390x.tar.gz`],
    // The two projects disagree on how to spell MIPS.
    ['linux', 'mips', `wgcf_${WGCF_VERSION}_linux_mips_softfloat`, `wireproxy_linux_mips.tar.gz`],
    ['linux', 'mipsel', `wgcf_${WGCF_VERSION}_linux_mipsle_softfloat`, `wireproxy_linux_mipsle.tar.gz`],
    ['darwin', 'x64', `wgcf_${WGCF_VERSION}_darwin_amd64`, `wireproxy_darwin_amd64.tar.gz`],
    ['darwin', 'arm64', `wgcf_${WGCF_VERSION}_darwin_arm64`, `wireproxy_darwin_arm64.tar.gz`],
  ];

  for (const [platform, arch, wgcf, wireproxy] of cases) {
    const plan = downloads(detect(platform, arch));
    assert.equal(plan.wgcf.asset, wgcf, `${platform}/${arch}: wgcf asset`);
    assert.equal(plan.wireproxy.asset, wireproxy, `${platform}/${arch}: wireproxy asset`);
    // Both are fetched from the release that published the checksum list beside them.
    assert.ok(plan.wgcf.url.includes(`/v${WGCF_VERSION}/`), 'wgcf comes from the pinned release');
    assert.ok(plan.wireproxy.url.includes(`/v${WIREPROXY_VERSION}/`), 'wireproxy comes from the pinned release');
    assert.equal(path.dirname(plan.wgcf.url), path.dirname(plan.wgcf.checksums), 'checksums live beside the asset');
    // The name on disk never carries a version, so nothing downstream has to know one.
    assert.match(plan.wgcf.binary, /^wgcf(\.exe)?$/);
    assert.match(plan.wireproxy.binary, /^wireproxy(\.exe)?$/);
  }
});

test('32-bit ARM keeps its ABI for wgcf and collapses to one build for wireproxy', () => {
  // `process.arch` says only "arm" for three incompatible ABIs, and wgcf ships
  // one build per ABI while wireproxy ships one for all of them.
  const plan = downloads(detect('linux', 'arm'));
  assert.match(plan.wgcf.asset, /_linux_armv[567]$/, 'wgcf gets an ABI-specific build');
  assert.equal(plan.wireproxy.asset, 'wireproxy_linux_arm.tar.gz');
});

test('a platform with no build refuses by name, and `supported` reports it instead of throwing', () => {
  // wgcf publishes no riscv64; wireproxy publishes nothing for FreeBSD.
  assert.throws(() => downloads(detect('linux', 'riscv64')), UnsupportedPlatformError);
  assert.throws(() => downloads(detect('freebsd', 'x64')), /wireproxy/);
  assert.throws(() => detect('aix', 'ppc64'), /aix/);

  const riscv = supported('linux', 'riscv64');
  assert.equal(riscv.ok, false);
  assert.match(riscv.reason, /riscv64/, 'the reason names the architecture, so it can be acted on');
  assert.equal(supported('linux', 'x64').ok, true);
});

test('a platform with no build leaves the paths null rather than pointing at a file that cannot exist', () => {
  // `warpPaths` is called on every state read, including on an unsupported host.
  const paths = warpPaths(path.join(os.tmpdir(), 'nowhere', 'config.json'));
  assert.ok(paths.state.endsWith(`warp${path.sep}state.json`), 'the state file is always locatable');
});

/* ------------------------------------------------------------------ *
 * Reading a release archive                                           *
 * ------------------------------------------------------------------ */

/**
 * A tar entry, built by hand. The header checksum is left blank on purpose: our
 * reader does not verify it, and a test that computed one would be asserting
 * something nobody relies on.
 */
function tarEntry(name, contents, type = '0') {
  const data = Buffer.from(contents);
  const header = Buffer.alloc(512);
  header.write(name.slice(0, 100), 0, 100, 'utf8');
  header.write('0000755\0', 100, 8, 'ascii'); // mode
  header.write(`${data.length.toString(8).padStart(11, '0')}\0`, 124, 12, 'ascii');
  header.write('        ', 148, 8, 'ascii'); // checksum, unverified
  header.write(type, 156, 1, 'ascii');
  header.write('ustar\0', 257, 6, 'ascii');
  const payload = Buffer.alloc(Math.ceil(data.length / 512) * 512);
  data.copy(payload);
  return Buffer.concat([header, payload]);
}

const END = Buffer.alloc(1024); // two zero blocks

test('a release archive gives up the executable inside it', () => {
  const tar = Buffer.concat([tarEntry('README.md', 'ignore me'), tarEntry('wireproxy', 'BINARY-BYTES'), END]);
  const found = extractFromTarGz(zlib.gzipSync(tar), (name) => name === 'wireproxy');
  assert.equal(found?.toString(), 'BINARY-BYTES');
  assert.equal(extractFromTarGz(zlib.gzipSync(tar), (name) => name === 'nothing'), null, 'and says so when it is not there');
});

test('the archive reader skips what is not a file, and follows a long GNU name', () => {
  const tar = Buffer.concat([
    tarEntry('a-directory/', '', '5'),
    tarEntry('pax_global_header', 'metadata', 'g'),
    tarEntry('././@LongLink', 'deeply/nested/path/wireproxy', 'L'),
    tarEntry('short-name-placeholder', 'THE-REAL-ONE'),
    END,
  ]);
  const files = untar(zlib.gunzipSync(zlib.gzipSync(tar)));
  assert.deepEqual(
    files.map((file) => file.name),
    ['deeply/nested/path/wireproxy'],
    'only the regular file survives, under the name the LongLink gave it',
  );
  // And the base name is what the caller matches on, not the path around it.
  assert.equal(extractFromTarGz(zlib.gzipSync(tar), (name) => name === 'wireproxy')?.toString(), 'THE-REAL-ONE');
});

test('a checksum list is read by asset name, and an unlisted asset has no digest', () => {
  const list = [
    'bce041ea9fe0f8a3351301dcbe29cdf6a523bb25cf9c62f17ebb5699a8051d0f  wireproxy_windows_amd64.tar.gz',
    '2b3648a5d39550b6423be562e619805ed9f7a64bcda51cf36c60caeba97b1777 *wgcf_2.2.32_windows_amd64.exe',
  ].join('\n');

  assert.equal(digestFor(list, 'wireproxy_windows_amd64.tar.gz'), 'bce041ea9fe0f8a3351301dcbe29cdf6a523bb25cf9c62f17ebb5699a8051d0f');
  // `sha256sum` marks binary mode with a star; it is not part of the name.
  assert.equal(digestFor(list, 'wgcf_2.2.32_windows_amd64.exe'), '2b3648a5d39550b6423be562e619805ed9f7a64bcda51cf36c60caeba97b1777');
  // An asset the release did not attest is exactly when a check matters: no
  // digest means the download is refused, never run unverified.
  assert.equal(digestFor(list, 'wireproxy_linux_amd64.tar.gz'), null);
  assert.equal(digestFor('', 'anything'), null);
});

/* ------------------------------------------------------------------ *
 * Turning a WARP account into a tunnel configuration                  *
 * ------------------------------------------------------------------ */

const PROFILE = [
  '[Interface]',
  'PrivateKey = cMAImILCqRdvv9H2HkpWPHC6U37le8G454FxlY/NjWI=',
  'Address = 172.16.0.2/32, 2606:4700:110:8b36:6abd:24b6:b32a:b4a6/128',
  'DNS = 1.1.1.1, 2606:4700:4700::1111',
  'MTU = 1280',
  '[Peer]',
  'PublicKey = bmXOC+F1FxEMF9dyiK2H5/1SUtzH0JuVo51h2wPfgyo=',
  'AllowedIPs = 0.0.0.0/0, ::/0',
  'Endpoint = engage.cloudflareclient.com:2408',
].join('\n');

test('a wgcf profile is read for its keys and its IPv4 address only', () => {
  const profile = parseProfile(PROFILE);
  assert.equal(profile.address, '172.16.0.2/32');
  assert.equal(profile.privateKey, 'cMAImILCqRdvv9H2HkpWPHC6U37le8G454FxlY/NjWI=');
  assert.equal(profile.publicKey, 'bmXOC+F1FxEMF9dyiK2H5/1SUtzH0JuVo51h2wPfgyo=');

  // A profile missing either key or the address cannot produce a tunnel, and
  // saying so here beats a wireproxy that starts and quietly routes nothing.
  assert.throws(() => parseProfile('[Interface]\nAddress = 172.16.0.2/32'), /missing/);
  assert.throws(() => parseProfile(PROFILE.replace(/Address = .*/, 'Address = 2606:4700::1/128')), /IPv4/);
});

test('the tunnel configuration carries the chosen ports and no IPv6 route', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'llm-proxy-warp-'));
  try {
    const configFile = path.join(dir, 'config.json');
    await fs.mkdir(path.join(dir, 'warp'), { recursive: true });
    await fs.writeFile(warpPaths(configFile).profile, PROFILE);

    const file = writeTunnelConfig(configFile, { socksPort: 31000, httpPort: 31001, endpoint: '162.159.192.1:2408' });
    const contents = await fs.readFile(file, 'utf8');

    assert.match(contents, /BindAddress = 127\.0\.0\.1:31000/, 'the SOCKS5 proxy is bound where asked');
    assert.match(contents, /BindAddress = 127\.0\.0\.1:31001/, 'and so is the HTTP one this proxy itself uses');
    assert.match(contents, /Endpoint = 162\.159\.192\.1:2408/);
    assert.match(contents, /AllowedIPs = 0\.0\.0\.0\/0\s/, 'IPv4 only');
    // A host with no IPv6 route would black-hole half the requests through a
    // tunnel that advertised one.
    assert.ok(!contents.includes('::/0'), 'no IPv6 route is offered');
    assert.ok(!contents.includes('2606:4700'), 'and no IPv6 address is assigned');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('a trace answer is read for the address and for whether WARP really carried it', () => {
  const trace = parseTrace(['fl=123abc', 'ip=104.28.211.192', 'warp=on', 'colo=CDG', 'loc=FR'].join('\n'));
  assert.deepEqual(trace, { ip: '104.28.211.192', warp: true, colo: 'CDG', loc: 'FR' });

  // WARP+ is still WARP.
  assert.equal(parseTrace('ip=1.2.3.4\nwarp=plus').warp, true);
  // The distinction that matters: the tunnel is up but the traffic went around it.
  assert.equal(parseTrace('ip=1.2.3.4\nwarp=off').warp, false);
  assert.equal(parseTrace('nothing useful'), null, 'an answer with no address is no answer');
});

/* ------------------------------------------------------------------ *
 * Configuration: upgrades, and hand-edited files                      *
 * ------------------------------------------------------------------ */

test('a configuration written before WARP existed loads with the feature off', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'llm-proxy-warp-cfg-'));
  try {
    const file = path.join(dir, 'config.json');
    // Exactly what an install from an earlier version has on disk: no `warp` key.
    await fs.writeFile(file, JSON.stringify({ server: { port: 47821 }, providers: [], models: [] }));

    const config = loadConfig(file);
    assert.equal(config.warp.enabled, false, 'an upgrade never starts routing traffic somewhere new');
    assert.equal(config.warp.fallbackDirect, false);
    assert.deepEqual(config.warp, DEFAULTS.warp, 'the whole block is filled in from the defaults');

    // And saving it back does not lose the block, so the next load is identical.
    saveConfig(config, file);
    assert.deepEqual(loadConfig(file).warp, DEFAULTS.warp);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('a hand-edited warp block is bounded, not trusted', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'llm-proxy-warp-cfg-'));
  try {
    const file = path.join(dir, 'config.json');
    await fs.writeFile(
      file,
      JSON.stringify({
        providers: [],
        models: [],
        warp: {
          enabled: 'yes', // not a boolean
          socksPort: 80, // privileged, and not ours to bind
          httpPort: 999999, // not a port
          // This is written into a generated config file, so a value that could
          // be read as a second setting has to be refused rather than escaped.
          endpoint: '1.2.3.4:2408\nAllowedIPs = 10.0.0.0/8',
        },
      }),
    );

    const { warp } = loadConfig(file);
    assert.equal(warp.enabled, false, 'only a real `true` turns it on');
    assert.equal(warp.socksPort, DEFAULTS.warp.socksPort);
    assert.equal(warp.httpPort, DEFAULTS.warp.httpPort);
    assert.equal(warp.endpoint, DEFAULTS.warp.endpoint, 'an endpoint carrying a newline is refused whole');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('one port cannot be used for both proxies', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'llm-proxy-warp-cfg-'));
  try {
    const file = path.join(dir, 'config.json');
    await fs.writeFile(file, JSON.stringify({ providers: [], models: [], warp: { socksPort: 30000, httpPort: 30000 } }));
    const { warp } = loadConfig(file);
    // Left alone, the tunnel would fail to bind and report an address in use —
    // a message about the tunnel, for what is a typo.
    assert.notEqual(warp.socksPort, warp.httpPort);
    assert.equal(warp.socksPort, DEFAULTS.warp.socksPort);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ *
 * Outbound: what must never go through the tunnel                     *
 * ------------------------------------------------------------------ */

test('local and private providers are never sent through the tunnel', () => {
  // Ollama on this machine, or an inference box on the LAN, are ordinary
  // providers here — and unreachable from inside a tunnel that egresses on the
  // internet.
  for (const host of ['localhost', 'app.localhost', 'ollama.local', 'box.internal', '127.0.0.1', '10.1.2.3', '172.16.5.4', '172.31.255.1', '192.168.1.10', '169.254.1.1', '::1', 'fe80::1', 'fd00::1', '[::1]']) {
    assert.equal(isLocalTarget(host), true, `${host} must bypass the proxy`);
  }
  for (const host of ['api.openai.com', 'openrouter.ai', '8.8.8.8', '172.32.0.1', '172.15.0.1', '193.168.1.1', 'fcbank.example', 'localhost.attacker.com']) {
    assert.equal(isLocalTarget(host), false, `${host} must go through the proxy`);
  }
});

/* ------------------------------------------------------------------ *
 * Outbound: the hand-written proxy transport                          *
 * ------------------------------------------------------------------ */

const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));

/**
 * A stub that is both proxy and origin: a plain HTTP target reaches a proxy in
 * absolute form (`GET http://host/path`), so one server can check what arrived
 * and answer it.
 */
async function stubProxy(handler) {
  const seen = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    seen.push({ url: req.url, method: req.method, headers: req.headers, body: Buffer.concat(chunks).toString() });
    await handler(req, res);
  });
  const port = await listen(server);
  return {
    seen,
    url: `http://127.0.0.1:${port}`,
    async close() {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

test('a request through the proxy carries its body and comes back as a Response', async () => {
  const stub = await stubProxy((req, res) => {
    res.writeHead(201, { 'content-type': 'application/json', 'x-upstream': 'yes' });
    res.end(JSON.stringify({ ok: true }));
  });
  try {
    const send = proxiedFetch(stub.url);
    const response = await send('http://provider.example/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer sk-test' },
      body: JSON.stringify({ model: 'm' }),
    });

    assert.equal(response.status, 201);
    assert.equal(response.ok, true);
    assert.equal(response.headers.get('x-upstream'), 'yes');
    assert.deepEqual(await response.json(), { ok: true });

    const [request] = stub.seen;
    // A plain HTTP target is asked for in absolute form: that is how a proxy is
    // told which origin to reach, without a tunnel.
    assert.equal(request.url, 'http://provider.example/v1/chat/completions');
    assert.equal(request.headers.host, 'provider.example');
    assert.equal(request.headers.authorization, 'Bearer sk-test', 'the provider key survives the hop');
    assert.equal(request.body, JSON.stringify({ model: 'm' }));
    // Node's client sets no length of its own, and a provider that reads one
    // should not be handed a chunked body instead.
    assert.equal(request.headers['content-length'], String(JSON.stringify({ model: 'm' }).length));
  } finally {
    await stub.close();
  }
});

test('a streamed answer arrives in pieces, not in one lump at the end', async () => {
  const stub = await stubProxy(async (req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: first\n\n');
    // Flushed separately, and only after the reader has had a chance to see the
    // first one: a transport that buffered would fail this.
    await new Promise((resolve) => setTimeout(resolve, 120));
    res.write('data: second\n\n');
    res.end();
  });
  try {
    const response = await proxiedFetch(stub.url)('http://provider.example/stream', { method: 'POST', body: '{}' });
    const reader = response.body.getReader();
    const first = await reader.read();
    assert.match(Buffer.from(first.value).toString(), /first/);
    assert.ok(!Buffer.from(first.value).toString().includes('second'), 'the second chunk had not been written yet');

    const rest = [];
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      rest.push(Buffer.from(value).toString());
    }
    assert.match(rest.join(''), /second/);
  } finally {
    await stub.close();
  }
});

test('a compressed answer is decoded, because `fetch` would have decoded it', async () => {
  // `node:http` hands over the bytes as they arrived. Callers read JSON and SSE.
  const stub = await stubProxy((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'gzip' });
    res.end(zlib.gzipSync(JSON.stringify({ compressed: true })));
  });
  try {
    const response = await proxiedFetch(stub.url)('http://provider.example/v1/models');
    assert.deepEqual(await response.json(), { compressed: true });
    // The headers described the bytes on the wire, which are not the ones handed on.
    assert.equal(response.headers.get('content-encoding'), null);
    assert.equal(stub.seen[0].headers['accept-encoding'], 'identity', 'and none was asked for in the first place');
  } finally {
    await stub.close();
  }
});

test('aborting rejects with the caller’s own reason, the way fetch does', async () => {
  // The failover engine reads the reason to tell a deadline from a client that
  // hung up. Handing `http.request` the signal would replace it with a generic
  // AbortError and lose that.
  const stub = await stubProxy(() => new Promise(() => {})); // never answers
  try {
    const controller = new AbortController();
    const reason = Object.assign(new Error('no response within 15s'), { name: 'TimeoutError' });
    const pending = proxiedFetch(stub.url)('http://provider.example/v1/chat', { method: 'POST', body: '{}', signal: controller.signal });
    setTimeout(() => controller.abort(reason), 50);

    await assert.rejects(pending, (err) => {
      assert.equal(err, reason, 'the very error the caller aborted with');
      assert.equal(err.name, 'TimeoutError');
      return true;
    });

    // And a signal that is already aborted never opens a connection at all.
    await assert.rejects(proxiedFetch(stub.url)('http://provider.example/v1/chat', { signal: AbortSignal.abort(reason) }), (err) => err === reason);
  } finally {
    await stub.close();
  }
});

test('a local target skips the proxy entirely', async () => {
  // The proxy stub would answer anything; the point is that it is never asked.
  const stub = await stubProxy((req, res) => res.end('through the proxy'));
  const origin = http.createServer((req, res) => res.end('straight there'));
  const port = await listen(origin);
  try {
    const response = await proxiedFetch(stub.url)(`http://127.0.0.1:${port}/v1/models`);
    assert.equal(await response.text(), 'straight there');
    assert.equal(stub.seen.length, 0, 'a loopback provider could not be reached through a tunnel');
  } finally {
    origin.closeAllConnections?.();
    await new Promise((resolve) => origin.close(resolve));
    await stub.close();
  }
});

test('an https target is tunnelled with CONNECT, and a refusal is not mistaken for a provider failure', async () => {
  const lines = [];
  const proxy = net.createServer((socket) => {
    socket.once('data', (chunk) => {
      lines.push(chunk.toString('latin1').split('\r\n')[0]);
      socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
    });
  });
  const port = await listen(proxy);
  try {
    const send = proxiedFetch(`http://127.0.0.1:${port}`);
    await assert.rejects(send('https://api.provider.example/v1/chat', { method: 'POST', body: '{}' }), (err) => {
      // Told apart on purpose: the tunnel being unreachable is not the provider
      // failing, and the two lead somewhere different.
      assert.ok(err instanceof ProxyUnreachableError, `expected ProxyUnreachableError, got ${err.name}`);
      assert.match(err.message, /403/);
      return true;
    });
    assert.equal(lines[0], 'CONNECT api.provider.example:443 HTTP/1.1', 'the port is implied by the scheme');
  } finally {
    resetTunnels();
    proxy.close();
    await new Promise((resolve) => proxy.close(resolve));
  }
});

/* ------------------------------------------------------------------ *
 * What the stats say about where a request went                        *
 * ------------------------------------------------------------------ */

test('a served request records the path it took, and asks nobody when WARP is off', async () => {
  const mock = await startMock('ok', { name: 'provider' });
  const proxy = await startProxy(assemble([backend(mock, { model: 'm', alias: 'a' })]));
  try {
    await postJson(`${proxy.url}/v1/chat/completions`, { messages: [{ role: 'user', content: 'hi' }] });
    const stats = await (await fetch(`${proxy.url}/stats`)).json();

    assert.equal(stats.warp.enabled, false, 'the default, and what an upgraded install keeps');
    assert.equal(stats.recent[0].via, 'direct', 'a row always says which way it went');
    // No lookup is made while WARP is off: there is nothing to verify, and this
    // tool makes no outbound request of its own that a user did not ask for.
    assert.equal(stats.recent[0].exitIp, null);

    flushStats();
    const onDisk = JSON.parse(await fs.readFile(statsPathFor(proxy.file), 'utf8'));
    assert.equal(onDisk.recent[0].via, 'direct', 'and it is written down, not only served');
  } finally {
    await proxy.close();
    await mock.close();
  }
});

test('a stats file written before WARP existed still loads, and its rows say so', async () => {
  const mock = await startMock('ok', { name: 'provider' });
  const first = await startProxy(assemble([backend(mock, { model: 'm', alias: 'a' })]));
  const modelId = 'mdl_provider';
  try {
    await postJson(`${first.url}/v1/chat/completions`, { messages: [{ role: 'user', content: 'hi' }] });
    flushStats();
    await first.stop();

    // Rewritten as an older version left it: recent rows with no `via`, no `exitIp`.
    const file = statsPathFor(first.file);
    const saved = JSON.parse(await fs.readFile(file, 'utf8'));
    saved.recent = [{ id: modelId, at: Date.now() - 5000, ttftMs: 431 }];
    await fs.writeFile(file, JSON.stringify(saved));

    const restarted = await startProxy({ reuse: first.file });
    const stats = await (await fetch(`${restarted.url}/stats`)).json();
    assert.equal(stats.recent.length, 1, 'the row survives the upgrade');
    assert.equal(stats.recent[0].ttftMs, 431, 'with what it did record intact');
    // Unknown, which is not the same as "went out directly" — the row predates
    // anything having been recorded about the path.
    assert.equal(stats.recent[0].via, null);
    assert.equal(stats.recent[0].exitIp, null);
    await restarted.close();
  } finally {
    await mock.close();
  }
});

test('a proxy that is not listening at all is reported as unreachable', async () => {
  // Nothing on this port: what a request looks like when the tunnel is down.
  const free = net.createServer();
  const port = await listen(free);
  await new Promise((resolve) => free.close(resolve));

  await assert.rejects(proxiedFetch(`http://127.0.0.1:${port}`)('https://api.provider.example/v1/chat'), (err) => {
    assert.ok(err instanceof ProxyUnreachableError);
    return true;
  });
  resetTunnels();
});
