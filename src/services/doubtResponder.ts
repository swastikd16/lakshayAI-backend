import { randomUUID } from "crypto";
import { env } from "../lib/env";
import { buildAssistantReply as buildDeterministicReply } from "./deterministicResponder";

type AssistantStep = {
  title: string;
  body: string;
};

export type DoubtAssistantReply = {
  contentText: string;
  structuredResponse: {
    title: string;
    summary: string;
    steps: AssistantStep[];
    equations: string[];
    sources: string[];
    confidence: number;
  };
  confidence: number; // 0..1 for DB compatibility
  sources: string[];
};

export type DoubtReplyMeta = {
  provider: "gemini" | "deterministic" | "canned";
  geminiAttempted: boolean;
  traceId: string;
};

export type DoubtReplyResult = {
  reply: DoubtAssistantReply;
  meta: DoubtReplyMeta;
};

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function debugLog(traceId: string, message: string, details?: Record<string, unknown>) {
  if (!env.doubtAiDebug) return;
  const payload = details ? ` ${JSON.stringify(details)}` : "";
  // eslint-disable-next-line no-console
  console.log(`[doubt][${traceId}] ${message}${payload}`);
}

function extractJsonCandidate(text: string) {
  const trimmed = text.trim().replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```\s*$/i, "").trim();
  if (trimmed.startsWith("{")) return trimmed;

  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) {
    return trimmed.slice(start, end + 1);
  }

  return trimmed;
}

function parseGeminiTextResponse(raw: any): string {
  const parts = raw?.candidates?.[0]?.content?.parts;
  const text = Array.isArray(parts)
    ? parts
        .map((part: any) => (typeof part?.text === "string" ? part.text : ""))
        .join("\n")
        .trim()
    : "";

  if (!text) {
    throw new Error("Gemini returned no parseable text.");
  }

  return text;
}

function uniqueStrings(values: string[]) {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function buildNcertSources(questionText: string) {
  const q = questionText.toLowerCase();
  const physics = [
    "NCERT Class 11 Physics, Chapter 2: Units and Measurements",
    "NCERT Class 11 Physics, Chapter 6: Work, Energy and Power",
    "NCERT Class 12 Physics, Chapter 1: Electric Charges and Fields",
    "NCERT Class 12 Physics, Chapter 2: Electrostatic Potential and Capacitance"
  ];
  const chemistry = [
    "NCERT Class 11 Chemistry, Chapter 1: Some Basic Concepts of Chemistry",
    "NCERT Class 11 Chemistry, Chapter 2: Structure of Atom",
    "NCERT Class 11 Chemistry, Chapter 3: Classification of Elements and Periodicity in Properties"
  ];
  const maths = [
    "NCERT Class 11 Mathematics, Chapter 2: Relations and Functions",
    "NCERT Class 11 Mathematics, Chapter 13: Limits and Derivatives",
    "NCERT Class 12 Mathematics, Chapter 6: Applications of Derivatives"
  ];

  if (
    q.includes("electric") ||
    q.includes("charge") ||
    q.includes("field") ||
    q.includes("gauss") ||
    q.includes("force") ||
    q.includes("energy") ||
    q.includes("work") ||
    q.includes("motion") ||
    q.includes("lens") ||
    q.includes("mirror") ||
    q.includes("wave") ||
    q.includes("magnetic") ||
    q.includes("current")
  ) {
    return physics.slice(0, 2);
  }

  if (
    q.includes("mole") ||
    q.includes("acid") ||
    q.includes("base") ||
    q.includes("salt") ||
    q.includes("organic") ||
    q.includes("periodic") ||
    q.includes("bond") ||
    q.includes("redox") ||
    q.includes("reaction") ||
    q.includes("chemistry")
  ) {
    return chemistry.slice(0, 2);
  }

  if (
    q.includes("integral") ||
    q.includes("derivative") ||
    q.includes("limit") ||
    q.includes("vector") ||
    q.includes("matrix") ||
    q.includes("probability") ||
    q.includes("trigon") ||
    q.includes("sequence") ||
    q.includes("series") ||
    q.includes("coordinate") ||
    q.includes("math")
  ) {
    return maths.slice(0, 2);
  }

  return [
    "NCERT Class 11 Science, Chapter 1: Physical World",
    "NCERT Class 11 Science, Chapter 2: Units and Measurements"
  ];
}

function isNcertStyleSource(value: unknown) {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  return /^NCERT\s+Class\s+\d+\s+[A-Za-z ]+(?:,|\s+-|\s+)?\s*Chapter/i.test(trimmed);
}

function normalizeSources(questionText: string, sources: unknown): string[] {
  const candidateSources = Array.isArray(sources) ? sources.filter(isNcertStyleSource).map((item) => String(item).trim()) : [];
  const fallbackSources = buildNcertSources(questionText);
  return uniqueStrings(candidateSources.length > 0 ? candidateSources.slice(0, 2) : fallbackSources).slice(0, 2);
}

function normalizeConfidenceToRatio(value: unknown, fallbackPercent = 96) {
  if (typeof value !== "number" || Number.isNaN(value)) {
    return clamp(fallbackPercent / 100, 0.01, 0.9999);
  }

  const scaled = value > 1 ? value / 100 : value;
  return clamp(Number(scaled.toFixed(4)), 0.01, 0.9999);
}

function normalizeSteps(steps: unknown, fallbackText: string): AssistantStep[] {
  const parsedSteps = Array.isArray(steps)
    ? steps
        .map((step, index) => {
          if (typeof step === "string") {
            const body = step.trim();
            return body ? { title: `Step ${index + 1}`, body } : null;
          }

          if (step && typeof step === "object") {
            const record = step as Record<string, unknown>;
            const title = String(record.title ?? `Step ${index + 1}`).trim() || `Step ${index + 1}`;
            const body = String(record.body ?? record.text ?? "").trim();
            if (body) {
              return { title, body };
            }
          }

          return null;
        })
        .filter((step): step is AssistantStep => step !== null)
    : [];

  if (parsedSteps.length > 0) {
    return parsedSteps.slice(0, 5);
  }

  return [
    { title: "Read the question", body: fallbackText },
    { title: "Use NCERT concept", body: "Map the doubt to the exact NCERT definition, law, or formula." }
  ];
}

function normalizeEquations(equations: unknown) {
  if (!Array.isArray(equations)) {
    return ["Use the relevant NCERT formula from the chapter."];
  }

  const cleaned = equations.map((item) => String(item).trim()).filter(Boolean);
  return cleaned.length > 0 ? cleaned.slice(0, 6) : ["Use the relevant NCERT formula from the chapter."];
}

function normalizeStructuredResponse(questionText: string, raw: unknown, fallbackText: string, fallbackPercent: number) {
  const record = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const summary = String(record.summary ?? record.explanation ?? fallbackText).trim() || fallbackText;
  const sources = normalizeSources(questionText, record.sources);
  const confidence = normalizeConfidenceToRatio(record.confidence, fallbackPercent);

  return {
    title: String(record.title ?? "NCERT-based solution").trim() || "NCERT-based solution",
    summary,
    steps: normalizeSteps(record.steps, fallbackText),
    equations: normalizeEquations(record.equations),
    sources,
    confidence
  };
}

function getCannedReply(questionText: string): DoubtAssistantReply {
  const sources = buildNcertSources(questionText).slice(0, 2);
  const confidence = 0.9;
  const summary = "I can help with this. Based on NCERT, start by identifying the core concept, writing the governing relation, then substituting known values step-by-step.";
  return {
    contentText: summary,
    structuredResponse: {
      title: "NCERT quick answer",
      summary,
      steps: [
        { title: "Identify concept", body: "Locate the exact NCERT chapter concept used in this question." },
        { title: "Apply relation", body: "Write the governing formula/definition and substitute the given values." },
        { title: "Check result", body: "Verify units/sign/concept consistency with NCERT examples." }
      ],
      equations: ["Knowns -> NCERT formula -> substitution -> final result"],
      sources,
      confidence
    },
    confidence,
    sources
  };
}

async function callGemini(questionText: string, traceId: string): Promise<DoubtAssistantReply> {
  if (!env.geminiApiKey) {
    throw new Error("GEMINI_API_KEY not set");
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), env.doubtAiTimeoutMs);

  const systemPrompt = [
    "You are Lakshay AI's doubt solver.",
    "Use only NCERT textbook knowledge.",
    "Do not use or cite any non-NCERT source.",
    "If NCERT is insufficient, say so briefly and still answer with NCERT framing.",
    "Return only valid JSON with exact keys: title, summary, steps, equations, sources, confidence.",
    "steps: array of objects with title and body.",
    "equations: array of strings.",
    "sources: NCERT chapter strings only.",
    "confidence: number from 0 to 100."
  ].join(" ");

  debugLog(traceId, "gemini start", {
    model: env.geminiModel,
    promptLength: questionText.length,
    timeoutMs: env.doubtAiTimeoutMs
  });

  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${env.geminiModel}:generateContent?key=${env.geminiApiKey}`,
      {
        method: "POST",
        signal: controller.signal,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          systemInstruction: {
            parts: [{ text: systemPrompt }]
          },
          contents: [
            {
              role: "user",
              parts: [
                {
                  text: [
                    "Answer this academic doubt using NCERT only.",
                    "Question:",
                    questionText
                  ].join("\n")
                }
              ]
            }
          ],
          generationConfig: {
            responseMimeType: "application/json",
            temperature: 0.2,
            maxOutputTokens: 1200
          }
        })
      }
    );

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`Gemini HTTP ${response.status}: ${body.slice(0, 300)}`);
    }

    const json = (await response.json()) as any;
    const text = parseGeminiTextResponse(json);
    const parsed = JSON.parse(extractJsonCandidate(text)) as any;
    const structuredResponse = normalizeStructuredResponse(questionText, parsed, "Here is the NCERT-based solution.", 96);

    debugLog(traceId, "gemini success", {
      sourceCount: structuredResponse.sources.length,
      confidence: structuredResponse.confidence
    });

    return {
      contentText: structuredResponse.summary,
      structuredResponse,
      confidence: structuredResponse.confidence,
      sources: structuredResponse.sources
    };
  } finally {
    clearTimeout(timer);
  }
}

function buildFallbackReply(questionText: string): DoubtAssistantReply {
  const reply = buildDeterministicReply(questionText);
  const sources = normalizeSources(questionText, reply.sources);
  const confidence = normalizeConfidenceToRatio(reply.confidence, 96);

  return {
    contentText: reply.contentText,
    structuredResponse: {
      title: reply.structuredResponse.title,
      summary: reply.structuredResponse.summary,
      steps: reply.structuredResponse.steps,
      equations: reply.structuredResponse.equations,
      sources,
      confidence
    },
    confidence,
    sources
  };
}

export async function buildDoubtAssistantReply(questionText: string): Promise<DoubtReplyResult> {
  const traceId = randomUUID();

  try {
    if (env.geminiApiKey) {
      const reply = await callGemini(questionText, traceId);
      return {
        reply,
        meta: {
          provider: "gemini",
          geminiAttempted: true,
          traceId
        }
      };
    }

    const deterministicReply = buildFallbackReply(questionText);
    return {
      reply: deterministicReply,
      meta: {
        provider: "deterministic",
        geminiAttempted: false,
        traceId
      }
    };
  } catch (error) {
    debugLog(traceId, "gemini failure", {
      error: error instanceof Error ? error.message : String(error)
    });

    try {
      const deterministicReply = buildFallbackReply(questionText);
      return {
        reply: deterministicReply,
        meta: {
          provider: "deterministic",
          geminiAttempted: Boolean(env.geminiApiKey),
          traceId
        }
      };
    } catch (fallbackError) {
      debugLog(traceId, "deterministic failure", {
        error: fallbackError instanceof Error ? fallbackError.message : String(fallbackError)
      });
      return {
        reply: getCannedReply(questionText),
        meta: {
          provider: "canned",
          geminiAttempted: Boolean(env.geminiApiKey),
          traceId
        }
      };
    }
  }
}
