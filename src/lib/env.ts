import dotenv from "dotenv";

dotenv.config();

function required(name: string) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

export const env = {
  port: Number(process.env.PORT ?? 4000),
  corsOrigin: process.env.CORS_ORIGIN ?? "*",
  supabaseUrl: required("SUPABASE_URL"),
  supabaseServiceRoleKey: required("SUPABASE_SERVICE_ROLE_KEY"),

  // Ollama AI settings (used for planner + doubt solver).
  ollamaBaseUrl: process.env.OLLAMA_BASE_URL ?? "http://127.0.0.1:11434",
  ollamaModel: process.env.OLLAMA_MODEL ?? "gemma3:4b",
  // Legacy provider keys retained for backward compatibility (unused in current runtime path).
  geminiApiKey: process.env.GEMINI_API_KEY ?? null,
  geminiModel: process.env.GEMINI_MODEL ?? "gemini-2.0-flash",
  openaiApiKey: process.env.OPENAI_API_KEY ?? null,
  openaiModel: process.env.OPENAI_MODEL ?? "gpt-5-mini",
  plannerLlmTimeoutMs: Number(process.env.PLANNER_LLM_TIMEOUT_MS ?? 20000),
  pythonBin: process.env.PYTHON_BIN ?? "python",
  youtubeTranscriptTimeoutMs: Number(process.env.YOUTUBE_TRANSCRIPT_TIMEOUT_MS ?? 15000),
  multimodalMaxTranscriptChars: Number(process.env.MULTIMODAL_MAX_TRANSCRIPT_CHARS ?? 24000),

  // Doubt AI runtime diagnostics
  doubtAiDebug: String(process.env.DOUBT_AI_DEBUG ?? "false").toLowerCase() === "true",
  doubtAiTimeoutMs: Number(process.env.DOUBT_AI_TIMEOUT_MS ?? 30000)
};
