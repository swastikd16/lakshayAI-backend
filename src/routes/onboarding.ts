import { Router } from "express";
import { sendError, sendOk } from "../lib/response";
import { supabaseService } from "../lib/supabase";
import { requireAuth } from "../middleware/auth";
import {
  evaluateDiagnosticAnswers,
  getDiagnosticQuestionBank,
  hasDiagnosticQuestion,
  isSupportedExamType
} from "../services/onboardingDiagnosticService";
import { regenerateWithAgentSafe } from "../services/studyPlanService";

export const onboardingRouter = Router();

onboardingRouter.get("/diagnostic", requireAuth, async (req, res) => {
  const auth = req.auth;
  if (!auth) {
    return sendError(res, 401, "Unauthorized", "UNAUTHORIZED");
  }

  const examType = typeof req.query.examType === "string" ? req.query.examType : undefined;
  const bank = getDiagnosticQuestionBank(examType);

  return sendOk(res, {
    examType: bank.examType,
    totalQuestions: bank.questions.length,
    questions: bank.questions
  });
});

onboardingRouter.post("/", requireAuth, async (req, res) => {
  try {
    const auth = req.auth;
    if (!auth) {
      return sendError(res, 401, "Unauthorized", "UNAUTHORIZED");
    }

    const { examType, targetDate, dailyHoursTarget, confidenceBySubject, diagnosticAnswers } = req.body ?? {};

    if (!isSupportedExamType(examType)) {
      return sendError(res, 400, "examType must be one of JEE, NEET or UPSC", "BAD_REQUEST");
    }

    const parsedTargetDate = new Date(String(targetDate ?? ""));
    if (!targetDate || Number.isNaN(parsedTargetDate.getTime())) {
      return sendError(res, 400, "targetDate must be a valid date", "BAD_REQUEST");
    }

    const parsedDailyHoursTarget = Number(dailyHoursTarget);
    if (!Number.isFinite(parsedDailyHoursTarget) || parsedDailyHoursTarget <= 0) {
      return sendError(res, 400, "dailyHoursTarget must be a positive number", "BAD_REQUEST");
    }

    if (!confidenceBySubject || typeof confidenceBySubject !== "object") {
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
        target_date: parsedTargetDate.toISOString().slice(0, 10),
        daily_hours_target: parsedDailyHoursTarget,
        onboarding_completed: true
      },
      { onConflict: "user_id,exam_type" }
    );

    if (settingsError) {
      return sendError(res, 500, settingsError.message, "SETTINGS_UPSERT_FAILED");
    }

    const confidenceRows = Object.entries(confidenceBySubject as Record<string, number>)
      .filter(([subject]) => typeof subject === "string" && subject.length > 0)
      .map(([subject, level]) => ({
        user_id: auth.userId,
        subject,
        confidence_level: Math.max(1, Math.min(4, Number(level) || 1))
      }));

    if (confidenceRows.length > 0) {
      const { error: confidenceError } = await supabaseService
        .from("user_subject_confidence")
        .upsert(confidenceRows, { onConflict: "user_id,subject" });

      if (confidenceError) {
        return sendError(res, 500, confidenceError.message, "CONFIDENCE_UPSERT_FAILED");
      }
    }

    const normalizedDiagnosticAnswers = Array.isArray(diagnosticAnswers)
      ? diagnosticAnswers.filter((entry): entry is { questionId: string; selectedOption: string } => {
        if (!entry || typeof entry !== "object") {
          return false;
        }

        const { questionId, selectedOption } = entry as Record<string, unknown>;
        return (
          typeof questionId === "string" &&
          questionId.length > 0 &&
          hasDiagnosticQuestion(questionId) &&
          typeof selectedOption === "string" &&
          selectedOption.trim().length > 0
        );
      })
      : [];

    const diagnosticResult = evaluateDiagnosticAnswers(normalizedDiagnosticAnswers);
    const weakTopics = dedupeWeakTopics(diagnosticResult.weakTopics);
    const persistence = await replaceDiagnosticWeakTopics(auth.userId, weakTopics);

    const result = await regenerateWithAgentSafe(auth.userId, new Date());

    return sendOk(res, {
      success: true,
      generatedItems: result.items,
      focusMessage: result.focusMessage,
      plannerSource: result.plannerSource,
      usedFallback: result.usedFallback,
      diagnostic: {
        answersEvaluated: diagnosticResult.answersEvaluated,
        subjectAccuracy: diagnosticResult.subjectAccuracy,
        weakTopicCount: weakTopics.length,
        weakTopics: weakTopics.map((topic) => ({
          subject: topic.subject,
          topic: topic.topic,
          riskLevel: topic.riskLevel,
          retentionEstimate: topic.retentionEstimate
        })),
        persistence
      }
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

function dedupeWeakTopics(
  weakTopics: Array<{
    subject: string;
    topic: string;
    accuracy: number;
    correct: boolean;
    riskLevel: "critical" | "high" | "medium";
    retentionEstimate: number;
  }>
) {
  const topicMap = new Map<string, (typeof weakTopics)[number]>();

  weakTopics.forEach((topic) => {
    const key = `${topic.subject}:${topic.topic}`.toLowerCase();
    const previous = topicMap.get(key);

    if (!previous || topic.retentionEstimate < previous.retentionEstimate) {
      topicMap.set(key, topic);
    }
  });

  return Array.from(topicMap.values());
}

async function replaceDiagnosticWeakTopics(
  userId: string,
  weakTopics: Array<{
    subject: string;
    topic: string;
    riskLevel: "critical" | "high" | "medium";
    retentionEstimate: number;
  }>
) {
  const summary = {
    deletedPreviousRows: 0,
    insertedRows: 0,
    usedOriginColumn: true,
    warning: null as string | null
  };

  const { data: existingRows, error: existingError } = await supabaseService
    .from("revision_items")
    .select("id")
    .eq("user_id", userId)
    .eq("origin", "diagnostic");

  if (existingError) {
    summary.usedOriginColumn = false;
    summary.warning = existingError.message;
    return summary;
  }

  const existingIds = (existingRows ?? []).map((row: any) => row.id);
  if (existingIds.length > 0) {
    const { error: deleteError } = await supabaseService
      .from("revision_items")
      .delete()
      .in("id", existingIds)
      .eq("user_id", userId);

    if (deleteError) {
      summary.warning = deleteError.message;
      return summary;
    }

    summary.deletedPreviousRows = existingIds.length;
  }

  if (weakTopics.length === 0) {
    return summary;
  }

  const nextReviewAt = new Date();
  nextReviewAt.setDate(nextReviewAt.getDate() + 1);

  const rows = weakTopics.map((topic) => ({
    user_id: userId,
    subject: topic.subject,
    topic: topic.topic,
    origin: "diagnostic",
    risk_level: topic.riskLevel,
    retention_estimate: topic.retentionEstimate,
    next_review_at: nextReviewAt.toISOString(),
    queue_enabled: true
  }));

  const { error: insertError } = await supabaseService.from("revision_items").insert(rows);
  if (insertError) {
    summary.warning = insertError.message;
    return summary;
  }

  summary.insertedRows = rows.length;
  return summary;
}
