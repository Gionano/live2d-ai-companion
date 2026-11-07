import express from 'express';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { isLoopbackAddress } from '../selfie/imageRoutes.js';
import { ProviderRegistry } from '../providers/registry.js';
import { testSlot } from '../providers/testSlot.js';
import { getSettingsService } from './service.js';
import { listModels } from './models.js';
import { identifier, invalid, object, SETTINGS_LIMIT, SettingsError, SLOT_NAMES, text } from './schema.js';

const values = value => typeof value === 'string' ? value.split(',').map(item => item.trim()) : [];
const hostAllowed = value => {
  if (typeof value !== 'string' || !/^(localhost|127\.0\.0\.1|\[::1\])(?::[0-9]{1,5})?$/i.test(value)) return false;
  try { return Boolean(new URL('http://' + value).hostname); } catch { return false; }
};

export function isSettingsRequestAllowed(req) {
  if (!isLoopbackAddress(req.socket.remoteAddress || '') || !hostAllowed(req.headers.host)) return false;
  for (const name of ['x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto']) {
    if (req.headers[name] === undefined) continue;
    const entries = values(req.headers[name]);
    if (!entries.length || entries.some(item => !item)) return false;
    if (name === 'x-forwarded-for' && !entries.every(isLoopbackAddress)) return false;
    if (name === 'x-forwarded-host' && !entries.every(hostAllowed)) return false;
    if (name === 'x-forwarded-proto' && !entries.every(item => ['http', 'https'].includes(item))) return false;
  }
  const site = req.headers['sec-fetch-site'];
  if (site !== undefined && !['same-origin', 'none'].includes(site)) return false;
  const origin = req.headers.origin;
  if (origin === undefined) return site === 'same-origin';
  try {
    const host = values(req.headers['x-forwarded-host']).at(-1) || req.headers.host;
    const protocol = values(req.headers['x-forwarded-proto']).at(-1) || (req.socket.encrypted ? 'https' : 'http');
    return new URL(origin).origin === origin && origin === new URL(protocol + '://' + host).origin;
  } catch { return false; }
}

export function installSettingsRoutes(app, { service = getSettingsService(), registry,
  probe = testSlot, models = listModels, imageStatus = () => null, imageService = null, now = Date.now, testLimit = 5, testWindowMs = 60000, testTimeoutMs = 20000 } = {}) {
  registry ||= new ProviderRegistry({ config: service.config(), secretResolver: service.resolver() });
  service.attach(registry);
  const token = randomBytes(32).toString('hex');
  const attempts = [];
  let testing = false;
  const take = () => {
    while (attempts.length && attempts[0] <= now() - testWindowMs) attempts.shift();
    if (testing || attempts.length >= testLimit) throw new SettingsError('RATE_LIMIT', 429);
    attempts.push(now());
    testing = true;
  };
  const timeoutFor = value => {
    if (value === undefined) return testTimeoutMs;
    if (!Number.isInteger(value) || value < 1000 || value > 60000) invalid();
    return value;
  };
  const router = express.Router();
  router.use((req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    for (const name of res.getHeaderNames()) if (String(name).toLowerCase().startsWith('access-control-')) res.removeHeader(name);
    const setHeader = res.setHeader;
    res.setHeader = function (name, value) {
      if (String(name).toLowerCase().startsWith('access-control-')) return this;
      return setHeader.call(this, name, value);
    };
    if (!isSettingsRequestAllowed(req)) return next(new SettingsError('FORBIDDEN', 403));
    if (!['GET', 'HEAD'].includes(req.method) || /^\/secrets(?:\/|$)/i.test(req.path)) {
      const supplied = req.headers['x-settings-token'];
      if (typeof supplied !== 'string' || !/^[a-f0-9]{64}$/.test(supplied)
        || !timingSafeEqual(Buffer.from(supplied), Buffer.from(token))) return next(new SettingsError('FORBIDDEN', 403));
    }
    next();
  });
  router.use(express.json({ limit: SETTINGS_LIMIT, strict: true, inflate: false }));
  const respond = operation => (req, res, next) => {
    try { res.json(operation(req)); } catch (error) { next(error); }
  };
  const respondAsync = operation => async (req, res, next) => {
    try { res.json(await operation(req)); } catch (error) { next(error); }
  };
  const requireImages = () => {
    if (!imageService) throw new SettingsError('NOT_FOUND', 404);
    return imageService;
  };
  router.get('/bootstrap', respond(() => ({ token })));
  router.get('/', respond(() => service.effective()));
  router.get('/status', respond(() => service.status()));
  router.get('/legacy', respond(() => service.legacy()));
  router.get('/images', respondAsync(() => {
    if (imageService) return imageService.status();
    const current = imageStatus();
    const provider = ['comfyui', 'comfyui-managed', 'sdcpp', 'cloud'].includes(current?.active) ? current.active : null;
    return { ready: Boolean(provider), provider };
  }));
  router.put('/images', respondAsync(async req => {
    const result = service.putImages(req.body);
    return imageService ? { ...await imageService.status(), ...result } : result;
  }));
  router.put('/images/secret', respond(req => service.putImageSecret(req.body)));
  router.delete('/images/secret', respond(req => service.deleteImageSecret(req.body)));
  router.post('/images/install/plan', respondAsync(req => {
    object(req.body, ['provider', 'variant']);
    return requireImages().plan(req.body);
  }));
  router.post('/images/install', respondAsync(req => {
    object(req.body, ['planId', 'acceptedLicenses']);
    return requireImages().installer.start(req.body);
  }));
  router.get('/images/install/:id', respondAsync(async req => {
    identifier(req.params.id);
    const job = await requireImages().installer.get(req.params.id);
    if (!job) throw new SettingsError('NOT_FOUND', 404);
    return job;
  }));
  router.post('/images/install/:id/cancel', respondAsync(req => {
    identifier(req.params.id);
    object(req.body, []);
    return requireImages().installer.cancel(req.params.id);
  }));
  router.post('/images/test', async (req, res, next) => {
    let ownsTest = false;
    let timer;
    const controller = new AbortController();
    const disconnected = () => { if (!res.writableEnded) controller.abort(); };
    try {
      object(req.body, ['provider', 'timeoutMs']);
      const timeoutMs = timeoutFor(req.body.timeoutMs);
      take(); ownsTest = true;
      res.on('close', disconnected);
      const deadline = new Promise((_, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(new SettingsError('TIMEOUT', 504)); }, timeoutMs);
      });
      const result = await Promise.race([requireImages().test({ provider: req.body.provider, signal: controller.signal }), deadline]);
      if (!res.destroyed) res.json(result);
    } catch (error) { next(error); }
    finally { clearTimeout(timer); controller.abort(); res.removeListener('close', disconnected); if (ownsTest) testing = false; }
  });
  router.put('/profiles/:id', respond(req => service.putProfile(req.params.id, req.body)));
  router.delete('/profiles/:id', respond(req => service.deleteProfile(req.params.id, req.body)));
  router.put('/slots/:slot', respond(req => service.putSlot(req.params.slot, req.body)));
  router.put('/ui', respond(req => service.putUi(req.body)));
  router.put('/secrets/:id', respond(req => service.putSecret(req.params.id, req.body)));
  router.delete('/secrets/:id', respond(req => service.deleteSecret(req.params.id, req.body)));
  router.post('/export', respond(req => { object(req.body, []); return service.export(); }));
  router.post('/import', respond(req => service.import(req.body)));
  router.post('/legacy/import', respond(req => service.importLegacy(req.body)));
  router.post('/diagnostics', respond(req => {
    object(req.body, []);
    take();
    try { return service.diagnostics(); } finally { testing = false; }
  }));
  router.post('/models', async (req, res, next) => {
    let ownsTest = false;
    let timer;
    const controller = new AbortController();
    const abort = () => { if (!res.writableEnded) controller.abort(); };
    try {
      object(req.body, ['profile', 'apiKey', 'timeoutMs']);
      identifier(req.body.profile);
      const { apiKey } = req.body;
      if (apiKey !== undefined && (typeof apiKey !== 'string' || !apiKey || apiKey.length > 8192 || /[\x00-\x1f\x7f]/.test(apiKey))) invalid();
      const timeoutMs = timeoutFor(req.body.timeoutMs);
      take(); ownsTest = true;
      res.on('close', abort);
      const deadline = new Promise(resolve => { timer = setTimeout(() => {
        controller.abort(); resolve({ models: [], reason: 'TIMEOUT' });
      }, timeoutMs); });
      const result = await Promise.race([models(service, { profile: req.body.profile, apiKey, signal: controller.signal }), deadline]);
      res.json(result);
    } catch (error) { next(error); }
    finally { clearTimeout(timer); controller.abort(); res.removeListener('close', abort); if (ownsTest) testing = false; }
  });
  router.post('/test', async (req, res, next) => {
    let timer;
    let ownsTest = false;
    const controller = new AbortController();
    const abort = () => controller.abort();
    const disconnected = () => { if (!res.writableEnded) abort(); };
    const streamed = req.headers.accept === 'application/x-ndjson';
    const phases = new Set();
    const progress = phase => {
      if (!['connecting', 'first_byte', 'done'].includes(phase) || phases.has(phase)) return;
      phases.add(phase);
      if (streamed && !res.destroyed) {
        if (!res.headersSent) res.setHeader('Content-Type', 'application/x-ndjson');
        res.write(JSON.stringify({ phase }) + '\n');
      }
    };
    const finish = result => {
      if (streamed) { progress('done'); res.end(JSON.stringify({ result }) + '\n'); }
      else res.json(result);
    };
    try {
      object(req.body, ['slot', 'profile', 'model', 'timeoutMs']);
      const { slot, profile, model } = req.body;
      if (!SLOT_NAMES.includes(slot)) invalid();
      if (profile !== undefined) identifier(profile);
      if (model !== undefined) text(model, 256);
      const timeoutMs = timeoutFor(req.body.timeoutMs);
      take();
      ownsTest = true;
      const active = registry.withSlotOverride(slot, { profile, model });
      if (active.config.slots[slot]) active.config.slots[slot].timeouts = {
        firstByteMs: timeoutMs, idleMs: timeoutMs, totalMs: timeoutMs,
      };
      req.on('aborted', abort);
      res.on('close', disconnected);
      const deadline = new Promise((_, reject) => {
        timer = setTimeout(() => { abort(); reject(new SettingsError('TIMEOUT', 504)); }, timeoutMs);
      });
      progress('connecting');
      const result = await Promise.race([probe(slot, { registry: active, signal: controller.signal, onProgress: progress }), deadline]);
      // Return only the shared probe's fixed result fields, never provider output.
      const metric = value => Number.isFinite(value) && value >= 0 ? value : undefined;
      const codes = ['AUTH', 'RATE_LIMIT', 'TIMEOUT', 'BAD_REQUEST', 'SERVER', 'NETWORK', 'UNSUPPORTED', 'ABORTED', 'BAD_RESPONSE'];
      finish({ ok: result.ok === true, latencyMs: metric(result.latencyMs), ttftMs: metric(result.ttftMs),
        ...(result.tokens && { tokens: { inputTokens: metric(result.tokens.inputTokens), outputTokens: metric(result.tokens.outputTokens) } }),
        ...(result.error && { error: { code: codes.includes(result.error.code) ? result.error.code : 'BAD_RESPONSE',
          message: 'Provider test failed. Check the slot status and credentials.' } }) });
    } catch (error) {
      if (res.headersSent) finish({ ok: false, error: { code: error instanceof SettingsError ? error.code : 'BAD_RESPONSE' } });
      else next(error);
    }
    finally {
      clearTimeout(timer);
      abort();
      req.removeListener('aborted', abort);
      res.removeListener('close', disconnected);
      if (ownsTest) testing = false;
    }
  });
  router.use((_req, _res, next) => next(new SettingsError('NOT_FOUND', 404)));
  router.use((error, _req, res, _next) => {
    const installCodes = { CONFLICT: 409, IN_USE: 409, LOCK_BUSY: 409, NOT_FOUND: 404, STORAGE: 503, INVALID_SETTINGS: 400 };
    const safe = error instanceof SettingsError ? error : Object.hasOwn(installCodes, error.code)
      ? new SettingsError(error.code, installCodes[error.code])
      : new SettingsError(error.type === 'entity.too.large' ? 'TOO_LARGE' : 'INVALID_SETTINGS', error.type === 'entity.too.large' ? 413 : 400);
    if (!res.headersSent) res.status(safe.status).json({ error: { code: safe.code, message: safe.message } });
  });
  app.use('/api/settings', router);
  return { service, registry };
}
