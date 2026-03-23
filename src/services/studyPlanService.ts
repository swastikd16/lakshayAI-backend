import { env } from "../lib/env";
import { supabaseService } from "../lib/supabase";
import { collectPlannerContext, generateDeterministicFallback, runPlannerAgent } from "./plannerAgentService";
import type { PlannerBlock } from "../types/planner";

export type WeekBounds = {
  start: Date;
  end: Date;
};

export type PlanItem = {
  id: string;
  startsAt: string;
  endsAt: string;
  subject: string;
  topic: string;
  type: "study" | "revision" | "test";
};

export type ActivePlan = {
  id: string;
  week_start_date: string;
  status: string;
  focus_message: string | null;
  planner_source: string | null;
  used_fallback: boolean | null;
};

const ACTIVE_PLAN_CORE_SELECT = "id,week_start_date,status";
const ACTIVE_PLAN_METADATA_SELECT = "id,week_start_date,status,focus_message,planner_source,used_fallback";

function isMissingStudyPlanMetadataColumnError(error: unknown) {
  if (!error || typeof error !== "object") {
    return false;
  }

  const candidate = error as {
    code?: unknown;
    message?: unknown;
    details?: unknown;
    hint?: unknown;
  };

  const text = [candidate.code, candidate.message, candidate.details, candidate.hint]
    .filter((value): value is string => typeof value === "string")
    .join(" ")
    .toLowerCase();

  return (
    text.includes("42703") ||
    (text.includes("column") && text.includes("does not exist")) ||
    text.includes("unknown column") ||
    text.includes("schema cache")
  );
}

function isStudyPlanItemSourceWriteError(error: unknown) {
  if (!error || typeof error !== "object") return false;
  const candidate = error as {
    code?: unknown;
    message?: unknown;
    details?: unknown;
    hint?: unknown;
  };
  const text = [candidate.code, candidate.message, candidate.details, candidate.hint]
    .filter((value): value is string => typeof value === "string")
    .join(" ")
    .toLowerCase();

  return (
    text.includes("42703") ||
    text.includes("source") ||
    text.includes("check constraint") ||
    text.includes("invalid input value") ||
    text.includes("column") && text.includes("does not exist")
  );
}

function normalizeActivePlanRow(row: {
  id: string;
  week_start_date: string;
  status: string;
  focus_message?: string | null;
  planner_source?: string | null;
  used_fallback?: boolean | null;
}): ActivePlan {
  return {
    id: row.id,
    week_start_date: row.week_start_date,
    status: row.status,
    focus_message: row.focus_message ?? null,
    planner_source: row.planner_source ?? null,
    used_fallback: row.used_fallback ?? null
  };
}

async function fetchActivePlanRow(userId: string): Promise<ActivePlan | null> {
  const fullSelect = await supabaseService
    .from("study_plans")
    .select(ACTIVE_PLAN_METADATA_SELECT)
    .eq("user_id", userId)
    .eq("status", "active")
    .order("generated_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (fullSelect.error) {
    if (!isMissingStudyPlanMetadataColumnError(fullSelect.error)) {
      throw fullSelect.error;
    }

    const fallbackSelect = await supabaseService
      .from("study_plans")
      .select(ACTIVE_PLAN_CORE_SELECT)
      .eq("user_id", userId)
      .eq("status", "active")
      .order("generated_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (fallbackSelect.error) {
      throw fallbackSelect.error;
    }

    return fallbackSelect.data ? normalizeActivePlanRow(fallbackSelect.data) : null;
  }

  return fullSelect.data ? normalizeActivePlanRow(fullSelect.data) : null;
}

async function createActivePlanRow(userId: string, weekStartDate: string): Promise<ActivePlan> {
  const baseInsert = {
    user_id: userId,
    status: "active",
    week_start_date: weekStartDate
  };

  const metadataInsert = {
    ...baseInsert,
    planner_source: "fallback",
    used_fallback: true
  };

  const fullInsert = await supabaseService
    .from("study_plans")
    .insert(metadataInsert)
    .select(ACTIVE_PLAN_METADATA_SELECT)
    .single();

  if (fullInsert.error) {
    if (!isMissingStudyPlanMetadataColumnError(fullInsert.error)) {
      throw fullInsert.error;
    }

    const fallbackInsert = await supabaseService
      .from("study_plans")
      .insert(baseInsert)
      .select(ACTIVE_PLAN_CORE_SELECT)
      .single();

    if (fallbackInsert.error || !fallbackInsert.data) {
      throw fallbackInsert.error ?? new Error("Unable to create active study plan");
    }

    return normalizeActivePlanRow(fallbackInsert.data);
  }

  if (!fullInsert.data) {
    throw new Error("Unable to create active study plan");
  }

  return normalizeActivePlanRow(fullInsert.data);
}

function asDateOnly(value: Date) {
  return value.toISOString().slice(0, 10);
}

export function getWeekBounds(anchor = new Date()): WeekBounds {
  const base = new Date(anchor);
  const day = base.getDay();
  const mondayOffset = day === 0 ? -6 : 1 - day;

  const start = new Date(base);
  start.setDate(base.getDate() + mondayOffset);
  start.setHours(0, 0, 0, 0);

  const end = new Date(start);
  end.setDate(start.getDate() + 6);
  end.setHours(23, 59, 59, 999);

  return { start, end };
}

export function buildWeekDays(start: Date) {
  const days = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  return days.map((day, index) => {
    const date = new Date(start);
    date.setDate(start.getDate() + index);
    const now = new Date();

    return {
      day,
      date: String(date.getDate()),
      active:
        now.getFullYear() === date.getFullYear() &&
        now.getMonth() === date.getMonth() &&
        now.getDate() === date.getDate()
    };
  });
}

export async function ensureActivePlan(userId: string): Promise<ActivePlan> {
  const existing = await fetchActivePlanRow(userId);
  if (existing) {
    return existing;
  }

  const { start } = getWeekBounds();
  return createActivePlanRow(userId, asDateOnly(start));
}

export async function listWeekPlanItems(userId: string, anchor = new Date()): Promise<PlanItem[]> {
  const plan = await ensureActivePlan(userId);
  const { start, end } = getWeekBounds(anchor);

  const { data, error } = await supabaseService
    .from("study_plan_items")
    .select("id,starts_at,ends_at,subject,topic,type")
    .eq("plan_id", plan.id)
    .gte("starts_at", start.toISOString())
    .lte("starts_at", end.toISOString())
    .order("starts_at", { ascending: true });

  if (error) {
    throw error;
  }

  return (data ?? []).map((row) => ({
    id: row.id,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    subject: row.subject,
    topic: row.topic,
    type: row.type
  }));
}

const TYPE_SEQUENCE: Array<"study" | "revision" | "test"> = ["study", "revision", "study", "study", "revision", "test", "study"];
const HOUR_SEQUENCE = [8, 10, 11, 9, 12, 8, 10];

export async function regenerateWeekPlan(userId: string, anchor = new Date()) {
  const plan = await ensureActivePlan(userId);
  const { start, end } = getWeekBounds(anchor);

  await supabaseService.from("study_plans").update({ week_start_date: asDateOnly(start) }).eq("id", plan.id);

  await supabaseService
    .from("study_plan_items")
    .delete()
    .eq("plan_id", plan.id)
    .gte("starts_at", start.toISOString())
    .lte("starts_at", end.toISOString());

  const [{ data: revisionRows }, { data: confidenceRows }, { data: examRow }] = await Promise.all([
    supabaseService
      .from("revision_items")
      .select("subject,topic")
      .eq("user_id", userId)
      .order("updated_at", { ascending: false })
      .limit(18),
    supabaseService
      .from("user_subject_confidence")
      .select("subject,confidence_level")
      .eq("user_id", userId)
      .order("confidence_level", { ascending: true }),
    supabaseService
      .from("user_exam_settings")
      .select("exam_type")
      .eq("user_id", userId)
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle()
  ]);

  const topicPool = new Map<string, { subject: string; topic: string }>();

  (revisionRows ?? []).forEach((row) => {
    const key = `${row.subject}::${row.topic}`.toLowerCase();
    if (!topicPool.has(key)) {
      topicPool.set(key, { subject: row.subject, topic: row.topic });
    }
  });

  const confidenceOrderedSubjects =
    (confidenceRows ?? []).map((item) => item.subject) ?? ["Physics", "Chemistry", "Mathematics"];

  if (topicPool.size === 0) {
    confidenceOrderedSubjects.forEach((subject) => {
      const topic = `${subject} Core Revision`;
      topicPool.set(`${subject}::${topic}`.toLowerCase(), { subject, topic });
    });
  }

  const topicList = [...topicPool.values()];

  const rows = Array.from({ length: 7 }).map((_, index) => {
    const date = new Date(start);
    date.setDate(start.getDate() + index);

    const hour = HOUR_SEQUENCE[index % HOUR_SEQUENCE.length] ?? 9;
    const startsAt = new Date(date);
    startsAt.setHours(hour, 0, 0, 0);

    const endsAt = new Date(startsAt);
    endsAt.setMinutes(startsAt.getMinutes() + 90);

    const selected = topicList[index % topicList.length];
    const fallbackSubject = confidenceOrderedSubjects[index % confidenceOrderedSubjects.length] ?? "Physics";

    return {
      plan_id: plan.id,
      starts_at: startsAt.toISOString(),
      ends_at: endsAt.toISOString(),
      subject: selected?.subject ?? fallbackSubject,
      topic: selected?.topic ?? `${fallbackSubject} Practice`,
      type: TYPE_SEQUENCE[index % TYPE_SEQUENCE.length],
      source: "fallback" as const,
      notes: `Default regenerated schedule for ${(examRow?.exam_type ?? "JEE").trim()} prep`
    };
  });

  const { data: inserted, error } = await supabaseService
    .from("study_plan_items")
    .insert(rows)
    .select("id,starts_at,ends_at,subject,topic,type")
    .order("starts_at", { ascending: true });

  if (error) {
    throw error;
  }

  return (inserted ?? []).map((row) => ({
    id: row.id,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    subject: row.subject,
    topic: row.topic,
    type: row.type
  }));
}

export type RegenerateWithAgentResult = {
  items: PlanItem[];
  focusMessage: string;
  plannerSource: "llm" | "fallback";
  usedFallback: boolean;
  planId: string;
};

async function persistGeneratedWeek(
  planId: string,
  weekStart: Date,
  weekEnd: Date,
  items: PlannerBlock[],
  metadata: {
    plannerSource: "llm" | "fallback";
    focusMessage: string;
    rebalanceLogic: string;
    plannerModel: string | null;
    usedFallback: boolean;
    plannerInputSnapshot: unknown;
  }
): Promise<PlanItem[]> {
  await supabaseService
    .from("study_plan_items")
    .delete()
    .eq("plan_id", planId)
    .gte("starts_at", weekStart.toISOString())
    .lte("starts_at", weekEnd.toISOString());

  const { error: weekUpdateError } = await supabaseService
    .from("study_plans")
    .update({
      week_start_date: asDateOnly(weekStart)
    })
    .eq("id", planId);

  if (weekUpdateError) {
    throw weekUpdateError;
  }

  const { error: metadataUpdateError } = await supabaseService
    .from("study_plans")
    .update({
      rebalance_logic: metadata.rebalanceLogic,
      focus_message: metadata.focusMessage,
      planner_source: metadata.plannerSource,
      planner_model: metadata.plannerModel,
      planner_input_snapshot: metadata.plannerInputSnapshot,
      used_fallback: metadata.usedFallback,
      last_rebalanced_at: new Date().toISOString()
    })
    .eq("id", planId);

  if (metadataUpdateError && !isMissingStudyPlanMetadataColumnError(metadataUpdateError)) {
    throw metadataUpdateError;
  }

  const insertPrimary = items.map((item) => ({
    plan_id: planId,
    starts_at: item.starts_at,
    ends_at: item.ends_at,
    subject: item.subject,
    topic: item.topic,
    type: item.type,
    source: item.source,
    notes: item.notes ?? null
  }));

  let inserted: any[] | null = null;

  const primaryInsert = await supabaseService
    .from("study_plan_items")
    .insert(insertPrimary)
    .select("id,starts_at,ends_at,subject,topic,type")
    .order("starts_at", { ascending: true });

  if (primaryInsert.error) {
    if (!isStudyPlanItemSourceWriteError(primaryInsert.error)) {
      throw primaryInsert.error;
    }

    const legacyInsert = await supabaseService
      .from("study_plan_items")
      .insert(
        items.map((item) => ({
          plan_id: planId,
          starts_at: item.starts_at,
          ends_at: item.ends_at,
          subject: item.subject,
          topic: item.topic,
          type: item.type,
          source: "ai",
          notes: item.notes ?? null
        }))
      )
      .select("id,starts_at,ends_at,subject,topic,type")
      .order("starts_at", { ascending: true });

    if (legacyInsert.error) {
      const noSourceInsert = await supabaseService
        .from("study_plan_items")
        .insert(
          items.map((item) => ({
            plan_id: planId,
            starts_at: item.starts_at,
            ends_at: item.ends_at,
            subject: item.subject,
            topic: item.topic,
            type: item.type,
            notes: item.notes ?? null
          }))
        )
        .select("id,starts_at,ends_at,subject,topic,type")
        .order("starts_at", { ascending: true });

      if (noSourceInsert.error) {
        throw noSourceInsert.error;
      }

      inserted = noSourceInsert.data ?? [];
    } else {
      inserted = legacyInsert.data ?? [];
    }
  } else {
    inserted = primaryInsert.data ?? [];
  }

  return (inserted ?? []).map((row) => ({
    id: row.id,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    subject: row.subject,
    topic: row.topic,
    type: row.type
  }));
}

export async function regenerateWithAgent(userId: string, anchor = new Date()): Promise<RegenerateWithAgentResult> {
  const plan = await ensureActivePlan(userId);
  const { start, end } = getWeekBounds(anchor);
  const input = await collectPlannerContext(userId, anchor);
  const agentOutput = await runPlannerAgent(userId, anchor);

  const plannerSource: "llm" | "fallback" = agentOutput.rebalance.used_fallback ? "fallback" : "llm";
  const focusMessage = agentOutput.rebalance.detail || agentOutput.rebalance.headline;

  const rows = agentOutput.items.map((item) => ({
    ...item,
    source: plannerSource
  })) as PlannerBlock[];

  const storedItems = await persistGeneratedWeek(plan.id, start, end, rows, {
    plannerSource,
    focusMessage,
    rebalanceLogic: agentOutput.rebalance.detail,
    plannerModel: agentOutput.rebalance.model,
    usedFallback: agentOutput.rebalance.used_fallback,
    plannerInputSnapshot: {
      examType: input.examType,
      targetDate: input.targetDate,
      dailyHoursTarget: input.dailyHoursTarget,
      weekStartDate: input.weekStartDate,
      weakTopics: input.weakTopics,
      recentAccuracy: input.recentAccuracy,
      subjectConfidence: input.subjectConfidence
    }
  });

  return {
    items: storedItems,
    focusMessage,
    plannerSource,
    usedFallback: agentOutput.rebalance.used_fallback,
    planId: plan.id
  };
}

export async function regenerateWithAgentSafe(userId: string, anchor = new Date()): Promise<RegenerateWithAgentResult> {
  try {
    return await Promise.race([
      regenerateWithAgent(userId, anchor),
      new Promise<RegenerateWithAgentResult>((_, reject) => {
        setTimeout(() => reject(new Error("Planner agent timeout")), env.plannerLlmTimeoutMs);
      })
    ]);
  } catch (error) {
    console.warn("[planner] Safe regenerate fallback path:", error instanceof Error ? error.message : error);

    const plan = await ensureActivePlan(userId);
    const { start, end } = getWeekBounds(anchor);
    const input = await collectPlannerContext(userId, anchor);
    const fallback = generateDeterministicFallback(input);

    const fallbackItems = await persistGeneratedWeek(plan.id, start, end, fallback.items, {
      plannerSource: "fallback",
      focusMessage: `used default plan: ${fallback.rebalance.detail}`,
      rebalanceLogic: fallback.rebalance.detail,
      plannerModel: null,
      usedFallback: true,
      plannerInputSnapshot: {
        examType: input.examType,
        targetDate: input.targetDate,
        dailyHoursTarget: input.dailyHoursTarget,
        weekStartDate: input.weekStartDate,
        weakTopics: input.weakTopics,
        recentAccuracy: input.recentAccuracy,
        subjectConfidence: input.subjectConfidence
      }
    });

    return {
      items: fallbackItems,
      focusMessage: `used default plan: ${fallback.rebalance.detail}`,
      plannerSource: "fallback",
      usedFallback: true,
      planId: plan.id
    };
  }
}
