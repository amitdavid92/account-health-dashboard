/**
 * Orchestrates the pure stages: normalized data -> account summaries + KPIs.
 *
 * Kept free of I/O so the whole model can be exercised by tests and by the
 * ingest script without a database in the way.
 */

import { PRIORITY_TIER_WEIGHT, RISK_THRESHOLDS, SEVERITY_RULES, TREND, WINDOW } from "./config";
import { computeHealth } from "./health";
import { computeMetrics, computeTrend } from "./metrics";
import { detectRisks, quantile, severityRank, type RiskContext } from "./risks";
import type {
  Account,
  AccountSummary,
  HealthTier,
  PortfolioKpis,
  UsageEvent,
} from "./types";

/**
 * Priority = how much it costs us if this account is really in trouble.
 *
 * ARR is log-scaled so a $218K account outranks a $66K one without one whale
 * flattening the list, and the `1 +` keeps $0 accounts orderable by tier rather
 * than collapsing them all to zero. Healthy accounts score 0 by construction -
 * there is nothing to prioritise.
 */
export function priorityScore(tier: HealthTier, arrUsd: number): number {
  const weight = PRIORITY_TIER_WEIGHT[tier] ?? 0;
  if (weight === 0) return 0;
  return weight * (1 + Math.log10(1 + Math.max(arrUsd, 0)));
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
        priorityScore: priorityScore(health.tier, account.arrUsd),
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

  for (const s of summaries) {
    tierCounts[s.health.tier] += 1;
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

  const scores = summaries
    .filter((s) => s.health.tier !== "No Data")
    .map((s) => s.health.score)
    .sort((a, b) => a - b);
  const medianScore = scores.length
    ? scores.length % 2
      ? scores[(scores.length - 1) / 2]
      : (scores[scores.length / 2 - 1] + scores[scores.length / 2]) / 2
    : 0;

  return {
    snapshotDate: new Date(snapshotMs).toISOString().slice(0, 10),
    accounts: summaries.length,
    totalArr,
    arrAtRisk,
    arrAtRiskPct: totalArr > 0 ? arrAtRisk / totalArr : 0,
    arrWatch,
    tierCounts,
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

export function highestSeverity(summary: AccountSummary) {
  return summary.risks.reduce(
    (best, r) => (best === null || severityRank(r.severity) > severityRank(best.severity) ? r : best),
    summary.risks[0] ?? null,
  );
}

export const ANALYSIS_WINDOW = WINDOW;
