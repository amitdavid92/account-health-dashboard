/**
 * Every tunable number in the health model lives here, with the reason it was
 * chosen next to it. Nothing downstream hard-codes a threshold.
 *
 * These are *calibrated*, not fitted. There are no churn labels in this
 * dataset, so the bands were chosen to split this portfolio in a way a CSM can
 * act on, then sanity-checked against the observed distribution. With real
 * churn outcomes they would be fitted instead - see README "What I'd build next".
 */

import type { HealthTier, PillarKey, RiskSeverity } from "./types";

// ---------------------------------------------------------------------------
// Analysis windows
// ---------------------------------------------------------------------------

/**
 * "Today" is the latest event timestamp in the export, never wall-clock time.
 * The data ends 2026-09-13; using new Date() would make every account look
 * dormant and the demo would rot. Resolved at ingest and stored in `meta`.
 */
export const WINDOW = {
  /** The "recent" period every signal is measured over. */
  recentDays: 30,
  /** The comparison period immediately before it. */
  priorDays: 60,
  /** Full export window. */
  totalDays: 90,
  /** Weeks used by the consistency pillar. */
  consistencyWeeks: 8,
  /** Weeks rendered in the drill-down activity chart. */
  chartWeeks: 13,
} as const;

// ---------------------------------------------------------------------------
// Pillars
// ---------------------------------------------------------------------------

/**
 * A band is `[minimum value, points]`, evaluated top-down: the first band whose
 * minimum the value meets wins. Points sum to 100 across the four pillars.
 */
export type Band = readonly [min: number, points: number];

export const PILLARS: Record<
  PillarKey,
  { label: string; max: number; rationale: string }
> = {
  recency: {
    label: "Recency",
    max: 30,
    rationale:
      "Days since the last event. The strongest and least ambiguous churn signal available here, and the one with real spread in this data (0-43 days).",
  },
  breadth: {
    label: "Breadth",
    max: 25,
    rationale:
      "Distinct users active in the last 30 days. Separates a team habit from a single champion, which is the difference between a renewal and a resignation letter.",
  },
  depth: {
    label: "Depth",
    max: 25,
    rationale:
      "Guides created and shared recently. Guidde's value is captured knowledge, not sessions - an account that only logs in is not getting what it paid for.",
  },
  consistency: {
    label: "Consistency",
    max: 20,
    rationale:
      "Active weeks out of the last 8. Counting weeks rather than events keeps this stable at the low event volumes in this dataset.",
  },
};

/** Days since last event -> points. Lower is better, so bands read downward. */
export const RECENCY_BANDS: readonly { maxDays: number; points: number; label: string }[] = [
  { maxDays: 7, points: 30, label: "Active within the last 7 days" },
  { maxDays: 14, points: 22, label: "Active within the last 14 days" },
  { maxDays: 30, points: 12, label: "Active within the last 30 days" },
  { maxDays: 60, points: 4, label: "Last activity 30-60 days ago" },
  { maxDays: Infinity, points: 0, label: "Silent for more than 60 days" },
];

/** Distinct active users in the last 30 days -> points. */
export const BREADTH_BANDS: readonly Band[] = [
  [7, 25],
  [4, 19],
  [2, 12],
  [1, 5],
  [0, 0],
];

/**
 * Depth is scored on a "core value" count, not raw events:
 *   coreValue = guides_created(30d) * CREATED_WEIGHT + guides_shared(30d)
 * Creation is weighted higher because it is the act that produces the asset;
 * sharing distributes an asset that already exists.
 */
export const DEPTH_CREATED_WEIGHT = 2;

export const DEPTH_BANDS: readonly Band[] = [
  [6, 25],
  [3, 18],
  [1, 10],
  [0, 0],
];

/**
 * Partial credit for an account that used to create and stopped. It is not the
 * same as an account with no creation anywhere in the window, and the evidence line
 * says which one it is.
 */
export const DEPTH_LAPSED_POINTS = 4;

/** Distinct active weeks within the consistency window -> points. */
export const CONSISTENCY_BANDS: readonly Band[] = [
  [6, 20],
  [4, 14],
  [2, 8],
  [1, 3],
  [0, 0],
];

// ---------------------------------------------------------------------------
// Tiers
// ---------------------------------------------------------------------------

export const TIER_THRESHOLDS = {
  /** >= this score is Healthy. */
  healthy: 75,
  /** >= this score is Watch; below it is At Risk. */
  watch: 45,
} as const;

/**
 * Facts that a weighted sum should not be able to outvote. Each one caps the
 * tier rather than subtracting points, so it is impossible for a strong showing
 * on three pillars to hide a month of silence.
 */
export const OVERRIDES = {
  /** No event at all for this many days forces At Risk. */
  dormantDays: 30,
  /** <= this many active users in 30d caps the tier at Watch. */
  singleUserMax: 1,
} as const;

// ---------------------------------------------------------------------------
// Confidence
// ---------------------------------------------------------------------------

/**
 * Fewer than this many events in the whole 90-day window is less than one event
 * every two weeks. The metrics are arithmetically valid but too thin to
 * characterise a customer. We still score the account - hiding it would be
 * worse - but the verdict is labelled so nobody over-reads it.
 *
 * On this data it flags 3 accounts, all of them in the At Risk bucket, which is
 * exactly where a confident-sounding wrong answer does the most damage.
 */
export const LOW_CONFIDENCE_MIN_EVENTS = 6;

// ---------------------------------------------------------------------------
// Trend
// ---------------------------------------------------------------------------

/**
 * Trend is computed, displayed, and deliberately NOT scored.
 *
 * The median account produces 19 events in 90 days. Comparing 30 days against
 * 30 days on ~6 events measures sampling noise, not customer behaviour. Scoring
 * it would generate false alarms that destroy a CSM's trust in the tool faster
 * than no signal at all.
 *
 * So it is gated twice: the account needs enough volume for the comparison to
 * mean anything, and the change needs to be large enough to survive the noise.
 */
export const TREND = {
  /** Minimum events in the full window before trend is reported at all. */
  minEvents: 12,
  /** Minimum relative change (+/-) before it is reported. */
  minChange: 0.5,
} as const;

// ---------------------------------------------------------------------------
// Risk severity
// ---------------------------------------------------------------------------

/**
 * Severity = how bad the signal is, escalated by how much it costs us if we are
 * right, and by whether other rules fire alongside it. The second term is a
 * co-occurrence heuristic, not evidence of independent agreement - the rules
 * share one event stream and are correlated by construction - so it is capped
 * at one level and withheld entirely on low-confidence accounts. Both
 * escalations are shown in the UI so a CSM never sees a bare label.
 */
export const SEVERITY_RULES = {
  /** ARR percentile above which an account counts as high value. */
  highValueQuantile: 0.75,
  /** Concurrent risks needed before severity escalates on co-occurrence. */
  convergenceCount: 2,
} as const;

export const RISK_THRESHOLDS = {
  /** Dormancy bands, in days since last event. */
  dormantMedium: 21,
  dormantHigh: 30,
  dormantCritical: 60,
  /** Share of events that must be logins before "login-only" fires. */
  loginOnlyShare: 0.6,
  /** Relative drop in active users that counts as adoption collapse. */
  adoptionDropPct: 0.5,
  /** Guides created before "no audience" is worth reporting. */
  noAudienceMinCreated: 5,
} as const;

// ---------------------------------------------------------------------------
// Priority
// ---------------------------------------------------------------------------

/**
 * Priority is ARR-weighted health, kept strictly outside the health score.
 *
 * An Enterprise account is not healthier for paying more - but it is the call a
 * CSM should make first. Keeping the two axes apart is what lets the dashboard
 * say "$391K of ARR is at risk" instead of "the average score is 71".
 *
 * ARR is log-scaled so a $218K account outranks a $66K one without a single
 * whale flattening the rest of the list.
 */
export const PRIORITY_TIER_WEIGHT: Record<HealthTier, number> = {
  "At Risk": 3,
  Watch: 2,
  "No Data": 2,
  Healthy: 0,
};

/**
 * Floor on the priority weight, derived from the account's most severe risk.
 *
 * Usage health and action priority are different questions, and this is where
 * they meet. An account can be Healthy on all four usage pillars and still
 * carry a commercial flag that a human has to look at - a plan downgrade is the
 * example in this book. Health must not move for that (it is not usage), but a
 * worklist that sorts such an account to zero is telling the CSM there is
 * nothing to do, which is false.
 *
 * So severity sets a floor rather than adding points: the weight used is
 * max(tier weight, floor). On an At Risk account the tier already dominates and
 * the floor changes nothing; on a Healthy one it is what puts the account in
 * the queue at all. Only High and Critical qualify - Low and Medium are
 * diagnostic, and promoting them would refill the queue with everything.
 *
 * This is an operational triage policy, not a churn prediction. It encodes
 * "somebody should look at this", not "this account will leave".
 */
export const PRIORITY_RISK_FLOOR: Partial<Record<RiskSeverity, number>> = {
  High: 2,
  Critical: 3,
};
