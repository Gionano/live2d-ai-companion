import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { validateBaseUrl } from '../providers/baseUrl.js';
import { providerFetch } from '../providers/resilience.js';
import { ProviderRegistry } from '../providers/registry.js';
import { ADAPTER_CASES, SECRET, collect, requestFor } from './providerFixtures.js';

for (const value of [
  'file:///tmp/provider', 'ftp://example.test', 'javascript:alert(1)', 'https:example.test',
  ['https://user:password', 'example.test'].join('@'), 'https://example.test/#fragment', 'https://example.test/#',
  'https://example.test/?key=secret', 'https://example.test/?', ' https://example.test',
  'https://example.test\\@127.0.0.1',
]) {
  test(`baseUrl rejects invalid URL form ${value.split(':')[0]}`, () => {
    assert.throws(() => validateBaseUrl(value), /without credentials, query or fragment/);
  });
}

for (const host of [
  '169.254.169.254', '169.254.1.1', '0xa9fea9fe', '2852039166',
  '[fe80::1]', '[febf::1]', '[::ffff:169.254.169.254]', '[::169.254.169.254]',
  '100.100.100.200', '168.63.129.16', '192.0.0.192', '[fd00:ec2::254]',
  'metadata.google.internal', 'metadata.google.internal.', 'metadata.goog', 'instance-data',
]) {
  test(`baseUrl rejects metadata/link-local host ${host}`, () => {
    for (const scheme of ['http', 'https']) assert.throws(() => validateBaseUrl(`${scheme}://${host}`), /link-local or cloud-metadata/);
  });
}

test('baseUrl normalizes origins and flags only permitted unencrypted local addresses', () => {
  assert.deepEqual(validateBaseUrl('HTTPS://EXAMPLE.TEST:443/v1'), {
    url: 'https://example.test/v1', origin: 'https://example.test', insecureTransport: false,
  });
  for (const host of ['localhost', 'localhost.', '127.1', '0x7f000001', '10.20.30.40', '172.16.0.1',
    '172.31.255.254', '192.168.1.1', '[::1]', '[::ffff:127.0.0.1]', '[fd12:3456::1]', '[fc00::1]']) {
    assert.equal(validateBaseUrl(`http://${host}`).insecureTransport, true);
    assert.equal(validateBaseUrl(`ws://${host}`, { websocket: true }).insecureTransport, true);
  }
  for (const host of ['example.test', 'localhost.example.test', '8.8.8.8', '172.15.0.1', '172.32.0.1',
    '192.169.0.1', '100.64.0.1', '0.0.0.0', '[::]', '[2001:db8::1]']) {
    assert.throws(() => validateBaseUrl(`http://${host}`), /requires HTTPS/);
    assert.throws(() => validateBaseUrl(`ws://${host}`, { websocket: true }), /requires HTTPS/);
  }
  assert.throws(() => validateBaseUrl('wss://example.test'), /HTTP\(S\)/);
  assert.throws(() => validateBaseUrl('https://example.test', { websocket: true }), /HTTP\(S\)/);
});

test('slot status exposes safe TLS warnings and rejects unencrypted public endpoints', () => {
  const config = { profiles: { fixture: { adapter: 'openaiCompatible', baseUrl: 'http://192.168.1.1:1234/v1' } },
    slots: { llm: { profile: 'fixture', model: 'fixture-model' } } };
  const registry = new ProviderRegistry({ config });
  let status = registry.getSlotStatus('llm');
  assert.equal(status.available, true);
  assert.equal(status.insecureTransport, true);
  assert.match(status.warnings[0], /unencrypted/);
  assert.equal(JSON.stringify(status).includes('192.168.1.1'), false);
  config.profiles.fixture.baseUrl = 'https://example.test';
  registry.reload(config);
  status = registry.getSlotStatus('llm');
  assert.equal(status.available, true);
  assert.equal(status.insecureTransport, false);
  assert.deepEqual(status.warnings, []);
  config.profiles.fixture.baseUrl = 'http://example.test';
  registry.reload(config);
  assert.equal(registry.getLlm(), null);
  assert.match(registry.getSlotStatus('llm').reason, /requires HTTPS/);
});

async function listen(t, handler) {
  const server = http.createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  return { server, url: `http://127.0.0.1:${server.address().port}` };
}

for (const spec of [...ADAPTER_CASES, { ...ADAPTER_CASES[0], id: 'openaiCompatible STT', stt: true }]) {
  for (const sameOrigin of [false, true]) {
    test(`${spec.id}: refuses ${sameOrigin ? 'same' : 'cross'}-origin redirects including custom key headers`, async t => {
      let targetRequests = 0;
      const sourceRequests = [];
      const target = await listen(t, (_req, res) => { targetRequests++; res.end(); });
      let source;
      const handle = (req, res) => {
        if (req.url === '/target') { targetRequests++; res.end(); return; }
        sourceRequests.push(req.headers);
        const location = sameOrigin ? `${source.url}/target` : `${target.url}/target`;
        res.writeHead(307, { Location: location.replace(/^http/, spec.audio ? 'ws' : 'http') });
        res.end();
      };
      source = await listen(t, handle);
      if (spec.audio) source.server.on('upgrade', (req, socket) => {
        sourceRequests.push(req.headers);
        const location = (sameOrigin ? source.url : target.url).replace(/^http/, 'ws');
        socket.end(`HTTP/1.1 302 Found\r\nLocation: ${location}/target\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`);
      });
      const adapter = new spec.Adapter({ profile: {
        baseUrl: source.url.replace(/^http/, spec.audio ? 'ws' : 'http'), apiKeyEnv: 'FIXTURE_KEY',
        extraHeaders: { 'X-Custom-Provider-Key': SECRET }, flags: { supportsStt: true },
      }, model: 'fixture-model', secretResolver: { resolve: () => SECRET }, resilience: { maxRetries: 0 },
      timeouts: { firstByteMs: 2000, totalMs: 3000 } });
      const run = spec.stt
        ? adapter.transcribe({ audio: Buffer.alloc(1), mime: 'audio/wav', filename: 'fixture.wav' })
        : collect(adapter.stream(requestFor(spec)));
      await assert.rejects(run, error => ['NETWORK', 'BAD_REQUEST'].includes(error.code) && !error.message.includes(SECRET));
      assert.equal(sourceRequests.length, 1);
      assert.equal(sourceRequests[0]['x-custom-provider-key'], SECRET);
      assert.equal(sourceRequests[0][spec.id === 'anthropicNative' ? 'x-api-key' : 'authorization'],
        spec.id === 'anthropicNative' ? SECRET : `Bearer ${SECRET}`);
      assert.equal(targetRequests, 0);
    });
  }
}

test('resilience HTTP helper cannot override redirects or send headers to another origin', async t => {
  let leaked = 0;
  const target = await listen(t, (_req, res) => { leaked++; res.end(); });
  const source = await listen(t, (_req, res) => { res.writeHead(302, { Location: target.url }); res.end(); });
  const headers = { Authorization: `Bearer ${SECRET}`, 'X-Custom-Key': SECRET };
  await assert.rejects(providerFetch(source.url, { headers, redirect: 'follow' }, { baseUrl: source.url }));
  await assert.rejects(providerFetch(target.url, { headers }, { baseUrl: source.url }), error => error.code === 'BAD_REQUEST');
  assert.equal(leaked, 0);
  let fetches = 0;
  for (const [baseUrl, url] of [
    ['https://example.test', 'http://example.test'], ['https://example.test', 'https://other.test'],
    ['http://example.test', 'http://example.test'], ['https://169.254.169.254', 'https://169.254.169.254'],
  ]) {
    await assert.rejects(providerFetch(url, { headers }, { baseUrl, fetchImpl: () => { fetches++; } }),
      error => error.code === 'BAD_REQUEST');
  }
  assert.equal(fetches, 0);
});

test('resilience HTTP helper rejects redirect responses from custom fetch implementations', async () => {
  let cancelled = false;
  await assert.rejects(providerFetch('https://example.test/v1', {}, { baseUrl: 'https://example.test',
    fetchImpl: async (_url, options) => {
      assert.equal(options.redirect, 'error');
      return { status: 307, body: { async cancel() { cancelled = true; } } };
    },
  }), error => error.code === 'BAD_REQUEST');
  assert.equal(cancelled, true);
});

for (const spec of ADAPTER_CASES) {
  test(`${spec.id}: direct construction cannot bypass endpoint or Host-header policy`, async () => {
    let fetches = 0;
    for (const profile of [
      { baseUrl: `${spec.audio ? 'ws' : 'http'}://example.test` },
      { baseUrl: `${spec.audio ? 'wss' : 'https'}://169.254.169.254` },
      { baseUrl: `${spec.audio ? 'ws' : 'http'}://127.0.0.1:1`, extraHeaders: { Host: 'other.test' } },
    ]) {
      const adapter = new spec.Adapter({ profile, model: 'fixture', resilience: { maxRetries: 0 },
        fetchImpl: async () => { fetches++; }, timeouts: { totalMs: 1000 } });
      await assert.rejects(collect(adapter.stream(requestFor(spec))), error => error.code === 'BAD_REQUEST');
    }
    assert.equal(fetches, 0);
  });
}

test('invalid custom headers never expose their contents through slot status', () => {
  const config = { profiles: { fixture: { adapter: 'openaiCompatible', baseUrl: 'https://example.test',
    extraHeaders: { 'X-Fixture': `${SECRET}\ninvalid` } } }, slots: { llm: { profile: 'fixture', model: 'fixture' } } };
  const status = new ProviderRegistry({ config }).getSlotStatus('llm');
  assert.equal(status.available, false);
  assert.equal(JSON.stringify(status).includes(SECRET), false);
  assert.match(status.reason, /valid HTTP header/);
});
