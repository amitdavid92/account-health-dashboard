/**
 * Compact facts for the collapsed view, derived from the stored metrics.
 *
 * The rule this module exists to keep: a short line and the long sentence it
 * replaces must be reading the same number. So nothing here slices, truncates
 * or parses an `evidence` string - every value is read from the structured
 * fields that `metrics.ts` computed and `db.ts` stored, which is exactly where
 * the long sentences got their numbers from too. A short line can therefore be
 * wrong only if the long one is wrong as well.
 *
 * Nothing here scores, ranks or decides anything. It is presentation.
 */

import { DEPTH_LAPSED_POINTS, WINDOW } from "./config";
import { TIER_RANK } from "./health";
import { money } from "./ui";
import type {
  Account,
  AccountMetrics,
  HealthOverride,
  HealthResult,
  PillarKey,
  PillarResult,
  Risk,
} from "./types";

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

function pct(n: number): string {
  return `${Math.round(Math.abs(n) * 100)}%`;
}

// ---------------------------------------------------------------------------
// Pillars
// ---------------------------------------------------------------------------

/** The one number behind a pillar's points, in as few words as it can be said. */
export function pillarFact(key: PillarKey, m: AccountMetrics): string {
  switch (key) {
    case "recency": {
      const d = m.daysSinceLastEvent;
      if (d === null) return `No activity in the ${WINDOW.totalDays}-day window`;
      if (d === 0) return "Last activity: today";
      if (d === 1) return "Last activity: yesterday";
      return `Last activity: ${d} days ago`;
    }
    case "breadth":
      return `${plural(m.activeUsersRecent, "active user")} · last ${WINDOW.recentDays} days`;
    case "depth":
      return `${m.byTypeRecent.guide_created} created · ${m.byTypeRecent.guide_shared} shared · last ${WINDOW.recentDays} days`;
    case "consistency":
      return `Active in ${m.activeWeeksRecent} of ${WINDOW.consistencyWeeks} weeks`;
  }
}

/**
 * Depth awards partial credit to an account that used to create and stopped,
 * so the compact line can read "0 created · 0 shared" beside a positive score.
 * Without this note that looks like a bug rather than a deliberate rule - and
 * on this dataset it is six accounts, not an edge case.
 */
export function depthPartialCredit(m: AccountMetrics, pillar: PillarResult): string | null {
  if (pillar.key !== "depth" || pillar.points !== DEPTH_LAPSED_POINTS) return null;
  if (m.byTypeRecent.guide_created > 0 || m.byTypeRecent.guide_shared > 0) return null;
  return `Partial credit for ${m.byType.guide_created} created and ${m.byType.guide_shared} shared earlier in the window`;
}

// ---------------------------------------------------------------------------
// Risks
// ---------------------------------------------------------------------------

/**
 * One line per risk code. Any code without an entry falls back to the full
 * evidence sentence, so adding a rule to risks.ts degrades to "verbose" rather
 * than to "blank".
 */
export function riskFact(risk: Risk, m: AccountMetrics, account: Account): string {
  switch (risk.code) {
    case "no_data":
      return `No events in the ${WINDOW.totalDays}-day window`;
    case "dormant":
      return `Last activity: ${m.daysSinceLastEvent} days ago`;
    case "no_core_value":
      return `0 created · 0 shared · ${pct(m.loginShare)} logins`;
    case "login_only_recent":
      return `0 created · 0 shared in last ${WINDOW.recentDays} days · ${pct(m.loginShare)} logins`;
    case "single_user":
      // Deliberately not paired with topUserShare. That share belongs to the
      // busiest user across the whole window, who is not necessarily the one
      // still active in the last 30 days - on this export they differ on 3 of
      // the 4 accounts this rule fires on. Putting the two side by side would
      // assert a link the data does not establish.
      return `1 active user · ${m.knownUsers} seen in the window`;
    case "usage_collapse":
      return `${plural(m.eventsRecent, "event")} vs ${m.eventsPriorPer30.toFixed(1)} prior run rate`;
    case "adoption_collapse":
      return `Active users ${m.activeUsersPrevious30} → ${m.activeUsersRecent}`;
    case "no_audience":
      return `${m.byType.guide_created} created · ${m.byType.guide_viewed} views`;
    case "plan_downgrade":
      return `Contract ${account.planTier} · events ${m.planAtLastEvent}`;
    case "high_value_low_adoption":
      return `${money(account.arrUsd)} ARR · ${plural(m.totalEvents, "event")} · ${plural(m.knownUsers, "user")}`;
    default:
      return risk.evidence;
  }
}

// ---------------------------------------------------------------------------
// Overrides
// ---------------------------------------------------------------------------

/**
 * Split the caps into the ones that actually decided the tier and the ones the
 * score had already reached on its own.
 *
 * The distinction matters because presenting a cap as the reason for a verdict
 * it did not change overstates what happened. On this dataset every cap falls
 * in the second group - the score got there first every time - which is a
 * finding about the model worth being able to show, not hide.
 */
export function splitOverrides(health: HealthResult): {
  binding: HealthOverride[];
  nonBinding: HealthOverride[];
} {
  const scoreRank = TIER_RANK[health.tierFromScore];
  return {
    binding: health.overrides.filter((o) => TIER_RANK[o.cappedAt] < scoreRank),
    nonBinding: health.overrides.filter((o) => TIER_RANK[o.cappedAt] >= scoreRank),
  };
}

/** The cap in one line: what was observed, and what it capped the tier at. */
export function overrideFact(override: HealthOverride, m: AccountMetrics): string {
  switch (override.code) {
    case "dormant":
      return `Silent ${plural(m.daysSinceLastEvent ?? 0, "day")} → capped at ${override.cappedAt}`;
    case "no_core_value":
      return `No guide created or shared → capped at ${override.cappedAt}`;
    case "single_user":
      return `${m.activeUsersRecent === 0 ? "No" : "One"} active user → capped at ${override.cappedAt}`;
    default:
      return `Capped at ${override.cappedAt}`;
  }
}

// ---------------------------------------------------------------------------
// Confidence
// ---------------------------------------------------------------------------

/** The number behind the low-confidence flag, without the paragraph. */
export function confidenceFact(m: AccountMetrics): string {
  return `Only ${plural(m.totalEvents, "event")} in the available window`;
}
