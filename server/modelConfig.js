// Model IDs are kept in one place so real requests and maintenance pings
// always target the same instances.
import 'dotenv/config';

// LLM Chat: model lokal via LM Studio (sebelumnya gpt-oss-120b via Groq).
// Isi LMSTUDIO_MODEL di .env dengan ID model yang di-load di LM Studio.
export const CHAT_MODEL = process.env.LMSTUDIO_MODEL || 'local-model';

// Legacy filter model: DeepSeek V4 Flash via 9inference
// Still used by streamingVisionManager.js for periodic filtering.
export const FILTER_MODEL = 'deepseek-v4-flash-0731';

// Vision: Qwen 3.8 27B via Groq (defined locally in visionCapture.js and
// streamingVisionManager.js since it uses a separate provider/client)
