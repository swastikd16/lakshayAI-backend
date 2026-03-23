import { Router } from "express";
import { sendError, sendOk } from "../lib/response";
import { requireAuth } from "../middleware/auth";
import {
  buildPlannerCalendarPayload,
  regenerateMonthWithAgentSafe,
  regenerateWeekPlan,
  regenerateWithAgentSafe
} from "../services/studyPlanService";
import type { PlannerCalendarView } from "../types/planner";

function parseView(value: unknown): PlannerCalendarView {
  return value === "month" ? "month" : "week";
}

function parseAnchor(value: unknown) {
  if (typeof value !== "string") {
    return new Date();
  }

  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) {
    return new Date();
  }

  return parsed;
}

export const plannerRouter = Router();

plannerRouter.get("/week", requireAuth, async (req, res) => {
  try {
    const auth = req.auth;
    if (!auth) {
      return sendError(res, 401, "Unauthorized", "UNAUTHORIZED");
    }

    const anchor = parseAnchor(req.query.start);
    const payload = await buildPlannerCalendarPayload(auth.userId, anchor, "week");
    return sendOk(res, payload);
  } catch (error: any) {
    return sendError(res, 500, error?.message ?? "Failed to load planner week", "PLANNER_WEEK_FAILED");
  }
});

plannerRouter.get("/calendar", requireAuth, async (req, res) => {
  try {
    const auth = req.auth;
    if (!auth) {
      return sendError(res, 401, "Unauthorized", "UNAUTHORIZED");
    }

    const view = parseView(req.query.view);
    const anchor = parseAnchor(req.query.start);
    const payload = await buildPlannerCalendarPayload(auth.userId, anchor, view);
    return sendOk(res, payload);
  } catch (error: any) {
    return sendError(
      res,
      500,
      error?.message ?? "Failed to load planner calendar",
      "PLANNER_CALENDAR_FAILED"
    );
  }
});

plannerRouter.post("/regenerate", requireAuth, async (req, res) => {
  const auth = req.auth;
  if (!auth) {
    return sendError(res, 401, "Unauthorized", "UNAUTHORIZED");
  }

  const view = parseView(req.body?.view);
  const anchor = parseAnchor(req.body?.start);

  if (view === "month") {
    try {
      await regenerateMonthWithAgentSafe(auth.userId, anchor);
      const payload = await buildPlannerCalendarPayload(auth.userId, anchor, "month");
      return sendOk(res, {
        ...payload,
        focusMessage:
          payload.focusMessage ||
          "Weak topics were distributed across the month for steady coverage and spaced revision."
      });
    } catch (error: any) {
      return sendError(
        res,
        500,
        error?.message ?? "Failed to regenerate monthly calendar",
        "PLANNER_MONTH_REGENERATE_FAILED"
      );
    }
  }

  try {
    await regenerateWithAgentSafe(auth.userId, anchor);
    const payload = await buildPlannerCalendarPayload(auth.userId, anchor, view);
    return sendOk(res, payload);
  } catch (err: any) {
    try {
      const fallbackItems = await regenerateWeekPlan(auth.userId, anchor);
      const payload = await buildPlannerCalendarPayload(auth.userId, anchor, view);
      return sendOk(res, {
        ...payload,
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
