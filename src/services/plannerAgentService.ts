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

function riskWeight(riskLevel: WeakTopicInfo["riskLevel"]) {
  switch (riskLevel) {
    case "critical":
      return 4;
    case "high":
      return 3;
    case "medium":
      return 2;
    case "low":
    default:
      return 1;
  }
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

function repairJsonText(text: string) {
  let candidate = extractJsonCandidate(text)
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/,\s*([}\]])/g, "$1")
    .trim();

  const openBraces = (candidate.match(/\{/g) ?? []).length;
  const closeBraces = (candidate.match(/\}/g) ?? []).length;
  if (closeBraces < openBraces) {
    candidate += "}".repeat(openBraces - closeBraces);
  }

  const openBrackets = (candidate.match(/\[/g) ?? []).length;
  const closeBrackets = (candidate.match(/\]/g) ?? []).length;
  if (closeBrackets < openBrackets) {
    candidate += "]".repeat(openBrackets - closeBrackets);
  }

  return candidate;
}

function tryParsePlannerJson(rawText: string): any | null {
  const candidates = Array.from(
    new Set([extractJsonCandidate(rawText), repairJsonText(rawText), repairJsonText(extractJsonCandidate(rawText))].filter(Boolean))
  );

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {
      // Try next repair.
    }
  }

  return null;
}

function extractPlannerItemCandidates(parsed: any): any[] {
  if (!parsed) return [];
  if (Array.isArray(parsed)) return parsed;

  const directKeys = [
    "weekPlanItems",
    "week_plan_items",
    "items",
    "planItems",
    "plan_items",
    "schedule",
    "timetable",
    "blocks"
  ];

  for (const key of directKeys) {
    const value = parsed[key];
    if (Array.isArray(value)) {
      return value;
    }
  }

  const nestedCandidates = [
    parsed?.data?.weekPlanItems,
    parsed?.data?.items,
    parsed?.schedule?.items,
    parsed?.schedule?.blocks,
    parsed?.plan?.items
  ];

  for (const value of nestedCandidates) {
    if (Array.isArray(value)) {
      return value;
    }
  }

  return [];
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
    `2) Spread all weak topics across the week. Do not cluster them on one day.`,
    `3) Repeat critical/high-risk topics more often than medium/low-risk topics.`,
    `4) Prioritize weak topics in morning slots (07:00 to 12:00).`,
    `5) Keep each day within ${input.dailyHoursTarget} total study hours.`,
    "6) Use a mix of types: study, revision, test.",
    "7) No overlapping blocks within a day.",
    "8) Each block duration: min 30 minutes, max 180 minutes.",
    "9) If exam is <= 14 days away, increase revision/test density.",
    "10) source must always be 'llm'.",
    "11) Include concise rebalance logic in headline/detail/focus_window.",
    "12) rebalanceLogic.detail must be only 2-3 short actionable lines separated by newlines.",
    "13) Keep rebalanceLogic focused on what to study next and when.",
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

    return translateOutput(text, env.geminiModel, input);
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
      return translateOutput(fallback, env.openaiModel, input);
    }

    const json = (await responsesRes.json()) as any;
    const text = parseOpenAIResponseText(json);
    return translateOutput(text, env.openaiModel, input);
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

async function callOllama(input: PlannerAgentInput, timeoutMs: number): Promise<PlannerAgentOutput> {
  const prompt = buildPrompt(input);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(`${env.ollamaBaseUrl.replace(/\/+$/, "")}/api/generate`, {
      method: "POST",
      signal: controller.signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: env.ollamaModel,
        prompt,
        format: "json",
        stream: false,
        options: {
          temperature: 0.25
        }
      })
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`Ollama HTTP ${response.status}: ${body.slice(0, 300)}`);
    }

    const json = (await response.json()) as any;
    const text = typeof json?.response === "string" ? json.response.trim() : "";
    if (!text) {
      throw new Error("Ollama returned empty response");
    }

    return translateOutput(text, env.ollamaModel, input);
  } finally {
    clearTimeout(timer);
  }
}

function conciseLines(text: string, fallbackLines: string[]) {
  const cleaned = String(text ?? "").replace(/\r\n/g, "\n").trim();
  const sentences = cleaned
    .split(/\n+/)
    .flatMap((line) => line.split(/(?<=[.!?])\s+/g))
    .map((line) => line.trim())
    .filter(Boolean);

  const lines = sentences.length > 0 ? sentences.slice(0, 3) : fallbackLines.slice(0, 3);
  if (lines.length < 2) {
    lines.push(...fallbackLines.slice(lines.length, 2));
  }
  return lines.slice(0, 3).join("\n");
}

function normaliseRebalance(raw: any, model: string, usedFallback: boolean): RebalanceMetadata {
  const detailSource = raw?.detail ?? raw?.message ?? raw?.explanation ?? raw?.summary ?? "";
  const headline = String(raw?.headline ?? raw?.title ?? "AI plan generated from your latest data.").trim().slice(0, 120);
  const detail = conciseLines(String(detailSource), [
    "Weak topics are placed in your highest-focus slots.",
    "Use the first block of the day to clear the hardest topic.",
    "Keep the final block for review or quick testing."
  ]);
  const focusWindow = String(raw?.focus_window ?? raw?.focusWindow ?? "Morning 08:00-11:00").trim().slice(0, 80);

  return {
    headline,
    detail,
    focus_window: focusWindow || "Morning 08:00-11:00",
    used_fallback: usedFallback,
    model
  };
}

function normalizePlannerBlockCandidate(item: any): PlannerBlock | null {
  const startsAt = String(item?.starts_at ?? item?.startsAt ?? "").trim();
  const endsAt = String(item?.ends_at ?? item?.endsAt ?? "").trim();
  const start = new Date(startsAt);
  const end = new Date(endsAt);
  if (!startsAt || !endsAt || Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) {
    return null;
  }

  return {
    starts_at: start.toISOString(),
    ends_at: end.toISOString(),
    subject: String(item?.subject ?? "Study").trim() || "Study",
    topic: String(item?.topic ?? "Study Block").trim() || "Study Block",
    type: validateType(item?.type),
    source: "llm",
    notes: item?.notes == null ? null : String(item.notes)
  };
}

function translateOutput(rawText: string, model: string, input: PlannerAgentInput): PlannerAgentOutput {
  const parsed = tryParsePlannerJson(rawText);
  if (!parsed) {
    throw new Error("Planner output could not be parsed");
  }

  const candidateItems = extractPlannerItemCandidates(parsed);

  const weekStart = new Date(`${input.weekStartDate}T00:00:00.000Z`);
  const weekEnd = new Date(weekStart);
  weekEnd.setUTCDate(weekStart.getUTCDate() + 7);

  const items = candidateItems
    .map((item: any) => normalizePlannerBlockCandidate(item))
    .filter((item): item is PlannerBlock => Boolean(item))
    .filter((item) => {
      const start = new Date(item.starts_at);
      return start >= weekStart && start < weekEnd;
    })
    .slice(0, 28);

  if (items.length === 0) {
    const fallback = generateDeterministicFallback(input);
    const mergedRebalance = normaliseRebalance(
      parsed.rebalanceLogic ?? parsed.rebalance ?? parsed.rebalance_logic ?? {},
      model,
      true
    );
    return {
      items: fallback.items,
      rebalance: {
        ...mergedRebalance,
        detail: mergedRebalance.detail || fallback.rebalance.detail,
        used_fallback: true,
        model
      }
    };
  }

  const rebalance = normaliseRebalance(parsed.rebalanceLogic ?? parsed.rebalance ?? parsed.rebalance_logic ?? {}, model, false);

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
    rebalance: normaliseRebalance(output.rebalance, output.rebalance.model ?? env.ollamaModel, false)
  };
}

function buildTopicQueue(input: PlannerAgentInput) {
  const weakOrdered = [...input.weakTopics].sort((a, b) => {
    const weightDelta = riskWeight(b.riskLevel) - riskWeight(a.riskLevel);
    if (weightDelta !== 0) return weightDelta;
    return a.retentionEstimate - b.retentionEstimate;
  });

  const baseTopics =
    weakOrdered.length > 0
      ? weakOrdered.map((item) => ({ subject: item.subject, topic: item.topic, weight: riskWeight(item.riskLevel) }))
      : input.availableTopics.length > 0
        ? input.availableTopics.map((item) => ({ subject: item.subject, topic: item.topic, weight: 1 }))
        : input.subjectConfidence.length > 0
          ? input.subjectConfidence.map((item) => ({ subject: item.subject, topic: `${item.subject} Core Revision`, weight: 1 }))
          : [{ subject: "General", topic: "Core Concepts", weight: 1 }];

  const expanded: Array<{ subject: string; topic: string }> = [];
  for (const item of baseTopics) {
    const copies = clamp(item.weight, 1, 4);
    for (let index = 0; index < copies; index += 1) {
      expanded.push({ subject: item.subject, topic: item.topic });
    }
  }

  return expanded.length > 0 ? expanded : [{ subject: "General", topic: "Core Concepts" }];
}

function chooseTopic(queue: Array<{ subject: string; topic: string }>, index: number) {
  return queue[index % queue.length] ?? { subject: "General", topic: "Core Concepts" };
}

function buildConciseFallbackDetail(nearExam: boolean) {
  const lines = nearExam
    ? [
        "Weak topics move to the first morning slot.",
        "Revision and short tests increase as the exam gets closer.",
        "Finish the day with a quick recall block."
      ]
    : [
        "The plan starts with your weakest topics in the morning.",
        "Study, revision, and test blocks are balanced across the week.",
        "Daily hours stay within your target cap."
      ];

  return lines.join("\n");
}

export function generateDeterministicFallback(input: PlannerAgentInput): PlannerAgentOutput {
  const weekStart = new Date(`${input.weekStartDate}T00:00:00.000Z`);
  const examNear = input.targetDate
    ? (new Date(input.targetDate).getTime() - Date.now()) / 86400000 <= 14
    : false;

  const items: PlannerBlock[] = [];
  const dailyMinutes = clamp(Math.round(input.dailyHoursTarget * 60), 90, 8 * 60);
  const topicQueue = buildTopicQueue(input);
  let topicCursor = 0;

  for (let dayIndex = 0; dayIndex < 7; dayIndex += 1) {
    const date = new Date(weekStart);
    date.setUTCDate(weekStart.getUTCDate() + dayIndex);

    const morningTopic = chooseTopic(topicQueue, topicCursor);
    topicCursor += 1;
    const midTopic = chooseTopic(topicQueue, topicCursor);
    topicCursor += 1;
    const lateTopic = chooseTopic(topicQueue, topicCursor);
    topicCursor += 1;

    const firstStart = new Date(date);
    firstStart.setUTCHours(8, 0, 0, 0);

    const firstDuration = clamp(Math.round(dailyMinutes * 0.5), 60, 120);
    const firstEnd = new Date(firstStart.getTime() + firstDuration * 60000);

    items.push({
      starts_at: firstStart.toISOString(),
      ends_at: firstEnd.toISOString(),
      subject: morningTopic.subject,
      topic: morningTopic.topic,
      type: "study",
      source: "fallback",
      notes: "Scheduled by default planner"
    });

    const secondDuration = clamp(Math.round(dailyMinutes * 0.28), 45, 90);
    const remainingAfterFirst = dailyMinutes - firstDuration;
    if (remainingAfterFirst >= 45) {
      const secondStart = new Date(firstEnd.getTime() + 45 * 60000);

      const secondType: PlanType = examNear
        ? (dayIndex % 2 === 0 ? "revision" : "test")
        : (dayIndex % 3 === 0 ? "test" : "revision");

      items.push({
        starts_at: secondStart.toISOString(),
        ends_at: addMinutes(secondStart.toISOString(), secondDuration),
        subject: midTopic.subject,
        topic: midTopic.topic,
        type: secondType,
        source: "fallback",
        notes: "Auto-rebalanced default block"
      });
    }

    const remainingAfterSecond = dailyMinutes - firstDuration - secondDuration;
    if (remainingAfterSecond >= 45) {
      const thirdStart = new Date(date);
      thirdStart.setUTCHours(16, 0, 0, 0);
      const thirdDuration = clamp(Math.round(dailyMinutes * 0.2), 45, 75);

      items.push({
        starts_at: thirdStart.toISOString(),
        ends_at: addMinutes(thirdStart.toISOString(), thirdDuration),
        subject: lateTopic.subject,
        topic: lateTopic.topic,
        type: examNear ? "test" : "revision",
        source: "fallback",
        notes: "Evening recall and retention block"
      });
    }
  }

  return {
    items,
    rebalance: {
      headline: "Used default plan due to AI timeout.",
      detail: buildConciseFallbackDetail(examNear),
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
      .eq("queue_enabled", true)
      .in("risk_level", ["critical", "high", "medium"])
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

  try {
    const llmOutput = await callOllama(input, env.plannerLlmTimeoutMs);

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
