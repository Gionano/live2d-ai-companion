// Model IDs are kept in one place so real requests and maintenance pings
// always target the same instances.
//
// LLM Chat & Filter: DeepSeek V4 Flash via 9inference
export const CHAT_MODEL = 'deepseek-v4-flash-0731';

// Vision: Qwen 3.8 27B via Groq (defined locally in visionCapture.js and
// streamingVisionManager.js since it uses a separate provider/client)
