/**
 * Stage 3: metrics -> health score, tier, and the evidence that explains both.
 *
 * The contract this module keeps:
 *
 *   Every point in the score is attributable to exactly one pillar, and every
 *   pillar returns a sentence that stands on its own. The drill-down does not
 *   interpret the score - it prints what the score was made of. If a CSM
 *   disagrees with a verdict, they can point at the specific line they think
 *   is wrong, which is the only kind of disagreement worth having.
 *
 * Health deliberately contains no commercial input. ARR and plan tier decide
 * *who you call first*, not *how the product is going* - see priority.ts.
 */

import {
  BREADTH_BANDS,
  CONSISTENCY_BANDS,
  DEPTH_BANDS,
  DEPTH_CREATED_WEIGHT,
  DEPTH_LAPSED_POINTS,
  LOW_CONFIDENCE_MIN_EVENTS,
  OVERRIDES,
  PILLARS,
  RECENCY_BANDS,
  TIER_THRESHOLDS,
  WINDOW,
  type Band,
} from "./config";
import type {
  AccountMetrics,
  HealthOverride,
  HealthResult,
  HealthTier,
  PillarResult,
} from "./types";

/** Tier strength, used so an override can cap a tier without special-casing. */
const TIER_RANK: Record<HealthTier, number> = {
  "At Risk": 0,
  "No Data": 1,
  Watch: 2,
  Healthy: 3,
};

function scoreBands(value: number, bands: readonly Band[]): number {
  for (const [min, points] of bands) {
    if (value >= min) return points;
  }
  return 0;
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

// ---------------------------------------------------------------------------
// Pillars
// ---------------------------------------------------------------------------

function recencyPillar(m: AccountMetrics): PillarResult {
  const days = m.daysSinceLastEvent;
  const band =
    days === null
      ? { points: 0, label: "No activity has ever been recorded" }
      : RECENCY_BANDS.find((b) => days <= b.maxDays)!;

  const evidence =
    days === null
      ? band.label
      : days === 0
        ? "Active today"
        : `${band.label} (last event ${plural(days, "day")} ago)`;

  return {
    key: "recency",
    label: PILLARS.recency.label,
    evidence,
    points: band.points,
    maxPoints: PILLARS.recency.max,
  };
}

function breadthPillar(m: AccountMetrics): PillarResult {
  const n = m.activeUsersRecent;
  const points = scoreBands(n, BREADTH_BANDS);

  let evidence: string;
  if (n === 0) {
    evidence = `No users active in the last ${WINDOW.recentDays} days (${plural(m.knownUsers, "user")} seen earlier in the window)`;
  } else if (n === 1) {
    evidence = `Only 1 user active in the last ${WINDOW.recentDays} days - the account depends on one person`;
  } else {
    evidence = `${plural(n, "user")} active in the last ${WINDOW.recentDays} days, out of ${plural(m.knownUsers, "user")} seen in the window`;
  }
  if (m.newUsersRecent > 0 && n > 0) {
    evidence += `, ${m.newUsersRecent} of them new`;
  }

  return {
    key: "breadth",
    label: PILLARS.breadth.label,
    evidence,
    points,
    maxPoints: PILLARS.breadth.max,
  };
}

function depthPillar(m: AccountMetrics): PillarResult {
  const created = m.byTypeRecent.guide_created;
  const shared = m.byTypeRecent.guide_shared;
  const coreValue = created * DEPTH_CREATED_WEIGHT + shared;

  const createdEver = m.byType.guide_created;
  const sharedEver = m.byType.guide_shared;

  let points: number;
  let evidence: string;

  if (coreValue > 0) {
    points = scoreBands(coreValue, DEPTH_BANDS);
    evidence = `${plural(created, "guide")} created and ${shared} shared in the last ${WINDOW.recentDays} days`;
    if (m.creators > 0) {
      evidence += ` (${m.creators} of ${plural(m.knownUsers, "user")} have ever created one)`;
    }
  } else if (createdEver + sharedEver > 0) {
    points = DEPTH_LAPSED_POINTS;
    evidence = `Nothing created or shared in the last ${WINDOW.recentDays} days, after ${createdEver} created and ${sharedEver} shared earlier in the window`;
  } else {
    points = 0;
    evidence = `No guide has ever been created or shared - ${m.totalEvents} events in ${WINDOW.totalDays} days, ${Math.round(m.loginShare * 100)}% of them logins`;
  }

  return {
    key: "depth",
    label: PILLARS.depth.label,
    evidence,
    points,
    maxPoints: PILLARS.depth.max,
  };
}

function consistencyPillar(m: AccountMetrics): PillarResult {
  const weeks = m.activeWeeksRecent;
  const points = scoreBands(weeks, CONSISTENCY_BANDS);
  const evidence =
    weeks === 0
      ? `No activity in any of the last ${WINDOW.consistencyWeeks} weeks`
      : `Active in ${weeks} of the last ${WINDOW.consistencyWeeks} weeks, across ${plural(m.activeDays, "day")} in the window`;

  return {
    key: "consistency",
    label: PILLARS.consistency.label,
    evidence,
    points,
    maxPoints: PILLARS.consistency.max,
  };
}

// ---------------------------------------------------------------------------
// Tier
// ---------------------------------------------------------------------------

export function tierFromScore(score: number): HealthTier {
  if (score >= TIER_THRESHOLDS.healthy) return "Healthy";
  if (score >= TIER_THRESHOLDS.watch) return "Watch";
  return "At Risk";
}

/**
 * Overrides cap the tier instead of subtracting points.
 *
 * A weighted sum can always be outvoted by its other terms: an account that is
 * broad, consistent and creative can absorb a -30 recency hit and still read
 * "Healthy" a month after it went quiet. Some facts should not be outvotable,
 * so they are applied as ceilings after the arithmetic is done, and each one
 * prints its own reason.
 */
function collectOverrides(m: AccountMetrics): HealthOverride[] {
  const overrides: HealthOverride[] = [];

  if (m.daysSinceLastEvent !== null && m.daysSinceLastEvent > OVERRIDES.dormantDays) {
    overrides.push({
      code: "dormant",
      reason: `No activity for ${plural(m.daysSinceLastEvent, "day")}. A customer that has not opened the product in a month is at risk regardless of how it looked before that.`,
      cappedAt: "At Risk",
    });
  }

  if (m.totalEvents > 0 && m.byType.guide_created === 0 && m.byType.guide_shared === 0) {
    overrides.push({
      code: "no_core_value",
      reason: `Not one guide created or shared in ${WINDOW.totalDays} days. The account is paying for a guide platform and is not producing guides, so it cannot be called healthy whatever the login count says.`,
      cappedAt: "Watch",
    });
  }

  if (m.totalEvents > 0 && m.activeUsersRecent <= OVERRIDES.singleUserMax) {
    overrides.push({
      code: "single_user",
      reason: `${m.activeUsersRecent === 0 ? "No users" : "One user"} active in the last ${WINDOW.recentDays} days. Usage that rests on a single person is one resignation away from zero, so it is capped below Healthy.`,
      cappedAt: "Watch",
    });
  }

  return overrides;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function computeHealth(m: AccountMetrics): HealthResult {
  if (m.totalEvents === 0) {
    return {
      score: 0,
      tier: "No Data",
      tierFromScore: "No Data",
      pillars: [],
      overrides: [],
      lowConfidence: true,
      confidenceNote:
        "No usage events were received for this account in the window. That is not the same as churn - it is just as likely to be a broken export or an unmapped workspace - so it is reported as No Data rather than scored.",
    };
  }

  const pillars = [recencyPillar(m), breadthPillar(m), depthPillar(m), consistencyPillar(m)];
  const score = pillars.reduce((sum, p) => sum + p.points, 0);
  const fromScore = tierFromScore(score);

  const overrides = collectOverrides(m);
  const tier = overrides.reduce<HealthTier>(
    (current, o) => (TIER_RANK[o.cappedAt] < TIER_RANK[current] ? o.cappedAt : current),
    fromScore,
  );

  const lowConfidence = m.totalEvents < LOW_CONFIDENCE_MIN_EVENTS;

  return {
    score,
    tier,
    tierFromScore: fromScore,
    pillars,
    overrides,
    lowConfidence,
    confidenceNote: lowConfidence
      ? `Only ${plural(m.totalEvents, "event")} in ${WINDOW.totalDays} days. The verdict is shown because a silent account is exactly what a CSM needs to see, but there is not enough activity here to characterise the account with confidence.`
      : null,
  };
}
