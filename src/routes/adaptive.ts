import { Router } from "express";
import { sendError, sendOk } from "../lib/response";
import { supabaseService } from "../lib/supabase";
import { requireAuth } from "../middleware/auth";
import { getExpandedAttempts, getLatestExamType } from "../services/dataHelpers";
import { regenerateWithAgentSafe } from "../services/studyPlanService";

function normalizeOptions(options: Record<string, string>) {
  const entries = Object.entries(options ?? {});
  if (entries.length > 0) {
    return entries.map(([id, text]) => ({ id, text }));
  }

  return [
    { id: "A", text: "Option A" },
    { id: "B", text: "Option B" },
    { id: "C", text: "Option C" },
    { id: "D", text: "Option D" }
  ];
}

async function pickQuestion(userId: string, topic?: string, difficulty?: string) {
  const examType = await getLatestExamType(userId);

  let query = supabaseService
    .from("questions")
    .select("id,subject,topic,difficulty,prompt,options,correct_option,solution_steps")
    .eq("exam_type", examType)
    .limit(1);

  if (topic) {
    query = query.ilike("topic", `%${topic}%`);
  }

  if (difficulty && ["easy", "medium", "hard", "adaptive"].includes(difficulty)) {
    query = query.eq("difficulty", difficulty);
  }

  const { data, error } = await query;

  if (error || !data || data.length === 0) {
    const fallback = await supabaseService
      .from("questions")
      .select("id,subject,topic,difficulty,prompt,options,correct_option,solution_steps")
      .limit(1)
      .maybeSingle();

    if (fallback.error || !fallback.data) {
      return null;
    }

    return fallback.data;
  }

  return data[0] as any;
}

async function computeSessionSummary(sessionId: string) {
  const { data: attempts, error } = await supabaseService
    .from("practice_attempts")
    .select("is_correct,time_spent_sec")
    .eq("session_id", sessionId);

  if (error) {
    throw error;
  }

  const total = attempts?.length ?? 0;
  const correct = (attempts ?? []).filter((item: any) => item.is_correct === true).length;
  const accuracy = total > 0 ? Math.round((correct / total) * 100) : 0;
  const timeSpentSec = (attempts ?? []).reduce(
    (sum: number, item: any) => sum + Number(item.time_spent_sec ?? 0),
    0
  );

  return {
    total,
    correct,
    accuracy,
    score: accuracy,
    timeSpentSec
  };
}

export const adaptiveRouter = Router();

adaptiveRouter.post("/session/start", requireAuth, async (req, res) => {
  const auth = req.auth;
  if (!auth) {
    return sendError(res, 401, "Unauthorized", "UNAUTHORIZED");
  }

  const moduleName = req.body?.module ?? null;
  const topic = req.body?.topic ?? null;
  const difficulty = req.body?.difficulty ?? "adaptive";

  const { data: session, error: sessionError } = await supabaseService
    .from("practice_sessions")
    .insert({
      user_id: auth.userId,
      module: moduleName,
      topic,
      difficulty,
      status: "in_progress"
    })
    .select("id,module,topic,difficulty,status,started_at")
    .single();

  if (sessionError || !session) {
    return sendError(res, 500, sessionError?.message ?? "Unable to start session", "SESSION_START_FAILED");
  }

  const question = await pickQuestion(auth.userId, topic ?? undefined, difficulty);
  if (!question) {
    return sendError(res, 404, "No question available", "QUESTION_NOT_FOUND");
  }

  return sendOk(res, {
    session: {
      id: session.id,
      module: session.module,
      topic: session.topic,
      difficulty: session.difficulty,
      status: session.status,
      startedAt: session.started_at
    },
    question: {
      id: question.id,
      subject: question.subject,
      topic: question.topic,
      difficulty: question.difficulty,
      prompt: question.prompt,
      options: normalizeOptions((question.options ?? {}) as Record<string, string>),
      solutionSteps: Array.isArray(question.solution_steps) ? question.solution_steps : []
    }
  });
});

adaptiveRouter.post("/session/:id/attempt", requireAuth, async (req, res) => {
  const auth = req.auth;
  if (!auth) {
    return sendError(res, 401, "Unauthorized", "UNAUTHORIZED");
  }

  const sessionId = req.params.id;
  const { questionId, selectedOption, timeSpentSec } = req.body ?? {};

  if (!questionId || !selectedOption) {
    return sendError(res, 400, "questionId and selectedOption are required", "BAD_REQUEST");
  }

  const { data: session, error: sessionError } = await supabaseService
    .from("practice_sessions")
    .select("id")
    .eq("id", sessionId)
    .eq("user_id", auth.userId)
    .maybeSingle();

  if (sessionError || !session) {
    return sendError(res, 404, "Session not found", "SESSION_NOT_FOUND");
  }

  const { data: question, error: questionError } = await supabaseService
    .from("questions")
    .select("id,correct_option")
    .eq("id", questionId)
    .maybeSingle();

  if (questionError || !question) {
    return sendError(res, 404, "Question not found", "QUESTION_NOT_FOUND");
  }

  const isCorrect = String(question.correct_option) === String(selectedOption);

  const { data: inserted, error: insertError } = await supabaseService
    .from("practice_attempts")
    .insert({
      session_id: sessionId,
      question_id: questionId,
      selected_option: selectedOption,
      is_correct: isCorrect,
      time_spent_sec: Number(timeSpentSec ?? 0)
    })
    .select("id,created_at")
    .single();

  if (insertError || !inserted) {
    return sendError(res, 500, insertError?.message ?? "Unable to save attempt", "ATTEMPT_SAVE_FAILED");
  }

  return sendOk(res, {
    attemptId: inserted.id,
    isCorrect,
    selectedOption,
    createdAt: inserted.created_at
  });
});

adaptiveRouter.post("/session/:id/complete", requireAuth, async (req, res) => {
  const auth = req.auth;
  if (!auth) {
    return sendError(res, 401, "Unauthorized", "UNAUTHORIZED");
  }

  const sessionId = req.params.id;
  const reason = req.body?.reason ?? "submit";

  const { data: session, error: sessionError } = await supabaseService
    .from("practice_sessions")
    .select("id,user_id,status,started_at")
    .eq("id", sessionId)
    .eq("user_id", auth.userId)
    .maybeSingle();

  if (sessionError || !session) {
    return sendError(res, 404, "Session not found", "SESSION_NOT_FOUND");
  }

  const summary = await computeSessionSummary(sessionId);

  const { data: updated, error: updateError } = await supabaseService
    .from("practice_sessions")
    .update({
      status: "completed",
      ended_at: new Date().toISOString(),
      score_percent: summary.score,
      accuracy_percent: summary.accuracy,
      time_spent_sec: summary.timeSpentSec
    })
    .eq("id", sessionId)
    .select("id,status,score_percent,accuracy_percent,time_spent_sec,ended_at")
    .single();

  if (updateError || !updated) {
    return sendError(res, 500, updateError?.message ?? "Unable to complete session", "SESSION_COMPLETE_FAILED");
  }

  try {
    await regenerateWithAgentSafe(auth.userId);
  } catch (rebalanceError: any) {
    console.warn("[planner] Auto-rebalance after session complete failed:", rebalanceError?.message ?? rebalanceError);
  }

  return sendOk(res, {
    sessionId,
    reason,
    summary: {
      totalQuestions: summary.total,
      correctAnswers: summary.correct,
      accuracyPercent: summary.accuracy,
      scorePercent: summary.score,
      timeSpentSec: summary.timeSpentSec
    },
    redirectTo: `#/adaptive-review?sessionId=${sessionId}`
  });
});

async function buildAdaptiveReview(userId: string, sessionId: string) {
  const { data: session, error: sessionError } = await supabaseService
    .from("practice_sessions")
    .select("id,module,topic,status,started_at,ended_at,score_percent,accuracy_percent,time_spent_sec")
    .eq("id", sessionId)
    .eq("user_id", userId)
    .maybeSingle();

  if (sessionError || !session) {
    throw new Error("Session not found");
  }

  const { data: attempts } = await supabaseService
    .from("practice_attempts")
    .select("id,question_id,selected_option,is_correct,time_spent_sec,created_at")
    .eq("session_id", sessionId)
    .order("created_at", { ascending: true });

  const questionIds = [...new Set((attempts ?? []).map((row: any) => row.question_id))];
  const questionMap = new Map<string, any>();

  if (questionIds.length > 0) {
    const { data: questions } = await supabaseService
      .from("questions")
      .select("id,subject,topic,prompt,options,correct_option")
      .in("id", questionIds);

    (questions ?? []).forEach((row: any) => questionMap.set(row.id, row));
  }

  const reviewItems = (attempts ?? []).map((row: any, index: number) => {
    const question = questionMap.get(row.question_id);
    const options = normalizeOptions((question?.options ?? {}) as Record<string, string>);

    return {
      number: String(index + 1).padStart(2, "0"),
      questionId: row.question_id,
      subject: question?.subject ?? "General",
      topic: question?.topic ?? "Concept",
      prompt: question?.prompt ?? "Question unavailable",
      status: row.is_correct ? "correct" : "incorrect",
      timeSpentSec: Number(row.time_spent_sec ?? 0),
      selectedOption: row.selected_option,
      correctOption: question?.correct_option ?? null,
      options: options.map((option) => ({
        ...option,
        isSelected: option.id === row.selected_option,
        isCorrect: option.id === question?.correct_option
      }))
    };
  });

  const incorrect = reviewItems.filter((item) => item.status === "incorrect");

  const conceptMap = new Map<string, number>();
  incorrect.forEach((item) => {
    const key = `${item.subject}: ${item.topic}`;
    conceptMap.set(key, (conceptMap.get(key) ?? 0) + 1);
  });

  const weakConcept = [...conceptMap.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "No critical weak concept";

  const calcMistakes = incorrect.filter((item) => item.timeSpentSec <= 45).length;
  const conceptualGaps = incorrect.filter((item) => item.timeSpentSec > 45).length;

  return {
    session: {
      id: session.id,
      module: session.module,
      topic: session.topic,
      startedAt: session.started_at,
      endedAt: session.ended_at,
      scorePercent: Number(session.score_percent ?? 0),
      accuracyPercent: Number(session.accuracy_percent ?? 0),
      timeSpentSec: Number(session.time_spent_sec ?? 0)
    },
    errorPatterns: [
      { label: "Calculation Mistakes", count: calcMistakes },
      { label: "Conceptual Gaps", count: conceptualGaps }
    ],
    weakConcept,
    recommendation: {
      title: "Adaptive Recommendation",
      description:
        weakConcept === "No critical weak concept"
          ? "Great run. Continue with adaptive progression to sustain momentum."
          : `You should reinforce ${weakConcept} with targeted follow-up questions.`
    },
    questions: reviewItems
  };
}

adaptiveRouter.get("/review/latest", requireAuth, async (req, res) => {
  const auth = req.auth;
  if (!auth) {
    return sendError(res, 401, "Unauthorized", "UNAUTHORIZED");
  }

  const { data: latest } = await supabaseService
    .from("practice_sessions")
    .select("id")
    .eq("user_id", auth.userId)
    .eq("status", "completed")
    .order("ended_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!latest?.id) {
    return sendError(res, 404, "No completed session found", "SESSION_NOT_FOUND");
  }

  const payload = await buildAdaptiveReview(auth.userId, latest.id);
  return sendOk(res, payload);
});

adaptiveRouter.get("/review/:sessionId", requireAuth, async (req, res) => {
  const auth = req.auth;
  if (!auth) {
    return sendError(res, 401, "Unauthorized", "UNAUTHORIZED");
  }

  try {
    const payload = await buildAdaptiveReview(auth.userId, req.params.sessionId);
    return sendOk(res, payload);
  } catch (error) {
    return sendError(res, 404, "Session review not found", "SESSION_REVIEW_NOT_FOUND", (error as Error).message);
  }
});
