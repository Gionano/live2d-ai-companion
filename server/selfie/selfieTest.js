// ---------------------------------------------------------------------------
// selfieTest.js  (skrip uji Fase A)
//   npm run selfie:test --provider=comfyui --preset=cepat
// Menjalankan satu job dengan prompt default, mencetak durasi tiap tahap + lokasi file,
// dan menyimpan durasi untuk ETA (rata-rata 5 terakhir per preset).
// ---------------------------------------------------------------------------
import { loadSelfieConfig } from './config.js';
import { createImageProvider } from './imageProvider.js';
import { EtaStore } from './etaStore.js';

// `npm run x --provider=a` diteruskan npm sebagai env npm_config_*; dukung juga argv (--provider=a).
function arg(name) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=')[1] : process.env[`npm_config_${name}`];
}

const DEFAULT_POSITIVE =
  'Keep the character from the reference image exactly as is. Change only: pose to a casual selfie ' +
  'holding the camera, expression to a gentle smile, background to a cozy bedroom, soft warm lighting.';
const DEFAULT_NEGATIVE = 'blurry, low quality, deformed hands, extra fingers, watermark, text, nsfw';

const cfg = loadSelfieConfig({ provider: arg('provider'), preset: arg('preset') });
const preset = cfg.presets[cfg.preset];
const eta = new EtaStore(cfg);

console.log(`== selfie:test | provider=${cfg.provider} preset=${cfg.preset} (${JSON.stringify(preset)})`);
const prevEta = eta.estimateSeconds(cfg.preset);
console.log(`ETA dari riwayat: ${prevEta === null ? '(belum ada)' : `${prevEta}s`}`);

const provider = await createImageProvider(cfg);
if (typeof provider.init === 'function') {
  try {
    await provider.init();
  } catch (err) {
    console.error(`GAGAL init: ${err.message}`);
    process.exit(2);
  }
}
if (!(await provider.isAvailable())) {
  console.error(`Provider "${cfg.provider}" tidak tersedia (cek ${cfg.comfyUrl}).`);
  process.exit(3);
}

const ctl = new AbortController();
process.on('SIGINT', () => {
  console.log('\nDibatalkan (Ctrl+C)...');
  ctl.abort();
});

let lastPct = -1;
try {
  const result = await provider.generate(
    {
      positivePrompt: DEFAULT_POSITIVE,
      negativePrompt: DEFAULT_NEGATIVE,
      referenceImage: cfg.defaultReference,
      resolution: preset.resolution,
      steps: preset.steps,
    },
    ({ value, max }) => {
      const pct = Math.floor((value / max) * 100);
      if (pct !== lastPct && (pct % 25 === 0 || value === max)) {
        lastPct = pct;
        console.log(`  progres ${value}/${max} (${pct}%)`);
      }
    },
    ctl.signal,
  );
  eta.record(cfg.preset, result.timings.totalMs);
  console.log('\n== HASIL');
  console.log(`file     : ${result.imagePath}`);
  console.log(`seed     : ${result.seed}`);
  console.log(`antre    : ${result.timings.queueMs} ms`);
  console.log(`generate : ${result.timings.generateMs} ms`);
  console.log(`unduh    : ${result.timings.downloadMs} ms`);
  console.log(`total    : ${result.timings.totalMs} ms`);
  console.log(`ETA baru : ${eta.estimateSeconds(cfg.preset)}s (rata-rata ${cfg.etaHistorySize} terakhir)`);
} catch (err) {
  console.error(`\nGAGAL [${err.code ?? 'ERR'}]: ${err.message}`);
  process.exitCode = 1;
}
