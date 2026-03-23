import { Router } from "express";
import { sendError, sendOk } from "../lib/response";
import { supabaseService } from "../lib/supabase";
import { requireAuth } from "../middleware/auth";
import { getExpandedAttempts } from "../services/dataHelpers";
import { buildTopicCurve, lowerRiskLevel } from "../services/revisionCurveService";
import { regenerateWithAgentSafe } from "../services/studyPlanService";

const riskOrder = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3
} as const;

function riskRank(risk: string) {
  return (riskOrder as Record<string, number>)[risk] ?? 10;
}

function riskLabel(risk: string) {
  if (risk === "critical") return "High Forgetting Risk";
  if (risk === "high") return "Due Now";
  if (risk === "medium") return "Moderate Risk";
  return "Low Risk";
}

function riskAction(risk: string) {
  if (risk === "critical" || risk === "high") return "Revise Now";
  if (risk === "medium") return "Start Review";
  return "Quick Recall";
}

function buildForgettingCurve(avgRetention: number, reviewCount: number) {
  const adjustment = Math.min(12, Math.floor(reviewCount / 3));
  const base = Math.max(35, Math.min(98, avgRetention + adjustment));

  const checkpoints = [0, 4, 24, 72, 168];
  return checkpoints.map((hours, idx) => ({
    label: idx === 0 ? "Now" : `${hours}h`,
    retention: Math.max(20, Math.round(base - Math.log2(hours + 1) * 10))
  }));
}

export const revisionRouter = Router();

revisionRouter.get("/overview", requireAuth, async (req, res) => {
  const auth = req.auth;
  if (!auth) {
    return sendError(res, 401, "Unauthorized", "UNAUTHORIZED");
  }

  const { data: revisionItems, error: revisionError } = await supabaseService
    .from("revision_items")
    .select("id,subject,topic,risk_level,retention_estimate,last_review_at,next_review_at,queue_enabled")
    .eq("user_id", auth.userId)
    .eq("queue_enabled", true)
    .order("updated_at", { ascending: false });

  if (revisionError) {
    return sendError(res, 500, revisionError.message, "REVISION_FETCH_FAILED");
  }

  const itemRows = revisionItems ?? [];
  const itemIds = itemRows.map((item: any) => item.id);

  const { data: reviews } = await supabaseService
    .from("revision_reviews")
    .select("id,revision_item_id,reviewed_at,outcome,next_interval_hours")
    .in("revision_item_id", itemIds.length > 0 ? itemIds : ["00000000-0000-0000-0000-000000000000"])
    .order("reviewed_at", { ascending: false });

  const now = new Date();
  const overdue = itemRows.filter((item: any) => item.next_review_at && new Date(item.next_review_at) < now).length;
  const dueToday = itemRows.filter((item: any) => {
    if (!item.next_review_at) return false;
    const day = item.next_review_at.slice(0, 10);
    return day === now.toISOString().slice(0, 10);
  }).length;

  const avgRetention =
    itemRows.length > 0
      ? Math.round(
        itemRows.reduce((sum: number, item: any) => sum + Number(item.retention_estimate ?? 0), 0) / itemRows.length
      )
      : 0;

  const queue = [...itemRows]
    .sort((a: any, b: any) => {
      const rankDiff = riskRank(a.risk_level) - riskRank(b.risk_level);
      if (rankDiff !== 0) return rankDiff;
      return String(a.next_review_at ?? "9999").localeCompare(String(b.next_review_at ?? "9999"));
    })
    .slice(0, 5)
    .map((item: any) => ({
      id: item.id,
      title: item.topic || "Untitled topic",
      subtitle: item.subject || "General",
      subject: item.subject,
      topic: item.topic,
      risk: riskLabel(String(item.risk_level ?? "low")),
      riskLevel: item.risk_level,
      retentionEstimate: Number(item.retention_estimate ?? 0),
      retention: Number(item.retention_estimate ?? 0),
      action: riskAction(String(item.risk_level ?? "low")),
      lastReviewAt: item.last_review_at,
      nextReviewAt: item.next_review_at
    }));

  const attempts = await getExpandedAttempts(auth.userId, 400);
  const recentMistakes = attempts
    .filter((item) => item.isCorrect === false)
    .slice(0, 10)
    .map((item) => ({
      questionId: item.questionId,
      topic: item.topic,
      subject: item.subject,
      note: item.prompt,
      errorRate: 100,
      createdAt: item.createdAt
    }));

  const byDay = new Map<string, number>();
  (reviews ?? []).forEach((item: any) => {
    const day = String(item.reviewed_at).slice(0, 10);
    byDay.set(day, (byDay.get(day) ?? 0) + 1);
  });

  const repetitionStats = Array.from({ length: 5 }).map((_, idx) => {
    const date = new Date();
    date.setDate(date.getDate() - (4 - idx));
    const key = date.toISOString().slice(0, 10);
    return {
      label: key,
      value: byDay.get(key) ?? 0
    };
  });

  return sendOk(res, {
    kpis: {
      topicsDue: dueToday,
      retention: avgRetention,
      overdue
    },
    forgettingCurve: buildForgettingCurve(avgRetention || 80, reviews?.length ?? 0),
    recommendations: [
      "Next review in 4h to keep retention above 85%",
      "Prioritize critical topics before new practice"
    ],
    weakTopics: [...itemRows]
      .filter(
        (item: any) =>
          item.queue_enabled === true &&
          ["critical", "high", "medium"].includes(String(item.risk_level ?? ""))
      )
      .sort((a: any, b: any) => {
        const rankDiff = riskRank(a.risk_level) - riskRank(b.risk_level);
        if (rankDiff !== 0) return rankDiff;
        return String(a.next_review_at ?? "9999").localeCompare(String(b.next_review_at ?? "9999"));
      })
      .map((item: any, index: number) => ({
        priority: index + 1,
        revisionItemId: item.id,
        subject: item.subject,
        topic: item.topic,
        riskLevel: item.risk_level,
        risk: riskLabel(String(item.risk_level ?? "low")),
        retentionEstimate: Number(item.retention_estimate ?? 0),
        lastReviewAt: item.last_review_at,
        nextReviewAt: item.next_review_at
      })),
    queue,
    recentMistakes,
    repetitionStats,
    memoryModes: [
      { label: "Fast Recall", description: "Short formula refresh" },
      { label: "Deep Review", description: "Detailed concept reinforcement" },
      { label: "Mixed Drill", description: "Interleaved topic rotation" }
    ]
  });
});

revisionRouter.get("/topic-curve", requireAuth, async (req, res) => {
  const auth = req.auth;
  if (!auth) {
    return sendError(res, 401, "Unauthorized", "UNAUTHORIZED");
  }

  const revisionItemId =
    typeof req.query.revisionItemId === "string" ? req.query.revisionItemId.trim() : "";

  if (!revisionItemId) {
    return sendError(res, 400, "revisionItemId is required", "BAD_REQUEST");
  }

  const { data: item, error: itemError } = await supabaseService
    .from("revision_items")
    .select("id,subject,topic,risk_level,retention_estimate,last_review_at,next_review_at")
    .eq("id", revisionItemId)
    .eq("user_id", auth.userId)
    .single();

  if (itemError || !item) {
    return sendError(
      res,
      itemError?.code === "PGRST116" ? 404 : 500,
      itemError?.message ?? "Revision item not found",
      itemError?.code === "PGRST116" ? "NOT_FOUND" : "REVISION_TOPIC_FETCH_FAILED"
    );
  }

  const { count: reviewCount } = await supabaseService
    .from("revision_reviews")
    .select("id", { count: "exact", head: true })
    .eq("revision_item_id", revisionItemId);

  const curve = buildTopicCurve({
    retentionEstimate: Number(item.retention_estimate ?? 0),
    riskLevel: item.risk_level,
    lastReviewAt: item.last_review_at,
    nextReviewAt: item.next_review_at,
    reviewCount: reviewCount ?? 0
  });

  return sendOk(res, {
    revisionItemId: item.id,
    subject: item.subject,
    topic: item.topic,
    riskLevel: item.risk_level,
    retentionEstimate: Number(item.retention_estimate ?? 0),
    lastReviewAt: item.last_review_at,
    nextReviewAt: item.next_review_at,
    reviewCount: reviewCount ?? 0,
    points: curve.points,
    currentRetention: curve.currentRetention,
    dueInHours: curve.dueInHours,
    safeWindow: curve.dueInHours === null ? "N/A" : `${Math.max(1, curve.dueInHours)}h`,
    recommendation:
      curve.dueInHours !== null && curve.dueInHours <= 12
        ? `Revise ${item.topic} in the next ${Math.max(1, curve.dueInHours)} hours to avoid a steep retention drop.`
        : `Keep ${item.topic} active with a short recall drill before your next planned review block.`,
    updatedAt: new Date().toISOString()
  });
});

revisionRouter.post("/review", requireAuth, async (req, res) => {
  const auth = req.auth;
  if (!auth) {
    return sendError(res, 401, "Unauthorized", "UNAUTHORIZED");
  }

  const { revisionItemId, outcome, notes } = req.body ?? {};

  if (!revisionItemId || !outcome) {
    return sendError(res, 400, "revisionItemId and outcome are required", "BAD_REQUEST");
  }

  const interval = outcome === "easy" ? 48 : outcome === "ok" ? 24 : 8;
  const now = new Date();
  const nextReview = new Date(now);
  nextReview.setHours(now.getHours() + interval);

  const { error: reviewError } = await supabaseService.from("revision_reviews").insert({
    revision_item_id: revisionItemId,
    outcome,
    next_interval_hours: interval,
    notes: notes ?? null
  });

  if (reviewError) {
    return sendError(res, 500, reviewError.message, "REVISION_REVIEW_FAILED");
  }

  const retention = outcome === "easy" ? 92 : outcome === "ok" ? 78 : 62;
  const riskLevel = outcome === "easy" ? "low" : outcome === "ok" ? "medium" : "high";

  const { data: updated, error: updateError } = await supabaseService
    .from("revision_items")
    .update({
      last_review_at: now.toISOString(),
      next_review_at: nextReview.toISOString(),
      retention_estimate: retention,
      risk_level: riskLevel
    })
    .eq("id", revisionItemId)
    .eq("user_id", auth.userId)
    .select("id,subject,topic,risk_level,retention_estimate,last_review_at,next_review_at")
    .single();

  if (updateError || !updated) {
    return sendError(res, 500, updateError?.message ?? "Unable to update revision item", "REVISION_ITEM_UPDATE_FAILED");
  }

  try {
    await regenerateWithAgentSafe(auth.userId);
  } catch (rebalanceError: any) {
    console.warn("[planner] Auto-rebalance after revision review failed:", rebalanceError?.message ?? rebalanceError);
  }

  return sendOk(res, {
    id: updated.id,
    subject: updated.subject,
    topic: updated.topic,
    riskLevel: updated.risk_level,
    retentionEstimate: Number(updated.retention_estimate ?? 0),
    lastReviewAt: updated.last_review_at,
    nextReviewAt: updated.next_review_at
  });
});

revisionRouter.post("/topic-reset", requireAuth, async (req, res) => {
  const auth = req.auth;
  if (!auth) {
    return sendError(res, 401, "Unauthorized", "UNAUTHORIZED");
  }

  const revisionItemId =
    typeof req.body?.revisionItemId === "string" ? req.body.revisionItemId.trim() : "";

  if (!revisionItemId) {
    return sendError(res, 400, "revisionItemId is required", "BAD_REQUEST");
  }

  const { data: existing, error: existingError } = await supabaseService
    .from("revision_items")
    .select("id,subject,topic,risk_level,retention_estimate,last_review_at,next_review_at")
    .eq("id", revisionItemId)
    .eq("user_id", auth.userId)
    .single();

  if (existingError || !existing) {
    return sendError(
      res,
      existingError?.code === "PGRST116" ? 404 : 500,
      existingError?.message ?? "Revision item not found",
      existingError?.code === "PGRST116" ? "NOT_FOUND" : "REVISION_TOPIC_FETCH_FAILED"
    );
  }

  const now = new Date();
  const nextReview = new Date(now);
  nextReview.setHours(now.getHours() + 72);
  const loweredRisk = lowerRiskLevel(existing.risk_level);

  const { error: reviewError } = await supabaseService.from("revision_reviews").insert({
    revision_item_id: revisionItemId,
    outcome: "easy",
    next_interval_hours: 72,
    notes: "Topic reset from revision focus panel"
  });

  if (reviewError) {
    return sendError(res, 500, reviewError.message, "REVISION_RESET_REVIEW_FAILED");
  }

  const { data: updated, error: updateError } = await supabaseService
    .from("revision_items")
    .update({
      retention_estimate: 100,
      last_review_at: now.toISOString(),
      next_review_at: nextReview.toISOString(),
      risk_level: loweredRisk
    })
    .eq("id", revisionItemId)
    .eq("user_id", auth.userId)
    .select("id,subject,topic,risk_level,retention_estimate,last_review_at,next_review_at")
    .single();

  if (updateError || !updated) {
    return sendError(
      res,
      500,
      updateError?.message ?? "Unable to reset revision item",
      "REVISION_RESET_FAILED"
    );
  }

  try {
    await regenerateWithAgentSafe(auth.userId);
  } catch (rebalanceError: any) {
    console.warn(
      "[planner] Auto-rebalance after revision topic reset failed:",
      rebalanceError?.message ?? rebalanceError
    );
  }

  return sendOk(res, {
    revisionItemId: updated.id,
    subject: updated.subject,
    topic: updated.topic,
    riskLevel: updated.risk_level,
    retentionEstimate: Number(updated.retention_estimate ?? 0),
    lastReviewAt: updated.last_review_at,
    nextReviewAt: updated.next_review_at
  });
});
