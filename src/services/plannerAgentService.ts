import { env } from "../lib/env";
import { supabaseService } from "../lib/supabase";
import type {
  PlannerAgentInput,
  PlannerAgentOutput,
  PlannerBlock,
  RebalanceMetadata,
  RecentSessionAccuracy,
  WeakTopicInfo
} from "../types/planner";

type PlanType = "study" | "revision" | "test";

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function getMonday(anchor: Date): Date {
  const base = new Date(anchor);
  const day = base.getDay();
  const mondayOffset = day === 0 ? -6 : 1 - day;
  base.setDate(base.getDate() + mondayOffset);
  base.setHours(0, 0, 0, 0);
  return base;
}

function parseRisk(value: unknown): WeakTopicInfo["riskLevel"] {
  if (value === "critical" || value === "high" || value === "medium" || value === "low") {
    return value;
  }
  return "medium";
}

function validateType(raw: unknown): PlanType {
  if (raw === "study" || raw === "revision" || raw === "test") {
    return raw;
  }
  return "study";
}

function addMinutes(iso: string, minutes: number) {
  return new Date(new Date(iso).getTime() + minutes * 60000).toISOString();
}

function extractJsonCandidate(text: string) {
  const cleaned = text.trim().replace(/^```json\s*/i, "").replace(/```\s*$/i, "").trim();
  if (cleaned.startsWith("{")) return cleaned;

  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start >= 0 && end > start) {
    return cleaned.slice(start, end + 1);
  }
  return cleaned;
}

function parseOpenAIResponseText(raw: any): string {
  if (typeof raw?.output_text === "string" && raw.output_text.trim().length > 0) {
    return raw.output_text;
  }

  const outputItems = Array.isArray(raw?.output) ? raw.output : [];
  for (const item of outputItems) {
    const contentItems = Array.isArray(item?.content) ? item.content : [];
    for (const content of contentItems) {
      if (typeof content?.text === "string" && content.text.trim().length > 0) {
        return content.text;
      }
    }
  }

  const chatText = raw?.choices?.[0]?.message?.content;
  if (typeof chatText === "string" && chatText.trim().length > 0) {
    return chatText;
  }

  throw new Error("LLM returned no parseable text.");
}

function plannerJsonSchema() {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      weekPlanItems: {
        type: "array",
        minItems: 1,
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            starts_at: { type: "string" },
            ends_at: { type: "string" },
            subject: { type: "string" },
            topic: { type: "string" },
            type: { type: "string", enum: ["study", "revision", "test"] },
            source: { type: "string", enum: ["llm"] },
            notes: { type: ["string", "null"] }
          },
          required: ["starts_at", "ends_at", "subject", "topic", "type", "source", "notes"]
        }
      },
      rebalanceLogic: {
        type: "object",
        additionalProperties: false,
        properties: {
          headline: { type: "string" },
          detail: { type: "string" },
          focus_window: { type: "string" }
        },
        required: ["headline", "detail", "focus_window"]
      }
    },
    required: ["weekPlanItems", "rebalanceLogic"]
  };
}

function buildPrompt(input: PlannerAgentInput): string {
  const daysUntilExam = input.targetDate
    ? Math.max(0, Math.ceil((new Date(input.targetDate).getTime() - Date.now()) / 86400000))
    : null;

  const weakSummary = input.weakTopics
    .slice(0, 10)
    .map((topic) => `${topic.subject}/${topic.topic} (risk=${topic.riskLevel}, retention=${topic.retentionEstimate}%)`)
    .join("; ");

  const confidenceSummary = input.subjectConfidence
    .map((subject) => `${subject.subject}: ${subject.confidenceLevel}/4`)
    .join(", ");

  const recentAccuracy =
    input.recentAccuracy.length > 0
      ? Math.round(input.recentAccuracy.reduce((sum, item) => sum + item.accuracyPercent, 0) / input.recentAccuracy.length)
      : null;

  const topics = input.availableTopics
    .slice(0, 18)
    .map((topic) => `${topic.subject}/${topic.topic}`)
    .join("; ");

  return [
    "Generate a 7-day study plan for a competitive exam student.",
    "Return ONLY valid JSON.",
    "",
    `Exam: ${input.examType}`,
    `Target Date: ${input.targetDate ?? "unknown"}${daysUntilExam !== null ? ` (${daysUntilExam} days left)` : ""}`,
    `Daily Study Hours Target: ${input.dailyHoursTarget}`,
    `Week Start Date (Monday): ${input.weekStartDate}`,
    `Weak Topics: ${weakSummary || "none"}`,
    `Recent Accuracy: ${recentAccuracy !== null ? `${recentAccuracy}%` : "unknown"}`,
    `Subject Confidence: ${confidenceSummary || "unknown"}`,
    `Available Topics: ${topics || "none"}`,
    "",
    "Rules:",
    `1) Generate blocks only for 7 days starting ${input.weekStartDate}.`,
    `2) Keep each day within ${input.dailyHoursTarget} total study hours.`,
    "3) Prioritize weak topics in morning slots (07:00 to 12:00).",
    "4) Use a mix of types: study, revision, test.",
    "5) No overlapping blocks within a day.",
    "6) Each block duration: min 30 minutes, max 180 minutes.",
    "7) If exam is <= 14 days away, increase revision/test density.",
    "8) source must always be 'llm'.",
    "9) Include concise rebalance logic in headline/detail/focus_window.",
    "",
    "Output object keys must be exactly: weekPlanItems, rebalanceLogic"
  ].join("\n");
}

async function callGemini(input: PlannerAgentInput, timeoutMs: number): Promise<PlannerAgentOutput> {
  if (!env.geminiApiKey) {
    throw new Error("GEMINI_API_KEY not set");
  }

  const prompt = buildPrompt(input);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${env.geminiModel}:generateContent?key=${env.geminiApiKey}`,
      {
        method: "POST",
        signal: controller.signal,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            responseMimeType: "application/json",
            temperature: 0.35,
            maxOutputTokens: 4096
          }
        })
      }
    );

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`Gemini HTTP ${response.status}: ${body.slice(0, 300)}`);
    }

    const json = (await response.json()) as any;
    const text =
      json?.candidates?.[0]?.content?.parts
        ?.map((part: any) => (typeof part?.text === "string" ? part.text : ""))
        .join("\n")
        .trim() ?? "";

    if (!text) {
      throw new Error("Gemini returned empty content");
    }

    return translateOutput(text, env.geminiModel);
  } finally {
    clearTimeout(timer);
  }
}

async function callOpenAI(input: PlannerAgentInput, timeoutMs: number): Promise<PlannerAgentOutput> {
  if (!env.openaiApiKey) {
    throw new Error("OPENAI_API_KEY not set");
  }

  const prompt = buildPrompt(input);
  const schema = plannerJsonSchema();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const responsesRes = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${env.openaiApiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: env.openaiModel,
        input: [
          { role: "system", content: [{ type: "input_text", text: "You are a strict JSON planner generator." }] },
          { role: "user", content: [{ type: "input_text", text: prompt }] }
        ],
        text: {
          format: {
            type: "json_schema",
            name: "planner_output",
            schema,
            strict: true
          }
        },
        max_output_tokens: 3000
      })
    });

    if (!responsesRes.ok) {
      const fallback = await callOpenAIChatCompletions(prompt, controller.signal);
      return translateOutput(fallback, env.openaiModel);
    }

    const json = (await responsesRes.json()) as any;
    const text = parseOpenAIResponseText(json);
    return translateOutput(text, env.openaiModel);
  } finally {
    clearTimeout(timer);
  }
}

async function callOpenAIChatCompletions(prompt: string, signal: AbortSignal): Promise<string> {
  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    signal,
    headers: {
      Authorization: `Bearer ${env.openaiApiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: env.openaiModel,
      temperature: 0.3,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: "Return valid JSON only." },
        { role: "user", content: prompt }
      ]
    })
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`OpenAI HTTP ${response.status}: ${body.slice(0, 300)}`);
  }

  const json = (await response.json()) as any;
  return parseOpenAIResponseText(json);
}

function translateOutput(rawText: string, model: string): PlannerAgentOutput {
  const parsed = JSON.parse(extractJsonCandidate(rawText)) as any;
  if (!parsed || !Array.isArray(parsed.weekPlanItems)) {
    throw new Error("Planner output missing weekPlanItems array");
  }

  const items: PlannerBlock[] = parsed.weekPlanItems.map((item: any) => ({
    starts_at: String(item.starts_at ?? ""),
    ends_at: String(item.ends_at ?? ""),
    subject: String(item.subject ?? "").trim() || "Study",
    topic: String(item.topic ?? "").trim() || "Study Block",
    type: validateType(item.type),
    source: "llm",
    notes: item.notes == null ? null : String(item.notes)
  }));

  const rebalanceRaw = parsed.rebalanceLogic ?? {};
  const rebalance: RebalanceMetadata = {
    headline: String(rebalanceRaw.headline ?? "AI plan generated from your latest data.").slice(0, 120),
    detail: String(rebalanceRaw.detail ?? "Weak areas are prioritized in peak focus slots."),
    focus_window: String(rebalanceRaw.focus_window ?? "Morning 08:00-11:00"),
    used_fallback: false,
    model
  };

  return { items, rebalance };
}

function sanitiseOutput(output: PlannerAgentOutput, input: PlannerAgentInput): PlannerAgentOutput | null {
  const weekStart = new Date(`${input.weekStartDate}T00:00:00.000Z`);
  const weekEnd = new Date(weekStart);
  weekEnd.setUTCDate(weekStart.getUTCDate() + 7);

  const byDay = new Map<string, PlannerBlock[]>();

  for (const item of output.items) {
    const start = new Date(item.starts_at);
    const end = new Date(item.ends_at);

    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) continue;
    if (end <= start) continue;
    if (start < weekStart || start >= weekEnd) continue;

    const durationMin = Math.round((end.getTime() - start.getTime()) / 60000);
    if (durationMin < 30 || durationMin > 180) continue;

    const dayKey = start.toISOString().slice(0, 10);
    const list = byDay.get(dayKey) ?? [];
    list.push({
      starts_at: start.toISOString(),
      ends_at: end.toISOString(),
      subject: item.subject.trim() || "Study",
      topic: item.topic.trim() || "Study Block",
      type: validateType(item.type),
      source: "llm",
      notes: item.notes ?? null
    });
    byDay.set(dayKey, list);
  }

  const maxDailyMinutes = clamp(Math.round(input.dailyHoursTarget * 60), 60, 16 * 60);
  const finalItems: PlannerBlock[] = [];

  byDay.forEach((itemsForDay) => {
    itemsForDay.sort((a, b) => new Date(a.starts_at).getTime() - new Date(b.starts_at).getTime());

    let consumed = 0;
    let lastEnd = -Infinity;

    for (const block of itemsForDay) {
      const startTs = new Date(block.starts_at).getTime();
      const endTs = new Date(block.ends_at).getTime();
      const duration = Math.round((endTs - startTs) / 60000);

      if (startTs < lastEnd) continue;
      if (consumed + duration > maxDailyMinutes) continue;

      consumed += duration;
      lastEnd = endTs;
      finalItems.push(block);
    }
  });

  if (finalItems.length === 0) {
    return null;
  }

  finalItems.sort((a, b) => new Date(a.starts_at).getTime() - new Date(b.starts_at).getTime());

  return {
    items: finalItems,
    rebalance: {
      ...output.rebalance,
      used_fallback: false,
      model: output.rebalance.model ?? env.openaiModel
    }
  };
}

function chooseTopic(input: PlannerAgentInput, index: number) {
  const weak = input.weakTopics
    .filter((item) => item.riskLevel === "critical" || item.riskLevel === "high")
    .map((item) => ({ subject: item.subject, topic: item.topic }));

  const pool = weak.length > 0
    ? weak
    : input.availableTopics.length > 0
      ? input.availableTopics
      : input.subjectConfidence.length > 0
        ? input.subjectConfidence.map((item) => ({ subject: item.subject, topic: `${item.subject} Core Revision` }))
        : [{ subject: "General", topic: "Core Concepts" }];

  return pool[index % pool.length];
}

export function generateDeterministicFallback(input: PlannerAgentInput): PlannerAgentOutput {
  const weekStart = new Date(`${input.weekStartDate}T00:00:00.000Z`);
  const examNear = input.targetDate
    ? (new Date(input.targetDate).getTime() - Date.now()) / 86400000 <= 14
    : false;

  const items: PlannerBlock[] = [];
  const dailyMinutes = clamp(Math.round(input.dailyHoursTarget * 60), 90, 8 * 60);

  for (let dayIndex = 0; dayIndex < 7; dayIndex += 1) {
    const date = new Date(weekStart);
    date.setUTCDate(weekStart.getUTCDate() + dayIndex);

    const firstTopic = chooseTopic(input, dayIndex);
    const secondTopic = chooseTopic(input, dayIndex + 3);

    const firstStart = new Date(date);
    firstStart.setUTCHours(8, 0, 0, 0);

    const firstDuration = clamp(Math.round(dailyMinutes * 0.55), 60, 120);
    const firstEnd = new Date(firstStart.getTime() + firstDuration * 60000);

    items.push({
      starts_at: firstStart.toISOString(),
      ends_at: firstEnd.toISOString(),
      subject: firstTopic.subject,
      topic: firstTopic.topic,
      type: "study",
      source: "fallback",
      notes: "Scheduled by default planner"
    });

    const remaining = dailyMinutes - firstDuration;
    if (remaining >= 40) {
      const secondStart = new Date(firstEnd.getTime() + 45 * 60000);
      const secondDuration = clamp(remaining, 40, 120);

      const secondType: PlanType = examNear
        ? (dayIndex % 2 === 0 ? "revision" : "test")
        : (dayIndex % 3 === 0 ? "test" : "revision");

      items.push({
        starts_at: secondStart.toISOString(),
        ends_at: addMinutes(secondStart.toISOString(), secondDuration),
        subject: secondTopic.subject,
        topic: secondTopic.topic,
        type: secondType,
        source: "fallback",
        notes: "Auto-rebalanced default block"
      });
    }
  }

  return {
    items,
    rebalance: {
      headline: "Used default plan due to AI timeout.",
      detail:
        "We could not complete an AI generation in time, so a deterministic plan was created from your weak topics and daily-hour target.",
      focus_window: "Morning 08:00-11:00",
      used_fallback: true,
      model: null
    }
  };
}

export async function collectPlannerContext(userId: string, anchor = new Date()): Promise<PlannerAgentInput> {
  const weekStart = getMonday(anchor);

  const [examSettingsRes, confidenceRes, revisionRes, sessionRes, questionRes] = await Promise.all([
    supabaseService
      .from("user_exam_settings")
      .select("exam_type,target_date,daily_hours_target")
      .eq("user_id", userId)
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
    supabaseService
      .from("user_subject_confidence")
      .select("subject,confidence_level")
      .eq("user_id", userId)
      .order("confidence_level", { ascending: true }),
    supabaseService
      .from("revision_items")
      .select("subject,topic,risk_level,retention_estimate")
      .eq("user_id", userId)
      .order("updated_at", { ascending: false })
      .limit(15),
    supabaseService
      .from("practice_sessions")
      .select("id,accuracy_percent,topic,module")
      .eq("user_id", userId)
      .eq("status", "completed")
      .order("ended_at", { ascending: false })
      .limit(8),
    supabaseService
      .from("questions")
      .select("subject,topic")
      .limit(50)
  ]);

  const examSettings = examSettingsRes.data;
  const examType = examSettings?.exam_type ?? "JEE Main";
  const targetDate = examSettings?.target_date ?? null;
  const dailyHoursTarget = clamp(Number(examSettings?.daily_hours_target ?? 4), 1, 16);

  const weakTopics: WeakTopicInfo[] = (revisionRes.data ?? []).map((row: any) => ({
    subject: String(row.subject ?? "General"),
    topic: String(row.topic ?? "Core Concepts"),
    riskLevel: parseRisk(row.risk_level),
    retentionEstimate: clamp(Number(row.retention_estimate ?? 70), 0, 100)
  }));

  const recentAccuracy: RecentSessionAccuracy[] = (sessionRes.data ?? []).map((row: any) => ({
    sessionId: String(row.id),
    accuracyPercent: clamp(Number(row.accuracy_percent ?? 0), 0, 100),
    topic: row.topic ? String(row.topic) : null,
    subject: row.module ? String(row.module) : null
  }));

  const topics = new Map<string, { subject: string; topic: string }>();
  for (const row of revisionRes.data ?? []) {
    const subject = String((row as any).subject ?? "General");
    const topic = String((row as any).topic ?? "Core Concepts");
    topics.set(`${subject}::${topic}`.toLowerCase(), { subject, topic });
  }
  for (const row of questionRes.data ?? []) {
    const subject = String((row as any).subject ?? "General");
    const topic = String((row as any).topic ?? "Core Concepts");
    topics.set(`${subject}::${topic}`.toLowerCase(), { subject, topic });
  }

  const subjectConfidence = (confidenceRes.data ?? []).map((row: any) => ({
    subject: String(row.subject ?? "General"),
    confidenceLevel: clamp(Number(row.confidence_level ?? 2), 1, 4)
  }));

  return {
    userId,
    examType,
    targetDate,
    dailyHoursTarget,
    weekStartDate: weekStart.toISOString().slice(0, 10),
    weakTopics,
    recentAccuracy,
    availableTopics: [...topics.values()],
    subjectConfidence
  };
}

export async function runPlannerAgent(userId: string, anchor = new Date()): Promise<PlannerAgentOutput> {
  const input = await collectPlannerContext(userId, anchor);

  if (!env.geminiApiKey && !env.openaiApiKey) {
    console.info("[planner] No Gemini/OpenAI key found; using deterministic fallback plan.");
    return generateDeterministicFallback(input);
  }

  try {
    const llmOutput = env.geminiApiKey
      ? await callGemini(input, env.plannerLlmTimeoutMs)
      : await callOpenAI(input, env.plannerLlmTimeoutMs);

    const sanitised = sanitiseOutput(llmOutput, input);

    if (!sanitised) {
      console.warn("[planner] LLM output failed validation; using deterministic fallback plan.");
      return generateDeterministicFallback(input);
    }

    return sanitised;
  } catch (error) {
    console.warn(
      "[planner] LLM generation failed; using deterministic fallback plan:",
      error instanceof Error ? error.message : error
    );
    return generateDeterministicFallback(input);
  }
}
