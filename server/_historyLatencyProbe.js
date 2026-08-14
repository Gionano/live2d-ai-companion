// Diagnostic: warm both models, then run a real five-turn conversation while
// accumulating history. Usage: node server/_historyLatencyProbe.js [runs]
import { generateReply } from './llmChat.js';
import { warmUpModels } from './modelWarmup.js';

const prompts = [
  'Jawab singkat: sebutkan satu warna yang kamu suka.',
  'Kenapa kamu memilih warna itu? Jawab satu kalimat.',
  'Sebutkan satu makanan yang cocok dengan suasana warna itu.',
  'Kalau kita menikmatinya bersama, tempat seperti apa yang cocok?',
  'Ringkas percakapan kita sejauh ini dalam satu kalimat pendek.',
];
const runs = Math.max(1, Math.min(Number(process.argv[2] || 5), prompts.length));
const history = [];
const results = [];

console.log('[history-probe] confirming startup-style warm-up responses...');
const warmupResults = await warmUpModels();
if (warmupResults.some((result) => result.status === 'rejected')) {
  console.warn('[history-probe] one or more warm-ups failed; continuing probe');
}

for (let i = 0; i < runs; i++) {
  const startedAt = performance.now();
  let firstTokenAt = 0;
  let reply = '';

  try {
    for await (const event of generateReply(history, prompts[i], null)) {
      if (event.type !== 'delta') continue;
      if (!firstTokenAt) firstTokenAt = performance.now();
      reply += event.text;
    }
    const finishedAt = performance.now();
    const ttft = Math.round(firstTokenAt - startedAt);
    results.push({ turn: i + 1, historyMessages: history.length, ttft });
    console.log(
      `[history-probe #${i + 1}] history=${history.length} messages` +
        ` | ttft=${ttft}ms | total=${Math.round(finishedAt - startedAt)}ms` +
        ` | reply=${reply.length} chars`,
    );
    history.push({ role: 'user', content: prompts[i] });
    history.push({ role: 'assistant', content: reply });
  } catch (error) {
    console.error(`[history-probe #${i + 1}] failed: ${error.message}`);
  }
}

if (results.length >= 2) {
  const xs = results.map((r) => r.historyMessages);
  const ys = results.map((r) => r.ttft);
  const mean = (values) => values.reduce((a, b) => a + b, 0) / values.length;
  const mx = mean(xs);
  const my = mean(ys);
  const numerator = xs.reduce((sum, x, i) => sum + (x - mx) * (ys[i] - my), 0);
  const denominator = Math.sqrt(
    xs.reduce((sum, x) => sum + (x - mx) ** 2, 0) *
      ys.reduce((sum, y) => sum + (y - my) ** 2, 0),
  );
  const correlation = denominator ? numerator / denominator : 0;
  console.log(`[history-probe] Pearson r(history messages, TTFT)=${correlation.toFixed(3)}`);
}
