import { Router } from "express";
import { sendError, sendOk } from "../lib/response";
import { supabaseService } from "../lib/supabase";
import { requireAuth } from "../middleware/auth";
import { regenerateWithAgentSafe } from "../services/studyPlanService";

export const onboardingRouter = Router();

onboardingRouter.post("/", requireAuth, async (req, res) => {
  try {
    const auth = req.auth;
    if (!auth) {
      return sendError(res, 401, "Unauthorized", "UNAUTHORIZED");
    }

    const { examType, targetDate, dailyHoursTarget, confidenceBySubject } = req.body ?? {};

    if (!examType || !targetDate || dailyHoursTarget === undefined || dailyHoursTarget === null || !confidenceBySubject) {
      return sendError(
        res,
        400,
        "examType, targetDate, dailyHoursTarget and confidenceBySubject are required",
        "BAD_REQUEST"
      );
    }

    const { error: profileError } = await supabaseService
      .from("profiles")
      .update({ target_exam: examType })
      .eq("id", auth.userId);

    if (profileError) {
      return sendError(res, 500, profileError.message, "PROFILE_UPDATE_FAILED");
    }

    const { error: settingsError } = await supabaseService.from("user_exam_settings").upsert(
      {
        user_id: auth.userId,
        exam_type: examType,
        target_date: targetDate,
        daily_hours_target: Number(dailyHoursTarget),
        onboarding_completed: true
      },
      { onConflict: "user_id,exam_type" }
    );

    if (settingsError) {
      return sendError(res, 500, settingsError.message, "SETTINGS_UPSERT_FAILED");
    }

    const confidenceRows = Object.entries(confidenceBySubject as Record<string, number>).map(([subject, level]) => ({
      user_id: auth.userId,
      subject,
      confidence_level: Math.max(1, Math.min(4, Number(level)))
    }));

    if (confidenceRows.length > 0) {
      const { error: confidenceError } = await supabaseService
        .from("user_subject_confidence")
        .upsert(confidenceRows, { onConflict: "user_id,subject" });

      if (confidenceError) {
        return sendError(res, 500, confidenceError.message, "CONFIDENCE_UPSERT_FAILED");
      }
    }

    const result = await regenerateWithAgentSafe(auth.userId, new Date());

    return sendOk(res, {
      success: true,
      generatedItems: result.items,
      focusMessage: result.focusMessage,
      plannerSource: result.plannerSource,
      usedFallback: result.usedFallback
    });
  } catch (error: any) {
    const message =
      typeof error?.message === "string"
        ? error.message
        : typeof error === "string"
          ? error
          : "Unexpected onboarding error";
    return sendError(res, 500, message, "ONBOARDING_UNHANDLED", error);
  }
});
