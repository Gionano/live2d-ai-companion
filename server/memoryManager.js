// ---------------------------------------------------------------------------
// memoryManager.js  (server-side)
// Sistem Memori Jangka Panjang (Long-Term Memory) & Episodic Conversation Recall
// untuk Amika.
//
// Fitur:
// 1. Profil & Fakta Permanen: Preferensi, kebiasaan, nama, dan detail user.
// 2. Episodic Recall: Ringkasan topik percakapan dari hari/sesi sebelumnya.
// 3. Time-Awareness: Mengetahui berapa lama jeda sejak percakapan terakhir
//    (misal: 10 menit lalu vs 3 hari lalu) untuk sambutan yang kontekstual.
// 4. Non-Blocking Background Extraction: Ekstraksi fakta baru berjalan di
//    latar belakang setelah respons selesai dikirim, sehingga TTFT tetap 0ms delay.
// 5. Penyimpanan Persisten JSON: Disimpan di data/memory.json.
// ---------------------------------------------------------------------------
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { explabs } from './experientialClient.js';
import { CHAT_MODEL } from './modelConfig.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = path.resolve(__dirname, '../data');
const MEMORY_FILE = path.resolve(DATA_DIR, 'memory.json');

const MAX_FACTS = 40;
const MAX_EPISODES = 20;

const DEFAULT_MEMORY = {
  version: 1,
  lastSeen: null,
  profile: {
    userName: '',
    nickname: 'sayang',
    facts: [],
  },
  episodes: [],
};

class MemoryManager {
  constructor() {
    this.memory = { ...DEFAULT_MEMORY };
    this.isExtracting = false;
    this.init();
  }

  init() {
    try {
      if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
      }
      if (fs.existsSync(MEMORY_FILE)) {
        const raw = fs.readFileSync(MEMORY_FILE, 'utf-8');
        const parsed = JSON.parse(raw);
        this.memory = {
          ...DEFAULT_MEMORY,
          ...parsed,
          profile: { ...DEFAULT_MEMORY.profile, ...(parsed.profile || {}) },
          episodes: Array.isArray(parsed.episodes) ? parsed.episodes : [],
        };
      } else {
        this.save();
      }
    } catch (err) {
      console.error('[memory] Gagal memuat memory.json, menggunakan default:', err.message);
      this.memory = { ...DEFAULT_MEMORY };
    }
  }

  save() {
    try {
      if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
      }
      fs.writeFileSync(MEMORY_FILE, JSON.stringify(this.memory, null, 2), 'utf-8');
    } catch (err) {
      console.error('[memory] Gagal menyimpan memory.json:', err.message);
    }
  }

  // Hitung selisih waktu secara deskriptif dalam Bahasa Indonesia
  formatTimeElapsed(lastTimestamp) {
    if (!lastTimestamp) return 'Ini adalah percakapan pertama kali bersama suami.';
    const diffMs = Date.now() - Number(lastTimestamp);
    if (diffMs < 0) return 'Baru saja mengobrol beberapa saat lalu.';

    const diffSec = Math.floor(diffMs / 1000);
    const diffMin = Math.floor(diffSec / 60);
    const diffHours = Math.floor(diffMin / 60);
    const diffDays = Math.floor(diffHours / 24);

    if (diffMin < 2) return 'Baru saja mengobrol beberapa detik lalu.';
    if (diffMin < 60) return `Terakhir mengobrol ${diffMin} menit yang lalu.`;
    if (diffHours < 24) return `Terakhir mengobrol sekitar ${diffHours} jam yang lalu.`;
    if (diffDays === 1) return 'Terakhir mengobrol kemarin.';
    if (diffDays < 7) return `Terakhir mengobrol ${diffDays} hari yang lalu.`;
    return `Terakhir mengobrol pada ${new Date(lastTimestamp).toLocaleDateString('id-ID', {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    })}.`;
  }

  // Dapatkan blok memori untuk disuntikkan ke system prompt Amika
  getMemoryPrompt() {
    const timeInfo = this.formatTimeElapsed(this.memory.lastSeen);
    const facts = this.memory.profile.facts || [];
    const episodes = this.memory.episodes || [];

    const lines = [
      '### [MEMORI JANGKA PANJANG & PENGALAMAN BERSAMA SUAMI]',
      `- Riwayat waktu interaksi: ${timeInfo}`,
    ];

    if (this.memory.profile.userName) {
      lines.push(`- Nama suami: ${this.memory.profile.userName}`);
    }

    if (facts.length > 0) {
      lines.push('- Fakta penting tentang suami yang kamu ingat:');
      for (const fact of facts.slice(-15)) {
        lines.push(`  * ${fact.text || fact}`);
      }
    }

    if (episodes.length > 0) {
      lines.push('- Catatan peristiwa & percakapan sebelumnya:');
      for (const ep of episodes.slice(-5)) {
        lines.push(`  * [${ep.date || 'Sesi lampau'}] ${ep.summary}`);
      }
    }

    lines.push(
      'Aturan ingatan:\n' +
        '- Jadikan memori di atas sebagai bekal keintiman emosional alami seolah kamu benar-benar mengingat kehidupan kalian bersama.\n' +
        '- Kalau jeda percakapan lama (misal berjam-jam atau berhari-hari), sapa dengan rasa rindu. Kalau jedanya baru semenit lalu, jangan menyapa seperti baru ketemu seharian.\n' +
        '- JANGAN PERNAH mengucapkan kata kaku seperti "Berdasarkan memoriku", "Menurut dataku", atau "Catatan saya". Bicaralah mengalir seperti istri biasa.',
    );

    return lines.join('\n');
  }

  // Tambah fakta manual atau dari ekstraksi
  addFact(factText, category = 'general') {
    if (!factText || typeof factText !== 'string') return;
    const text = factText.trim();
    if (text.length < 3) return;

    const facts = this.memory.profile.facts;
    // Cek duplikasi teks yang serupa
    const lower = text.toLowerCase();
    const alreadyExists = facts.some(
      (f) => (f.text || f).toLowerCase() === lower || lower.includes((f.text || f).toLowerCase()),
    );
    if (alreadyExists) return;

    facts.push({
      id: 'fact_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
      text,
      category,
      createdAt: new Date().toISOString(),
    });

    if (facts.length > MAX_FACTS) {
      facts.splice(0, facts.length - MAX_FACTS);
    }
    this.save();
    console.log(`[memory] Fakta baru diingat: "${text}"`);
  }

  // Tambah ringkasan episode percakapan
  addEpisode(summary, topic = '') {
    if (!summary || typeof summary !== 'string') return;
    const text = summary.trim();
    if (text.length < 5) return;

    const now = new Date();
    const dateStr = now.toLocaleDateString('id-ID', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
    });

    this.memory.episodes.push({
      id: 'ep_' + Date.now(),
      timestamp: Date.now(),
      date: dateStr,
      topic: topic || '',
      summary: text,
    });

    if (this.memory.episodes.length > MAX_EPISODES) {
      this.memory.episodes.splice(0, this.memory.episodes.length - MAX_EPISODES);
    }
    this.save();
    console.log(`[memory] Episode baru dicatat: "[${dateStr}] ${text}"`);
  }

  updateLastSeen() {
    this.memory.lastSeen = Date.now();
    this.save();
  }

  clearMemory() {
    this.memory = { ...DEFAULT_MEMORY, lastSeen: Date.now() };
    this.save();
    console.log('[memory] Memori telah di-reset ke kondisi awal.');
  }

  // Ekstraksi memori di latar belakang secara cerdas (Fire & Forget, non-blocking)
  async recordTurnAndExtract(userText, assistantText) {
    this.updateLastSeen();

    if (!userText || userText.length < 5) return;
    if (this.isExtracting) return;

    // Filter pesan singkat umum yang tidak perlu ekstraksi LLM
    const lower = userText.toLowerCase().trim();
    const isTrivial =
      /^(halo|hai|pagi|siang|malam|tes|test|oke|iya|nggak|apa kabar|lagi ngapain|ehem|haha|hehe)\b/i.test(
        lower,
      ) && lower.length < 25;
    if (isTrivial) return;

    this.isExtracting = true;
    try {
      const extractionPrompt = `
Kamu adalah modul ekstraksi memori jangka panjang untuk AI istri "Amika".
Analisis giliran percakapan berikut:
Suami: "${userText}"
Amika: "${assistantText}"

Tugas:
1. Ekstrak apakah ada fakta baru atau preferensi pribadi tentang Suami (nama, kesukaan, makanan/minuman favorit, kebiasaan, pekerjaan/kegiatan, hal yang dibenci, kondisi emosi/fisik penting).
2. Jika ada peristiwa, cerita, atau topik percakapan yang layak diingat sebagai sebuah "Episode/Momen", buatkan 1 kalimat ringkasan padatnya.
3. Jika hanya obrolan basa-basi atau tidak ada informasi baru yang penting, kembalikan fakta kosong.

Kembalikan tepat satu JSON valid tanpa blok markdown:
{
  "hasNewInfo": true atau false,
  "newFacts": ["fakta spesifik 1", ...],
  "episodeSummary": "1 kalimat ringkasan momen penting (atau null jika obrolan biasa)"
}
`.trim();

      const response = await explabs.chat.completions.create({
        model: CHAT_MODEL,
        messages: [{ role: 'user', content: extractionPrompt }],
        temperature: 0.1,
        max_tokens: 250,
        response_format: { type: 'json_object' },
        reasoning_effort: 'none',
      });

      const raw = response.choices?.[0]?.message?.content?.trim() || '{}';
      const clean = raw.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```$/i, '').trim();
      const parsed = JSON.parse(clean);

      if (parsed.hasNewInfo) {
        if (Array.isArray(parsed.newFacts)) {
          for (const fact of parsed.newFacts) {
            this.addFact(fact);
          }
        }
        if (parsed.episodeSummary && typeof parsed.episodeSummary === 'string') {
          this.addEpisode(parsed.episodeSummary);
        }
      }
    } catch (err) {
      // Background extraction gagal tidak boleh mengganggu jalannya companion
      console.warn('[memory:extract] Ekstraksi latar belakang dilewati:', err.message);
    } finally {
      this.isExtracting = false;
    }
  }
}

export const memoryManager = new MemoryManager();

// Self-check: `node server/memoryManager.js`
if (process.argv[1] && process.argv[1].endsWith('memoryManager.js')) {
  const assert = (c, m) => {
    if (!c) throw new Error('FAIL: ' + m);
  };

  const testMgr = new MemoryManager();
  const prompt = testMgr.getMemoryPrompt();
  assert(prompt.includes('MEMORI JANGKA PANJANG'), 'prompt header check');
  testMgr.addFact('Suka ngopi hitam tanpa gula', 'preference');
  const promptAfterFact = testMgr.getMemoryPrompt();
  assert(promptAfterFact.includes('Suka ngopi hitam tanpa gula'), 'fact retention check');

  console.log('memoryManager self-check OK!');
  console.log('Sample Memory Prompt:\n', promptAfterFact);
}
