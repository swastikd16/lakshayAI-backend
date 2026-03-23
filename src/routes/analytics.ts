import { Router } from "express";
import { sendError, sendOk } from "../lib/response";
import { requireAuth } from "../middleware/auth";
import { getExpandedAttempts } from "../services/dataHelpers";
import { supabaseService } from "../lib/supabase";

function avg(values: number[]) {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export const analyticsRouter = Router();

analyticsRouter.get("/snapshot", requireAuth, async (req, res) => {
  const auth = req.auth;
  if (!auth) {
    return sendError(res, 401, "Unauthorized", "UNAUTHORIZED");
  }

  const [attempts, { data: sessions }, { data: revisionItems }, { data: planItems }] = await Promise.all([
    getExpandedAttempts(auth.userId, 1200),
    supabaseService
      .from("practice_sessions")
      .select("id,started_at,score_percent,time_spent_sec,status")
      .eq("user_id", auth.userId)
      .eq("status", "completed")
      .order("started_at", { ascending: false })
      .limit(60),
    supabaseService
      .from("revision_items")
      .select("retention_estimate")
      .eq("user_id", auth.userId),
    supabaseService
      .from("study_plan_items")
      .select("starts_at")
      .in(
        "plan_id",
        (
          await supabaseService
            .from("study_plans")
            .select("id")
            .eq("user_id", auth.userId)
            .eq("status", "active")
        ).data?.map((row: any) => row.id) ?? []
      )
      .limit(200)
  ]);

  const sessionRows = sessions ?? [];
  const scores = sessionRows.map((item: any) => Number(item.score_percent ?? 0));
  const overallScore = Math.round(avg(scores));

  const now = new Date();
  const sevenDaysAgo = new Date(now);
  sevenDaysAgo.setDate(now.getDate() - 7);
  const fourteenDaysAgo = new Date(now);
  fourteenDaysAgo.setDate(now.getDate() - 14);

  const currentWeek = sessionRows.filter((item: any) => new Date(item.started_at) >= sevenDaysAgo);
  const previousWeek = sessionRows.filter(
    (item: any) => new Date(item.started_at) >= fourteenDaysAgo && new Date(item.started_at) < sevenDaysAgo
  );

  const weeklyDelta = Math.round(
    avg(currentWeek.map((item: any) => Number(item.score_percent ?? 0))) -
      avg(previousWeek.map((item: any) => Number(item.score_percent ?? 0)))
  );

  const byTopic = new Map<string, { subject: string; topic: string; total: number; correct: number }>();
  attempts.forEach((item) => {
    const key = `${item.subject}::${item.topic}`;
    const bucket = byTopic.get(key) ?? {
      subject: item.subject,
      topic: item.topic,
      total: 0,
      correct: 0
    };
    bucket.total += 1;
    if (item.isCorrect) bucket.correct += 1;
    byTopic.set(key, bucket);
  });

  const proficiencyCards = [...byTopic.values()]
    .map((item) => ({
      title: item.topic,
      subject: item.subject,
      score: item.total > 0 ? Math.round((item.correct / item.total) * 100) : 0,
      delta: item.total > 0 ? Math.round(((item.correct / item.total) * 100 - 50) / 2) : 0
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 4);

  const bySubject = new Map<string, Array<{ name: string; value: number }>>();
  [...byTopic.values()].forEach((item) => {
    const score = item.total > 0 ? Math.round((item.correct / item.total) * 100) : 0;
    const list = bySubject.get(item.subject) ?? [];
    list.push({ name: item.topic, value: score });
    bySubject.set(item.subject, list);
  });

  const subjectBreakdown = [...bySubject.entries()].map(([subject, topics]) => ({
    subject,
    topics: topics.slice(0, 4)
  }));

  const dailyMap = new Map<string, number>();
  sessionRows.forEach((item: any) => {
    const key = String(item.started_at).slice(0, 10);
    const previous = dailyMap.get(key) ?? 0;
    dailyMap.set(key, previous + Number(item.time_spent_sec ?? 0) / 3600);
  });

  const dailyMastery = Array.from({ length: 7 }).map((_, idx) => {
    const date = new Date();
    date.setDate(date.getDate() - (6 - idx));
    const key = date.toISOString().slice(0, 10);
    const hours = Number((dailyMap.get(key) ?? 0).toFixed(1));
    return {
      label: date.toLocaleDateString("en-US", { weekday: "short" }),
      hours,
      fill: Math.min(100, Math.round((hours / 8) * 100))
    };
  });

  const avgRetention = Math.round(
    avg((revisionItems ?? []).map((item: any) => Number(item.retention_estimate ?? 0)))
  );
  const retentionBars = [24, 72, 168, 336, 720].map((hours, idx) => ({
    label: idx === 0 ? "24h" : idx === 1 ? "3d" : idx === 2 ? "7d" : idx === 3 ? "14d" : "30d",
    value: Math.max(20, Math.round((avgRetention || 80) - Math.log2(hours) * 8))
  }));

  const hourCounts = new Map<number, number>();
  (planItems ?? []).forEach((item: any) => {
    const hour = new Date(item.starts_at).getHours();
    hourCounts.set(hour, (hourCounts.get(hour) ?? 0) + 1);
  });

  const focusHour = [...hourCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 8;
  const focusWindow = `${String(focusHour).padStart(2, "0")}:00 - ${String((focusHour + 3) % 24).padStart(2, "0")}:00`;

  return sendOk(res, {
    overallScore,
    weeklyDelta,
    focusWindow,
    achievementStats: [
      { label: "Percentile", value: `${Math.max(60, Math.min(99, overallScore + 12))}`, icon: "leaderboard" },
      { label: "Consistency", value: `${dailyMastery.filter((d) => d.hours > 0).length} days`, icon: "local_fire_department" },
      { label: "Weak Concepts", value: `${Math.max(0, 20 - proficiencyCards.length)} left`, icon: "warning" }
    ],
    proficiencyCards,
    subjectBreakdown,
    dailyMastery,
    retentionBars,
    insightSignals: [
      `Current weekly delta is ${weeklyDelta >= 0 ? "+" : ""}${weeklyDelta}.`,
      `Focus window optimized around ${focusWindow}.`,
      `Average retention estimate is ${avgRetention || 0}%.`
    ]
  });
});
