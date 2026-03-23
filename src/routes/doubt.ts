import { Router } from "express";
import { sendError, sendOk } from "../lib/response";
import { supabaseService } from "../lib/supabase";
import { requireAuth } from "../middleware/auth";
import { buildDoubtAssistantReply } from "../services/doubtResponder";

type AttachmentPayload = {
  label?: string;
  detail?: string;
  fileName?: string;
  mimeType?: string;
  sizeBytes?: number;
};

async function getOrCreateLatestThread(userId: string) {
  const { data: latest, error } = await supabaseService
    .from("doubt_threads")
    .select("id,title,created_at,updated_at")
    .eq("user_id", userId)
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    throw error;
  }

  if (latest) {
    return latest;
  }

  const { data: created, error: createError } = await supabaseService
    .from("doubt_threads")
    .insert({
      user_id: userId,
      title: "Latest Doubt Thread",
      rag_enabled: true
    })
    .select("id,title,created_at,updated_at")
    .single();

  if (createError || !created) {
    throw createError ?? new Error("Unable to create thread");
  }

  return created;
}

async function fetchMessages(threadId: string) {
  const { data: messages, error } = await supabaseService
    .from("doubt_messages")
    .select("id,role,content_text,structured_response,confidence,sources,created_at")
    .eq("thread_id", threadId)
    .order("created_at", { ascending: true });

  if (error) {
    throw error;
  }

  const messageIds = (messages ?? []).map((item: any) => item.id);
  let attachmentMap = new Map<string, any>();

  if (messageIds.length > 0) {
    const { data: attachments } = await supabaseService
      .from("doubt_attachments")
      .select("message_id,file_name,mime_type,file_size_bytes,storage_path")
      .in("message_id", messageIds);

    attachmentMap = new Map((attachments ?? []).map((item: any) => [item.message_id, item]));
  }

  return (messages ?? []).map((item: any) => {
    const attachment = attachmentMap.get(item.id);

    return {
      id: item.id,
      role: item.role,
      contentText: item.content_text ?? "",
      structuredResponse: item.structured_response ?? null,
      confidence: item.confidence ?? null,
      sources: Array.isArray(item.sources) ? item.sources : [],
      createdAt: item.created_at,
      attachment: attachment
        ? {
            fileName: attachment.file_name,
            mimeType: attachment.mime_type,
            sizeBytes: attachment.file_size_bytes,
            storagePath: attachment.storage_path
          }
        : null
    };
  });
}

function safeId(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export const doubtRouter = Router();

doubtRouter.get("/threads/latest", requireAuth, async (req, res) => {
  const auth = req.auth;
  if (!auth) {
    return sendError(res, 401, "Unauthorized", "UNAUTHORIZED");
  }

  const thread = await getOrCreateLatestThread(auth.userId);
  const messages = await fetchMessages(thread.id);

  return sendOk(res, {
    thread: {
      id: thread.id,
      title: thread.title,
      createdAt: thread.created_at,
      updatedAt: thread.updated_at,
      ragEnabled: true
    },
    messages
  });
});

doubtRouter.post("/threads/delete", requireAuth, async (req, res) => {
  const auth = req.auth;
  if (!auth) {
    return sendError(res, 401, "Unauthorized", "UNAUTHORIZED");
  }

  const requestedThreadId = typeof req.body?.threadId === "string" ? req.body.threadId : null;
  let targetThreadId = requestedThreadId;

  if (!targetThreadId) {
    const { data: latest, error: latestError } = await supabaseService
      .from("doubt_threads")
      .select("id")
      .eq("user_id", auth.userId)
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (latestError) {
      return sendError(res, 500, latestError.message, "DOUBT_THREAD_LOOKUP_FAILED");
    }

    targetThreadId = latest?.id ?? null;
  }

  if (!targetThreadId) {
    return sendOk(res, { deleted: false, threadId: null });
  }

  const { data: threadLookup, error: threadLookupError } = await supabaseService
    .from("doubt_threads")
    .select("id")
    .eq("id", targetThreadId)
    .eq("user_id", auth.userId)
    .maybeSingle();

  if (threadLookupError) {
    return sendError(res, 500, threadLookupError.message, "DOUBT_THREAD_LOOKUP_FAILED");
  }

  if (!threadLookup) {
    return sendOk(res, { deleted: false, threadId: targetThreadId });
  }

  // Keep thread row; only clear chat history so loading latest thread never breaks.
  const { error: deleteMessagesError } = await supabaseService
    .from("doubt_messages")
    .delete()
    .eq("thread_id", targetThreadId);

  if (deleteMessagesError) {
    return sendError(res, 500, deleteMessagesError.message, "DOUBT_MESSAGES_DELETE_FAILED");
  }

  const { error: updateThreadError } = await supabaseService
    .from("doubt_threads")
    .update({ updated_at: new Date().toISOString() })
    .eq("id", targetThreadId)
    .eq("user_id", auth.userId);

  if (updateThreadError) {
    return sendError(res, 500, updateThreadError.message, "DOUBT_THREAD_UPDATE_FAILED");
  }

  return sendOk(res, { deleted: true, threadId: targetThreadId });
});

doubtRouter.post("/messages", requireAuth, async (req, res) => {
  const auth = req.auth;
  if (!auth) {
    return sendError(res, 401, "Unauthorized", "UNAUTHORIZED");
  }

  const { threadId, text, attachment } = req.body as {
    threadId?: string;
    text?: string;
    attachment?: AttachmentPayload;
  };

  if (!text || !text.trim()) {
    return sendError(res, 400, "text is required", "BAD_REQUEST");
  }

  const userText = text.trim();
  const aiResult = await buildDoubtAssistantReply(userText);

  let resolvedThreadId: string | null = threadId ?? null;
  let persistedUserMessage: any = null;
  let persistedAssistantMessage: any = null;

  if (!resolvedThreadId) {
    try {
      const thread = await getOrCreateLatestThread(auth.userId);
      resolvedThreadId = thread.id;
    } catch (threadError: any) {
      // eslint-disable-next-line no-console
      console.warn("[doubt] thread create/fetch failed; returning ephemeral response:", threadError?.message ?? threadError);
    }
  }

  if (resolvedThreadId) {
    try {
      const { data: userMessage, error: userMessageError } = await supabaseService
        .from("doubt_messages")
        .insert({
          thread_id: resolvedThreadId,
          role: "user",
          content_text: userText
        })
        .select("id,role,content_text,created_at")
        .single();

      if (userMessageError || !userMessage) {
        throw userMessageError ?? new Error("Unable to save user message");
      }

      persistedUserMessage = userMessage;

      if (attachment) {
        await supabaseService.from("doubt_attachments").insert({
          message_id: userMessage.id,
          bucket: "doubt-attachments",
          storage_path: `placeholder/${Date.now()}-${attachment.fileName ?? "diagram.txt"}`,
          file_name: attachment.fileName ?? attachment.label ?? "diagram-placeholder.txt",
          mime_type: attachment.mimeType ?? "text/plain",
          file_size_bytes: Number(attachment.sizeBytes ?? 0)
        });
      }

      const confidenceDb = aiResult.reply.confidence <= 1
        ? aiResult.reply.confidence
        : aiResult.reply.confidence / 100;

      const { data: assistantMessage, error: assistantError } = await supabaseService
        .from("doubt_messages")
        .insert({
          thread_id: resolvedThreadId,
          role: "assistant",
          content_text: aiResult.reply.contentText,
          structured_response: aiResult.reply.structuredResponse,
          confidence: Number(confidenceDb.toFixed(4)),
          sources: aiResult.reply.sources
        })
        .select("id,role,content_text,structured_response,confidence,sources,created_at")
        .single();

      if (assistantError || !assistantMessage) {
        throw assistantError ?? new Error("Unable to save assistant message");
      }

      persistedAssistantMessage = assistantMessage;

      await supabaseService
        .from("doubt_threads")
        .update({ updated_at: new Date().toISOString() })
        .eq("id", resolvedThreadId);
    } catch (persistError: any) {
      // eslint-disable-next-line no-console
      console.warn("[doubt] message persistence failed; returning ephemeral response:", persistError?.message ?? persistError);
    }
  }

  const userMessagePayload = persistedUserMessage
    ? {
        id: persistedUserMessage.id,
        role: persistedUserMessage.role,
        contentText: persistedUserMessage.content_text,
        createdAt: persistedUserMessage.created_at,
        attachment: attachment ?? null
      }
    : {
        id: safeId("u-ephemeral"),
        role: "user",
        contentText: userText,
        createdAt: new Date().toISOString(),
        attachment: attachment ?? null
      };

  const assistantMessagePayload = persistedAssistantMessage
    ? {
        id: persistedAssistantMessage.id,
        role: persistedAssistantMessage.role,
        contentText: persistedAssistantMessage.content_text,
        structuredResponse: persistedAssistantMessage.structured_response,
        confidence: persistedAssistantMessage.confidence,
        sources: persistedAssistantMessage.sources,
        createdAt: persistedAssistantMessage.created_at
      }
    : {
        id: safeId("a-ephemeral"),
        role: "assistant",
        contentText: aiResult.reply.contentText,
        structuredResponse: aiResult.reply.structuredResponse,
        confidence: aiResult.reply.confidence,
        sources: aiResult.reply.sources,
        createdAt: new Date().toISOString()
      };

  return sendOk(
    res,
    {
      threadId: resolvedThreadId,
      userMessage: userMessagePayload,
      assistantMessage: assistantMessagePayload
    },
    {
      provider: aiResult.meta.provider,
      geminiAttempted: aiResult.meta.geminiAttempted,
      traceId: aiResult.meta.traceId,
      persisted: Boolean(persistedUserMessage && persistedAssistantMessage)
    }
  );
});
