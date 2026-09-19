import type {
  AccountMetrics,
  BandKey,
  DimensionKey,
  DimensionResult,
  HealthResult,
} from "./types";

/**
 * What "account health" means here
 * --------------------------------
 * Health is the answer to one question: is this account building a habit
 * around the product, or drifting away from it? Six inputs, each normalised
 * to 0-100 against a "what good looks like" target, combined with fixed
 * weights that sum to 1. Because they sum to 1, the score is always exactly
 * the sum of the contributions the drill-down shows - the explanation can
 * never drift from the number.
 *
 * Weighting rationale: creation is weighted heaviest because creating a guide
 * is the product's core value action and the hardest thing to fake. Breadth
 * and value realisation are next - they separate "one champion with a habit"
 * from "a team that depends on this", which is the distinction that actually
 * predicts renewal. Collaboration, momentum and recency are lighter: they are
 * leading indicators and noisier at small volumes, so they tilt a score
 * rather than decide it.
 *
 * The TARGETS below are CALIBRATED to the observed distribution of this
 * export (roughly its 80th percentile), not guessed. An earlier cut guessed
 * them and every target landed below the book's p80, so five of six
 * dimensions saturated at 100 for most accounts and the score stopped
 * discriminating at the top. Re-run `npm run calibrate` against a new export
 * and move these to the printed p80 column.
 *
 * Absolute-with-calibration rather than pure percentile scoring: percentiles
 * guarantee that someone is always "at risk" even when every account is
 * thriving, which would send a CSM chasing a healthy customer.
 */
export const TARGETS = {
  /**
   * guide_created per KNOWN seat per 30d that counts as excellent.
   *
   * Deliberately per known seat, not per active seat. An earlier cut of this
   * divided by active users and scored Kestrel Labs 100/100 on creation while
   * its creation had in fact collapsed 85% - because its team had walked away,
   * the denominator collapsed with it and the ratio looked great. Dividing by
   * everyone we have ever seen means losing your team costs you the score,
   * which is the behaviour we actually want to detect.
   */
  createsPerKnownSeat: 1.35,
  /** floor of the log curve - below this, creation is effectively nil */
  createsFloor: 0.1,
  /** share of known users active in 30d that counts as excellent */
  activeShare: 0.95,
  /**
   * guide_viewed in 30d per guide in the library that counts as excellent.
   *
   * Note this is NOT views-per-guide-created. An earlier cut used that and it
   * scored Petra Civil 96/100 on value realisation while the account was dying:
   * creation had stopped, so the denominator collapsed and the ratio soared.
   * Dividing current views by the accumulated library instead means the metric
   * falls when consumption falls and cannot be flattered by creation stopping.
   */
  viewsPerLibraryGuide: 3.0,
  /** (shares + invites) per 10 active users per 30d that counts as excellent */
  collabPer10Users: 16,
  /** activity ratio vs the prior 30d that counts as excellent (2x = doubling) */
  momentumRatio: 2,
  /** days since last guide_created at which recency hits zero */
  recencyFloorDays: 30,
} as const;

export const BAND_THRESHOLDS = { good: 70, warn: 40 } as const;

/** An account with no events for this long is not scored on behaviour. */
export const SILENCE_DAYS = 21;
/** Mean events/day before a hard stop that marks it as a pipeline gap, not churn. */
export const GAP_RUN_RATE = 3;

interface DimensionSpec {
  key: DimensionKey;
  name: string;
  weight: number;
  rationale: string;
  score: (m: AccountMetrics) => number;
  evidence: (m: AccountMetrics) => string;
}

const clamp = (n: number) => Math.max(0, Math.min(100, n));
const round1 = (n: number) => Math.round(n * 10) / 10;

export const DIMENSIONS: DimensionSpec[] = [
  {
    key: "creation",
    name: "Guide creation",
    weight: 0.3,
    rationale:
      "Creating guides is the product's core value action. Measured per known seat so a 12-seat account is not punished against a 90-seat one — and so an account that loses its team loses the score, which dividing by active seats would hide. Log curve, because the first guide a week matters far more than the twentieth.",
    score: (m) => {
      const x = m.createsPerKnownSeat;
      if (x <= 0) return 0;
      const num = Math.log1p(x / TARGETS.createsFloor);
      const den = Math.log1p(TARGETS.createsPerKnownSeat / TARGETS.createsFloor);
      return clamp((num / den) * 100);
    },
    evidence: (m) =>
      `${m.created30} guides in 30d · ${Math.round(m.createsPerKnownSeat * 100) / 100} per known seat`,
  },
  {
    key: "breadth",
    name: "Adoption breadth",
    weight: 0.2,
    rationale:
      "Share of known users active in the last 30 days. Separates one champion with a habit from a team that depends on the product - the single best predictor of whether usage survives one person leaving.",
    score: (m) =>
      clamp((m.activeUsers30 / Math.max(1, m.knownUsers) / TARGETS.activeShare) * 100),
    evidence: (m) =>
      `${m.activeUsers30} of ${m.knownUsers} known users active in 30d`,
  },
  {
    key: "value",
    name: "Value realisation",
    weight: 0.2,
    rationale:
      "Views in the last 30 days per guide in the library. Guides nobody watches are effort without payoff. Measured against the accumulated library rather than against recent creation, so an account that stops creating cannot score well here by shrinking its own denominator.",
    score: (m) => clamp((m.libraryViewRate / TARGETS.viewsPerLibraryGuide) * 100),
    evidence: (m) =>
      `${m.viewed30} views in 30d across ~${m.created90} guides · ${round1(m.libraryViewRate)}x per guide`,
  },
  {
    key: "collab",
    name: "Collaboration",
    weight: 0.1,
    rationale:
      "Shares plus invites per 10 active users. The footprint signal that precedes seat expansion, and its absence is the quietest early churn tell.",
    score: (m) => {
      const per10 = ((m.shared30 + m.invited30) * 10) / Math.max(1, m.activeUsers30);
      return clamp((per10 / TARGETS.collabPer10Users) * 100);
    },
    evidence: (m) => `${m.shared30} shares, ${m.invited30} invites in 30d`,
  },
  {
    key: "momentum",
    name: "Momentum",
    weight: 0.1,
    rationale:
      "Trailing 30 days of all activity against the prior 30. Whole windows, never day over day, so the 60-70% weekend trough every account shows cannot read as decline. Flat scores 50 by design.",
    score: (m) => {
      const ratio = m.events30 / Math.max(1, m.eventsPrior30);
      return clamp((ratio / TARGETS.momentumRatio) * 100);
    },
    evidence: (m) => {
      if (m.eventsPrior30 === 0) return `${m.events30} events in 30d, no prior baseline`;
      const pct = Math.round((m.events30 / m.eventsPrior30 - 1) * 100);
      return `${pct >= 0 ? "+" : "−"}${Math.abs(pct)}% vs prior 30d`;
    },
  },
  {
    key: "recency",
    name: "Recency",
    weight: 0.1,
    rationale:
      "Days since the last guide was created, decaying to zero at 30 days. Deliberately keyed to creation rather than logins: people keep logging in for a while after they have stopped getting value.",
    score: (m) => {
      if (m.daysSinceLastCreate === null) return 0;
      return clamp((1 - m.daysSinceLastCreate / TARGETS.recencyFloorDays) * 100);
    },
    evidence: (m) =>
      m.daysSinceLastCreate === null
        ? "no guide created in the window"
        : `last guide created ${m.daysSinceLastCreate} day${m.daysSinceLastCreate === 1 ? "" : "s"} ago`,
  },
];

if (Math.abs(DIMENSIONS.reduce((s, d) => s + d.weight, 0) - 1) > 1e-9) {
  throw new Error("Health dimension weights must sum to 1");
}

export function bandForScore(score: number): BandKey {
  if (score >= BAND_THRESHOLDS.good) return "good";
  if (score >= BAND_THRESHOLDS.warn) return "warn";
  return "crit";
}

export const BAND_LABELS: Record<BandKey, string> = {
  good: "Healthy",
  warn: "Watch",
  crit: "At risk",
  none: "No signal",
};

/**
 * Decide whether an account can be scored at all.
 *
 * Absence of data is not evidence of poor health. An account we cannot see is
 * a different problem from an account in trouble, and scoring it zero would
 * rank it above genuinely failing accounts in a triage queue - sending a CSM
 * to the wrong customer. So these are held out and surfaced as their own state.
 */
export function eligibility(m: AccountMetrics): { scored: boolean; reason?: HeldOut; detail?: string } {
  if (m.totalEvents === 0) {
    return {
      scored: false,
      reason: "no_events",
      detail:
        "The account exists in accounts.json but produced no events in the window. Nothing to score.",
    };
  }
  if (m.daysSinceLastEvent !== null && m.daysSinceLastEvent >= SILENCE_DAYS) {
    if (m.runRateBeforeLastEvent >= GAP_RUN_RATE) {
      return {
        scored: false,
        reason: "suspected_gap",
        detail:
          `Events stop dead ${m.daysSinceLastEvent} days ago after running at ` +
          `${round1(m.runRateBeforeLastEvent)}/day. Real churn decays; a clean cut with no ` +
          `tail-off looks like an ingestion gap, so this is flagged for a pipeline check ` +
          `rather than scored.`,
      };
    }
  }
  return { scored: true };
}

type HeldOut = NonNullable<HealthResult["heldOutReason"]>;

/**
 * Below this much volume the score still computes, but small-number effects
 * dominate: on a 4-seat account one person taking a fortnight off swings the
 * score 20 points. Scored, shown, and labelled — not hidden, because a CSM
 * would rather see a shaky number with a caveat than no number at all.
 */
export const LOW_CONFIDENCE_EVENTS = 150;
export const LOW_CONFIDENCE_SEATS = 6;

function confidence(m: AccountMetrics): { lowConfidence: boolean; confidenceNote?: string } {
  const reasons: string[] = [];
  if (m.totalEvents < LOW_CONFIDENCE_EVENTS) reasons.push(`${m.totalEvents} events in the window`);
  if (m.knownUsers < LOW_CONFIDENCE_SEATS) reasons.push(`${m.knownUsers} known users`);
  if (!reasons.length) return { lowConfidence: false };
  return {
    lowConfidence: true,
    confidenceNote: `Low volume (${reasons.join(", ")}) — this score moves a lot on small changes.`,
  };
}

export function computeHealth(m: AccountMetrics): HealthResult {
  const elig = eligibility(m);
  const conf = confidence(m);
  const dimensions: DimensionResult[] = DIMENSIONS.map((d) => {
    const subscore = Math.round(d.score(m));
    return {
      key: d.key,
      name: d.name,
      weight: d.weight,
      subscore,
      contribution: round1(subscore * d.weight),
      evidence: d.evidence(m),
      rationale: d.rationale,
    };
  });

  if (!elig.scored) {
    return {
      scored: false,
      score: null,
      band: "none",
      dimensions,
      heldOutReason: elig.reason,
      heldOutDetail: elig.detail,
      lowConfidence: false,
    };
  }

  const score = Math.round(dimensions.reduce((s, d) => s + d.subscore * d.weight, 0));
  return { scored: true, score, band: bandForScore(score), dimensions, ...conf };
}
