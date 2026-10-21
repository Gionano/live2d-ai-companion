// ---------------------------------------------------------------------------
// planner.js  (server-side, modul selfie / pap)
// Perencana adegan selfie menggunakan LLM Cloud (Experiential Labs).
// LLM HANYA memilih slot dari whitelist berformat JSON ketat, DILARANG menulis prompt bebas.
// Hasil slot dinormalisasi, dicek pembatas konten, dan dirakit deterministik menjadi prompt gambar.
// ---------------------------------------------------------------------------
import fs from 'node:fs';
import path from 'node:path';
import { explabs } from '../experientialClient.js';
import { CHAT_MODEL } from '../modelConfig.js';
import { loadSelfieConfig } from './config.js';
import { checkModeration } from './moderation.js';
import { normalizeSlots } from './slotMatcher.js';
import { buildPrompt, loadCharacterCard } from './promptBuilder.js';
import { logSelfie } from './log.js';

/**
 * Scan folder referenceDir untuk mendapatkan daftar file gambar yang valid.
 */
export function getAvailableReferences(referenceDir) {
  try {
    if (!fs.existsSync(referenceDir)) return ['default.jpg'];
    const entries = fs.readdirSync(referenceDir);
    const valid = entries.filter((f) => /\.(jpg|jpeg|png|webp)$/i.test(f));
    return valid.length > 0 ? valid : ['default.jpg'];
  } catch {
    return ['default.jpg'];
  }
}

/**
 * Parsing JSON dari output LLM dengan ketahanan terhadap markdown fences atau teks sekitar.
 */
export function parsePlannerJson(rawText) {
  if (!rawText || typeof rawText !== 'string') return null;

  let text = rawText.trim();

  // Bersihkan markdown code fences ```json ... ```
  if (text.startsWith('```')) {
    text = text.replace(/^```[a-zA-Z]*\n?/, '').replace(/\n?```$/, '').trim();
  }

  // Coba parse langsung
  try {
    const obj = JSON.parse(text);
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) return obj;
  } catch (_) {}

  // Coba ekstrak substring {...} pertama
  const firstBrace = text.indexOf('{');
  const lastBrace = text.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    try {
      const sub = text.slice(firstBrace, lastBrace + 1);
      const obj = JSON.parse(sub);
      if (obj && typeof obj === 'object' && !Array.isArray(obj)) return obj;
    } catch (_) {}
  }

  return null;
}

/**
 * Buat system prompt untuk Planner LLM Cloud.
 */
function buildPlannerSystemPrompt(characterCard, availableReferences) {
  const wl = characterCard.whitelist || {};
  const poseList = Object.keys(wl.pose || {}).join(', ');
  const exprList = Object.keys(wl.ekspresi || {}).join(', ');
  const bgList = Object.keys(wl.latar || {}).join(', ');
  const angleList = Object.keys(wl.sudut_kamera || {}).join(', ');
  const lightList = Object.keys(wl.pencahayaan || {}).join(', ');
  const outfitList = availableReferences.join(', ');
  const emotionList = Array.isArray(wl.emotion) ? wl.emotion.join(', ') : 'sayang, netral, malu, jahil';

  return `
You are the Selfie Scene Planner for Amika (a loving, playful AI companion/wife).
The user asked for a photo/selfie ("pap").
Your task is to select scene slots for the local image generator based on the user's request and mood.

STRICT CONSTRAINTS:
1. You are FORBIDDEN from writing arbitrary or free-form image prompts.
2. You MUST select slot values ONLY from the exact whitelist options listed below:
   - pose: [${poseList}]
   - ekspresi: [${exprList}]
   - latar: [${bgList}]
   - pakaian: [${outfitList}]
   - sudut_kamera: [${angleList}]
   - pencahayaan: [${lightList}]
   - emotion: [${emotionList}]
3. You must compose an affectionate "caption" (1-2 short sentences in Indonesian, natural wife tone, sweet and loving) that Amika speaks when sending this photo to her husband.
4. Output MUST be a single valid JSON object, without markdown, exactly matching this structure:
{
  "pose": "...",
  "ekspresi": "...",
  "latar": "...",
  "pakaian": "...",
  "sudut_kamera": "...",
  "pencahayaan": "...",
  "caption": "...",
  "emotion": "..."
}
`.trim();
}

/**
 * Rencanakan adegan selfie (Planner Fase B).
 * @param {object} params
 * @param {string} params.userText - Permintaan user ("pap dong", "minta foto kamu lagi senyum", dll)
 * @param {Array} [params.history] - Riwayat percakapan sebelumnya (opsional)
 * @param {object} [params.config] - Konfigurasi selfie
 * @param {object} [params.llmClient] - OpenAI-compatible client (default: explabs)
 * @returns {Promise<{ ok: boolean, blocked?: boolean, reason?: string, refusalText?: string, emotion?: string, plan?: object }>}
 */
export async function planSelfie({
  userText,
  history = [],
  config = null,
  llmClient = explabs,
}) {
  const cfg = config || loadSelfieConfig();
  const t0 = performance.now();

  // 1. Pembatas konten pada teks permintaan user
  const userMod = checkModeration(userText, { config: cfg });
  if (userMod.blocked) {
    logSelfie(
      `[planner] Permintaan user ditolak oleh filter konten: "${userMod.matchedWord}"`,
      'warn',
    );
    return {
      ok: false,
      blocked: true,
      reason: userMod.reason,
      matchedWord: userMod.matchedWord,
      refusalText: userMod.refusalText,
      emotion: userMod.emotion,
    };
  }

  // 2. Muat characterCard & daftar file referensi yang ada
  const card = loadCharacterCard(cfg.characterCardPath);
  const availableRefs = getAvailableReferences(cfg.referenceDir);

  // 3. Panggil LLM Cloud dengan skema JSON ketat
  const systemPrompt = buildPlannerSystemPrompt(card, availableRefs);
  const userContent = userText ? `Permintaan user: "${userText}"` : 'User meminta foto selfie santai.';

  // Siapkan pesan percakapan singkat untuk konteks (ambil 2 turn terakhir jika ada)
  const contextMessages = [];
  if (Array.isArray(history) && history.length > 0) {
    const recent = history.slice(-2);
    for (const h of recent) {
      if (h.role && h.content) {
        contextMessages.push({ role: h.role, content: String(h.content).slice(0, 300) });
      }
    }
  }

  const messages = [
    { role: 'system', content: systemPrompt },
    ...contextMessages,
    { role: 'user', content: userContent },
  ];

  let rawJson = null;
  let rawResponseText = '';

  try {
    const timeoutMs = cfg.plannerTimeoutMs || 20000;
    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);

    const completion = await llmClient.chat.completions.create(
      {
        model: CHAT_MODEL,
        messages,
        temperature: 0.3,
      },
      { signal: controller.signal },
    );
    clearTimeout(timeoutHandle);

    rawResponseText = completion?.choices?.[0]?.message?.content || '';
    rawJson = parsePlannerJson(rawResponseText);
    const durationMs = Math.round(performance.now() - t0);
    logSelfie(`[planner] Respons LLM diterima dalam ${durationMs}ms`);
  } catch (err) {
    logSelfie(`[planner] Gagal memanggil LLM Cloud (${err.message}); menggunakan default slot`, 'warn');
    rawJson = null; // trigger fallback
  }

  // 4. Normalisasi slot terhadap whitelist (otomatis fallback ke default jika JSON rusak atau nilai di luar whitelist)
  const normalizedSlots = normalizeSlots(rawJson, card, availableRefs);

  // 5. Susun prompt deterministik dari template
  const promptData = buildPrompt(normalizedSlots, card, cfg);

  // 6. Pembatas konten pada prompt akhir yang telah disusun
  const promptMod = checkModeration(promptData.positivePrompt, { config: cfg });
  if (promptMod.blocked) {
    logSelfie(
      `[planner] Prompt akhir memicu pembatas konten: "${promptMod.matchedWord}"`,
      'warn',
    );
    return {
      ok: false,
      blocked: true,
      reason: promptMod.reason,
      matchedWord: promptMod.matchedWord,
      refusalText: promptMod.refusalText,
      emotion: promptMod.emotion,
    };
  }

  const totalDurationMs = Math.round(performance.now() - t0);
  logSelfie(
    `[planner] Sukses menyusun adegan dalam ${totalDurationMs}ms (pose: ${normalizedSlots.pose}, latar: ${normalizedSlots.latar}, ref: ${promptData.referenceImage})`,
  );

  return {
    ok: true,
    blocked: false,
    durationMs: totalDurationMs,
    plan: {
      slots: normalizedSlots,
      positivePrompt: promptData.positivePrompt,
      negativePrompt: promptData.negativePrompt,
      referenceImage: promptData.referenceImage,
      caption: normalizedSlots.caption,
      emotion: normalizedSlots.emotion,
    },
  };
}
