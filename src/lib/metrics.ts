/**
 * Stage 2: normalized events -> per-account metrics.
 *
 * Pure functions, no I/O, no dates from the clock. Everything is measured
 * relative to `snapshotMs` so the same input always produces the same output.
 *
 * Only metrics that something downstream actually consumes are computed. The
 * dataset offers plenty more (events per user, hour-of-day, day-of-week); they
 * are left out on purpose, and the README says why.
 */

import { WINDOW } from "./config";
import {
  EVENT_TYPES,
  type AccountMetrics,
  type EventCounts,
  type PlanTier,
  type UsageEvent,
  type WeekBucket,
  type WorkspaceBreakdown,
} from "./types";

const DAY_MS = 86_400_000;

export function daysBetween(fromMs: number, toMs: number): number {
  return Math.floor((toMs - fromMs) / DAY_MS);
}

function emptyCounts(): EventCounts {
  return {
    guide_created: 0,
    guide_viewed: 0,
    guide_shared: 0,
    user_invited: 0,
    login: 0,
  };
}

function isoDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function emptyMetrics(accountSlug: string): AccountMetrics {
  return {
    accountSlug,
    totalEvents: 0,
    eventsRecent: 0,
    eventsPrior: 0,
    eventsPriorPer30: 0,
    knownUsers: 0,
    activeUsersRecent: 0,
    activeUsersPrior: 0,
    activeUsersPrevious30: 0,
    newUsersRecent: 0,
    returningUsersRecent: 0,
    creators: 0,
    topUserShare: 0,
    firstEvent: null,
    lastEvent: null,
    daysSinceLastEvent: null,
    activeDays: 0,
    activeWeeksRecent: 0,
    weekly: [],
    byType: emptyCounts(),
    byTypeRecent: emptyCounts(),
    loginShare: 0,
    workspaceCount: 0,
    workspaces: [],
    planAtLastEvent: null,
    planDowngraded: false,
  };
}

/**
 * Weeks are anchored to the snapshot, not to calendar weeks. Bucket 0 is the
 * 7 days ending at the snapshot. Anchoring this way means "active in 6 of the
 * last 8 weeks" is always measured over exactly 56 days, and a snapshot taken
 * mid-week never produces a misleading half-empty first bar.
 */
function weekIndex(snapshotMs: number, tsMs: number): number {
  return Math.floor(daysBetween(tsMs, snapshotMs) / 7);
}

export function computeMetrics(
  accountSlug: string,
  events: UsageEvent[],
  snapshotMs: number,
  contractedPlan: PlanTier,
): AccountMetrics {
  if (events.length === 0) return emptyMetrics(accountSlug);

  const sorted = [...events].sort((a, b) => a.timestampMs - b.timestampMs);
  const first = sorted[0];
  const last = sorted[sorted.length - 1];

  const byType = emptyCounts();
  const byTypeRecent = emptyCounts();

  const usersAll = new Set<string>();
  const usersRecent = new Set<string>();
  const usersPrior = new Set<string>();
  const usersPrevious30 = new Set<string>();
  const creators = new Set<string>();
  const eventsPerUser = new Map<string, number>();
  const activeDays = new Set<string>();
  const activeWeeks = new Set<number>();

  const weekBuckets = new Map<number, { counts: EventCounts; users: Set<string> }>();
  const wsGroups = new Map<string, UsageEvent[]>();

  let eventsRecent = 0;
  let eventsPrior = 0;

  for (const e of sorted) {
    const age = daysBetween(e.timestampMs, snapshotMs);

    byType[e.eventType] += 1;
    usersAll.add(e.userId);
    eventsPerUser.set(e.userId, (eventsPerUser.get(e.userId) ?? 0) + 1);
    activeDays.add(isoDate(e.timestampMs));
    if (e.eventType === "guide_created") creators.add(e.userId);

    if (age < WINDOW.recentDays) {
      eventsRecent += 1;
      usersRecent.add(e.userId);
      byTypeRecent[e.eventType] += 1;
    } else if (age < WINDOW.recentDays + WINDOW.priorDays) {
      eventsPrior += 1;
      usersPrior.add(e.userId);
      if (age < WINDOW.recentDays * 2) usersPrevious30.add(e.userId);
    }

    const wi = weekIndex(snapshotMs, e.timestampMs);
    if (wi < WINDOW.consistencyWeeks) activeWeeks.add(wi);
    if (wi < WINDOW.chartWeeks) {
      let bucket = weekBuckets.get(wi);
      if (!bucket) {
        bucket = { counts: emptyCounts(), users: new Set() };
        weekBuckets.set(wi, bucket);
      }
      bucket.counts[e.eventType] += 1;
      bucket.users.add(e.userId);
    }

    const group = wsGroups.get(e.workspaceId);
    if (group) group.push(e);
    else wsGroups.set(e.workspaceId, [e]);
  }

  // Oldest week first, so the chart reads left to right.
  const weekly: WeekBucket[] = [];
  for (let i = WINDOW.chartWeeks - 1; i >= 0; i--) {
    const bucket = weekBuckets.get(i);
    const endMs = snapshotMs - i * 7 * DAY_MS;
    const startMs = endMs - 6 * DAY_MS;
    const c = bucket?.counts ?? emptyCounts();
    weekly.push({
      weekStart: isoDate(startMs),
      weekEnd: isoDate(endMs),
      total: EVENT_TYPES.reduce((sum, t) => sum + c[t], 0),
      created: c.guide_created,
      shared: c.guide_shared,
      viewed: c.guide_viewed,
      invited: c.user_invited,
      login: c.login,
      activeUsers: bucket?.users.size ?? 0,
    });
  }

  const workspaces: WorkspaceBreakdown[] = [...wsGroups.entries()]
    .map(([workspaceId, group]) => {
      const wsFirst = group[0];
      const wsLast = group[group.length - 1];
      return {
        workspaceId,
        events: group.length,
        users: new Set(group.map((e) => e.userId)).size,
        firstEvent: isoDate(wsFirst.timestampMs),
        lastEvent: isoDate(wsLast.timestampMs),
        daysSinceLastEvent: daysBetween(wsLast.timestampMs, snapshotMs),
      };
    })
    .sort((a, b) => b.events - a.events);

  const newUsersRecent = [...usersRecent].filter((u) => !usersPrior.has(u)).length;
  const topUserEvents = Math.max(...eventsPerUser.values());

  return {
    accountSlug,
    totalEvents: sorted.length,
    eventsRecent,
    eventsPrior,
    eventsPriorPer30: (eventsPrior * WINDOW.recentDays) / WINDOW.priorDays,
    knownUsers: usersAll.size,
    activeUsersRecent: usersRecent.size,
    activeUsersPrior: usersPrior.size,
    activeUsersPrevious30: usersPrevious30.size,
    newUsersRecent,
    returningUsersRecent: usersRecent.size - newUsersRecent,
    creators: creators.size,
    topUserShare: topUserEvents / sorted.length,
    firstEvent: isoDate(first.timestampMs),
    lastEvent: isoDate(last.timestampMs),
    daysSinceLastEvent: daysBetween(last.timestampMs, snapshotMs),
    activeDays: activeDays.size,
    activeWeeksRecent: activeWeeks.size,
    weekly,
    byType,
    byTypeRecent,
    loginShare: byType.login / sorted.length,
    workspaceCount: wsGroups.size,
    workspaces,
    planAtLastEvent: last.planTierAtEvent,
    planDowngraded: last.planTierAtEvent !== contractedPlan,
  };
}

// ---------------------------------------------------------------------------
// Trend - computed here, gated and interpreted in risks.ts. Never scored.
// ---------------------------------------------------------------------------

export interface TrendResult {
  /** Relative change of the last 30d against the prior 60d, expressed per 30d. */
  changePct: number | null;
  /** True only when the account has enough volume for the comparison to mean anything. */
  reportable: boolean;
  direction: "up" | "down" | "flat";
}

export function computeTrend(metrics: AccountMetrics, minEvents: number, minChange: number): TrendResult {
  if (metrics.totalEvents < minEvents || metrics.eventsPriorPer30 === 0) {
    return { changePct: null, reportable: false, direction: "flat" };
  }
  const changePct =
    (metrics.eventsRecent - metrics.eventsPriorPer30) / metrics.eventsPriorPer30;
  const reportable = Math.abs(changePct) >= minChange;
  return {
    changePct,
    reportable,
    direction: changePct > 0 ? "up" : changePct < 0 ? "down" : "flat",
  };
}
