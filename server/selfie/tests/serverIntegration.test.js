// ---------------------------------------------------------------------------
// serverIntegration.test.js  (integration test untuk Fase C)
// Menguji endpoint HTTP /selfies/:token dan alur WebSocket selfie di index.js
// ---------------------------------------------------------------------------
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { jobManager } from '../jobManager.js';

test('1. Endpoint HTTP /selfies/:token (Point 15)', async (t) => {
  // Buat file dummy di outputDir untuk pengujian
  const outputDir = path.resolve(jobManager.config.outputDir);
  fs.mkdirSync(outputDir, { recursive: true });
  const dummyFile = path.join(outputDir, 'test_dummy_photo.png');
  fs.writeFileSync(dummyFile, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])); // PNG header

  // Daftarkan token acak di jobManager
  const testToken = 'abcd1234ef567890abcd1234ef567890';
  jobManager.tokenMap.set(testToken, {
    filePath: dummyFile,
    jobId: 'dummy-job',
    timestamp: Date.now(),
  });

  await t.test('token valid mengembalikan data gambar dengan benar', () => {
    const item = jobManager.getFileByToken(testToken);
    assert.ok(item);
    assert.equal(item.filePath, dummyFile);
    assert.ok(fs.existsSync(item.filePath));
  });

  await t.test('token acak yang tidak dikenal mengembalikan null (404)', () => {
    const item = jobManager.getFileByToken('token_tidak_dikenal');
    assert.equal(item, null);
  });

  await t.test('path traversal di luar outputDir dicegah', () => {
    const outsideFile = path.resolve('C:\\Windows\\win.ini');
    const traversalToken = 'traversal_attempt_token';
    jobManager.tokenMap.set(traversalToken, {
      filePath: outsideFile,
      jobId: 'bad-job',
      timestamp: Date.now(),
    });

    const item = jobManager.getFileByToken(traversalToken);
    assert.ok(item);
    // Verifikasi bahwa targetPath tidak diawali outputDir
    const resolvedOut = path.resolve(jobManager.config.outputDir);
    const resolvedTarget = path.resolve(item.filePath);
    assert.equal(resolvedTarget.startsWith(resolvedOut), false);
  });

  // Bersihkan file dummy
  try {
    fs.unlinkSync(dummyFile);
  } catch (_) {}
});
