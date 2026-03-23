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

  // Gemini planner agent settings (preferred if present).
  geminiApiKey: process.env.GEMINI_API_KEY ?? null,
  geminiModel: process.env.GEMINI_MODEL ?? "gemini-2.0-flash",

  // OpenAI planner agent settings (fallback provider).
  openaiApiKey: process.env.OPENAI_API_KEY ?? null,
  openaiModel: process.env.OPENAI_MODEL ?? "gpt-5-mini",
  plannerLlmTimeoutMs: Number(process.env.PLANNER_LLM_TIMEOUT_MS ?? 8000),

  // Doubt AI runtime diagnostics
  doubtAiDebug: String(process.env.DOUBT_AI_DEBUG ?? "false").toLowerCase() === "true",
  doubtAiTimeoutMs: Number(process.env.DOUBT_AI_TIMEOUT_MS ?? 8000)
};
