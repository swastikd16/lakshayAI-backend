import { env } from "../lib/env";

type MultimodalSummary = {
  notesMarkdown: string;
  conceptSummary: string;
  keyTopics: string[];
  source: "ollama" | "fallback";
};

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

function normalizeList(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item ?? "").trim()).filter(Boolean);
}

function normalizeMermaid(value: unknown) {
  const raw = String(value ?? "").trim();
  if (!raw) {
    return "flowchart TD\n  A[Topic] --> B[Core idea]\n  B --> C[Important formula]\n  C --> D[Common mistakes]";
  }
  const cleaned = raw.replace(/^```mermaid\s*/i, "").replace(/^```\s*/i, "").replace(/```\s*$/i, "").trim();
  if (!/^flowchart|^graph|^mindmap/i.test(cleaned)) {
    return `flowchart TD\n  A[Topic] --> B[${cleaned.replace(/\n+/g, " ").slice(0, 40)}]`;
  }
  return cleaned;
}

function buildFallbackSummary(transcript: string): MultimodalSummary {
  const firstLines = transcript
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 5);

  const summary = firstLines.join(" ").slice(0, 320) || "The video discusses the core concept and its applications.";
  const notesMarkdown = [
    "## Quick Summary",
    summary,
    "",
    "## Key Notes",
    "- Identify the main concept and why it matters.",
    "- Note formulas/definitions used repeatedly.",
    "- Capture one example and one common mistake.",
    "",
    "## Revision Prompt",
    "- Explain the concept in your own words in under 2 minutes."
  ].join("\n");

  return {
    notesMarkdown,
    conceptSummary: summary,
    keyTopics: ["Main concept", "Definition", "Example", "Revision"],
    source: "fallback"
  };
}

export async function generateMultimodalSummary(transcript: string): Promise<MultimodalSummary> {
  const clippedTranscript = transcript.slice(0, Math.max(2000, env.multimodalMaxTranscriptChars));
  const fallback = buildFallbackSummary(clippedTranscript);

  const prompt = [
    "You are an educational content processor.",
    "Create structured notes from a YouTube transcript for exam prep students.",
    "Return only JSON with exact keys:",
    "notesMarkdown, conceptSummary, keyTopics",
    "",
    "Rules:",
    "- notesMarkdown should use headings and bullet points.",
    "- conceptSummary should be 4-6 concise sentences.",
    "- keyTopics should be 4-8 short strings.",
    "",
    "Transcript:",
    clippedTranscript
  ].join("\n");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.max(5000, env.plannerLlmTimeoutMs));

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
          temperature: 0.2
        }
      })
    });

    if (!response.ok) {
      return fallback;
    }

    const payload = (await response.json()) as any;
    const content = String(payload?.response ?? "").trim();
    if (!content) {
      return fallback;
    }

    const parsed = JSON.parse(extractJsonCandidate(content)) as Record<string, unknown>;
    const notesMarkdown = String(parsed.notesMarkdown ?? "").trim() || fallback.notesMarkdown;
    const conceptSummary = String(parsed.conceptSummary ?? "").trim() || fallback.conceptSummary;
    const keyTopics = normalizeList(parsed.keyTopics);

    return {
      notesMarkdown,
      conceptSummary,
      keyTopics: keyTopics.length ? keyTopics.slice(0, 8) : fallback.keyTopics,
      source: "ollama"
    };
  } catch {
    return fallback;
  } finally {
    clearTimeout(timeout);
  }
}

type MermaidResult = {
  mermaidCode: string;
  source: "ollama" | "fallback";
};

function buildFallbackMermaid(): MermaidResult {
  return {
    mermaidCode: "flowchart TD\n  A[Main concept] --> B[Definition]\n  B --> C[Example]\n  C --> D[Revision]",
    source: "fallback"
  };
}

export async function generateMermaidFromTranscript(transcript: string): Promise<MermaidResult> {
  const clippedTranscript = transcript.slice(0, Math.max(2000, env.multimodalMaxTranscriptChars));
  const fallback = buildFallbackMermaid();

  const prompt = [
    "You are an educational visual-note generator.",
    "Generate a concise Mermaid flowchart from this transcript.",
    "Return only JSON with exact key: mermaidCode",
    "Rules:",
    "- mermaidCode must be valid Mermaid flowchart syntax.",
    "- Do not add markdown code fences.",
    "- Keep diagram compact and concept-focused.",
    "",
    "Transcript:",
    clippedTranscript
  ].join("\n");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.max(5000, env.plannerLlmTimeoutMs));

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
          temperature: 0.2
        }
      })
    });

    if (!response.ok) {
      return fallback;
    }

    const payload = (await response.json()) as any;
    const content = String(payload?.response ?? "").trim();
    if (!content) {
      return fallback;
    }

    const parsed = JSON.parse(extractJsonCandidate(content)) as Record<string, unknown>;
    return {
      mermaidCode: normalizeMermaid(parsed.mermaidCode),
      source: "ollama"
    };
  } catch {
    return fallback;
  } finally {
    clearTimeout(timeout);
  }
}
