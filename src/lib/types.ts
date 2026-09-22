/**
 * Shared domain types.
 *
 * The naming distinguishes three layers deliberately:
 *   Raw*      - exactly what the JSON export contains, untrusted
 *   Account/Event - normalized, validated, safe to compute on
 *   *Metrics / Health / Risk - derived, never stored in the raw layer
 */

export type PlanTier = "Free" | "Pro" | "Enterprise";

export type EventType =
  | "guide_created"
  | "guide_viewed"
  | "guide_shared"
  | "user_invited"
  | "login";

export const EVENT_TYPES: EventType[] = [
  "guide_created",
  "guide_viewed",
  "guide_shared",
  "user_invited",
  "login",
];

/** Ordered weakest -> strongest, so downgrades are comparable. */
export const PLAN_RANK: Record<PlanTier, number> = {
  Free: 0,
  Pro: 1,
  Enterprise: 2,
};

// ---------------------------------------------------------------------------
// Raw layer - shape as found in the export. Every field is optional/unknown
// because we must not assume the export is well formed.
// ---------------------------------------------------------------------------

export interface RawAccount {
  company_name?: unknown;
  domain?: unknown;
  plan_tier?: unknown;
  contract_start_date?: unknown;
  arr_usd?: unknown;
  csm_owner?: unknown;
}

export interface RawEvent {
  event_id?: unknown;
  workspace_id?: unknown;
  company_name?: unknown;
  event_type?: unknown;
  user_id?: unknown;
  timestamp?: unknown;
  plan_tier?: unknown;
}

// ---------------------------------------------------------------------------
// Normalized layer
// ---------------------------------------------------------------------------

export interface Account {
  /** URL-safe stable identifier derived from the company name. */
  slug: string;
  companyName: string;
  domain: string;
  /** Commercial plan from accounts.json - the source of truth for display. */
  planTier: PlanTier;
  contractStartDate: string;
  arrUsd: number;
  csmOwner: string;
}

export interface UsageEvent {
  eventId: string;
  workspaceId: string;
  /** Resolved account slug, not the raw company_name string. */
  accountSlug: string;
  eventType: EventType;
  userId: string;
  /** Epoch milliseconds - pre-parsed once at ingest so metrics never re-parse. */
  timestampMs: number;
  timestamp: string;
  /** Plan as recorded on the event itself, i.e. historical state. */
  planTierAtEvent: PlanTier;
}

// ---------------------------------------------------------------------------
// Data quality
// ---------------------------------------------------------------------------

export type QualitySeverity = "info" | "warning" | "error";

export interface QualityIssue {
  code: string;
  title: string;
  severity: QualitySeverity;
  /** How many rows/entities are affected. 0 means "checked, nothing found". */
  count: number;
  detail: string;
  /** What we decided to do about it, in one sentence. */
  resolution: string;
  /** Slugs of the accounts implicated, where applicable. */
  affectedAccounts?: string[];
}

export interface DataQualityReport {
  generatedAt: string;
  snapshotDate: string;
  totals: {
    accounts: number;
    events: number;
    eventsDropped: number;
    workspaces: number;
    users: number;
    companiesInEvents: number;
    windowStart: string;
    windowEnd: string;
    windowDays: number;
  };
  issues: QualityIssue[];
}

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

export interface WeekBucket {
  /** ISO date of the first day of the bucket (buckets are anchored to the snapshot). */
  weekStart: string;
  weekEnd: string;
  total: number;
  created: number;
  shared: number;
  viewed: number;
  invited: number;
  login: number;
  activeUsers: number;
}

export interface WorkspaceBreakdown {
  workspaceId: string;
  events: number;
  users: number;
  firstEvent: string;
  lastEvent: string;
  daysSinceLastEvent: number;
}

export type EventCounts = Record<EventType, number>;

export interface AccountMetrics {
  accountSlug: string;

  // Volume
  totalEvents: number;
  eventsRecent: number; // last 30d
  eventsPrior: number; // the 60d before that
  /** Prior 60 days expressed as a comparable 30-day rate. */
  eventsPriorPer30: number;

  // People
  knownUsers: number; // distinct users seen anywhere in the window
  activeUsersRecent: number; // distinct users in last 30d
  activeUsersPrior: number; // distinct users in the prior 60d
  /**
   * Distinct users in days 30-59 only. Kept separate from activeUsersPrior
   * because comparing a 30-day count against a 60-day count is not a
   * comparison - a longer window accumulates more distinct people by
   * construction. Any user-count trend must use this one.
   */
  activeUsersPrevious30: number;
  newUsersRecent: number; // active in last 30d, not seen earlier in the window
  returningUsersRecent: number;
  creators: number; // distinct users who created a guide at some point in the window
  /** Share of the account's events produced by its single busiest user (0-1). */
  topUserShare: number;

  // Time
  firstEvent: string | null;
  lastEvent: string | null;
  daysSinceLastEvent: number | null;
  activeDays: number;
  activeWeeksRecent: number; // distinct active weeks within the consistency window
  weekly: WeekBucket[];

  // Behaviour
  byType: EventCounts; // whole window
  byTypeRecent: EventCounts; // last 30d
  /** logins / total events over the window (0-1). */
  loginShare: number;

  // Structure
  workspaceCount: number;
  workspaces: WorkspaceBreakdown[];

  // Commercial state observed in the event stream
  planAtLastEvent: PlanTier | null;
  planDowngraded: boolean;
}

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

export type HealthTier = "Healthy" | "Watch" | "At Risk" | "No Data";

export type PillarKey = "recency" | "breadth" | "depth" | "consistency";

export interface PillarResult {
  key: PillarKey;
  label: string;
  /** One sentence a CSM can read without any further context. */
  evidence: string;
  points: number;
  maxPoints: number;
}

export interface HealthOverride {
  code: string;
  /** Plain-language reason the score was not allowed to decide alone. */
  reason: string;
  cappedAt: HealthTier;
}

export interface HealthResult {
  score: number;
  tier: HealthTier;
  /** Tier the raw score alone would have produced, before overrides. */
  tierFromScore: HealthTier;
  pillars: PillarResult[];
  overrides: HealthOverride[];
  lowConfidence: boolean;
  confidenceNote: string | null;
}

// ---------------------------------------------------------------------------
// Risks
// ---------------------------------------------------------------------------

export type RiskSeverity = "Low" | "Medium" | "High" | "Critical";

export const SEVERITY_ORDER: RiskSeverity[] = ["Low", "Medium", "High", "Critical"];

export interface Risk {
  code: string;
  title: string;
  severity: RiskSeverity;
  baseSeverity: RiskSeverity;
  /** The observation that triggered the rule. */
  evidence: string;
  /** Why this observation is a commercial risk, not just a number. */
  whyItMatters: string;
  /** Each escalation applied, so severity is never a bare label. */
  escalations: string[];
  /** True when the risk also constrains the health tier. */
  affectsHealth: boolean;
}

// ---------------------------------------------------------------------------
// Composed view models
// ---------------------------------------------------------------------------

export interface AccountSummary {
  account: Account;
  health: HealthResult;
  metrics: AccountMetrics;
  risks: Risk[];
  priorityScore: number;
  topRisk: Risk | null;
}

export interface PortfolioKpis {
  snapshotDate: string;
  accounts: number;
  totalArr: number;
  arrAtRisk: number;
  arrAtRiskPct: number;
  arrWatch: number;
  tierCounts: Record<HealthTier, number>;
  /**
   * Accounts that need a human, counted once each: everything below Healthy
   * (including No Data, which needs a pipeline question answered), plus any
   * Healthy account carrying a High or Critical risk. Deliberately not a sum
   * of tier counts - an account can qualify on two grounds and is still one
   * account.
   */
  accountsNeedingAttention: number;
  /** The Healthy subset of the above: strong usage, unresolved commercial flag. */
  healthyNeedingReview: number;
  dormantAccounts: number;
  noCoreUsageAccounts: number;
  singleUserAccounts: number;
  activeUsersRecent: number;
  activeUsersPrior: number;
  medianScore: number;
}
