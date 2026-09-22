/**
 * Orchestrates the pure stages: normalized data -> account summaries + KPIs.
 *
 * Kept free of I/O so the whole model can be exercised by tests and by the
 * ingest script without a database in the way.
 */

import {
  PRIORITY_RISK_FLOOR,
  PRIORITY_TIER_WEIGHT,
  RISK_THRESHOLDS,
  SEVERITY_RULES,
  TREND,
} from "./config";
import { computeHealth } from "./health";
import { computeMetrics, computeTrend } from "./metrics";
import { detectRisks, quantile, severityRank, type RiskContext } from "./risks";
import type {
  Account,
  AccountSummary,
  HealthTier,
  PortfolioKpis,
  Risk,
  RiskSeverity,
  UsageEvent,
} from "./types";

/**
 * Priority = how much it costs us if this account really needs a human.
 *
 * Two inputs, and they are deliberately different questions:
 *
 *   weight = max(tier weight, floor implied by the worst risk on the account)
 *   score  = weight * (1 + log10(1 + ARR))
 *
 * The tier weight is the usage verdict. The floor (config.ts,
 * PRIORITY_RISK_FLOOR) is the commercial one: a High or Critical risk means
 * somebody has to look, even on an account whose four usage pillars are all
 * strong. Taking the maximum rather than the sum keeps the two from
 * double-counting the same trouble - an At Risk account is already weighted 3
 * and a Critical floor of 3 adds nothing.
 *
 * ARR is log-scaled so a $218K account outranks a $66K one without one whale
 * flattening the list, and the `1 +` keeps $0 accounts orderable by weight
 * rather than collapsing them all to zero.
 *
 * This ranks a worklist. It is an operational policy about who to call first,
 * not an estimate of churn probability.
 */
export function priorityScore(
  tier: HealthTier,
  arrUsd: number,
  topSeverity: RiskSeverity | null = null,
): number {
  const tierWeight = PRIORITY_TIER_WEIGHT[tier] ?? 0;
  const riskFloor = topSeverity ? (PRIORITY_RISK_FLOOR[topSeverity] ?? 0) : 0;
  const weight = Math.max(tierWeight, riskFloor);
  if (weight === 0) return 0;
  return weight * (1 + Math.log10(1 + Math.max(arrUsd, 0)));
}

/** The most severe risk on an account, or null when no rule fired. */
export function worstSeverity(risks: Risk[]): RiskSeverity | null {
  return risks.reduce<RiskSeverity | null>(
    (worst, r) => (worst === null || severityRank(r.severity) > severityRank(worst) ? r.severity : worst),
    null,
  );
}

/** True when an account carries a risk severe enough to demand a human look. */
export function needsAttention(tier: HealthTier, risks: Risk[]): boolean {
  if (tier !== "Healthy") return true;
  const worst = worstSeverity(risks);
  return worst !== null && (PRIORITY_RISK_FLOOR[worst] ?? 0) > 0;
}

/**
 * The middle value of a numeric list, 0 for an empty one.
 *
 * Exported so a filtered view (the home page recomputing this KPI for
 * whatever subset the current filters select) uses the exact same formula as
 * the portfolio-wide figure below, rather than a second copy that could drift.
 */
export function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 0) return 0;
  const mid = sorted.length / 2;
  return sorted.length % 2 ? sorted[mid - 0.5] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function buildSummaries(
  accounts: Account[],
  events: UsageEvent[],
  snapshotMs: number,
): AccountSummary[] {
  const eventsBySlug = new Map<string, UsageEvent[]>();
  for (const e of events) {
    const list = eventsBySlug.get(e.accountSlug);
    if (list) list.push(e);
    else eventsBySlug.set(e.accountSlug, [e]);
  }

  const ctx: RiskContext = {
    highValueArrThreshold: quantile(
      accounts.map((a) => a.arrUsd),
      SEVERITY_RULES.highValueQuantile,
    ),
  };

  return accounts
    .map((account) => {
      const metrics = computeMetrics(
        account.slug,
        eventsBySlug.get(account.slug) ?? [],
        snapshotMs,
        account.planTier,
      );
      const health = computeHealth(metrics);
      const risks = detectRisks(account, metrics, health, ctx);

      return {
        account,
        metrics,
        health,
        risks,
        priorityScore: priorityScore(health.tier, account.arrUsd, worstSeverity(risks)),
        topRisk: risks[0] ?? null,
      };
    })
    .sort((a, b) => b.priorityScore - a.priorityScore || b.account.arrUsd - a.account.arrUsd);
}

export function buildPortfolioKpis(
  summaries: AccountSummary[],
  snapshotMs: number,
): PortfolioKpis {
  const tierCounts: Record<HealthTier, number> = {
    Healthy: 0,
    Watch: 0,
    "At Risk": 0,
    "No Data": 0,
  };

  let totalArr = 0;
  let arrAtRisk = 0;
  let arrWatch = 0;
  let dormant = 0;
  let noCoreUsage = 0;
  let singleUser = 0;
  let activeUsersRecent = 0;
  let activeUsersPrior = 0;
  let needingAttention = 0;
  let healthyNeedingReview = 0;

  for (const s of summaries) {
    tierCounts[s.health.tier] += 1;

    // One increment per account, whatever the reason. A Watch account with a
    // Critical risk is one account to call, not two.
    if (needsAttention(s.health.tier, s.risks)) {
      needingAttention += 1;
      if (s.health.tier === "Healthy") healthyNeedingReview += 1;
    }

    totalArr += s.account.arrUsd;
    if (s.health.tier === "At Risk") arrAtRisk += s.account.arrUsd;
    if (s.health.tier === "Watch") arrWatch += s.account.arrUsd;

    const m = s.metrics;
    if (m.daysSinceLastEvent !== null && m.daysSinceLastEvent >= RISK_THRESHOLDS.dormantHigh) {
      dormant += 1;
    }
    if (m.totalEvents > 0 && m.byType.guide_created === 0 && m.byType.guide_shared === 0) {
      noCoreUsage += 1;
    }
    /**
     * Exactly one, not "one or none". An account with zero active users is
     * dormant and is already counted in that tile; counting it here as well
     * would double-report the same account under two different headlines. This
     * also keeps the KPI equal to what clicking it filters to.
     */
    if (m.totalEvents > 0 && m.activeUsersRecent === 1) singleUser += 1;

    activeUsersRecent += m.activeUsersRecent;
    activeUsersPrior += m.activeUsersPrevious30;
  }

  const scores = summaries.filter((s) => s.health.tier !== "No Data").map((s) => s.health.score);
  const medianScore = median(scores);

  return {
    snapshotDate: new Date(snapshotMs).toISOString().slice(0, 10),
    accounts: summaries.length,
    totalArr,
    arrAtRisk,
    arrAtRiskPct: totalArr > 0 ? arrAtRisk / totalArr : 0,
    arrWatch,
    tierCounts,
    accountsNeedingAttention: needingAttention,
    healthyNeedingReview,
    dormantAccounts: dormant,
    noCoreUsageAccounts: noCoreUsage,
    singleUserAccounts: singleUser,
    activeUsersRecent,
    activeUsersPrior,
    medianScore,
  };
}

/** Convenience used by the API layer and the drill-down. */
export function trendFor(summary: AccountSummary) {
  return computeTrend(summary.metrics, TREND.minEvents, TREND.minChange);
}
