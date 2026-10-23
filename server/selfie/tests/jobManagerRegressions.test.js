import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JobManager } from '../jobManager.js';
import { loadSelfieConfig } from '../config.js';

const PLAN = {
  slots: {},
  positivePrompt: 'A test selfie',
  negativePrompt: 'blur',
  referenceImage: 'reference.png',
  caption: 'Ini fotonya sayang.',
  emotion: 'sayang',
};

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function withTimeout(promise, message) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), 2000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function flushLifecycle() {
  for (let index = 0; index < 8; index += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

function createProvider({ availability = null, releaseGate = null } = {}) {
  const runs = [];
  const runWaiters = new Map();
  return {
    runs,
    cancelCalls: 0,
    releaseCalls: 0,
    async isAvailable() {
      return availability ? availability.promise : true;
    },
    generate(params, onProgress, signal) {
      const completion = deferred();
      const abort = () => {
        const error = new Error('Generation cancelled');
        error.code = 'CANCELLED';
        completion.reject(error);
      };
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
      const run = {
        params,
        signal,
        progress: onProgress,
        complete: () => completion.resolve({ imagePath: 'fake-selfie.png' }),
        fail: () => completion.reject(new Error('Fake generation failure')),
      };
      runs.push(run);
      runWaiters.get(runs.length - 1)?.resolve(run);
      return completion.promise.finally(() => signal.removeEventListener('abort', abort));
    },
    waitForRun(index = 0) {
      if (runs[index]) return Promise.resolve(runs[index]);
      const waiter = deferred();
      runWaiters.set(index, waiter);
      return withTimeout(waiter.promise, `Provider run ${index} did not start`);
    },
    async cancel() {
      this.cancelCalls += 1;
    },
    async release() {
      this.releaseCalls += 1;
      if (releaseGate) await releaseGate.promise;
    },
  };
}

function createHarness(t, overrides = {}, providerOptions = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'selfie-job-regressions-'));
  const config = {
    dailyLimit: 10,
    cooldownMs: 0,
    maxQueue: 1,
    freeVramAfter: false,
    etaStorePath: path.join(directory, 'durations.json'),
    limitsStorePath: null,
    ...(typeof overrides === 'function' ? overrides(directory) : overrides),
  };
  const manager = new JobManager(config);
  const provider = createProvider(providerOptions);
  manager.provider = provider;
  const managers = [manager];
  const events = [];
  const eventWaiters = [];
  manager.setBroadcaster((event) => {
    events.push(event);
    for (const waiter of eventWaiters) {
      if (waiter.type === event.type && waiter.jobId === event.jobId) waiter.resolve(event);
    }
  });
  t.after(async () => {
    providerOptions.availability?.resolve(true);
    providerOptions.releaseGate?.resolve();
    await Promise.all(managers.map((instance) => instance.shutdown()));
    const resolvedDirectory = path.resolve(directory);
    const temporaryPrefix = path.resolve(os.tmpdir(), 'selfie-job-regressions-');
    assert.ok(resolvedDirectory.startsWith(temporaryPrefix));
    fs.rmSync(resolvedDirectory, { recursive: true, force: true });
  });
  return {
    manager,
    provider,
    events,
    config,
    directory,
    registerManager(instance) {
      managers.push(instance);
      return instance;
    },
    waitForEvent(type, jobId) {
      const existing = events.find((event) => event.type === type && event.jobId === jobId);
      if (existing) return Promise.resolve(existing);
      const waiter = deferred();
      eventWaiters.push({ ...waiter, type, jobId });
      return withTimeout(waiter.promise, `${type} was not emitted for ${jobId}`);
    },
  };
}

test('tryAdmit reserves the active slot and bounded queue synchronously', async (t) => {
  const { manager } = createHarness(t);
  const admissions = Array.from({ length: 3 }, () => manager.tryAdmit());

  assert.ok(admissions.every((admission) => !(admission instanceof Promise)));
  assert.deepEqual(admissions.map((admission) => admission.allowed), [true, true, false]);
  assert.equal(admissions[2].reason, 'BUSY');
  assert.equal(manager.activeJob.jobId, admissions[0].jobId);
  assert.equal(manager.queue.length, 1);
  assert.equal(manager.queue[0].jobId, admissions[1].jobId);

  await manager.cancelJob(admissions[1].jobId);
  assert.equal(manager.tryAdmit().allowed, true);
  assert.equal(manager.queue.length, 1);
});

test('invalid plans never reserve capacity and refund supplied admissions', async (t) => {
  const { manager } = createHarness(t, { dailyLimit: 1, maxQueue: 0 });
  for (const plan of [null, {}, { caption: '', slots: {} }, { caption: 'valid' },
    { caption: 'valid', slots: [] }]) {
    assert.equal((await manager.submitJob({ plan })).reason, 'INVALID_PLAN');
    assert.equal(manager.activeJob, null);
    assert.equal(manager.queue.length, 0);
    const admission = manager.tryAdmit();
    assert.equal(admission.allowed, true);
    assert.equal((await manager.submitJob({ plan, admission })).reason, 'INVALID_PLAN');
    assert.equal(manager.activeJob, null);
  }
  assert.equal(manager._runTasks.size, 0);
  const throwingPlan = { get caption() { throw new Error('Invalid plan getter'); }, slots: {} };
  await assert.rejects(manager.submitJob({ plan: throwingPlan }), /Invalid plan getter/);
  assert.equal(manager.activeJob, null);
  const admission = manager.tryAdmit();
  await assert.rejects(manager.submitJob({ plan: throwingPlan, admission }), /Invalid plan getter/);
  assert.equal(manager.activeJob, null);
});

test('submission setup failure refunds only its own reservation', async (t) => {
  const { manager } = createHarness(t, { dailyLimit: 2, maxQueue: 1 });
  const active = manager.tryAdmit();
  const queued = manager.tryAdmit();
  manager.pickPhrase = () => { throw new Error('Speech setup failed'); };
  await assert.rejects(manager.submitJob({ plan: PLAN, admission: queued }), /Speech setup failed/);
  assert.equal(manager.activeJob.jobId, active.jobId);
  assert.equal(manager.activeJob.reserved, true);
  assert.equal(manager.queue.length, 0);
  const retry = manager.tryAdmit();
  assert.equal(retry.allowed, true);
  await manager.cancelJob(retry.jobId);
  await manager.cancelJob(active.jobId);
  await assert.rejects(manager.submitJob({ plan: PLAN }), /Speech setup failed/);
  assert.equal(manager.activeJob, null);
  assert.equal(manager.tryAdmit().allowed, true);
});

test('concurrent submitJob calls cannot overfill maxQueue', async (t) => {
  const { manager, provider, events } = createHarness(t);
  const results = await Promise.all(Array.from({ length: 3 }, () => manager.submitJob({ plan: PLAN })));

  assert.equal(results.filter((result) => result.ok).length, 2);
  assert.equal(results.filter((result) => result.reason === 'BUSY').length, 1);
  assert.equal(manager.queue.length, 1);
  await provider.waitForRun();
  assert.equal(provider.runs.length, 1);
  assert.equal(events.filter((event) => event.type === 'selfie_started' && event.status === 'queued').length, 1);
});

test('maxQueue zero refuses every request while the active slot is reserved', (t) => {
  const { manager } = createHarness(t, { maxQueue: 0 });
  assert.equal(manager.tryAdmit().allowed, true);
  assert.equal(manager.tryAdmit().reason, 'BUSY');
  assert.equal(manager.queue.length, 0);
});

test('dailyLimit one admits only one concurrent job and completion', async (t) => {
  const { manager, provider, events, waitForEvent } = createHarness(t, { maxQueue: 5, dailyLimit: 1 });
  const results = await Promise.all(Array.from({ length: 3 }, () => manager.submitJob({ plan: PLAN })));
  const admitted = results.filter((result) => result.ok);
  assert.equal(admitted.length, 1);
  assert.equal(results.filter((result) => result.reason === 'DAILY_LIMIT').length, 2);
  const run = await provider.waitForRun();
  assert.equal(manager.getDailyCount(), 1);

  run.complete();
  await waitForEvent('selfie_ready', admitted[0].jobId);
  await flushLifecycle();
  assert.equal(provider.runs.length, 1);
  assert.equal(events.filter((event) => event.type === 'selfie_ready').length, 1);
  assert.equal(manager.getDailyCount(), 1);
  assert.equal(manager.tryAdmit().reason, 'DAILY_LIMIT');
});

test('cancelling an unsubmitted admission refunds its daily reservation', async (t) => {
  const { manager, provider } = createHarness(t, { dailyLimit: 1 });
  const admission = manager.tryAdmit();
  assert.equal(manager.tryAdmit().reason, 'DAILY_LIMIT');
  assert.equal(manager.getDailyCount(), 0);

  assert.equal(await manager.cancelJob(admission.jobId), true);
  assert.equal(manager.getDailyCount(), 0);
  assert.equal(manager.tryAdmit().allowed, true);
  assert.equal(provider.runs.length, 0);

  const cancelledSubmission = await manager.submitJob({ plan: PLAN, admission });
  assert.equal(cancelledSubmission.ok, false);
  assert.equal(provider.runs.length, 0);
});

test('cancellation before availability resolves never starts generation', async (t) => {
  const availability = deferred();
  const { manager, provider, waitForEvent } = createHarness(t, { dailyLimit: 1 }, { availability });
  const admission = manager.tryAdmit();
  const submission = manager.submitJob({ plan: PLAN, admission });
  const cancellation = manager.cancelJob(admission.jobId);
  availability.resolve(true);
  await cancellation;
  await submission;
  await waitForEvent('selfie_cancelled', admission.jobId);
  await flushLifecycle();

  assert.equal(provider.runs.length, 0);
  assert.equal(manager.getDailyCount(), 0);
  assert.equal(manager.tryAdmit().allowed, true);
});

test('shutdown during pending availability refunds admission and finishes without the provider response', async (t) => {
  const availability = deferred();
  const { manager, provider, events } = createHarness(t, { dailyLimit: 1 }, { availability });
  const submitted = await manager.submitJob({ plan: PLAN });
  await flushLifecycle();
  assert.equal(manager.getDailyCount(), 0);

  await withTimeout(manager.shutdown(), 'Shutdown waited for pending provider availability');
  assert.equal(manager.activeJob, null);
  assert.equal(manager.queue.length, 0);
  assert.equal(manager.getDailyCount(), 0);
  assert.equal(provider.runs.length, 0);
  assert.equal(provider.releaseCalls, 1);
  assert.ok(events.some((event) => event.type === 'selfie_cancelled' && event.jobId === submitted.jobId));

  availability.resolve(true);
  await flushLifecycle();
  assert.equal(provider.runs.length, 0);
  assert.equal(provider.releaseCalls, 1);
});

test('queued cancellation refunds quota and does not interrupt the running job', async (t) => {
  const { manager, provider, waitForEvent } = createHarness(t, { dailyLimit: 2, maxQueue: 2 });
  const active = await manager.submitJob({ plan: PLAN });
  const running = await provider.waitForRun();
  const queued = await manager.submitJob({ plan: PLAN });
  assert.equal(manager.tryAdmit().reason, 'DAILY_LIMIT');

  assert.equal(await manager.cancelJob(queued.jobId), true);
  await waitForEvent('selfie_cancelled', queued.jobId);
  assert.equal(running.signal.aborted, false);
  assert.equal(provider.cancelCalls, 0);
  assert.equal(manager.getDailyCount(), 1);
  assert.equal(manager.tryAdmit().allowed, true);
  assert.equal(provider.runs.length, 1);
  assert.equal(manager.activeJob.jobId, active.jobId);
});

test('running cancellation aborts the provider without ready or a quota refund', async (t) => {
  const { manager, provider, events, waitForEvent } = createHarness(t, { dailyLimit: 1 });
  const submitted = await manager.submitJob({ plan: PLAN });
  const run = await provider.waitForRun();

  assert.equal(await manager.cancelJob(submitted.jobId), true);
  await waitForEvent('selfie_cancelled', submitted.jobId);
  await flushLifecycle();

  assert.equal(run.signal.aborted, true);
  assert.ok(provider.cancelCalls > 0);
  assert.equal(events.filter((event) => event.type === 'selfie_ready').length, 0);
  assert.equal(manager.getDailyCount(), 1);
  assert.equal(manager.activeJob, null);
});

test('queued generation waits for the cooldown from the previous completion', async (t) => {
  const { manager, provider, waitForEvent } = createHarness(t, { cooldownMs: 70 });
  const first = await manager.submitJob({ plan: PLAN });
  const firstRun = await provider.waitForRun();
  await manager.submitJob({ plan: PLAN });
  firstRun.complete();
  await waitForEvent('selfie_ready', first.jobId);
  await flushLifecycle();

  assert.equal(provider.runs.length, 1);
  const completedAt = manager.lastCompletedTime;
  await provider.waitForRun(1);
  assert.ok(Date.now() - completedAt >= 70);
  assert.equal(manager.getDailyCount(), 2);
});

test('cancelling a queued job during cooldown refunds quota and clears delayed generation', async (t) => {
  const { manager, provider, events, waitForEvent } = createHarness(t, { cooldownMs: 70, dailyLimit: 2 });
  const first = await manager.submitJob({ plan: PLAN });
  const firstRun = await provider.waitForRun();
  const queued = await manager.submitJob({ plan: PLAN });
  firstRun.complete();
  await waitForEvent('selfie_ready', first.jobId);
  await flushLifecycle();
  assert.equal(manager.activeJob.jobId, queued.jobId);
  assert.equal(provider.runs.length, 1);

  await manager.cancelJob(queued.jobId);
  await waitForEvent('selfie_cancelled', queued.jobId);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(manager.activeJob, null);
  assert.equal(manager.queue.length, 0);
  assert.equal(provider.runs.length, 1);
  assert.equal(manager.getDailyCount(), 1);
  assert.equal(events.filter((event) => event.type === 'selfie_ready').length, 1);
  assert.equal(manager.tryAdmit().allowed, true);
});

test('queued generation rechecks a reduced daily limit before starting', async (t) => {
  const { manager, provider, events, waitForEvent } = createHarness(t, { dailyLimit: 2 });
  const first = await manager.submitJob({ plan: PLAN });
  const run = await provider.waitForRun();
  const queued = await manager.submitJob({ plan: PLAN });
  manager.config.dailyLimit = 1;
  run.complete();
  await waitForEvent('selfie_ready', first.jobId);
  const rejected = await waitForEvent('selfie_failed', queued.jobId);
  await flushLifecycle();

  assert.equal(rejected.reason, 'DAILY_LIMIT');
  assert.equal(provider.runs.length, 1);
  assert.equal(events.filter((event) => event.type === 'selfie_ready').length, 1);
  assert.equal(manager.getDailyCount(), 1);
  assert.equal(manager.queue.length, 0);
});

test('daily counter and completion cooldown survive a manager restart', async (t) => {
  const harness = createHarness(t, (directory) => ({
    limitsStorePath: path.join(directory, 'limits.json'),
    cooldownMs: 60000,
  }));
  const { manager, provider, waitForEvent, registerManager } = harness;
  const submitted = await manager.submitJob({ plan: PLAN });
  (await provider.waitForRun()).complete();
  await waitForEvent('selfie_ready', submitted.jobId);
  await flushLifecycle();

  const restarted = registerManager(new JobManager(manager.config));
  restarted.provider = createProvider();
  assert.equal(restarted.getDailyCount(), 1);
  assert.equal(restarted.lastCompletedTime, manager.lastCompletedTime);
  assert.equal(restarted.tryAdmit().reason, 'COOLDOWN');
  restarted.config.cooldownMs = 0;
  restarted.config.dailyLimit = 1;
  assert.equal(restarted.tryAdmit().reason, 'DAILY_LIMIT');

  const stored = JSON.parse(fs.readFileSync(manager.config.limitsStorePath, 'utf8'));
  assert.equal(stored.dailyRecords.count, 1);
  assert.equal(stored.lastCompletedTime, manager.lastCompletedTime);
});

test('started daily quota persists even if generation fails before completion', async (t) => {
  const { manager, provider, waitForEvent, registerManager } = createHarness(t, (directory) => ({
    dailyLimit: 1,
    limitsStorePath: path.join(directory, 'limits.json'),
  }));
  const submitted = await manager.submitJob({ plan: PLAN });
  (await provider.waitForRun()).fail();
  await waitForEvent('selfie_failed', submitted.jobId);
  await flushLifecycle();

  const restarted = registerManager(new JobManager(manager.config));
  restarted.provider = createProvider();
  assert.equal(restarted.getDailyCount(), 1);
  assert.equal(restarted.tryAdmit().reason, 'DAILY_LIMIT');
  assert.equal(restarted.lastCompletedTime, 0);
});

test('missing and corrupt limits files reset safely and warn', (t) => {
  const { config, directory, registerManager } = createHarness(t);
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));
  try {
    const missingPath = path.join(directory, 'missing.json');
    const missing = registerManager(new JobManager({ ...config, limitsStorePath: missingPath }));
    assert.equal(missing.getDailyCount(), 0);
    assert.equal(missing.lastCompletedTime, 0);
    assert.equal(warnings.length, 1);

    for (const invalid of ['{broken', JSON.stringify({ lastCompletedTime: -1, dailyRecords: { date: 'invalid', count: -2 } })]) {
      const corruptPath = path.join(directory, 'corrupt.json');
      fs.writeFileSync(corruptPath, invalid, 'utf8');
      const corrupt = registerManager(new JobManager({ ...config, limitsStorePath: corruptPath }));
      assert.equal(corrupt.getDailyCount(), 0);
      assert.equal(corrupt.lastCompletedTime, 0);
    }
    assert.equal(warnings.length, 3);
    assert.ok(warnings.every((warning) => /limit|persist|reset/i.test(warning)));
  } finally {
    console.warn = originalWarn;
  }
});

test('persisted daily quota uses the local date and resets after local midnight', (t) => {
  const { config, directory, registerManager } = createHarness(t);
  const originalDate = global.Date;
  const originalTimezone = process.env.TZ;
  const limitsPath = path.join(directory, 'local-date.json');
  let now = originalDate.parse('2026-10-22T17:05:00Z');
  process.env.TZ = 'Asia/Jakarta';
  global.Date = class extends originalDate {
    constructor(...args) {
      super(...(args.length ? args : [now]));
    }
    static now() {
      return now;
    }
  };
  try {
    fs.writeFileSync(limitsPath, JSON.stringify({
      lastCompletedTime: 0,
      dailyRecords: { date: '2026-10-23', count: 1 },
    }), 'utf8');
    const manager = registerManager(new JobManager({ ...config, dailyLimit: 1, limitsStorePath: limitsPath }));
    manager.provider = createProvider();
    assert.equal(manager.getDailyCount(), 1);
    assert.equal(manager.tryAdmit().reason, 'DAILY_LIMIT');

    now = originalDate.parse('2026-10-23T17:05:00Z');
    assert.equal(manager.getDailyCount(), 0);
    assert.equal(manager.dailyRecords.date, '2026-10-24');
    assert.equal(manager.tryAdmit().allowed, true);
  } finally {
    global.Date = originalDate;
    if (originalTimezone === undefined) delete process.env.TZ;
    else process.env.TZ = originalTimezone;
  }
});

test('each connection snapshot replays started and the last progress only to that client', async (t) => {
  const { manager, provider, events } = createHarness(t);
  const submitted = await manager.submitJob({ plan: PLAN });
  const run = await provider.waitForRun();
  run.progress({ value: 2, max: 8 });
  run.progress({ value: 5, max: 8 });
  const broadcastCount = events.length;
  const firstClient = [];
  const secondClient = [];
  manager.sendSnapshot((event) => firstClient.push(event));
  manager.sendSnapshot((event) => secondClient.push(event));

  assert.deepEqual(firstClient, secondClient);
  assert.equal(firstClient.length, 1);
  assert.equal(firstClient[0].type, 'selfie_snapshot');
  assert.equal(firstClient[0].activeJobId, submitted.jobId);
  const replay = firstClient[0].events;
  assert.deepEqual(replay.map((event) => event.type), ['selfie_started', 'selfie_progress']);
  assert.ok(replay.every((event) => event.jobId === submitted.jobId));
  assert.equal(replay[0].etaSeconds, null);
  assert.equal(replay[1].value, 5);
  assert.equal(replay[1].percentage, 63);
  replay[1].value = 0;
  assert.equal(manager.activeJob.lastProgress.value, 5, 'snapshot callers cannot change server state');
  assert.equal(secondClient[0].events[1].value, 5);
  assert.equal(events.length, broadcastCount);
});

test('completed snapshot replays ready and unknown duration has null ETA for both presets', async (t) => {
  const { manager, provider, waitForEvent } = createHarness(t);
  const emptySnapshot = [];
  manager.sendSnapshot((event) => emptySnapshot.push(event));
  assert.deepEqual(emptySnapshot, [{ type: 'selfie_snapshot', activeJobId: null, events: [] }]);

  const first = await manager.submitJob({ plan: PLAN, preset: 'cepat' });
  assert.equal(first.etaSeconds, null);
  (await provider.waitForRun()).complete();
  const ready = await waitForEvent('selfie_ready', first.jobId);
  await flushLifecycle();
  const completedSnapshot = [];
  manager.sendSnapshot((event) => completedSnapshot.push(event));
  assert.deepEqual(completedSnapshot, [{ type: 'selfie_snapshot', activeJobId: null, events: [ready] }]);

  const second = await manager.submitJob({ plan: PLAN, preset: 'kualitas' });
  assert.equal(second.etaSeconds, null);
});

test('ready and reconnect snapshots preserve shared auto-close including disabled auto-close', async (t) => {
  for (const autoCloseSeconds of [undefined, 0, 7]) {
    await t.test(`autoCloseSeconds ${autoCloseSeconds ?? 'default'}`, async (t) => {
      const { manager, provider, waitForEvent } = createHarness(t, { autoCloseSeconds });
      const submitted = await manager.submitJob({ plan: PLAN });
      (await provider.waitForRun()).complete();
      const ready = await waitForEvent('selfie_ready', submitted.jobId);
      assert.equal(ready.autoCloseSeconds, autoCloseSeconds ?? 30);
      await flushLifecycle();
      const snapshots = [];
      manager.sendSnapshot(event => snapshots.push(event));
      assert.deepEqual(snapshots, [{ type: 'selfie_snapshot', activeJobId: null, events: [ready] }]);
      assert.equal(JSON.stringify(snapshots).includes('fake-selfie.png'), false);
    });
  }
  assert.equal(loadSelfieConfig({ autoCloseSeconds: 0 }).autoCloseSeconds, 0);
  assert.equal(loadSelfieConfig({ autoCloseSeconds: -1 }).autoCloseSeconds, 30);
});

test('expired completed results and cancelled jobs send an authoritative empty snapshot', async (t) => {
  const { manager, provider, waitForEvent } = createHarness(t);
  const submitted = await manager.submitJob({ plan: PLAN });
  (await provider.waitForRun()).complete();
  const ready = await waitForEvent('selfie_ready', submitted.jobId);
  await flushLifecycle();
  const token = ready.imageUrl.slice('/api/selfies/'.length);
  manager.tokenMap.get(token).timestamp = Date.now() - 24 * 60 * 60 * 1000 - 1;
  const snapshots = [];
  manager.sendSnapshot(event => snapshots.push(event));
  assert.deepEqual(snapshots, [{ type: 'selfie_snapshot', activeJobId: null, events: [] }]);
  const next = await manager.submitJob({ plan: PLAN });
  await provider.waitForRun(1);
  await manager.cancelJob(next.jobId);
  await flushLifecycle();
  snapshots.length = 0;
  manager.sendSnapshot(event => snapshots.push(event));
  assert.deepEqual(snapshots, [{ type: 'selfie_snapshot', activeJobId: null, events: [] }]);
});

test('snapshots identify a pending admission and never replay an aborted active job', async (t) => {
  const { manager, provider, waitForEvent } = createHarness(t);
  const first = await manager.submitJob({ plan: PLAN });
  (await provider.waitForRun()).complete();
  await waitForEvent('selfie_ready', first.jobId);
  await flushLifecycle();
  const pending = manager.tryAdmit();
  const snapshots = [];
  manager.sendSnapshot(event => snapshots.push(event));
  assert.deepEqual(snapshots, [{ type: 'selfie_snapshot', activeJobId: pending.jobId, events: [] }]);
  await manager.submitJob({ plan: PLAN, admission: pending });
  await provider.waitForRun(1);
  manager.activeJob.abortController.abort();
  snapshots.length = 0;
  manager.sendSnapshot(event => snapshots.push(event));
  assert.deepEqual(snapshots, [{ type: 'selfie_snapshot', activeJobId: null, events: [] }]);
});

test('shutdown aborts running work, refunds pending jobs and releases exactly once', async (t) => {
  const { manager, provider, events } = createHarness(t, { freeVramAfter: true, dailyLimit: 3, maxQueue: 2 });
  await manager.submitJob({ plan: PLAN });
  const run = await provider.waitForRun();
  const queued = await manager.submitJob({ plan: PLAN });
  const pending = manager.tryAdmit();
  assert.equal(pending.allowed, true);

  await Promise.all([manager.shutdown(), manager.shutdown(), manager.shutdown()]);
  await flushLifecycle();

  assert.equal(run.signal.aborted, true);
  assert.ok(provider.cancelCalls > 0);
  assert.equal(provider.releaseCalls, 1);
  assert.equal(manager.activeJob, null);
  assert.equal(manager.queue.length, 0);
  assert.equal(manager.getDailyCount(), 1);
  assert.equal(provider.runs.length, 1);
  assert.ok(events.some((event) => event.type === 'selfie_cancelled' && event.jobId === queued.jobId));
  assert.equal(manager.tryAdmit().allowed, false);
  assert.equal((await manager.submitJob({ plan: PLAN, admission: pending })).ok, false);
});

test('shutdown during successful free-VRAM cleanup joins the existing release', async (t) => {
  const releaseGate = deferred();
  const { manager, provider, waitForEvent } = createHarness(t, { freeVramAfter: true }, { releaseGate });
  const submitted = await manager.submitJob({ plan: PLAN });
  (await provider.waitForRun()).complete();
  await waitForEvent('selfie_ready', submitted.jobId);
  await flushLifecycle();
  assert.equal(provider.releaseCalls, 1);

  const shutdown = manager.shutdown();
  releaseGate.resolve();
  await shutdown;
  await manager.shutdown();
  assert.equal(provider.releaseCalls, 1);
  assert.equal(manager.activeJob, null);
});

test('shutdown during failure cleanup releases the provider once', async (t) => {
  const releaseGate = deferred();
  const { manager, provider, waitForEvent } = createHarness(t, {}, { releaseGate });
  const submitted = await manager.submitJob({ plan: PLAN });
  (await provider.waitForRun()).fail();
  await waitForEvent('selfie_failed', submitted.jobId);
  await flushLifecycle();
  assert.equal(provider.releaseCalls, 1);

  const shutdown = manager.shutdown();
  releaseGate.resolve();
  await shutdown;
  await manager.shutdown();
  assert.equal(provider.releaseCalls, 1);
  assert.equal(manager.activeJob, null);
});
