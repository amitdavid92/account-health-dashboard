/**
 * Tests for the scoring model itself, on synthetic accounts.
 *
 * These are written against the *behaviour a CSM would expect*, not against the
 * current numbers: "an account silent for a month is At Risk however good it
 * looked before" rather than "score === 29". If a threshold in config.ts is
 * retuned, these should still pass; if the model stops meaning what it claims
 * to mean, they should fail.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { computeHealth, tierFromScore } from "../src/lib/health";
import { computeMetrics, computeTrend } from "../src/lib/metrics";
import { TIER_THRESHOLDS, TREND, WINDOW } from "../src/lib/config";
import type { EventType, PlanTier, UsageEvent } from "../src/lib/types";

const SNAPSHOT = Date.parse("2026-09-13T00:00:00Z");
const DAY = 86_400_000;

let seq = 0;

/** An event `daysAgo` before the snapshot. */
function ev(
  daysAgo: number,
  eventType: EventType,
  userId = "u1",
  workspaceId = "ws_1",
  planTierAtEvent: PlanTier = "Pro",
): UsageEvent {
  const timestampMs = SNAPSHOT - daysAgo * DAY;
  return {
    eventId: `e${seq++}`,
    accountSlug: "acme",
    workspaceId,
    eventType,
    userId,
    timestampMs,
    timestamp: new Date(timestampMs).toISOString(),
    planTierAtEvent,
  };
}

function health(events: UsageEvent[], plan: PlanTier = "Pro") {
  const metrics = computeMetrics("acme", events, SNAPSHOT, plan);
  return { metrics, result: computeHealth(metrics) };
}

/** A broad, recent, creative, consistent account - the Healthy reference. */
function thrivingAccount(): UsageEvent[] {
  const events: UsageEvent[] = [];
  for (let week = 0; week < 8; week++) {
    for (let u = 0; u < 8; u++) {
      events.push(ev(week * 7 + 1, "guide_viewed", `u${u}`));
    }
    events.push(ev(week * 7 + 1, "guide_created", `u${week % 4}`));
    events.push(ev(week * 7 + 2, "guide_shared", `u${week % 4}`));
  }
  return events;
}

describe("pillars", () => {
  it("awards full recency for activity today and none after 60 days of silence", () => {
    const fresh = health([ev(0, "login")]).result;
    const stale = health([ev(70, "login")]).result;

    const freshRecency = fresh.pillars.find((p) => p.key === "recency")!;
    const staleRecency = stale.pillars.find((p) => p.key === "recency")!;

    assert.equal(freshRecency.points, freshRecency.maxPoints);
    assert.equal(staleRecency.points, 0);
    assert.match(staleRecency.evidence, /70 days ago/);
  });

  it("scores breadth on distinct recent users, not on event volume", () => {
    const oneBusyUser = health(
      Array.from({ length: 20 }, (_, i) => ev(i % 25, "guide_viewed", "solo")),
    ).result;
    const manyQuietUsers = health(
      Array.from({ length: 8 }, (_, i) => ev(3, "guide_viewed", `u${i}`)),
    ).result;

    const busy = oneBusyUser.pillars.find((p) => p.key === "breadth")!;
    const many = manyQuietUsers.pillars.find((p) => p.key === "breadth")!;

    assert.ok(
      many.points > busy.points,
      "eight users doing a little must beat one user doing a lot",
    );
    assert.match(busy.evidence, /depends on one person/);
  });

  it("separates 'never created' from 'stopped creating' in depth", () => {
    const neverCreated = health([
      ev(2, "login"),
      ev(5, "login"),
      ev(9, "guide_viewed", "u2"),
    ]).result;
    const stoppedCreating = health([
      ev(40, "guide_created", "u1"),
      ev(45, "guide_shared", "u1"),
      ev(2, "login"),
    ]).result;

    const never = neverCreated.pillars.find((p) => p.key === "depth")!;
    const stopped = stoppedCreating.pillars.find((p) => p.key === "depth")!;

    assert.equal(never.points, 0);
    assert.match(never.evidence, /has ever been created or shared/);
    assert.ok(stopped.points > never.points, "a lapsed creator is not the same as a never-creator");
    assert.match(stopped.evidence, /after 1 created/);
  });

  it("measures consistency in weeks, so a single burst does not look like a habit", () => {
    const burst = health(
      Array.from({ length: 15 }, () => ev(3, "guide_viewed", "u1")),
    ).result;
    const habit = health(
      Array.from({ length: 8 }, (_, w) => ev(w * 7 + 1, "guide_viewed", "u1")),
    ).result;

    const burstPoints = burst.pillars.find((p) => p.key === "consistency")!.points;
    const habitPoints = habit.pillars.find((p) => p.key === "consistency")!.points;

    assert.ok(habitPoints > burstPoints, "8 active weeks must beat 15 events in one day");
  });

  it("sums the four pillars to exactly the score, with nothing unattributed", () => {
    const { result } = health(thrivingAccount());
    const summed = result.pillars.reduce((n, p) => n + p.points, 0);
    assert.equal(summed, result.score);
    assert.equal(
      result.pillars.reduce((n, p) => n + p.maxPoints, 0),
      100,
      "the pillars must add up to 100 or the score is not a percentage of anything",
    );
  });
});

describe("overrides", () => {
  it("forces At Risk after 30 days of silence however strong the history", () => {
    // A thriving account, shifted so its most recent event is 31 days old.
    const events = thrivingAccount().map((e) => ({
      ...e,
      timestampMs: e.timestampMs - 31 * DAY,
      timestamp: new Date(e.timestampMs - 31 * DAY).toISOString(),
    }));
    const { result } = health(events);

    assert.equal(result.tier, "At Risk");
    assert.ok(
      result.overrides.some((o) => o.code === "dormant"),
      "the dormancy override must be the stated reason",
    );
  });

  it("caps an account that has never created or shared a guide below Healthy", () => {
    const loginsOnly: UsageEvent[] = [];
    for (let week = 0; week < 8; week++) {
      for (let u = 0; u < 8; u++) loginsOnly.push(ev(week * 7 + 1, "login", `u${u}`));
    }
    const { result } = health(loginsOnly);

    assert.ok(result.score >= 0);
    assert.notEqual(result.tier, "Healthy");
    assert.ok(result.overrides.some((o) => o.code === "no_core_value"));
  });

  it("caps a single-user account below Healthy even when it is busy and recent", () => {
    const solo: UsageEvent[] = [];
    for (let week = 0; week < 8; week++) {
      solo.push(ev(week * 7 + 1, "guide_created", "solo"));
      solo.push(ev(week * 7 + 2, "guide_shared", "solo"));
      solo.push(ev(week * 7 + 3, "guide_viewed", "solo"));
    }
    const { result } = health(solo);

    assert.equal(result.tierFromScore, "Healthy", "the raw score alone would have said Healthy");
    assert.equal(result.tier, "Watch", "but one person is not adoption");
    assert.ok(result.overrides.some((o) => o.code === "single_user"));
  });

  it("never lets an override raise a tier, only lower it", () => {
    const { result } = health([ev(45, "login"), ev(50, "login", "u2")]);
    assert.ok(
      result.pillars.reduce((n, p) => n + p.points, 0) < TIER_THRESHOLDS.watch,
      "precondition: this account scores into At Risk",
    );
    assert.equal(result.tier, "At Risk");
  });
});

describe("edge cases", () => {
  it("reports an account with no events as No Data, never At Risk", () => {
    const { result } = health([]);
    assert.equal(result.tier, "No Data");
    assert.equal(result.score, 0);
    assert.deepEqual(result.pillars, []);
    assert.match(result.confidenceNote ?? "", /not the same as churn/);
  });

  it("flags low confidence on a barely-active account but still scores it", () => {
    const { result } = health([ev(2, "login"), ev(20, "guide_viewed", "u2")]);
    assert.equal(result.lowConfidence, true);
    assert.ok(result.confidenceNote);
    assert.ok(["At Risk", "Watch"].includes(result.tier), "it is still given a verdict");
  });

  it("rolls multiple workspaces into one account and counts each user once", () => {
    const events = [
      ev(1, "guide_created", "shared_user", "ws_a"),
      ev(2, "guide_viewed", "shared_user", "ws_b"),
      ev(3, "login", "only_in_b", "ws_b"),
    ];
    const { metrics } = health(events);

    assert.equal(metrics.workspaceCount, 2);
    assert.equal(metrics.knownUsers, 2, "a user active in both workspaces is still one person");
    assert.equal(metrics.workspaces.length, 2);
  });

  it("detects a plan downgrade from the event stream without touching the score", () => {
    const events = [
      ev(60, "guide_created", "u1", "ws_1", "Enterprise"),
      ev(2, "login", "u1", "ws_1", "Pro"),
    ];
    const { metrics } = health(events, "Enterprise");

    assert.equal(metrics.planAtLastEvent, "Pro");
    assert.equal(metrics.planDowngraded, true);
  });

  it("treats a recovering account as recent, not as its dead history", () => {
    const events = [
      ...Array.from({ length: 6 }, (_, i) => ev(60 + i, "guide_viewed", `old${i}`)),
      ev(1, "guide_created", "new1"),
      ev(2, "guide_shared", "new2"),
      ev(3, "login", "new3"),
    ];
    const { result } = health(events);
    const recency = result.pillars.find((p) => p.key === "recency")!;

    assert.equal(recency.points, recency.maxPoints);
    assert.ok(!result.overrides.some((o) => o.code === "dormant"));
  });
});

describe("trend gate", () => {
  it("stays silent below the volume floor, however violent the swing", () => {
    // 4 events recently, 0 before: an infinite percentage change on no evidence.
    const events = Array.from({ length: 4 }, (_, i) => ev(i + 1, "guide_viewed", `u${i}`));
    const { metrics } = health(events);
    const trend = computeTrend(metrics, TREND.minEvents, TREND.minChange);

    assert.equal(trend.reportable, false);
    assert.ok(metrics.totalEvents < TREND.minEvents);
  });

  it("reports a real collapse once there is enough history behind it", () => {
    const events = [
      ...Array.from({ length: 18 }, (_, i) => ev(35 + (i % 50), "guide_viewed", `u${i % 6}`)),
      ev(5, "login", "u1"),
    ];
    const { metrics } = health(events);
    const trend = computeTrend(metrics, TREND.minEvents, TREND.minChange);

    assert.equal(trend.reportable, true);
    assert.equal(trend.direction, "down");
    assert.ok((trend.changePct ?? 0) <= -TREND.minChange);
  });
});

describe("tier boundaries", () => {
  it("maps scores to tiers at the documented thresholds", () => {
    assert.equal(tierFromScore(TIER_THRESHOLDS.healthy), "Healthy");
    assert.equal(tierFromScore(TIER_THRESHOLDS.healthy - 1), "Watch");
    assert.equal(tierFromScore(TIER_THRESHOLDS.watch), "Watch");
    assert.equal(tierFromScore(TIER_THRESHOLDS.watch - 1), "At Risk");
    assert.equal(tierFromScore(0), "At Risk");
    assert.equal(tierFromScore(100), "Healthy");
  });

  it("keeps the analysis windows consistent with each other", () => {
    assert.equal(WINDOW.recentDays + WINDOW.priorDays, WINDOW.totalDays);
    assert.ok(WINDOW.consistencyWeeks * 7 <= WINDOW.totalDays);
  });
});
