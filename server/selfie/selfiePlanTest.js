// ---------------------------------------------------------------------------
// selfiePlanTest.js
// Skrip verifikasi live Cloud LLM Planner (Experiential Labs).
// Uji: node server/selfie/selfiePlanTest.js "pap dong sayang, lagi santai di cafe"
// ---------------------------------------------------------------------------
import 'dotenv/config';
import { planSelfie } from './planner.js';

const userPrompt = process.argv[2] || 'pap dong sayang lagi senyum manis di kafe';

console.log('=== UJI LIVE CLOUD LLM PLANNER ===');
console.log(`Input user: "${userPrompt}"`);

try {
  const t0 = performance.now();
  const res = await planSelfie({ userText: userPrompt });
  const totalMs = Math.round(performance.now() - t0);

  console.log(`\nStatus: ${res.ok ? 'SUKSES' : 'DITOLAK / GAGAL'}`);
  console.log(`Durasi total: ${totalMs}ms`);

  if (!res.ok) {
    console.log(`Alasan: ${res.reason}`);
    console.log(`Ucapan penolakan: "${res.refusalText}" (emosi: ${res.emotion})`);
  } else {
    console.log('\n--- Slot Terpilih (Whitelist) ---');
    console.log(JSON.stringify(res.plan.slots, null, 2));

    console.log('\n--- Caption Avatar ---');
    console.log(`"${res.plan.caption}" (emosi: ${res.plan.emotion})`);

    console.log('\n--- Positive Prompt (Deterministik) ---');
    console.log(res.plan.positivePrompt);

    console.log('\n--- Negative Prompt ---');
    console.log(res.plan.negativePrompt);

    console.log('\n--- Reference Image ---');
    console.log(res.plan.referenceImage);
  }
} catch (err) {
  console.error('Error saat menjalankan live planner:', err);
  process.exit(1);
}
