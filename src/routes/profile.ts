import { Router } from "express";
import { sendError, sendOk } from "../lib/response";
import { requireAuth } from "../middleware/auth";
import { supabaseService } from "../lib/supabase";
import { getExpandedAttempts } from "../services/dataHelpers";

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

export const profileRouter = Router();

profileRouter.get("/snapshot", requireAuth, async (req, res) => {
  const auth = req.auth;
  if (!auth) {
    return sendError(res, 401, "Unauthorized", "UNAUTHORIZED");
  }

  const [
    { data: profile },
    { data: examSettings },
    { data: confidenceRows },
    attempts
  ] = await Promise.all([
    supabaseService
      .from("profiles")
      .select("full_name,target_exam")
      .eq("id", auth.userId)
      .maybeSingle(),
    supabaseService
      .from("user_exam_settings")
      .select("exam_type")
      .eq("user_id", auth.userId)
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
    supabaseService
      .from("user_subject_confidence")
      .select("subject,confidence_level")
      .eq("user_id", auth.userId),
    getExpandedAttempts(auth.userId, 1200)
  ]);

  const confidenceMap = new Map(
    (confidenceRows ?? []).map((item: any) => [String(item.subject).toLowerCase(), Number(item.confidence_level)])
  );

  const subjects = ["mathematics", "physics", "chemistry"];

  const subjectStats = subjects.map((subject) => {
    const bySubject = attempts.filter((item) => item.subject.toLowerCase() === subject);
    const correct = bySubject.filter((item) => item.isCorrect).length;
    const mastery = bySubject.length > 0 ? Math.round((correct / bySubject.length) * 100) : 0;
    const confidence = confidenceMap.get(subject) ?? 2;

    return {
      subject: subject.charAt(0).toUpperCase() + subject.slice(1),
      mastery,
      confidence
    };
  });

  const masteryAverage =
    subjectStats.length > 0
      ? Math.round(subjectStats.reduce((sum, item) => sum + item.mastery, 0) / subjectStats.length)
      : 0;

  const topicMistakes = new Map<string, number>();
  attempts.forEach((item) => {
    if (item.isCorrect === false) {
      topicMistakes.set(item.topic, (topicMistakes.get(item.topic) ?? 0) + 1);
    }
  });

  const weakTopics = [...topicMistakes.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([topic], index) => ({
      index: String(index + 1).padStart(2, "0"),
      title: topic
    }));

  const byTopic = new Map<string, { total: number; correct: number; subject: string }>();
  attempts.forEach((item) => {
    const state = byTopic.get(item.topic) ?? { total: 0, correct: 0, subject: item.subject };
    state.total += 1;
    if (item.isCorrect) state.correct += 1;
    byTopic.set(item.topic, state);
  });

  const performanceBars = [...byTopic.entries()]
    .map(([topic, value]) => ({
      label: topic,
      performance: value.total > 0 ? Math.round((value.correct / value.total) * 100) : 0,
      confidence: clamp((confidenceMap.get(value.subject.toLowerCase()) ?? 2) * 25, 20, 95)
    }))
    .slice(0, 5);

  return sendOk(res, {
    fullName: profile?.full_name ?? "Lakshay Student",
    targetExam: profile?.target_exam ?? examSettings?.exam_type ?? "JEE",
    masteryCards: subjectStats.map((item) => ({
      label: item.subject,
      status: item.mastery >= 80 ? "Strong" : item.mastery >= 60 ? "Intermediate" : "Beginner",
      score: item.mastery
    })),
    weakTopics,
    performanceBars,
    masteryAverage,
    conceptRecall: clamp(masteryAverage + 8, 0, 100),
    problemSpeed: clamp(masteryAverage - 12, 0, 100),
    insight:
      "Your mathematical foundation is relatively stronger. Prioritize early chemistry reinforcement to balance overall preparation.",
    recommendedFocus: weakTopics[0]?.title ?? "Organic Reactions"
  });
});
