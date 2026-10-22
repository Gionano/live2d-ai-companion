// ---------------------------------------------------------------------------
// jobManager.test.js  (unit tests untuk Fase C)
// Menguji: JobManager, antrean, cooldown, batas harian, event WebSocket,
// token mapping HTTP, pembatalan, dan penanganan kegagalan.
// Dijalankan dengan: node --test server/selfie/tests/jobManager.test.js
// ---------------------------------------------------------------------------
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JobManager } from '../jobManager.js';
import { loadSelfieConfig } from '../config.js';

function createTestManager(t, config = null) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'selfie-job-tests-'));
  const manager = new JobManager({
    ...(config || loadSelfieConfig()),
    etaStorePath: path.join(directory, 'durations.json'),
    limitsStorePath: path.join(directory, 'limits.json'),
  });
  t.after(async () => {
    await manager.shutdown();
    assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir(), 'selfie-job-tests-')));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return manager;
}

function createMockProvider({ available = true, delayMs = 10, fail = false, cancel = false } = {}) {
  let released = false;
  let cancelled = false;
  return {
    name: 'mock',
    released: () => released,
    cancelled: () => cancelled,
    async isAvailable() {
      return available;
    },
    async generate(params, onProgress, signal) {
      if (fail) {
        throw new Error('Simulated generation error');
      }
      for (let i = 1; i <= 5; i++) {
        if (signal?.aborted) {
          const err = new Error('Aborted');
          err.code = 'CANCELLED';
          throw err;
        }
        if (onProgress) onProgress({ value: i, max: 5 });
        await new Promise((r) => setTimeout(r, delayMs));
      }
      return {
        imagePath: 'C:\\Users\\Lenovo\\Pictures\\WaifuSelfies\\mock_test.png',
        seed: 12345,
        timings: { totalMs: 50 },
      };
    },
    async cancel() {
      cancelled = true;
    },
    async release() {
      released = true;
    },
  };
}

test('1. JobManager: Eligibility Checks (Batas Harian, Cooldown, Sibuk, Provider)', async (t) => {
  await t.test('lolos jika sistem kosong dan provider tersedia', async () => {
    const jm = createTestManager(t, {
      dailyLimit: 5,
      cooldownMs: 1000,
      maxQueue: 1,
    });
    jm.provider = createMockProvider({ available: true });

    const check = await jm.canAcceptJob();
    assert.equal(check.allowed, true);
  });

  await t.test('menolak jika provider gambar tidak tersedia', async () => {
    const jm = createTestManager(t);
    jm.provider = createMockProvider({ available: false });

    const check = await jm.canAcceptJob();
    assert.equal(check.allowed, false);
    assert.equal(check.reason, 'PROVIDER_UNAVAILABLE');
    assert.ok(check.text.length > 5);
    assert.equal(check.emotion, 'malu');
  });

  await t.test('menolak jika batas harian tercapai', async () => {
    const jm = createTestManager(t, { dailyLimit: 2 });
    jm.provider = createMockProvider({ available: true });
    jm.dailyRecords.count = 2;

    const check = await jm.canAcceptJob();
    assert.equal(check.allowed, false);
    assert.equal(check.reason, 'DAILY_LIMIT');
    assert.ok(check.text.length > 5);
  });

  await t.test('menolak jika masih dalam periode cooldown', async () => {
    const jm = createTestManager(t, { cooldownMs: 10000 });
    jm.provider = createMockProvider({ available: true });
    jm.lastCompletedTime = Date.now() - 2000; // 8 detik tersisa

    const check = await jm.canAcceptJob();
    assert.equal(check.allowed, false);
    assert.equal(check.reason, 'COOLDOWN');
    assert.ok(check.remainingSec > 0);
  });

  await t.test('menolak jika antrean penuh (activeJob ada dan queue sudah maxQueue)', async () => {
    const jm = createTestManager(t, { maxQueue: 1 });
    jm.provider = createMockProvider({ available: true });
    assert.equal(jm.tryAdmit().allowed, true);
    assert.equal(jm.tryAdmit().allowed, true);

    const check = await jm.canAcceptJob();
    assert.equal(check.allowed, false);
    assert.equal(check.reason, 'BUSY');
    assert.ok(check.text.length > 5);
  });
});

test('2. Siklus Hidup Job, Event WebSocket, dan Token HTTP (Success Flow)', async (t) => {
  const jm = createTestManager(t, {
    cooldownMs: 500,
    dailyLimit: 10,
    freeVramAfter: true,
  });
  const mockProv = createMockProvider({ delayMs: 5 });
  jm.provider = mockProv;

  const events = [];
  jm.setBroadcaster((ev) => events.push(ev));

  const spokenMessages = [];
  jm.setSpeechHandler((msg) => spokenMessages.push(msg));

  const fakePlan = {
    slots: {},
    positivePrompt: 'A test selfie',
    negativePrompt: 'blurry',
    referenceImage: 'default.jpg',
    caption: 'Ini foto uji cobaku sayang~',
    emotion: 'sayang',
  };

  const submitRes = await jm.submitJob({ plan: fakePlan, preset: 'cepat' });
  assert.equal(submitRes.ok, true);
  assert.ok(submitRes.jobId);
  assert.equal(submitRes.etaSeconds, null);

  // Ucapan awal harus langsung diantrekan
  assert.equal(spokenMessages.length, 1);
  assert.ok(spokenMessages[0].text.length > 5);

  // Tunggu sampai job selesai
  while (jm.activeJob) {
    await new Promise((r) => setTimeout(r, 10));
  }

  // Periksa event WebSocket yang terkirim
  const types = events.map((e) => e.type);
  assert.ok(types.includes('selfie_started'), 'Harus mengirim selfie_started');
  assert.ok(types.includes('selfie_progress'), 'Harus mengirim selfie_progress');
  assert.ok(types.includes('selfie_ready'), 'Harus mengirim selfie_ready');

  const readyEv = events.find((e) => e.type === 'selfie_ready');
  assert.ok(readyEv.imageUrl.startsWith('/selfies/'), 'URL harus berupa /selfies/:token acak');
  assert.equal(readyEv.caption, fakePlan.caption);
  assert.equal(readyEv.emotion, fakePlan.emotion);

  // Periksa token acak dapat diambil oleh router HTTP
  const token = readyEv.imageUrl.replace('/selfies/', '');
  const fileData = jm.getFileByToken(token);
  assert.ok(fileData, 'Token harus terdaftar di tokenMap');
  assert.equal(fileData.filePath, 'C:\\Users\\Lenovo\\Pictures\\WaifuSelfies\\mock_test.png');

  // Suara avatar membacakan caption setelah selesai
  assert.equal(spokenMessages.length, 2);
  assert.equal(spokenMessages[1].text, fakePlan.caption);
  assert.equal(spokenMessages[1].emotion, fakePlan.emotion);

  // VRAM harus dibebaskan
  assert.equal(mockProv.released(), true);
});

test('3. Pembatalan Job (Cancellation Flow)', async (t) => {
  const jm = createTestManager(t);
  const mockProv = createMockProvider({ delayMs: 50 });
  jm.provider = mockProv;

  const events = [];
  jm.setBroadcaster((ev) => events.push(ev));

  const spoken = [];
  jm.setSpeechHandler((msg) => spoken.push(msg));

  const fakePlan = {
    slots: {},
    positivePrompt: 'A test selfie',
    negativePrompt: '',
    referenceImage: 'default.jpg',
    caption: 'Foto batal',
    emotion: 'netral',
  };

  const submitRes = await jm.submitJob({ plan: fakePlan, preset: 'cepat' });
  await new Promise((r) => setTimeout(r, 20)); // Biarkan job mulai

  const cancelled = await jm.cancelJob(submitRes.jobId);
  assert.equal(cancelled, true);

  // Tunggu activeJob bersih
  while (jm.activeJob) {
    await new Promise((r) => setTimeout(r, 10));
  }

  const types = events.map((e) => e.type);
  assert.ok(types.includes('selfie_cancelled'), 'Harus mengirim event selfie_cancelled');
  assert.equal(mockProv.cancelled(), true);
  assert.equal(mockProv.released(), true);
});

test('4. Penanganan Kegagalan / Error pada Generator (Failure Flow)', async (t) => {
  const jm = createTestManager(t);
  const mockProv = createMockProvider({ fail: true });
  jm.provider = mockProv;

  const events = [];
  jm.setBroadcaster((ev) => events.push(ev));

  const spoken = [];
  jm.setSpeechHandler((msg) => spoken.push(msg));

  const fakePlan = {
    slots: {},
    positivePrompt: 'A test selfie',
    negativePrompt: '',
    referenceImage: 'default.jpg',
    caption: 'Foto gagal',
    emotion: 'malu',
  };

  await jm.submitJob({ plan: fakePlan, preset: 'cepat' });

  while (jm.activeJob) {
    await new Promise((r) => setTimeout(r, 10));
  }

  const types = events.map((e) => e.type);
  assert.ok(types.includes('selfie_failed'), 'Harus mengirim event selfie_failed');
  assert.equal(mockProv.released(), true);

  // Avatar mengucapkan penyesalan in-character
  assert.equal(spoken.length, 2); // initial + failure phrase
  assert.ok(spoken[1].text.length > 5);
  assert.equal(spoken[1].emotion, 'malu');
});
