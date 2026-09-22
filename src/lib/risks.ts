/**
 * Stage 4: metrics + health -> named risks with derived severity.
 *
 * Risks are not a restatement of the score. The score answers "how is this
 * account doing"; a risk answers "what is wrong and what do I do about it".
 * Three of them also constrain the health tier (they are the overrides in
 * health.ts); the rest are diagnostic only, because a metric moving is not
 * automatically a business risk.
 *
 * Severity is derived, never assigned:
 *
 *     severity = base strength of the signal
 *                + 1 level if the account is high value
 *                + 1 level if other risks fire alongside it
 *                capped at High when the account is otherwise Healthy
 *
 * That is the CSM's own reasoning made explicit: how bad is it, how much does
 * it cost us if we are right, and does anything else agree. Every escalation is
 * returned as a string so the UI never shows a bare label.
 *
 * Known limitation of the second term. The rules are NOT independent of each
 * other: dormancy, single-user dependency and usage collapse are all computed
 * from the same thin event stream, and several of them tend to fire together on
 * the same underlying fact. Counting co-occurrence as corroboration therefore
 * overstates the evidence to some degree even on a well-covered account. It is
 * kept because a CSM reading two flags at once does reasonably escalate, and
 * because every step is printed rather than hidden - but it is a heuristic
 * about co-occurrence, not a statement that N independent signals agree.
 *
 * Two guards stop the escalations from manufacturing outright false urgency:
 *
 *   - On a low-confidence account, co-occurrence does not escalate at all.
 *     Several rules firing on four events is the same handful of events read
 *     several ways.
 *   - A risk whose own definition includes ARR is not escalated for ARR again.
 */

import {
  OVERRIDES,
  RISK_THRESHOLDS,
  SEVERITY_RULES,
  TREND,
  WINDOW,
} from "./config";
import { computeTrend } from "./metrics";
import { PLAN_RANK, SEVERITY_ORDER, type Account, type AccountMetrics, type HealthResult, type Risk, type RiskSeverity } from "./types";

export interface RiskContext {
  /** ARR at the portfolio's high-value quantile; computed once per run. */
  highValueArrThreshold: number;
}

function escalate(severity: RiskSeverity, levels: number): RiskSeverity {
  const i = SEVERITY_ORDER.indexOf(severity);
  return SEVERITY_ORDER[Math.min(i + levels, SEVERITY_ORDER.length - 1)];
}

export function severityRank(severity: RiskSeverity): number {
  return SEVERITY_ORDER.indexOf(severity);
}

/** Percentile of a numeric list, used for the high-value ARR cut. */
export function quantile(values: number[], q: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

type Draft = Omit<Risk, "severity" | "escalations">;

/**
 * The two co-occurrence escalation strings, exported so the UI and the tests
 * match on the same text instead of each keeping its own copy of the wording.
 */
export function convergenceEscalation(n: number): string {
  return `+1 for ${n} risks firing together (these rules read the same event stream, so they are not independent)`;
}

export function convergenceWithheld(n: number): string {
  return `no co-occurrence escalation: ${n} rules on too little activity to corroborate each other`;
}

export function detectRisks(
  account: Account,
  m: AccountMetrics,
  health: HealthResult,
  ctx: RiskContext,
): Risk[] {
  const drafts: Draft[] = [];
  const pct = (n: number) => `${Math.round(Math.abs(n) * 100)}%`;

  // -- No data ------------------------------------------------------------
  if (m.totalEvents === 0) {
    drafts.push({
      code: "no_data",
      title: "No usage data received",
      baseSeverity: "Medium",
      evidence: `Not a single event in the ${WINDOW.totalDays}-day window.`,
      whyItMatters:
        "Either the customer has stopped entirely or we are not receiving their telemetry. Both need a human to look, but they need completely different conversations - so this is never scored as churn risk.",
      affectsHealth: true,
    });
    return finalise(drafts, account, ctx, health);
  }

  // -- Dormancy -----------------------------------------------------------
  const silent = m.daysSinceLastEvent ?? 0;
  if (silent >= RISK_THRESHOLDS.dormantMedium) {
    const base: RiskSeverity =
      silent >= RISK_THRESHOLDS.dormantCritical
        ? "Critical"
        : silent >= RISK_THRESHOLDS.dormantHigh
          ? "High"
          : "Medium";
    drafts.push({
      code: "dormant",
      title: silent >= RISK_THRESHOLDS.dormantHigh ? "Dormant" : "Going quiet",
      baseSeverity: base,
      evidence: `No events for ${silent} days - last activity on ${m.lastEvent}.`,
      whyItMatters:
        "A product that has dropped out of the daily workflow rarely returns on its own, and a renewal conversation with no recent usage to point at is a conversation about price.",
      affectsHealth: true,
    });
  }

  // -- No core value ------------------------------------------------------
  if (m.byType.guide_created === 0 && m.byType.guide_shared === 0) {
    drafts.push({
      code: "no_core_value",
      title: "No guides created or shared",
      baseSeverity: "High",
      evidence: `${m.totalEvents} ${m.totalEvents === 1 ? "event" : "events"} in ${WINDOW.totalDays} days and not one guide created or shared. ${pct(m.loginShare)} of activity is logins.`,
      whyItMatters:
        "Guidde is bought to capture and distribute knowledge. An account that only logs in has people showing up and getting nothing, which is the state that precedes a non-renewal even while the usage chart looks alive.",
      affectsHealth: true,
    });
  } else if (
    // Gated on volume: a "60% of events are logins" ratio computed over four
    // events is arithmetic, not a finding.
    m.totalEvents >= TREND.minEvents &&
    m.loginShare >= RISK_THRESHOLDS.loginOnlyShare &&
    m.byTypeRecent.guide_created === 0 &&
    m.byTypeRecent.guide_shared === 0
  ) {
    drafts.push({
      code: "login_only_recent",
      title: "Logging in without creating",
      baseSeverity: "Medium",
      evidence: `${pct(m.loginShare)} of all activity is logins, and nothing has been created or shared in the last ${WINDOW.recentDays} days.`,
      whyItMatters:
        "Users are still opening the product but no longer producing anything with it. Usually the champion left or the use case ended.",
      affectsHealth: false,
    });
  }

  // -- Single-user dependency ---------------------------------------------
  if (m.activeUsersRecent > 0 && m.activeUsersRecent <= OVERRIDES.singleUserMax) {
    drafts.push({
      code: "single_user",
      title: "Single-user dependency",
      baseSeverity: "High",
      // "That user produced X%" would be wrong: topUserShare belongs to the
      // busiest user over the whole window, and on this export that is a
      // different person from the one still active on 3 of the 4 accounts this
      // rule fires on. The concentration is stated as its own fact about the
      // account, not attributed to the remaining user.
      evidence: `1 active user in the last ${WINDOW.recentDays} days, out of ${m.knownUsers} seen in the window. The busiest single user in the window accounts for ${pct(m.topUserShare)} of all activity.`,
      whyItMatters:
        "The account survives on one person. If they change role or leave, usage goes to zero with no warning and no internal advocate at renewal.",
      affectsHealth: true,
    });
  }

  // -- Usage collapse (volume-gated, evidence only) -----------------------
  const trend = computeTrend(m, TREND.minEvents, TREND.minChange);
  if (trend.reportable && trend.direction === "down" && trend.changePct !== null) {
    const drop = Math.abs(trend.changePct);
    drafts.push({
      code: "usage_collapse",
      title: "Usage declining sharply",
      baseSeverity: drop >= 0.75 ? "High" : "Medium",
      evidence: `${m.eventsRecent} ${m.eventsRecent === 1 ? "event" : "events"} in the last ${WINDOW.recentDays} days against a run rate of ${m.eventsPriorPer30.toFixed(1)} per ${WINDOW.recentDays} days before that - down ${pct(drop)}.`,
      whyItMatters:
        "Decline shows up before silence does. Catching an account on the way down leaves time to intervene; catching it after it goes quiet usually does not.",
      affectsHealth: false,
    });
  }

  // -- Adoption collapse --------------------------------------------------
  if (
    m.totalEvents >= TREND.minEvents &&
    m.activeUsersPrevious30 >= 3 &&
    m.activeUsersRecent <
      m.activeUsersPrevious30 * (1 - RISK_THRESHOLDS.adoptionDropPct)
  ) {
    const drop = 1 - m.activeUsersRecent / m.activeUsersPrevious30;
    drafts.push({
      code: "adoption_collapse",
      title: "Team walking away",
      baseSeverity: "High",
      evidence: `Active users fell from ${m.activeUsersPrevious30} to ${m.activeUsersRecent} between the previous ${WINDOW.recentDays} days and the last ${WINDOW.recentDays} - down ${pct(drop)}.`,
      whyItMatters:
        "Losing people is a sharper signal than losing events, because a single enthusiastic user can keep the event count up while the rest of the team has already stopped.",
      affectsHealth: false,
    });
  }

  // -- Content with no audience -------------------------------------------
  if (
    m.byType.guide_created >= RISK_THRESHOLDS.noAudienceMinCreated &&
    m.byType.guide_viewed < m.byType.guide_created
  ) {
    drafts.push({
      code: "no_audience",
      title: "Guides created, nobody watching",
      baseSeverity: "Medium",
      evidence: `${m.byType.guide_created} guides created but only ${m.byType.guide_viewed} views in ${WINDOW.totalDays} days, across ${m.knownUsers} users.`,
      whyItMatters:
        "A champion is investing effort that the rest of the organisation is not consuming. The value never lands, so when that champion is asked to justify the spend they will have nothing to point at.",
      affectsHealth: false,
    });
  }

  // -- Plan downgrade (commercial, not usage) -----------------------------
  if (
    m.planAtLastEvent &&
    PLAN_RANK[m.planAtLastEvent] < PLAN_RANK[account.planTier]
  ) {
    drafts.push({
      code: "plan_downgrade",
      title: "Plan downgraded during the window",
      baseSeverity: "High",
      evidence: `The contract record says ${account.planTier}, but events have been arriving as ${m.planAtLastEvent} since partway through the window.`,
      whyItMatters:
        "This is a commercial decision the customer has already taken, independent of how they are using the product. It does not belong in a usage score, but a CSM should never be surprised by it.",
      affectsHealth: false,
    });
  }

  // -- Value at stake without adoption ------------------------------------
  if (
    account.arrUsd >= ctx.highValueArrThreshold &&
    health.tier !== "Healthy" &&
    m.totalEvents < TREND.minEvents
  ) {
    drafts.push({
      code: "high_value_low_adoption",
      title: "High-value account, minimal adoption",
      baseSeverity: "High",
      evidence: `$${account.arrUsd.toLocaleString("en-US")} of ARR against ${m.totalEvents} events and ${m.knownUsers} users in ${WINDOW.totalDays} days.`,
      whyItMatters:
        "The gap between what this account pays and what it uses is the gap a procurement review will find. This is the one risk where ARR is part of the definition rather than a multiplier - low usage on a free account is a different problem entirely.",
      affectsHealth: false,
    });
  }

  return finalise(drafts, account, ctx, health);
}

/**
 * Risks whose definition already contains ARR. Escalating these for being
 * high-value would count the same fact twice.
 */
const ARR_IS_IN_THE_DEFINITION = new Set(["high_value_low_adoption"]);

function finalise(
  drafts: Draft[],
  account: Account,
  ctx: RiskContext,
  health: HealthResult,
): Risk[] {
  const highValue = account.arrUsd >= ctx.highValueArrThreshold && account.arrUsd > 0;

  /**
   * Co-occurrence is treated as weak corroboration, never as proof. These rules
   * read the same event stream and are correlated by construction, so this term
   * is deliberately capped at a single level. On an account with almost no
   * events it is withheld entirely: several rules firing on four events is the
   * same thin evidence counted several times, and the reason is printed instead
   * of the escalation.
   */
  const converging =
    drafts.length >= SEVERITY_RULES.convergenceCount && !health.lowConfidence;

  return drafts
    .map((d) => {
      const escalations: string[] = [];
      let severity = d.baseSeverity;

      if (highValue && !ARR_IS_IN_THE_DEFINITION.has(d.code)) {
        severity = escalate(severity, 1);
        escalations.push(
          `+1 for top-quartile ARR ($${account.arrUsd.toLocaleString("en-US")})`,
        );
      }

      if (converging) {
        severity = escalate(severity, 1);
        escalations.push(convergenceEscalation(drafts.length));
      } else if (drafts.length >= SEVERITY_RULES.convergenceCount && health.lowConfidence) {
        escalations.push(convergenceWithheld(drafts.length));
      }

      /**
       * Critical means "act this week". If every health pillar says the account
       * is thriving, a single diagnostic flag is a conversation to have, not an
       * emergency - so it stays visible at High rather than shouting.
       */
      if (health.tier === "Healthy" && severityRank(severity) > severityRank("High")) {
        severity = "High";
        escalations.push(
          "held at High: every health pillar on this account is strong",
        );
      }

      return { ...d, severity, escalations };
    })
    .sort((a, b) => severityRank(b.severity) - severityRank(a.severity));
}
