import { spawn } from "child_process";
import path from "path";
import { env } from "../lib/env";

export type TranscriptSegment = {
  text: string;
  start: number;
  duration: number;
};

type TranscriptScriptSuccess = {
  ok: true;
  videoId: string;
  language: string | null;
  source: "manual" | "generated" | "unknown";
  transcript: string;
  segments: TranscriptSegment[];
};

type TranscriptScriptFailure = {
  ok: false;
  errorCode: string;
  message: string;
};

type TranscriptScriptPayload = TranscriptScriptSuccess | TranscriptScriptFailure;

export type TranscriptResult = {
  videoId: string;
  language: string | null;
  source: "manual" | "generated" | "unknown";
  transcript: string;
  segments: TranscriptSegment[];
  totalSegments: number;
  transcriptLength: number;
};

function mapTranscriptError(code: string, message: string) {
  switch (code) {
    case "VIDEO_NOT_FOUND":
      return { status: 404, code, message };
    case "LANGUAGE_NOT_AVAILABLE":
    case "TRANSCRIPT_UNAVAILABLE":
      return { status: 422, code, message };
    case "FETCH_TIMEOUT":
      return { status: 504, code, message };
    default:
      return { status: 500, code: "TRANSCRIPT_FETCH_FAILED", message };
  }
}

function parsePayload(stdout: string): TranscriptScriptPayload {
  try {
    return JSON.parse(stdout) as TranscriptScriptPayload;
  } catch {
    return {
      ok: false,
      errorCode: "INVALID_SCRIPT_OUTPUT",
      message: "Transcript script returned invalid output."
    };
  }
}

export async function fetchYoutubeTranscript(
  videoId: string,
  preferredLanguages: string[] = ["en", "en-IN", "hi"]
): Promise<TranscriptResult> {
  const scriptPath = path.resolve(process.cwd(), "scripts", "youtube_transcript_fetch.py");
  const timeoutMs = Math.max(5000, env.youtubeTranscriptTimeoutMs);

  const payload = await new Promise<TranscriptScriptPayload>((resolve) => {
    const args = [
      scriptPath,
      "--video-id",
      videoId,
      "--languages",
      preferredLanguages.join(","),
      "--timeout-ms",
      String(timeoutMs)
    ];

    const child = spawn(env.pythonBin, args, {
      windowsHide: true
    });

    let stdout = "";
    let stderr = "";
    let resolved = false;

    const timer = setTimeout(() => {
      if (resolved) return;
      resolved = true;
      child.kill();
      resolve({
        ok: false,
        errorCode: "FETCH_TIMEOUT",
        message: "Transcript fetch timed out."
      });
    }, timeoutMs + 3000);

    child.stdout.on("data", (chunk) => {
      stdout += String(chunk ?? "");
    });

    child.stderr.on("data", (chunk) => {
      stderr += String(chunk ?? "");
    });

    child.on("error", (error) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      resolve({
        ok: false,
        errorCode: "PYTHON_EXECUTION_FAILED",
        message: error.message || "Unable to execute transcript helper."
      });
    });

    child.on("close", (code) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);

      const parsed = parsePayload(stdout.trim());
      if (parsed.ok) {
        resolve(parsed);
        return;
      }
      const failed = parsed as TranscriptScriptFailure;

      const derivedErrorCode =
        failed.errorCode ||
        (code === 0 ? "TRANSCRIPT_UNAVAILABLE" : "PYTHON_SCRIPT_FAILED");

      resolve({
        ok: false,
        errorCode: derivedErrorCode,
        message: failed.message || stderr.trim() || "Unable to fetch transcript."
      });
    });
  });

  if (!payload.ok) {
    const failed = payload as TranscriptScriptFailure;
    const mapped = mapTranscriptError(failed.errorCode, failed.message);
    const error = new Error(mapped.message) as Error & { status?: number; code?: string };
    error.status = mapped.status;
    error.code = mapped.code;
    throw error;
  }

  return {
    videoId: payload.videoId,
    language: payload.language,
    source: payload.source,
    transcript: payload.transcript,
    segments: payload.segments,
    totalSegments: payload.segments.length,
    transcriptLength: payload.transcript.length
  };
}
