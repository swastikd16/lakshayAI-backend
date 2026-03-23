import { supabaseService } from "../lib/supabase";
import { collectPlannerContext, generateDeterministicFallback, runPlannerAgent } from "./plannerAgentService";
import type {
  PlannerBlock,
  PlannerCalendarDay,
  PlannerCalendarPayload,
  PlannerCalendarView
} from "../types/planner";

export type WeekBounds = {
  start: Date;
  end: Date;
};

type CalendarRange = WeekBounds & {
  label: string;
  days: PlannerCalendarDay[];
};

type MonthCalendarCell = {
  date: string;
  weekday: string;
  monthLabel: string;
  inCurrentMonth: boolean;
  active: boolean;
  items: PlanItem[];
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

function formatWeekLabel(start: Date) {
  const end = new Date(start);
  end.setDate(start.getDate() + 6);

  const startLabel = start.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  const endLabel = end.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  return `${startLabel} - ${endLabel}`;
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

export function getCalendarRange(view: PlannerCalendarView, anchor = new Date()): CalendarRange {
  if (view === "month") {
    const base = new Date(anchor);
    const start = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), 1));
    start.setUTCHours(0, 0, 0, 0);

    const end = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + 1, 0));
    end.setUTCHours(23, 59, 59, 999);

    return {
      start,
      end,
      label: `${start.toLocaleDateString("en-US", { month: "short", year: "numeric", timeZone: "UTC" })}`,
      days: buildCalendarDays(start, end)
    };
  }

  const { start, end } = getWeekBounds(anchor);
  return {
    start,
    end,
    label: formatWeekLabel(start),
    days: buildCalendarDays(start, end)
  };
}

export function buildWeekDays(start: Date) {
  const end = new Date(start);
  end.setDate(start.getDate() + 6);
  return buildCalendarDays(start, end);
}

export function buildCalendarDays(start: Date, end: Date): PlannerCalendarDay[] {
  const days: PlannerCalendarDay[] = [];
  const cursor = new Date(start);
  const now = new Date();

  while (cursor <= end) {
    days.push({
      day: cursor.toLocaleDateString("en-US", { weekday: "short", timeZone: "UTC" }),
      date: String(cursor.getUTCDate()),
      active:
        now.getUTCFullYear() === cursor.getUTCFullYear() &&
        now.getUTCMonth() === cursor.getUTCMonth() &&
        now.getUTCDate() === cursor.getUTCDate()
    });

    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }

  return days;
}

function toDayKey(date: Date) {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
}

function buildMonthCalendarCells(monthStart: Date, items: PlanItem[]): MonthCalendarCell[] {
  const firstOfMonth = new Date(Date.UTC(monthStart.getUTCFullYear(), monthStart.getUTCMonth(), 1, 0, 0, 0, 0));
  const mondayOffset = firstOfMonth.getUTCDay() === 0 ? -6 : 1 - firstOfMonth.getUTCDay();
  const gridStart = new Date(firstOfMonth);
  gridStart.setUTCDate(firstOfMonth.getUTCDate() + mondayOffset);

  const itemBuckets = new Map<string, PlanItem[]>();
  items.forEach((item) => {
    if (!item.startsAt) return;
    const itemDate = new Date(item.startsAt);
    if (Number.isNaN(itemDate.getTime())) return;
    const key = toDayKey(itemDate);
    const dayList = itemBuckets.get(key) ?? [];
    dayList.push(item);
    itemBuckets.set(key, dayList);
  });

  return Array.from({ length: 42 }, (_, index) => {
    const date = new Date(gridStart);
    date.setUTCDate(gridStart.getUTCDate() + index);
    const key = toDayKey(date);
    const today = new Date();

    return {
      date: String(date.getUTCDate()),
      weekday: date.toLocaleDateString("en-US", { weekday: "short", timeZone: "UTC" }),
      monthLabel: date.toLocaleDateString("en-US", { month: "short", timeZone: "UTC" }),
      inCurrentMonth: date.getUTCMonth() === monthStart.getUTCMonth() && date.getUTCFullYear() === monthStart.getUTCFullYear(),
      active:
        date.getUTCFullYear() === today.getUTCFullYear() &&
        date.getUTCMonth() === today.getUTCMonth() &&
        date.getUTCDate() === today.getUTCDate(),
      items: itemBuckets.get(key) ?? []
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

async function listPlanItemsInRange(userId: string, anchor = new Date(), view: PlannerCalendarView = "week"): Promise<PlanItem[]> {
  const plan = await ensureActivePlan(userId);
  const { start, end } = getCalendarRange(view, anchor);

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

export async function listWeekPlanItems(userId: string, anchor = new Date()): Promise<PlanItem[]> {
  return listPlanItemsInRange(userId, anchor, "week");
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
      .select("subject,topic,risk_level")
      .eq("user_id", userId)
      .eq("queue_enabled", true)
      .in("risk_level", ["critical", "high", "medium"])
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

  (revisionRows ?? []).forEach((row: any) => {
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

function mapWeakTopics(weakTopicsRows: any[] | null | undefined) {
  return (weakTopicsRows ?? []).map((row: any) => ({
    id: row.id,
    title: `${row.subject}: ${row.topic}`,
    riskLevel: row.risk_level as string,
    retentionEstimate: Number(row.retention_estimate ?? 0),
    severity: row.risk_level?.toUpperCase() ?? "MEDIUM",
    copy: `Retention at ${Number(row.retention_estimate ?? 0)}%. Prioritized in morning blocks.`,
    icon: row.risk_level === "critical" ? "error" : row.risk_level === "high" ? "warning" : "priority_high"
  }));
}

function monthlyRiskWeight(riskLevel: string) {
  if (riskLevel === "critical") return 4;
  if (riskLevel === "high") return 3;
  if (riskLevel === "medium") return 2;
  return 1;
}

function buildMonthlyWeakTopicItems(
  monthStart: Date,
  monthEnd: Date,
  weakTopicsRows: any[] | null | undefined
): PlanItem[] {
  const rows = (weakTopicsRows ?? []).filter((row) => row?.subject && row?.topic);
  if (rows.length === 0) {
    return [];
  }

  const weightedTopics: Array<{ subject: string; topic: string }> = [];
  rows.forEach((row) => {
    const weight = monthlyRiskWeight(String(row.risk_level ?? ""));
    for (let index = 0; index < weight; index += 1) {
      weightedTopics.push({
        subject: String(row.subject),
        topic: String(row.topic)
      });
    }
  });

  const topicPool = weightedTopics.length > 0 ? weightedTopics : rows.map((row) => ({
    subject: String(row.subject),
    topic: String(row.topic)
  }));

  const items: PlanItem[] = [];
  const cursor = new Date(monthStart);
  let topicIndex = 0;

  while (cursor <= monthEnd) {
    const startAt = new Date(cursor);
    startAt.setUTCHours(8, 0, 0, 0);
    const endAt = new Date(startAt);
    endAt.setUTCMinutes(endAt.getUTCMinutes() + 90);

    const chosen = topicPool[topicIndex % topicPool.length];
    items.push({
      id: `month-${cursor.toISOString().slice(0, 10)}-${topicIndex}`,
      startsAt: startAt.toISOString(),
      endsAt: endAt.toISOString(),
      subject: chosen.subject,
      topic: chosen.topic,
      type: topicIndex % 4 === 0 ? "study" : "revision"
    });

    topicIndex += 1;
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }

  return items;
}

export async function buildPlannerCalendarPayload(
  userId: string,
  anchor = new Date(),
  view: PlannerCalendarView = "week"
): Promise<PlannerCalendarPayload> {
  const { start, end, label, days } = getCalendarRange(view, anchor);
  const weekStart = getWeekBounds(anchor).start;

  const [items, weakTopicsRows, plan] = await Promise.all([
    listPlanItemsInRange(userId, anchor, view),
    supabaseService
      .from("revision_items")
      .select("id,subject,topic,risk_level,retention_estimate")
      .eq("user_id", userId)
      .eq("queue_enabled", true)
      .in("risk_level", ["critical", "high", "medium"])
      .order("updated_at", { ascending: false })
      .limit(40),
    ensureActivePlan(userId)
  ]);

  const monthDistributedItems =
    view === "month" ? buildMonthlyWeakTopicItems(start, end, weakTopicsRows.data ?? []) : [];
  const effectiveItems =
    view === "month"
      ? items.length > 0
        ? items
        : monthDistributedItems
      : items;

  return {
    view,
    rangeStartDate: start.toISOString().slice(0, 10),
    rangeEndDate: end.toISOString().slice(0, 10),
    rangeLabel: label,
    monthStartDate: view === "month" ? start.toISOString().slice(0, 10) : undefined,
    monthLabel: view === "month" ? label : undefined,
    calendarLabel: label,
    weekStartDate: weekStart.toISOString().slice(0, 10),
    weekLabel: formatWeekLabel(weekStart),
    weekDays: buildWeekDays(weekStart),
    calendarDays: days,
    days: view === "month" ? buildMonthCalendarCells(start, effectiveItems) : undefined,
    items: effectiveItems,
    weakTopics: mapWeakTopics(weakTopicsRows.data ?? []),
    focusMessage: plan.focus_message ?? "Generate your plan to see AI rebalance reasoning.",
    plannerSource: (plan.planner_source ?? "fallback") as "llm" | "fallback",
    usedFallback: Boolean(plan.used_fallback ?? true)
  };
}

export type RegenerateWithAgentResult = {
  items: PlanItem[];
  focusMessage: string;
  plannerSource: "llm" | "fallback";
  usedFallback: boolean;
  planId: string;
};

async function insertGeneratedItems(planId: string, items: PlannerBlock[]): Promise<PlanItem[]> {
  if (items.length === 0) {
    return [];
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

  return insertGeneratedItems(planId, items);
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
    return await regenerateWithAgent(userId, anchor);
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

function buildMonthWeekAnchors(monthStart: Date, monthEnd: Date): Date[] {
  const firstWeek = getWeekBounds(monthStart).start;
  const anchors: Date[] = [];
  const cursor = new Date(firstWeek);

  while (cursor <= monthEnd) {
    anchors.push(new Date(cursor));
    cursor.setDate(cursor.getDate() + 7);
  }

  return anchors;
}

function toPlannerBlockRows(items: PlanItem[], source: "llm" | "fallback", notes: string): PlannerBlock[] {
  return items
    .filter((item) => item.startsAt && item.endsAt)
    .map((item) => ({
      starts_at: String(item.startsAt),
      ends_at: String(item.endsAt),
      subject: item.subject ?? "Study",
      topic: item.topic ?? "Untitled block",
      type: item.type === "revision" || item.type === "test" ? item.type : "study",
      source,
      notes
    }));
}

function inRange(isoDateTime: string, start: Date, end: Date) {
  const parsed = new Date(isoDateTime);
  if (Number.isNaN(parsed.getTime())) {
    return false;
  }
  return parsed >= start && parsed <= end;
}

export async function regenerateMonthWithAgent(userId: string, anchor = new Date()): Promise<RegenerateWithAgentResult> {
  const plan = await ensureActivePlan(userId);
  const { start: monthStart, end: monthEnd } = getCalendarRange("month", anchor);
  const weekAnchors = buildMonthWeekAnchors(monthStart, monthEnd);

  const monthBlocks: PlannerBlock[] = [];
  const rebalanceDetails: string[] = [];
  const modelSet = new Set<string>();

  for (const weekAnchor of weekAnchors) {
    const output = await runPlannerAgent(userId, weekAnchor);
    const source: "llm" | "fallback" = output.rebalance.used_fallback ? "fallback" : "llm";

    output.items
      .map((item) => ({ ...item, source }))
      .filter((item) => inRange(item.starts_at, monthStart, monthEnd))
      .forEach((item) => {
        monthBlocks.push(item);
      });

    if (output.rebalance.detail) {
      rebalanceDetails.push(output.rebalance.detail);
    }
    if (output.rebalance.model) {
      modelSet.add(output.rebalance.model);
    }
  }

  monthBlocks.sort((left, right) => new Date(left.starts_at).getTime() - new Date(right.starts_at).getTime());

  await supabaseService
    .from("study_plan_items")
    .delete()
    .eq("plan_id", plan.id)
    .gte("starts_at", monthStart.toISOString())
    .lte("starts_at", monthEnd.toISOString());

  const plannerSource: "llm" | "fallback" = monthBlocks.some((item) => item.source === "llm") ? "llm" : "fallback";
  const focusMessage =
    rebalanceDetails.length > 0
      ? [...new Set(rebalanceDetails.flatMap((detail) => detail.split("\n").map((line) => line.trim()).filter(Boolean)))]
          .slice(0, 3)
          .join("\n")
      : plannerSource === "llm"
        ? "Weak topics were distributed across this month using AI planning."
        : "used default plan: weak topics were distributed across the month.";
  const plannerModel = modelSet.size > 0 ? [...modelSet].join(", ") : null;

  const { error: metadataUpdateError } = await supabaseService
    .from("study_plans")
    .update({
      week_start_date: asDateOnly(getWeekBounds(anchor).start),
      rebalance_logic: focusMessage,
      focus_message: focusMessage,
      planner_source: plannerSource,
      planner_model: plannerModel,
      used_fallback: plannerSource === "fallback",
      last_rebalanced_at: new Date().toISOString()
    })
    .eq("id", plan.id);

  if (metadataUpdateError && !isMissingStudyPlanMetadataColumnError(metadataUpdateError)) {
    throw metadataUpdateError;
  }

  const storedItems = await insertGeneratedItems(plan.id, monthBlocks);

  return {
    items: storedItems,
    focusMessage,
    plannerSource,
    usedFallback: plannerSource === "fallback",
    planId: plan.id
  };
}

export async function regenerateMonthWithAgentSafe(userId: string, anchor = new Date()): Promise<RegenerateWithAgentResult> {
  try {
    return await regenerateMonthWithAgent(userId, anchor);
  } catch (error) {
    console.warn("[planner] Safe monthly regenerate fallback path:", error instanceof Error ? error.message : error);

    const plan = await ensureActivePlan(userId);
    const { start: monthStart, end: monthEnd } = getCalendarRange("month", anchor);
    const { data: weakTopicsRows, error: weakTopicsError } = await supabaseService
      .from("revision_items")
      .select("subject,topic,risk_level,retention_estimate")
      .eq("user_id", userId)
      .eq("queue_enabled", true)
      .in("risk_level", ["critical", "high", "medium"])
      .order("updated_at", { ascending: false })
      .limit(40);

    if (weakTopicsError) {
      throw weakTopicsError;
    }

    const fallbackPlanItems = buildMonthlyWeakTopicItems(monthStart, monthEnd, weakTopicsRows ?? []);
    const fallbackBlocks = toPlannerBlockRows(
      fallbackPlanItems,
      "fallback",
      "Auto-rebalanced default monthly block"
    );

    await supabaseService
      .from("study_plan_items")
      .delete()
      .eq("plan_id", plan.id)
      .gte("starts_at", monthStart.toISOString())
      .lte("starts_at", monthEnd.toISOString());

    const focusMessage = "used default plan: weak topics were distributed across the month.";

    const { error: metadataUpdateError } = await supabaseService
      .from("study_plans")
      .update({
        week_start_date: asDateOnly(getWeekBounds(anchor).start),
        rebalance_logic: focusMessage,
        focus_message: focusMessage,
        planner_source: "fallback",
        planner_model: null,
        used_fallback: true,
        last_rebalanced_at: new Date().toISOString()
      })
      .eq("id", plan.id);

    if (metadataUpdateError && !isMissingStudyPlanMetadataColumnError(metadataUpdateError)) {
      throw metadataUpdateError;
    }

    const storedItems = await insertGeneratedItems(plan.id, fallbackBlocks);

    return {
      items: storedItems,
      focusMessage,
      plannerSource: "fallback",
      usedFallback: true,
      planId: plan.id
    };
  }
}
