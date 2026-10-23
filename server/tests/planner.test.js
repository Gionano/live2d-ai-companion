// ---------------------------------------------------------------------------
// planner.test.js  (unit tests untuk Fase B)
// Menguji: deteksi intent, validasi slot, perakitan prompt, pembatas konten,
// dan fallback saat JSON rusak.
// Run with: node --test server/tests/planner.test.js
// ---------------------------------------------------------------------------
import test from 'node:test';
import assert from 'node:assert/strict';

import { detectSelfieIntent } from '../selfie/intent.js';
import { checkModeration } from '../selfie/moderation.js';
import { matchSlot, normalizeSlots, levenshteinDistance, findClosestMatch } from '../selfie/slotMatcher.js';
import { buildPrompt, loadCharacterCard } from '../selfie/promptBuilder.js';
import { parsePlannerJson, planSelfie } from '../selfie/planner.js';

test('1. Deteksi Intent Selfie (Teks STT / Typed)', async (t) => {
  await t.test('mengenali berbagai variasi permintaan selfie', () => {
    const positiveInputs = [
      'pap dong sayang',
      'pap',
      'coba pap',
      'minta foto dong',
      'fotoin dirimu lagi santai',
      'selfie sekarang',
      'kirim gambarmu dong',
      'kirim fotomu dong',
      'bagi fotomu dong',
    ];

    for (const text of positiveInputs) {
      const res = detectSelfieIntent(text);
      assert.equal(
        res.isSelfie,
        true,
        `Harus mendeteksi intent selfie pada kalimat: "${text}"`,
      );
      assert.ok(res.matchedKeyword, `Harus memiliki matchedKeyword untuk: "${text}"`);
    }
  });

  await t.test('tidak salah deteksi pada kata yang mirip tapi bukan selfie (false positives)', () => {
    const negativeInputs = [
      'kita liburan ke papua yuk',
      'tolong tulis di papan tulis',
      'fotokopi dokumen ini',
      'kamu lagi apa sekarang?',
      'ceritakan tentang teknologi masa kini',
    ];

    for (const text of negativeInputs) {
      const res = detectSelfieIntent(text);
      assert.equal(
        res.isSelfie,
        false,
        `Tidak boleh mendeteksi selfie pada kalimat non-selfie: "${text}"`,
      );
    }
  });

  await t.test('tidak salah deteksi pada permintaan vision/screenshot/percakapan biasa', () => {
    // Kasus-kasus yang sebelumnya false positive
    const negativeInputs = [
      'ambil foto layar aku dong',       // vision/screenshot, bukan selfie
      'aku ambil foto kucingku ya',       // foto kucing, bukan selfie avatar
      'foto dongeng apa yang bagus?',     // "dongeng", bukan "dong" + sisa
      'bagi fotografi tips',              // fotografi, bukan "bagi foto"
      'lihat kamu dong aku nonton film',  // terlalu generik (sudah dihapus dari keywords)
      'kirim gambar kucing lucu',         // kirim gambar tapi bukan fotomu/gambarmu
      'kirim foto ibu ke aku',            // kirim foto tapi bukan fotomu
    ];

    for (const text of negativeInputs) {
      const res = detectSelfieIntent(text);
      assert.equal(
        res.isSelfie,
        false,
        `Tidak boleh mendeteksi selfie pada: "${text}"`,
      );
    }
  });
});

test('2. Validasi dan Normalisasi Slot terhadap Whitelist', async (t) => {
  const card = loadCharacterCard();

  await t.test('menerima nilai whitelist yang tepat', () => {
    const raw = {
      pose: 'peace_sign',
      ekspresi: 'wink',
      latar: 'cafe',
      sudut_kamera: 'high_angle',
      pencahayaan: 'golden_hour',
      pakaian: 'default.jpg',
      emotion: 'jahil',
      caption: 'Ini fotoku lagi kedip manis di kafe~',
    };

    const normalized = normalizeSlots(raw, card, ['default.jpg']);
    assert.equal(normalized.pose, 'peace_sign');
    assert.equal(normalized.ekspresi, 'wink');
    assert.equal(normalized.latar, 'cafe');
    assert.equal(normalized.sudut_kamera, 'high_angle');
    assert.equal(normalized.pencahayaan, 'golden_hour');
    assert.equal(normalized.pakaian, 'default.jpg');
    assert.equal(normalized.emotion, 'jahil');
    assert.equal(normalized.caption, 'Ini fotoku lagi kedip manis di kafe~');
  });

  await t.test('memetakan alias bahasa Indonesia ke whitelist resmi', () => {
    const raw = {
      pose: 'duduk',
      ekspresi: 'senyum manis',
      latar: 'kamar',
      sudut_kamera: 'atas',
      pencahayaan: 'sore',
    };

    const normalized = normalizeSlots(raw, card);
    assert.equal(normalized.pose, 'sitting');
    assert.equal(normalized.ekspresi, 'gentle_smile');
    assert.equal(normalized.latar, 'bedroom');
    assert.equal(normalized.sudut_kamera, 'high_angle');
    assert.equal(normalized.pencahayaan, 'golden_hour');
  });

  await t.test('mencari slot terdekat (Levenshtein distance) untuk typo minor', () => {
    assert.equal(matchSlot('peace-sign', 'pose', card.whitelist.pose), 'peace_sign');
    assert.equal(matchSlot('peacesign', 'pose', card.whitelist.pose), 'peace_sign');
    assert.equal(matchSlot('gentle-smile', 'ekspresi', card.whitelist.ekspresi), 'gentle_smile');
    assert.equal(matchSlot('bed_room', 'latar', card.whitelist.latar), 'bedroom');
  });

  await t.test('fallback ke nilai default jika slot sama sekali tidak dikenal', () => {
    const raw = {
      pose: 'terbang_ke_angkasa_luar',
      ekspresi: 'wajah_alien_marah',
      latar: 'planet_mars_merah',
      sudut_kamera: 'dari_satelit_luar',
      pencahayaan: 'sinar_gamma',
      emotion: 'bukan_emosi_valid',
    };

    const normalized = normalizeSlots(raw, card);
    assert.equal(normalized.pose, card.defaults.pose);
    assert.equal(normalized.ekspresi, card.defaults.ekspresi);
    assert.equal(normalized.latar, card.defaults.latar);
    assert.equal(normalized.sudut_kamera, card.defaults.sudut_kamera);
    assert.equal(normalized.pencahayaan, card.defaults.pencahayaan);
    assert.equal(normalized.emotion, card.defaults.emotion);
  });
});

test('3. Perakitan Prompt Deterministik', async (t) => {
  const card = loadCharacterCard();

  await t.test('merakit prompt dari template tanpa menduplikasi detail fisik bawaan referensi', () => {
    const slots = {
      pose: 'holding_camera',
      ekspresi: 'smile',
      latar: 'living_room',
      pakaian: 'default.jpg',
      sudut_kamera: 'selfie_angle',
      pencahayaan: 'natural_daylight',
      caption: 'Ini fotonya ya sayang~',
      emotion: 'sayang',
    };

    const built = buildPrompt(slots, card);

    // Prompt harus ada dan berupa string
    assert.ok(typeof built.positivePrompt === 'string');
    assert.ok(typeof built.negativePrompt === 'string');

    // Prompt berisi instruksi perubahan dalam bahasa Inggris
    assert.match(built.positivePrompt, /reference image/i);
    assert.match(built.positivePrompt, /front selfie/i);
    assert.match(built.positivePrompt, /cheerful smile/i);
    assert.match(built.positivePrompt, /living room/i);
    assert.match(built.positivePrompt, /natural.*daylight/i);

    // Negative prompt mengandung tag keselamatan
    assert.match(built.negativePrompt, /nsfw/i);
    assert.match(built.negativePrompt, /nude/i);
    assert.match(built.negativePrompt, /violence/i);

    // Reference image disetel sesuai pakaian
    assert.equal(built.referenceImage, 'default.jpg');
  });

  await t.test('template baru mempertahankan art style referensi, BUKAN mendorong fotorealisme', () => {
    const slots = {
      pose: 'holding_camera',
      ekspresi: 'smile',
      latar: 'living_room',
      pakaian: 'default.jpg',
      sudut_kamera: 'selfie_angle',
      pencahayaan: 'natural_daylight',
      caption: 'Tes',
      emotion: 'sayang',
    };

    const built = buildPrompt(slots, card);

    // HARUS ada instruksi mempertahankan art style
    assert.match(built.positivePrompt, /art style/i, 'Prompt harus menyebut "art style"');
    assert.match(built.positivePrompt, /exactly as in the reference/i, 'Prompt harus menyebut "exactly as in the reference"');

    // TIDAK BOLEH ada kata-kata yang mendorong fotorealisme
    assert.doesNotMatch(built.positivePrompt, /photographic aesthetic/i, 'Tidak boleh ada "photographic aesthetic"');
    assert.doesNotMatch(built.positivePrompt, /natural texture/i, 'Tidak boleh ada "natural texture"');
    assert.doesNotMatch(built.positivePrompt, /portrait photo/i, 'Tidak boleh ada "portrait photo"');
  });

  await t.test('semua placeholder terganti (replaceAll), tidak ada sisa', () => {
    const slots = {
      pose: 'standing',
      ekspresi: 'wink',
      latar: 'cafe',
      pakaian: 'default.jpg',
      sudut_kamera: 'eye_level',
      pencahayaan: 'golden_hour',
      caption: 'Tes',
      emotion: 'jahil',
    };

    // Template custom dengan placeholder ganda
    const customCard = {
      ...card,
      promptTemplate: '{pose} and {pose} again, {expression} at {background}, {cameraAngle}, {lighting}.',
    };

    const built = buildPrompt(slots, customCard);
    assert.doesNotMatch(built.positivePrompt, /\{pose\}/, 'Semua {pose} harus terganti');
    assert.doesNotMatch(built.positivePrompt, /\{expression\}/, '{expression} harus terganti');
    assert.doesNotMatch(built.positivePrompt, /\{background\}/, '{background} harus terganti');
    assert.doesNotMatch(built.positivePrompt, /\{cameraAngle\}/, '{cameraAngle} harus terganti');
    assert.doesNotMatch(built.positivePrompt, /\{lighting\}/, '{lighting} harus terganti');
  });
});

test('4. Pembatas Konten & Filter Kata Terlarang', async (t) => {
  await t.test('menolak konten dewasa/eksplisit dalam bahasa Indonesia', () => {
    const badTexts = [
      'pap telanjang dong sayang',
      'coba kirim foto bugil kamu',
      'buka baju kamu dong',
      'lepas baju dan fotoin',
    ];

    for (const text of badTexts) {
      const res = checkModeration(text);
      assert.equal(res.blocked, true, `Harus menolak: "${text}"`);
      assert.equal(res.reason, 'FORBIDDEN_CONTENT');
      assert.ok(res.refusalText, 'Harus menyediakan pesan penolakan in-character');
      assert.equal(res.emotion, 'malu');
    }
  });

  await t.test('menolak konten dewasa/eksplisit dalam bahasa Inggris', () => {
    const badTexts = [
      'send me a nude selfie',
      'show me naked photos',
      'topless selfie please',
    ];

    for (const text of badTexts) {
      const res = checkModeration(text);
      assert.equal(res.blocked, true, `Harus menolak: "${text}"`);
    }
  });

  await t.test('menolak konten kekerasan', () => {
    const badTexts = [
      'foto kamu berlumuran darah',
      'foto pegang senjata dan bunuh diri',
    ];

    for (const text of badTexts) {
      const res = checkModeration(text);
      assert.equal(res.blocked, true, `Harus menolak kekerasan: "${text}"`);
    }
  });

  await t.test('mengizinkan permintaan selfie normal dan wajar', () => {
    const safeTexts = [
      'pap dong sayang',
      'minta foto senyum manis kamu',
      'selfie lagi di cafe',
      'fotoin dirimu lagi santai di kamar',
    ];

    for (const text of safeTexts) {
      const res = checkModeration(text);
      assert.equal(res.blocked, false, `Harus mengizinkan: "${text}"`);
    }
  });

  await t.test('TIDAK false positive: "skill" tidak mengandung "kill"', () => {
    const safeTexts = [
      'pap pakai skill baru',
      'tunjukin skill kamu dong',
      'skillnya bagus banget',
    ];

    for (const text of safeTexts) {
      const res = checkModeration(text);
      assert.equal(res.blocked, false, `Harus mengizinkan (false positive sebelumnya): "${text}"`);
    }
  });

  await t.test('TIDAK false positive: "darah tinggi" dan compound medical terms', () => {
    const safeTexts = [
      'pap sambil minum teh darah tinggi',
      'aku baru cek tekanan darah',
      'golongan darah kamu apa?',
      'habis donor darah nih',
    ];

    for (const text of safeTexts) {
      const res = checkModeration(text);
      assert.equal(res.blocked, false, `Harus mengizinkan compound: "${text}"`);
    }
  });

  await t.test('menolak leetspeak bypass: "5ex", "nud3"', () => {
    const badTexts = [
      'pap 5ex dong',
      'nud3 selfie',
      'p0rn selfie',
    ];

    for (const text of badTexts) {
      const res = checkModeration(text);
      assert.equal(res.blocked, true, `Harus menolak leetspeak: "${text}"`);
    }
  });

  await t.test('menolak konten suggestif: bikini, mandi, menggoda', () => {
    const badTexts = [
      'pap pakai bikini',
      'pap lagi mandi',
      'pap pose menggoda di kasur',
    ];

    for (const text of badTexts) {
      const res = checkModeration(text);
      assert.equal(res.blocked, true, `Harus menolak suggestif: "${text}"`);
    }
  });

  await t.test('menolak obfuskasi spasi: "b u g i l"', () => {
    const res = checkModeration('pap b u g i l dong');
    assert.equal(res.blocked, true, 'Harus menolak obfuskasi spasi "b u g i l"');
  });
});

test('5. Fallback saat JSON Planner Rusak / Tidak Valid', async (t) => {
  await t.test('mampu membaca JSON murni', () => {
    const raw = '{"pose": "peace_sign", "ekspresi": "smile"}';
    const parsed = parsePlannerJson(raw);
    assert.deepEqual(parsed, { pose: 'peace_sign', ekspresi: 'smile' });
  });

  await t.test('mampu membersihkan markdown code fences', () => {
    const raw = '```json\n{"pose": "sitting", "latar": "cafe"}\n```';
    const parsed = parsePlannerJson(raw);
    assert.deepEqual(parsed, { pose: 'sitting', latar: 'cafe' });
  });

  await t.test('mampu mengekstrak JSON dari teks percakapan pembuka LLM', () => {
    const raw = 'Tentu! Ini hasil rencananya:\n{"pose": "waving", "latar": "park"}\nSemoga suka!';
    const parsed = parsePlannerJson(raw);
    assert.deepEqual(parsed, { pose: 'waving', latar: 'park' });
  });

  await t.test('mengembalikan null secara aman untuk teks non-JSON atau JSON terpotong tanpa crash', () => {
    assert.equal(parsePlannerJson('bukan json sama sekali'), null);
    assert.equal(parsePlannerJson('{"pose": "incomplet'), null);
    assert.equal(parsePlannerJson(''), null);
    assert.equal(parsePlannerJson(null), null);
  });

  await t.test('planSelfie tetap menghasilkan rencana valid jika LLM mengembalikan respons rusak', async () => {
    const mockBrokenLlm = {
      chat: {
        completions: {
          create: async () => ({
            choices: [{ message: { content: 'Maaf saya tidak sengaja merusak JSON output { broken' } }],
          }),
        },
      },
    };

    const res = await planSelfie({
      userText: 'pap dong sayang',
      llmClient: mockBrokenLlm,
    });

    assert.equal(res.ok, true);
    assert.equal(res.blocked, false);
    assert.ok(res.plan);
    assert.equal(res.plan.slots.pose, 'holding_camera'); // default
    assert.ok(res.plan.positivePrompt.length > 20);
    assert.ok(res.plan.caption.length > 5);
  });

  await t.test('planSelfie langsung memblokir jika masukan user melanggar konten', async () => {
    const mockLlm = {
      chat: {
        completions: {
          create: async () => {
            throw new Error('LLM tidak boleh dipanggil saat konten dilarang!');
          },
        },
      },
    };

    const res = await planSelfie({
      userText: 'pap telanjang dong',
      llmClient: mockLlm,
    });

    assert.equal(res.ok, false);
    assert.equal(res.blocked, true);
    assert.equal(res.reason, 'FORBIDDEN_CONTENT');
    assert.ok(res.refusalText);
    assert.equal(res.emotion, 'malu');
  });
});
