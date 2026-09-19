export type EventType =
  | "guide_created"
  | "guide_viewed"
  | "guide_shared"
  | "user_invited"
  | "login";

export type PlanTier = "Free" | "Pro" | "Enterprise";

/** A row of usage_events.json, exactly as exported. */
export interface UsageEvent {
  event_id: string;
  workspace_id: string;
  company_name: string;
  event_type: EventType;
  user_id: string;
  timestamp: string;
  plan_tier: PlanTier;
}

/** A row of accounts.json - one per commercial account. */
export interface AccountRow {
  company_name: string;
  domain: string;
  plan_tier: PlanTier;
  contract_start_date: string;
  arr_usd: number;
  csm_owner: string;
}

export type DimensionKey =
  | "creation"
  | "breadth"
  | "value"
  | "collab"
  | "momentum"
  | "recency";

export type BandKey = "good" | "warn" | "crit" | "none";

/** Raw behavioural facts for one account over one window. No judgement yet. */
export interface AccountMetrics {
  created30: number;
  created90: number;
  viewed30: number;
  viewed90: number;
  shared30: number;
  invited30: number;
  logins30: number;
  activeUsers30: number;
  knownUsers: number;
  events30: number;
  eventsPrior30: number;
  totalEvents: number;
  daysSinceLastCreate: number | null;
  daysSinceLastEvent: number | null;
  /** Mean events/day over the 7 days leading up to the last event seen. */
  runRateBeforeLastEvent: number;
  viewsPerGuide: number;
  /** guide_viewed in 30d divided by guides in the library (created in window). */
  libraryViewRate: number;
  createsPerKnownSeat: number;
}

export interface DimensionResult {
  key: DimensionKey;
  name: string;
  weight: number;
  /** 0-100 normalised subscore. */
  subscore: number;
  /** subscore x weight - these sum to the health score. */
  contribution: number;
  /** Human-readable raw value behind the subscore. */
  evidence: string;
  rationale: string;
}

export type HeldOutReason = "no_events" | "suspected_gap" | "too_new";

export interface HealthResult {
  scored: boolean;
  score: number | null;
  band: BandKey;
  dimensions: DimensionResult[];
  heldOutReason?: HeldOutReason;
  heldOutDetail?: string;
  /** Scored, but on so little volume that the score is volatile. */
  lowConfidence: boolean;
  confidenceNote?: string;
}

export interface WorkspaceRollup {
  workspace_id: string;
  events: number;
  share: number;
}

export interface Signal {
  level: BandKey;
  title: string;
  detail: string;
  age: string;
}

export interface AccountHealth {
  slug: string;
  name: string;
  domain: string;
  plan: PlanTier;
  arr: number;
  csm: string;
  contractStart: string;
  seatsKnown: number;
  workspaces: WorkspaceRollup[];
  metrics: AccountMetrics;
  health: HealthResult;
  /** Score 30 days ago, and the delta. null when either window is unscored. */
  scorePrior: number | null;
  scoreDelta: number | null;
  /** Daily event counts across the window, oldest first. */
  daily: number[];
  mix: Record<EventType, number>;
  planTierChanges: { day: number; from: PlanTier; to: PlanTier }[];
  nameVariants: string[];
  signals: Signal[];
}

export interface DataQualityNote {
  id: string;
  title: string;
  count: number;
  detail: string;
  rule: string;
  accounts?: string[];
}

export interface BookSummary {
  snapshot: string;
  windowDays: number;
  totalEvents: number;
  accounts: number;
  scored: number;
  heldOut: number;
  arrTotal: number;
  arrAtRisk: number;
  /** ARR in anything below Healthy - the number CS leadership acts on. */
  arrBelowHealthy: number;
  medianScore: number;
  medianDelta: number;
  distribution: {
    band: BandKey;
    label: string;
    accounts: number;
    arr: number;
  }[];
}
