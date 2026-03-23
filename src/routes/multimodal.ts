import { Router } from "express";
import { sendError, sendOk } from "../lib/response";
import { requireAuth } from "../middleware/auth";
import { parseYoutubeVideoId, buildCanonicalYoutubeUrl } from "../services/youtubeUrlService";
import { fetchYoutubeTranscript } from "../services/youtubeTranscriptService";
import { generateMultimodalSummary } from "../services/multimodalSummarizerService";
import { supabaseService } from "../lib/supabase";

type VideoNotesRow = {
  id: string;
  youtube_url: string;
  video_id: string;
  video_title: string | null;
  transcript_language: string | null;
  transcript_source: string | null;
  transcript_text: string;
  transcript_segments_json: any[];
  notes_markdown: string;
  concept_summary: string;
  mermaid_code: string;
  key_topics: string[];
  status: string;
  created_at: string;
  updated_at: string;
};

function mapRowToDto(row: VideoNotesRow) {
  return {
    id: row.id,
    youtubeUrl: row.youtube_url,
    videoId: row.video_id,
    videoTitle: row.video_title,
    transcript: row.transcript_text,
    transcriptMeta: {
      language: row.transcript_language,
      source: row.transcript_source,
      segmentCount: Array.isArray(row.transcript_segments_json) ? row.transcript_segments_json.length : 0,
      transcriptLength: String(row.transcript_text ?? "").length
    },
    transcriptSegments: Array.isArray(row.transcript_segments_json) ? row.transcript_segments_json : [],
    notesMarkdown: row.notes_markdown,
    conceptSummary: row.concept_summary,
    mermaidCode: row.mermaid_code,
    keyTopics: Array.isArray(row.key_topics) ? row.key_topics : [],
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export const multimodalRouter = Router();

multimodalRouter.post("/youtube/process", requireAuth, async (req, res) => {
  const auth = req.auth;
  if (!auth) {
    return sendError(res, 401, "Unauthorized", "UNAUTHORIZED");
  }

  const url = typeof req.body?.url === "string" ? req.body.url.trim() : "";
  const languagePreference = Array.isArray(req.body?.languagePreference)
    ? req.body.languagePreference.map((item: unknown) => String(item).trim()).filter(Boolean)
    : ["en", "en-IN", "hi"];

  if (!url) {
    return sendError(res, 400, "url is required", "BAD_REQUEST");
  }

  let videoId = "";
  try {
    videoId = parseYoutubeVideoId(url);
  } catch (error: any) {
    return sendError(res, 400, error?.message ?? "Invalid YouTube URL", "INVALID_YOUTUBE_URL");
  }

  const youtubeUrl = buildCanonicalYoutubeUrl(videoId);

  try {
    const transcript = await fetchYoutubeTranscript(videoId, languagePreference);
    const summary = await generateMultimodalSummary(transcript.transcript);

    const { data: inserted, error: insertError } = await supabaseService
      .from("multimodal_video_notes")
      .insert({
        user_id: auth.userId,
        youtube_url: youtubeUrl,
        video_id: videoId,
        video_title: null,
        transcript_language: transcript.language,
        transcript_source: transcript.source,
        transcript_text: transcript.transcript,
        transcript_segments_json: transcript.segments,
        notes_markdown: summary.notesMarkdown,
        concept_summary: summary.conceptSummary,
        mermaid_code: summary.mermaidCode,
        key_topics: summary.keyTopics,
        status: "completed"
      })
      .select(
        "id,youtube_url,video_id,video_title,transcript_language,transcript_source,transcript_text,transcript_segments_json,notes_markdown,concept_summary,mermaid_code,key_topics,status,created_at,updated_at"
      )
      .single();

    if (insertError || !inserted) {
      return sendError(res, 500, insertError?.message ?? "Unable to save processed video notes", "VIDEO_NOTES_SAVE_FAILED");
    }

    return sendOk(res, mapRowToDto(inserted as VideoNotesRow), {
      summarySource: summary.source
    });
  } catch (error: any) {
    const status = Number(error?.status ?? 500);
    const code = typeof error?.code === "string" ? error.code : "VIDEO_PROCESS_FAILED";
    return sendError(res, status, error?.message ?? "Failed to process video", code);
  }
});

multimodalRouter.get("/youtube/history", requireAuth, async (req, res) => {
  const auth = req.auth;
  if (!auth) {
    return sendError(res, 401, "Unauthorized", "UNAUTHORIZED");
  }

  const limitRaw = Number(req.query.limit ?? 20);
  const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(50, Math.round(limitRaw))) : 20;

  const { data, error } = await supabaseService
    .from("multimodal_video_notes")
    .select(
      "id,youtube_url,video_id,video_title,transcript_language,transcript_source,transcript_text,transcript_segments_json,notes_markdown,concept_summary,mermaid_code,key_topics,status,created_at,updated_at"
    )
    .eq("user_id", auth.userId)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) {
    return sendError(res, 500, error.message, "VIDEO_NOTES_HISTORY_FAILED");
  }

  return sendOk(res, {
    items: (data ?? []).map((row: any) => mapRowToDto(row as VideoNotesRow))
  });
});

multimodalRouter.get("/youtube/:id", requireAuth, async (req, res) => {
  const auth = req.auth;
  if (!auth) {
    return sendError(res, 401, "Unauthorized", "UNAUTHORIZED");
  }

  const id = String(req.params.id ?? "").trim();
  if (!id) {
    return sendError(res, 400, "id is required", "BAD_REQUEST");
  }

  const { data, error } = await supabaseService
    .from("multimodal_video_notes")
    .select(
      "id,youtube_url,video_id,video_title,transcript_language,transcript_source,transcript_text,transcript_segments_json,notes_markdown,concept_summary,mermaid_code,key_topics,status,created_at,updated_at"
    )
    .eq("id", id)
    .eq("user_id", auth.userId)
    .maybeSingle();

  if (error) {
    return sendError(res, 500, error.message, "VIDEO_NOTES_FETCH_FAILED");
  }

  if (!data) {
    return sendError(res, 404, "Video notes item not found", "NOT_FOUND");
  }

  return sendOk(res, mapRowToDto(data as VideoNotesRow));
});
