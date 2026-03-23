type RiskLevel = "critical" | "high" | "medium" | "low";

type BuildTopicCurveInput = {
  retentionEstimate: number;
  riskLevel: string | null | undefined;
  lastReviewAt?: string | null;
  nextReviewAt?: string | null;
  reviewCount?: number;
  now?: Date;
};

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function normalizeRiskLevel(riskLevel: string | null | undefined): RiskLevel {
  if (riskLevel === "critical" || riskLevel === "high" || riskLevel === "medium") {
    return riskLevel;
  }
  return "low";
}

function hoursBetween(from: Date, to: Date) {
  return Math.max(0, (to.getTime() - from.getTime()) / (1000 * 60 * 60));
}

function getDecayPerHour(riskLevel: RiskLevel) {
  switch (riskLevel) {
    case "critical":
      return 1.3;
    case "high":
      return 0.95;
    case "medium":
      return 0.65;
    case "low":
    default:
      return 0.4;
  }
}

export function buildTopicCurve(input: BuildTopicCurveInput) {
  const now = input.now ?? new Date();
  const riskLevel = normalizeRiskLevel(input.riskLevel);
  const reviewCount = Math.max(0, input.reviewCount ?? 0);
  const decayPerHour = getDecayPerHour(riskLevel);
  const lastReview = input.lastReviewAt ? new Date(input.lastReviewAt) : null;
  const nextReview = input.nextReviewAt ? new Date(input.nextReviewAt) : null;
  const elapsedHours = lastReview ? hoursBetween(lastReview, now) : 0;
  const reviewBonus = Math.min(12, reviewCount * 1.4);
  const startingRetention = clamp(
    Number(input.retentionEstimate ?? 0) - elapsedHours * decayPerHour + reviewBonus,
    6,
    100
  );
  const dueInHours = nextReview ? Math.round(hoursBetween(now, nextReview)) : null;
  const checkpoints = [0, 4, 12, 24, 48, 72, 168];

  return {
    currentRetention: Math.round(startingRetention),
    dueInHours,
    points: checkpoints.map((hours) => {
      const decay = Math.log2(hours + 1) * 11 * (decayPerHour / 0.65);
      return {
        label: hours === 0 ? "Now" : `${hours}h`,
        hoursFromNow: hours,
        retention: clamp(Math.round(startingRetention - decay), 5, 100)
      };
    })
  };
}

export function lowerRiskLevel(riskLevel: string | null | undefined): RiskLevel {
  switch (normalizeRiskLevel(riskLevel)) {
    case "critical":
      return "high";
    case "high":
      return "medium";
    case "medium":
      return "low";
    case "low":
    default:
      return "low";
  }
}
