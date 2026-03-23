import { Router } from "express";
import { sendError, sendOk } from "../lib/response";
import { requireAuth } from "../middleware/auth";
import { getExpandedAttempts } from "../services/dataHelpers";
import { listWeekPlanItems } from "../services/studyPlanService";
import { supabaseService } from "../lib/supabase";

function computeStreak(dates: string[]) {
  const uniqueDays = [...new Set(dates.map((value) => value.slice(0, 10)))].sort().reverse();
  let streak = 0;
  let cursor = new Date();
  cursor.setHours(0, 0, 0, 0);

  for (const day of uniqueDays) {
    const current = new Date(`${day}T00:00:00`);
    if (current.getTime() === cursor.getTime()) {
      streak += 1;
      cursor.setDate(cursor.getDate() - 1);
      continue;
    }

    if (streak === 0 && current.getTime() === cursor.getTime() - 86400000) {
      streak += 1;
      cursor = current;
      cursor.setDate(cursor.getDate() - 1);
      continue;
    }

    break;
  }

  return streak;
}

function masteryLabel(score: number) {
  if (score >= 85) return "Platinum";
  if (score >= 72) return "Gold";
  if (score >= 55) return "Silver";
  return "Rising";
}

export const dashboardRouter = Router();

dashboardRouter.get("/summary", requireAuth, async (req, res) => {
  const auth = req.auth;
  if (!auth) {
    return sendError(res, 401, "Unauthorized", "UNAUTHORIZED");
  }

  const [
    { data: profile },
    { data: sessions },
    { data: revisionItems },
    planItems,
    expandedAttempts
  ] = await Promise.all([
    supabaseService.from("profiles").select("full_name").eq("id", auth.userId).maybeSingle(),
    supabaseService
      .from("practice_sessions")
      .select("id,started_at,score_percent,accuracy_percent,status")
      .eq("user_id", auth.userId)
      .eq("status", "completed")
      .order("started_at", { ascending: false })
      .limit(30),
    supabaseService
      .from("revision_items")
      .select("id,subject,topic,risk_level,retention_estimate,next_review_at")
      .eq("user_id", auth.userId)
      .order("updated_at", { ascending: false })
      .limit(12),
    listWeekPlanItems(auth.userId),
    getExpandedAttempts(auth.userId, 600)
  ]);

  const completed = sessions ?? [];

  const prepScore =
    completed.length > 0
      ? Math.round(completed.reduce((sum, row: any) => sum + Number(row.score_percent ?? 0), 0) / completed.length)
      : 0;

  const now = new Date();
  const last7Start = new Date(now);
  last7Start.setDate(now.getDate() - 7);

  const prev7Start = new Date(now);
  prev7Start.setDate(now.getDate() - 14);

  const currentWeek = completed.filter((row: any) => new Date(row.started_at) >= last7Start);
  const previousWeek = completed.filter(
    (row: any) => new Date(row.started_at) >= prev7Start && new Date(row.started_at) < last7Start
  );

  const currentAvg =
    currentWeek.length > 0
      ? currentWeek.reduce((sum: number, row: any) => sum + Number(row.score_percent ?? 0), 0) / currentWeek.length
      : 0;

  const previousAvg =
    previousWeek.length > 0
      ? previousWeek.reduce((sum: number, row: any) => sum + Number(row.score_percent ?? 0), 0) / previousWeek.length
      : 0;

  const weeklyDelta = Math.round(currentAvg - previousAvg);
  const streak = computeStreak(completed.map((row: any) => row.started_at));

  const todayKey = new Date().toISOString().slice(0, 10);
  const todayPlan = planItems
    .filter((item) => item.startsAt.startsWith(todayKey))
    .map((item) => ({
      id: item.id,
      time: new Date(item.startsAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }),
      subject: item.subject,
      title: item.topic,
      type: item.type
    }));

  const incorrect = expandedAttempts.filter((item) => item.isCorrect === false);
  const weakMap = new Map<string, { subject: string; topic: string; misses: number; total: number }>();

  expandedAttempts.forEach((item) => {
    const key = `${item.subject}::${item.topic}`;
    const state = weakMap.get(key) ?? { subject: item.subject, topic: item.topic, misses: 0, total: 0 };
    state.total += 1;
    if (item.isCorrect === false) state.misses += 1;
    weakMap.set(key, state);
  });

  const weakTopics = [...weakMap.values()]
    .map((item) => ({
      ...item,
      accuracy: item.total > 0 ? Math.round(((item.total - item.misses) / item.total) * 100) : 0
    }))
    .sort((a, b) => a.accuracy - b.accuracy)
    .slice(0, 3)
    .map((item, index) => ({
      id: `${item.subject}-${item.topic}`,
      priority: index === 0 ? "high" : index === 1 ? "mid" : "low",
      title: `${item.subject}: ${item.topic}`,
      trend: `${100 - item.accuracy}% error rate`,
      accuracy: item.accuracy,
      misses: item.misses,
      total: item.total,
      hint:
        index === 0
          ? "High forgetting risk"
          : index === 1
            ? "Needs targeted practice"
            : "Monitor this topic"
    }));

  const dueRevision = (revisionItems ?? []).slice(0, 2).map((item: any, index: number) => ({
    id: item.id,
    title: item.topic,
    status:
      item.next_review_at && new Date(item.next_review_at) < new Date()
        ? "Overdue"
        : index === 0
          ? "Due now"
          : "Upcoming",
    subject: item.subject,
    retention: Number(item.retention_estimate ?? 0),
    riskLevel: item.risk_level
  }));

  const recommendationTopic = weakTopics[0]?.title ?? dueRevision[0]?.title ?? "Adaptive Practice";

  return sendOk(res, {
    greetingName: profile?.full_name ?? "Student",
    prepScore,
    weeklyDelta,
    streak,
    masteryLabel: masteryLabel(prepScore),
    daysToExam: 68,
    todayPlan,
    revisionCards: dueRevision,
    weakTopics,
    recommendation: {
      title: `Complete \"${recommendationTopic}\" adaptive practice`,
      description: "AI-recommended next action based on your latest performance trend."
    },
    quickActions: [
      { key: "practice", label: "Practice", href: "#/adaptive-practice", icon: "fitness_center" },
      { key: "doubt", label: "Doubt Solver", href: "#/doubt-solver", icon: "smart_toy" },
      { key: "revision", label: "Revision", href: "#/revision", icon: "history" },
      { key: "analytics", label: "Analytics", href: "#/analytics", icon: "bar_chart" }
    ]
  });
});

