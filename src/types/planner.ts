// ─── Planner Agent Types ────────────────────────────────────────────────────

export type WeakTopicInfo = {
  subject: string;
  topic: string;
  riskLevel: "critical" | "high" | "medium" | "low";
  retentionEstimate: number; // 0-100
};

export type RecentSessionAccuracy = {
  sessionId: string;
  accuracyPercent: number;
  topic: string | null;
  subject: string | null;
};

export type PlannerCalendarView = "week" | "month";

export type PlannerCalendarDay = {
  day: string;
  date: string;
  active: boolean;
};

/**
 * Context fed to the planner agent (LLM or fallback).
 */
export type PlannerAgentInput = {
  userId: string;
  examType: string;                   // 'JEE' | 'NEET' | 'UPSC'
  targetDate: string | null;          // ISO date string or null
  dailyHoursTarget: number;           // 1-16
  weekStartDate: string;              // ISO date string (Monday)
  weakTopics: WeakTopicInfo[];
  recentAccuracy: RecentSessionAccuracy[];
  availableTopics: { subject: string; topic: string }[];
  subjectConfidence: { subject: string; confidenceLevel: number }[];
};

/**
 * A single calendar block returned by the planner agent.
 */
export type PlannerBlock = {
  starts_at: string;  // ISO datetime
  ends_at: string;    // ISO datetime
  subject: string;
  topic: string;
  type: "study" | "revision" | "test";
  source: "llm" | "fallback";
  notes: string | null;
};

/**
 * AI rebalance metadata.
 */
export type RebalanceMetadata = {
  headline: string;
  detail: string;
  focus_window: string;
  used_fallback: boolean;
  model: string | null;
};

/**
 * Full output from the planner agent.
 */
export type PlannerAgentOutput = {
  items: PlannerBlock[];
  rebalance: RebalanceMetadata;
};

export type PlannerCalendarPayload = {
  view: PlannerCalendarView;
  rangeStartDate: string;
  rangeEndDate: string;
  rangeLabel: string;
  monthStartDate?: string;
  monthLabel?: string;
  calendarLabel?: string;
  weekStartDate: string;
  weekLabel: string;
  weekDays: PlannerCalendarDay[];
  calendarDays: PlannerCalendarDay[];
  days?: Array<{
    date: string;
    weekday: string;
    monthLabel: string;
    inCurrentMonth: boolean;
    active: boolean;
    items: Array<{
      id: string;
      startsAt: string;
      endsAt: string;
      subject: string;
      topic: string;
      type: "study" | "revision" | "test";
    }>;
  }>;
  items: Array<{
    id: string;
    startsAt: string;
    endsAt: string;
    subject: string;
    topic: string;
    type: "study" | "revision" | "test";
  }>;
  weakTopics: {
    id: string;
    title: string;
    riskLevel: string;
    retentionEstimate: number;
    severity: string;
    copy: string;
    icon: string;
  }[];
  focusMessage: string;
  plannerSource: "llm" | "fallback";
  usedFallback: boolean;
};
