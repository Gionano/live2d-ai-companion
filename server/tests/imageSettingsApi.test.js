import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import express from 'express';
import { SettingsService } from '../settings/service.js';
import { installSettingsRoutes } from '../settings/routes.js';

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pap-api-'));
  const service = new SettingsService({ repoRoot: root, localDir: root, env: {}, platform: 'linux',
    allowPlaintext: true, layers: { defaults: { profiles: {}, slots: {} }, dev: {} } });
  const calls = [];
  const imageService = {
    status: async () => ({ version: service.effective().version, images: service.imageOverrides(),
      ready: true, provider: 'cloud', ...service.imageSecretStatus() }),
    plan: async input => { calls.push(['plan', input]); return { planId: 'reviewed-plan', components: [] }; },
    test: async input => { calls.push(['test', input.provider]); return { ready: true, generationTested: false }; },
    installer: {
      start: async input => { calls.push(['start', input]); return { id: 'mock-job', state: 'queued' }; },
      get: async id => ({ id, state: 'running' }),
      cancel: async id => { calls.push(['cancel', id]); return { id, state: 'cancelling' }; },
    },
  };
  const app = express();
  installSettingsRoutes(app, { service, imageService });
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { await new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }); fs.rmSync(root, { recursive: true, force: true }); });
  const send = (route, { method = 'GET', body, token, origin = base } = {}) => fetch(base + '/api/settings' + route, {
    method, headers: { Origin: origin, 'Sec-Fetch-Site': 'same-origin', ...(token && { 'X-Settings-Token': token }),
      ...(body !== undefined && { 'Content-Type': 'application/json' }) }, ...(body !== undefined && { body: JSON.stringify(body) }),
  });
  const { token } = await (await send('/bootstrap')).json();
  return { service, send, token, calls, imageService };
}

test('PAP settings and cloud credentials use protected versioned endpoints', async t => {
  const { send, token, service } = await fixture(t);
  const images = { provider: 'cloud', cloud: { accountId: 'a'.repeat(32) } };
  assert.equal((await send('/images', { method: 'PUT', body: { version: 0, images } })).status, 403);
  assert.equal((await send('/images', { method: 'PUT', token, origin: 'https://foreign.invalid', body: { version: 0, images } })).status, 403);
  const saved = await send('/images', { method: 'PUT', token, body: { version: 0, images } });
  assert.equal(saved.status, 200);
  assert.equal((await saved.json()).images.provider, 'cloud');
  const key = 'private-cloud-api-fixture-token';
  assert.equal((await send('/images/secret', { method: 'PUT', token, body: { version: 1, key } })).status, 200);
  const status = await (await send('/images')).json();
  assert.equal(status.hasKey, true);
  assert.equal(JSON.stringify(status).includes(key), false);
  assert.equal(JSON.stringify(service.export()).includes(key), false);
  assert.equal((await send('/images/secret')).status, 404);
  assert.equal((await send('/images/secret', { method: 'DELETE', token, body: { version: 2 } })).status, 200);
  assert.equal((await send('/images', { method: 'PUT', token, body: { version: 0, images } })).status, 409);
});

test('setup endpoints accept only reviewed plans and await job status', async t => {
  const { send, token, calls } = await fixture(t);
  for (const route of ['/images/install/plan', '/images/install', '/images/install/mock-job/cancel', '/images/test']) {
    assert.equal((await send(route, { method: 'POST', body: {} })).status, 403);
  }
  assert.equal((await send('/images/install/plan', { method: 'POST', token, body: { provider: 'sdcpp', url: 'https://arbitrary.invalid' } })).status, 400);
  const plan = await (await send('/images/install/plan', { method: 'POST', token, body: { provider: 'sdcpp' } })).json();
  assert.equal(plan.planId, 'reviewed-plan');
  assert.equal((await send('/images/install', { method: 'POST', token, body: { planId: plan.planId, acceptedLicenses: [], command: 'anything' } })).status, 400);
  assert.equal((await send('/images/install', { method: 'POST', token, body: { planId: plan.planId, acceptedLicenses: [] } })).status, 200);
  assert.equal((await (await send('/images/install/mock-job')).json()).state, 'running');
  assert.equal((await send('/images/install/mock-job/cancel', { method: 'POST', token, body: {} })).status, 200);
  assert.deepEqual(calls.map(call => call[0]), ['plan', 'start', 'cancel']);
});

test('cloud readiness tests never generate and installer errors preserve safe codes', async t => {
  const { send, token, imageService, calls } = await fixture(t);
  const checked = await (await send('/images/test', { method: 'POST', token, body: {} })).json();
  assert.equal(checked.generationTested, false);
  assert.deepEqual(calls.map(call => call[0]), ['test']);
  imageService.installer.start = async () => { throw Object.assign(new Error('private filesystem diagnostic'), { code: 'IN_USE' }); };
  const response = await send('/images/install', { method: 'POST', token, body: { planId: 'reviewed-plan', acceptedLicenses: [] } });
  assert.equal(response.status, 409);
  const body = await response.json();
  assert.equal(body.error.code, 'IN_USE');
  assert.equal(JSON.stringify(body).includes('private filesystem'), false);
});
