import { Router } from "express";
import { sendError, sendOk } from "../lib/response";
import { requireAuth } from "../middleware/auth";
import {
  buildWeekDays,
  ensureActivePlan,
  getWeekBounds,
  listWeekPlanItems,
  regenerateWeekPlan,
  regenerateWithAgentSafe
} from "../services/studyPlanService";
import { supabaseService } from "../lib/supabase";

function formatWeekLabel(start: Date) {
  const end = new Date(start);
  end.setDate(start.getDate() + 6);

  const startLabel = start.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  const endLabel = end.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  return `${startLabel} - ${endLabel}`;
}

export const plannerRouter = Router();

plannerRouter.get("/week", requireAuth, async (req, res) => {
  const auth = req.auth;
  if (!auth) {
    return sendError(res, 401, "Unauthorized", "UNAUTHORIZED");
  }

  const queryStart = typeof req.query.start === "string" ? req.query.start : undefined;
  const anchor = queryStart ? new Date(`${queryStart}T00:00:00`) : new Date();
  const { start } = getWeekBounds(anchor);

  const [items, weakTopicsRows, plan] = await Promise.all([
    listWeekPlanItems(auth.userId, anchor),
    supabaseService
      .from("revision_items")
      .select("id,subject,topic,risk_level,retention_estimate")
      .eq("user_id", auth.userId)
      .order("updated_at", { ascending: false })
      .limit(5),
    ensureActivePlan(auth.userId)
  ]);

  const weakTopics = (weakTopicsRows.data ?? []).map((row: any) => ({
    id: row.id,
    title: `${row.subject}: ${row.topic}`,
    riskLevel: row.risk_level as string,
    retentionEstimate: Number(row.retention_estimate ?? 0),
    severity: row.risk_level?.toUpperCase() ?? "MEDIUM",
    copy: `Retention at ${Number(row.retention_estimate ?? 0)}%. Prioritized in morning blocks.`,
    icon: row.risk_level === "critical" ? "error" : row.risk_level === "high" ? "warning" : "priority_high"
  }));

  return sendOk(res, {
    weekStartDate: start.toISOString().slice(0, 10),
    weekLabel: formatWeekLabel(start),
    weekDays: buildWeekDays(start),
    items,
    weakTopics,
    focusMessage: plan.focus_message ?? "Generate your plan to see AI rebalance reasoning.",
    plannerSource: (plan.planner_source ?? "fallback") as "llm" | "fallback",
    usedFallback: Boolean(plan.used_fallback ?? true)
  });
});

plannerRouter.post("/regenerate", requireAuth, async (req, res) => {
  const auth = req.auth;
  if (!auth) {
    return sendError(res, 401, "Unauthorized", "UNAUTHORIZED");
  }

  const queryStart = typeof req.body?.start === "string" ? req.body.start : undefined;
  const anchor = queryStart ? new Date(`${queryStart}T00:00:00`) : new Date();

  try {
    const result = await regenerateWithAgentSafe(auth.userId, anchor);
    const { start } = getWeekBounds(anchor);

    return sendOk(res, {
      weekStartDate: start.toISOString().slice(0, 10),
      weekLabel: formatWeekLabel(start),
      weekDays: buildWeekDays(start),
      items: result.items,
      focusMessage: result.focusMessage,
      plannerSource: result.plannerSource,
      usedFallback: result.usedFallback
    });
  } catch (err: any) {
    try {
      const fallbackItems = await regenerateWeekPlan(auth.userId, anchor);
      const { start } = getWeekBounds(anchor);
      return sendOk(res, {
        weekStartDate: start.toISOString().slice(0, 10),
        weekLabel: formatWeekLabel(start),
        weekDays: buildWeekDays(start),
        items: fallbackItems,
        focusMessage: "used default plan: deterministic fallback generated.",
        plannerSource: "fallback" as const,
        usedFallback: true
      });
    } catch (fallbackErr: any) {
      return sendError(
        res,
        500,
        fallbackErr?.message ?? err?.message ?? "Failed to regenerate plan",
        "PLANNER_REGENERATE_FAILED"
      );
    }
  }
});
