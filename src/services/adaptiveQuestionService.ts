import { env } from "../lib/env";
import { supabaseService } from "../lib/supabase";
import { getLatestExamType } from "./dataHelpers";

type SupportedDifficulty = "easy" | "medium" | "hard" | "adaptive";
type OptionId = "A" | "B" | "C" | "D";

type StoredQuestionRow = {
  id: string;
  subject: string;
  topic: string;
  difficulty: SupportedDifficulty;
  prompt: string;
  options: Record<OptionId, string>;
  correct_option: OptionId;
  solution_steps: string[];
};

type GeneratedQuestionCandidate = Omit<StoredQuestionRow, "id">;

type GenerateAdaptiveQuestionInput = {
  userId: string;
  topic?: string | null;
  subject?: string | null;
  difficulty?: string | null;
  excludeQuestionIds?: string[];
};

type GenerateAdaptiveQuestionResult = {
  question: StoredQuestionRow;
  source: "ollama" | "db";
};

type ExplanationResult = {
  solutionSteps: string[];
  aiSolution: string;
  source: "stored" | "ollama" | "fallback";
};

type HintResult = {
  hint: string;
  source: "stored" | "ollama" | "fallback";
};

const OPTION_IDS: OptionId[] = ["A", "B", "C", "D"];
const DIFFICULTIES = new Set<SupportedDifficulty>(["easy", "medium", "hard", "adaptive"]);

function normalizeDifficulty(value: unknown): SupportedDifficulty {
  const candidate = String(value ?? "").trim().toLowerCase();
  if (candidate === "easy" || candidate === "medium" || candidate === "hard" || candidate === "adaptive") {
    return candidate;
  }
  return "adaptive";
}

function normalizeOptionId(value: unknown): OptionId | null {
  const upper = String(value ?? "").trim().toUpperCase();
  return upper === "A" || upper === "B" || upper === "C" || upper === "D" ? upper : null;
}

function extractJsonCandidate(text: string) {
  const cleaned = text.trim().replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```\s*$/i, "").trim();
  if (cleaned.startsWith("{")) {
    return cleaned;
  }

  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start >= 0 && end > start) {
    return cleaned.slice(start, end + 1);
  }

  return cleaned;
}

function repairJsonText(text: string) {
  let candidate = extractJsonCandidate(text)
    .replace(/[â€œâ€]/g, '"')
    .replace(/[â€˜â€™]/g, "'")
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

function tryParseJson(rawText: string): any | null {
  const candidates = Array.from(
    new Set([extractJsonCandidate(rawText), repairJsonText(rawText), repairJsonText(extractJsonCandidate(rawText))].filter(Boolean))
  );

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {
      // Try the next repaired payload.
    }
  }

  return null;
}

function normalizeOptions(raw: unknown): Record<OptionId, string> | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }

  const source = raw as Record<string, unknown>;
  const normalized: Partial<Record<OptionId, string>> = {};

  OPTION_IDS.forEach((id) => {
    const value = source[id] ?? source[id.toLowerCase()];
    const text = String(value ?? "").trim();
    if (text) {
      normalized[id] = text;
    }
  });

  if (OPTION_IDS.some((id) => !normalized[id])) {
    return null;
  }

  const deduped = new Set(Object.values(normalized).map((value) => value.toLowerCase()));
  if (deduped.size !== OPTION_IDS.length) {
    return null;
  }

  return normalized as Record<OptionId, string>;
}

function normalizeSolutionSteps(raw: unknown): string[] {
  if (!Array.isArray(raw)) {
    return [];
  }

  return raw
    .map((step) => String(step ?? "").trim())
    .filter(Boolean)
    .slice(0, 6);
}

function sanitizeQuestionCandidate(
  raw: any,
  requested: { topic?: string | null; subject?: string | null; difficulty?: string | null }
): GeneratedQuestionCandidate | null {
  const record = raw && typeof raw === "object" ? raw : {};
  const nested = record.question && typeof record.question === "object" ? record.question : record;
  const subject = String(nested.subject ?? requested.subject ?? "").trim();
  const topic = String(nested.topic ?? requested.topic ?? "").trim();
  const prompt = String(nested.prompt ?? nested.question ?? "").trim();
  const options = normalizeOptions(nested.options);
  const correctOption = normalizeOptionId(nested.correct_option ?? nested.correctOption ?? nested.answer);
  const solutionSteps = normalizeSolutionSteps(nested.solution_steps ?? nested.solutionSteps ?? nested.explanation_steps);

  if (!subject || !topic || !prompt || !options || !correctOption) {
    return null;
  }

  return {
    subject,
    topic,
    difficulty: normalizeDifficulty(nested.difficulty ?? requested.difficulty),
    prompt,
    options,
    correct_option: correctOption,
    solution_steps: solutionSteps
  };
}

function sanitizeExplanation(raw: any): ExplanationResult | null {
  const record = raw && typeof raw === "object" ? raw : {};
  const nested = record.explanation && typeof record.explanation === "object" ? record.explanation : record;
  const solutionSteps = normalizeSolutionSteps(nested.solution_steps ?? nested.solutionSteps ?? nested.steps);
  const aiSolution = String(nested.summary ?? nested.explanation ?? nested.answer ?? "").trim();

  if (solutionSteps.length === 0 && !aiSolution) {
    return null;
  }

  return {
    solutionSteps,
    aiSolution: aiSolution || solutionSteps.join(" "),
    source: "ollama"
  };
}

function sanitizeHint(raw: any): HintResult | null {
  const record = raw && typeof raw === "object" ? raw : {};
  const hint = String(record.hint ?? record.clue ?? record.tip ?? "").trim();
  if (!hint) {
    return null;
  }

  return {
    hint,
    source: "ollama"
  };
}

function formatOptionsForPrompt(options: Record<OptionId, string>) {
  return OPTION_IDS.map((id) => `${id}. ${options[id]}`).join("\n");
}

async function callOllama(prompt: string) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), env.plannerLlmTimeoutMs);

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

    return text;
  } finally {
    clearTimeout(timer);
  }
}

async function generateQuestionWithOllama(
  examType: string,
  requested: { topic?: string | null; subject?: string | null; difficulty?: string | null }
): Promise<GeneratedQuestionCandidate> {
  const prompt = [
    "You generate a single academically correct multiple-choice question.",
    "Return ONLY valid JSON.",
    "Output keys must be exactly: subject, topic, difficulty, prompt, options, correct_option, solution_steps.",
    "options must be an object with exactly four keys: A, B, C, D.",
    "correct_option must be one of A, B, C, D.",
    "solution_steps must be an array of 2 to 5 short instructional strings.",
    "Keep the question aligned to competitive exam prep.",
    "",
    `Exam type: ${examType}`,
    `Subject hint: ${requested.subject ?? "General"}`,
    `Topic focus: ${requested.topic ?? "General Concepts"}`,
    `Difficulty: ${normalizeDifficulty(requested.difficulty)}`,
    "",
    "Make the topic match the requested topic closely.",
    "Use concise but realistic MCQ wording.",
    "Do not include markdown fences or extra commentary."
  ].join("\n");

  const rawText = await callOllama(prompt);
  const parsed = tryParseJson(rawText);
  const candidate = sanitizeQuestionCandidate(parsed, requested);

  if (!candidate) {
    throw new Error("Ollama question payload failed validation");
  }

  return candidate;
}

async function persistGeneratedQuestion(examType: string, question: GeneratedQuestionCandidate): Promise<StoredQuestionRow> {
  const { data, error } = await supabaseService
    .from("questions")
    .insert({
      exam_type: examType,
      subject: question.subject,
      topic: question.topic,
      difficulty: DIFFICULTIES.has(question.difficulty) ? question.difficulty : "adaptive",
      prompt: question.prompt,
      options: question.options,
      correct_option: question.correct_option,
      solution_steps: question.solution_steps
    })
    .select("id,subject,topic,difficulty,prompt,options,correct_option,solution_steps")
    .single();

  if (error || !data) {
    throw error ?? new Error("Failed to persist generated adaptive question");
  }

  return {
    id: data.id,
    subject: data.subject,
    topic: data.topic,
    difficulty: normalizeDifficulty(data.difficulty),
    prompt: data.prompt,
    options: normalizeOptions(data.options) ?? {
      A: "Option A",
      B: "Option B",
      C: "Option C",
      D: "Option D"
    },
    correct_option: normalizeOptionId(data.correct_option) ?? "A",
    solution_steps: normalizeSolutionSteps(data.solution_steps)
  };
}

function textScore(candidate: string, target?: string | null) {
  const left = candidate.trim().toLowerCase();
  const right = String(target ?? "").trim().toLowerCase();
  if (!left || !right) return 0;
  if (left === right) return 100;
  if (left.includes(right) || right.includes(left)) return 70;

  const leftTokens = new Set(left.split(/[^a-z0-9]+/).filter(Boolean));
  const rightTokens = new Set(right.split(/[^a-z0-9]+/).filter(Boolean));
  let overlap = 0;
  rightTokens.forEach((token) => {
    if (leftTokens.has(token)) overlap += 1;
  });
  return overlap * 10;
}

function sanitizeStoredQuestion(row: any): StoredQuestionRow | null {
  const options = normalizeOptions(row?.options);
  const correctOption = normalizeOptionId(row?.correct_option);
  if (!row?.id || !row?.subject || !row?.topic || !row?.prompt || !options || !correctOption) {
    return null;
  }

  return {
    id: String(row.id),
    subject: String(row.subject),
    topic: String(row.topic),
    difficulty: normalizeDifficulty(row.difficulty),
    prompt: String(row.prompt),
    options,
    correct_option: correctOption,
    solution_steps: normalizeSolutionSteps(row.solution_steps)
  };
}

function buildSupabaseInFilter(values: string[]) {
  const escaped = values
    .map((value) => String(value ?? "").trim())
    .filter(Boolean)
    .map((value) => `"${value.replace(/"/g, '\\"')}"`);

  return `(${escaped.join(",")})`;
}

async function fetchQuestionCandidates(
  examType: string,
  requested: { topic?: string | null; subject?: string | null; difficulty?: string | null; excludeQuestionIds?: string[] }
) {
  let query = supabaseService
    .from("questions")
    .select("id,subject,topic,difficulty,prompt,options,correct_option,solution_steps")
    .eq("exam_type", examType)
    .limit(50);

  if (requested.difficulty) {
    query = query.eq("difficulty", normalizeDifficulty(requested.difficulty));
  }

  if (requested.excludeQuestionIds && requested.excludeQuestionIds.length > 0) {
    query = query.not("id", "in", buildSupabaseInFilter(requested.excludeQuestionIds));
  }

  const { data, error } = await query;
  if (error) {
    throw error;
  }

  return (data ?? [])
    .map((row) => sanitizeStoredQuestion(row))
    .filter((row): row is StoredQuestionRow => Boolean(row));
}

async function pickFallbackQuestion(
  examType: string,
  requested: { topic?: string | null; subject?: string | null; difficulty?: string | null; excludeQuestionIds?: string[] }
): Promise<StoredQuestionRow | null> {
  let candidates = await fetchQuestionCandidates(examType, requested);
  if (candidates.length === 0) {
    candidates = await fetchQuestionCandidates(examType, {
      ...requested,
      difficulty: null
    });
  }
  if (candidates.length === 0) {
    return null;
  }

  return [...candidates]
    .sort((left, right) => {
      const leftScore = textScore(left.topic, requested.topic) + textScore(left.subject, requested.subject);
      const rightScore = textScore(right.topic, requested.topic) + textScore(right.subject, requested.subject);
      if (rightScore !== leftScore) {
        return rightScore - leftScore;
      }

      const promptCompare = left.prompt.localeCompare(right.prompt);
      if (promptCompare !== 0) {
        return promptCompare;
      }

      return left.id.localeCompare(right.id);
    })[0] ?? null;
}

export async function getAdaptiveQuestion(
  input: GenerateAdaptiveQuestionInput
): Promise<GenerateAdaptiveQuestionResult | null> {
  const examType = await getLatestExamType(input.userId);
  const requested = {
    topic: input.topic ?? null,
    subject: input.subject ?? null,
    difficulty: input.difficulty ?? "adaptive",
    excludeQuestionIds: input.excludeQuestionIds ?? []
  };

  if (requested.topic || requested.subject) {
    try {
      const generated = await generateQuestionWithOllama(examType, requested);
      const stored = await persistGeneratedQuestion(examType, generated);
      return { question: stored, source: "ollama" };
    } catch (error) {
      console.warn("[adaptive] Ollama question generation failed, using DB fallback:", error instanceof Error ? error.message : error);
    }
  }

  const fallback = await pickFallbackQuestion(examType, requested);
  if (!fallback) {
    return null;
  }

  return { question: fallback, source: "db" };
}

export async function getQuestionHint(
  question: {
    subject: string;
    topic: string;
    difficulty?: string | null;
    prompt: string;
    options: Record<string, string> | null;
    solution_steps: unknown;
  },
  selectedOption?: string | null
): Promise<HintResult> {
  const storedSteps = normalizeSolutionSteps(question.solution_steps);
  if (storedSteps.length > 0) {
    return {
      hint: storedSteps[0],
      source: "stored"
    };
  }

  try {
    const prompt = [
      "You provide one concise study hint for a multiple-choice question.",
      "Do not reveal the final answer directly.",
      "Return ONLY valid JSON with key: hint.",
      "",
      `Subject: ${question.subject}`,
      `Topic: ${question.topic}`,
      `Difficulty: ${normalizeDifficulty(question.difficulty)}`,
      "Question:",
      question.prompt,
      "",
      "Options:",
      formatOptionsForPrompt(normalizeOptions(question.options) ?? {
        A: "Option A",
        B: "Option B",
        C: "Option C",
        D: "Option D"
      }),
      "",
      `Student selected: ${normalizeOptionId(selectedOption) ?? "unknown"}`
    ].join("\n");

    const rawText = await callOllama(prompt);
    const parsed = tryParseJson(rawText);
    const hint = sanitizeHint(parsed);
    if (!hint) {
      throw new Error("Ollama hint payload failed validation");
    }

    return hint;
  } catch (error) {
    console.warn("[adaptive] Ollama hint generation failed:", error instanceof Error ? error.message : error);
    return {
      hint: "Focus on the core definition and eliminate options that violate it before computing anything.",
      source: "fallback"
    };
  }
}

export async function getQuestionExplanation(
  question: {
    id: string;
    subject: string;
    topic: string;
    difficulty?: string | null;
    prompt: string;
    options: Record<string, string> | null;
    correct_option: string;
    solution_steps: unknown;
  },
  selectedOption?: string | null
): Promise<ExplanationResult> {
  const storedSolutionSteps = normalizeSolutionSteps(question.solution_steps);
  if (storedSolutionSteps.length > 0) {
    return {
      solutionSteps: storedSolutionSteps,
      aiSolution: storedSolutionSteps.join(" "),
      source: "stored"
    };
  }

  try {
    const prompt = [
      "You explain a multiple-choice question solution.",
      "Return ONLY valid JSON.",
      "Output keys must be exactly: solution_steps, summary.",
      "solution_steps must be an array of 2 to 5 short instructional strings.",
      "",
      `Subject: ${question.subject}`,
      `Topic: ${question.topic}`,
      `Difficulty: ${normalizeDifficulty(question.difficulty)}`,
      "Question:",
      question.prompt,
      "",
      "Options:",
      formatOptionsForPrompt(normalizeOptions(question.options) ?? {
        A: "Option A",
        B: "Option B",
        C: "Option C",
        D: "Option D"
      }),
      "",
      `Correct option: ${normalizeOptionId(question.correct_option) ?? "A"}`,
      `Student selected: ${normalizeOptionId(selectedOption) ?? "unknown"}`,
      "Explain why the correct option is right and why the selected option is wrong if applicable."
    ].join("\n");

    const rawText = await callOllama(prompt);
    const parsed = tryParseJson(rawText);
    const explanation = sanitizeExplanation(parsed);
    if (!explanation) {
      throw new Error("Ollama explanation payload failed validation");
    }

    await supabaseService
      .from("questions")
      .update({ solution_steps: explanation.solutionSteps })
      .eq("id", question.id);

    return explanation;
  } catch (error) {
    console.warn("[adaptive] Ollama explanation generation failed:", error instanceof Error ? error.message : error);
    const correctOption = normalizeOptionId(question.correct_option) ?? "A";
    const fallbackSteps = [
      `Start by identifying what the question is asking in ${question.topic}.`,
      `Compare each option against the core concept and eliminate the mismatches.`,
      `Option ${correctOption} is correct because it best matches the required concept or calculation.`
    ];

    return {
      solutionSteps: fallbackSteps,
      aiSolution: fallbackSteps.join(" "),
      source: "fallback"
    };
  }
}
