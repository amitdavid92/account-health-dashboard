/**
 * Score-as-of-30-days-ago, computed by re-running the same pure pipeline on
 * an earlier snapshot rather than by storing any history.
 *
 * This is not a new model: computeMetrics/computeHealth in health.ts and
 * metrics.ts are pure functions of (events, snapshotMs). Moving `snapshotMs`
 * back 30 days and re-running them - after dropping events that had not
 * happened yet at that point - produces the score exactly as it would have
 * been reported then, through the identical code path. Nothing about scoring
 * changes; this only calls the existing pipeline twice.
 *
 * It exists to answer one question a single-snapshot API cannot: "is this
 * account getting better or worse?" The production version of this is a
 * scheduled job that keeps real history (see README, "what's next") - this
 * is the honest, no-new-infrastructure version of the same idea.
 */

import { buildSummaries } from "./pipeline";
import type { Account, UsageEvent } from "./types";

const THIRTY_DAYS_MS = 30 * 86_400_000;

/** account slug -> score 30 days before the real snapshot, or null if unscoreable then. */
export function scoresThirtyDaysAgo(
  accounts: Account[],
  events: UsageEvent[],
  snapshotMs: number,
): Map<string, number | null> {
  const priorSnapshotMs = snapshotMs - THIRTY_DAYS_MS;
  const priorEvents = events.filter((e) => e.timestampMs <= priorSnapshotMs);
  const priorSummaries = buildSummaries(accounts, priorEvents, priorSnapshotMs);

  const out = new Map<string, number | null>();
  for (const s of priorSummaries) {
    // A "No Data" verdict 30 days ago (nothing had happened yet, or the
    // account did not exist in the window) is not a score of 0 - it is an
    // absence, so the delta for it is left unscored rather than reported.
    out.set(s.account.slug, s.health.tier === "No Data" ? null : s.health.score);
  }
  return out;
}
