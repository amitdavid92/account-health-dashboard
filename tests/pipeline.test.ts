/**
 * Integration tests against the real export.
 *
 * Two jobs:
 *
 *  1. Pin the findings the README and the analysis claim, so a change to the
 *     model that silently rewrites the story fails here instead of in a debrief.
 *  2. Re-derive the headline numbers from SQLite with plain SQL and check they
 *     match what the pipeline computed in memory. Unit tests on pure functions
 *     cannot catch a persistence bug; this can.
 */

import assert from "node:assert/strict";
import { describe, it, before } from "node:test";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { PRIORITY_RISK_FLOOR, SEVERITY_RULES, TREND } from "../src/lib/config";
import { computeTrend } from "../src/lib/metrics";
import { listAccounts, parseSort, SORT_KEYS, type SortKey } from "../src/lib/db";
import { normalize } from "../src/lib/normalize";
import {
  buildPortfolioKpis,
  buildSummaries,
  needsAttention,
  priorityScore,
  worstSeverity,
} from "../src/lib/pipeline";
import {
  convergenceEscalation,
  convergenceWithheld,
  severityRank,
} from "../src/lib/risks";
import type { AccountSummary, RawAccount, RawEvent } from "../src/lib/types";

const DATA_DIR = path.join(process.cwd(), "data");
const DB_PATH = path.join(DATA_DIR, "health.db");

const rawAccounts = JSON.parse(
  fs.readFileSync(path.join(DATA_DIR, "accounts.json"), "utf8"),
) as RawAccount[];
const rawEvents = JSON.parse(
  fs.readFileSync(path.join(DATA_DIR, "usage_events.json"), "utf8"),
) as RawEvent[];

const { accounts, events, snapshotMs, quality } = normalize(rawAccounts, rawEvents);
const summaries = buildSummaries(accounts, events, snapshotMs);
const kpis = buildPortfolioKpis(summaries, snapshotMs);

const bySlug = new Map(summaries.map((s) => [s.account.slug, s]));
function get(slug: string): AccountSummary {
  const s = bySlug.get(slug);
  assert.ok(s, `expected an account with slug ${slug}`);
  return s;
}

function issue(code: string) {
  const i = quality.issues.find((x) => x.code === code);
  assert.ok(i, `expected a quality check called ${code}`);
  return i;
}

describe("the export, as loaded", () => {
  it("keeps every row: nothing in this export is unusable", () => {
    assert.equal(quality.totals.accounts, 25);
    assert.equal(quality.totals.events, 480);
    assert.equal(quality.totals.eventsDropped, 0);
    assert.equal(quality.totals.workspaces, 28);
    assert.equal(quality.totals.users, 186);
    assert.equal(quality.totals.windowDays, 89);
  });

  it("pins 'today' to the last event, not to the clock", () => {
    assert.equal(new Date(snapshotMs).toISOString().slice(0, 10), "2026-09-13");
  });

  it("finds a clean join between the two files", () => {
    assert.equal(issue("orphan_events").count, 0);
    assert.equal(issue("accounts_without_events").count, 0);
    assert.equal(issue("duplicate_event_ids").count, 0);
    assert.equal(issue("duplicate_rows").count, 0);
    assert.equal(issue("shared_workspaces").count, 0);
    assert.equal(issue("cross_account_users").count, 0);
  });

  it("finds the two problems that are actually there", () => {
    assert.equal(issue("multi_workspace_accounts").count, 3);
    assert.deepEqual(issue("multi_workspace_accounts").affectedAccounts?.sort(), [
      "alderman-freight",
      "brightside-logistics",
      "cobalt-financial",
    ]);

    assert.equal(issue("plan_drift").count, 2);
    assert.deepEqual(issue("plan_drift").affectedAccounts?.sort(), [
      "marlowe-and-reed",
      "thistle-and-vine-events",
    ]);
  });
});

describe("the portfolio", () => {
  it("splits into tiers that are worth acting on", () => {
    assert.equal(kpis.accounts, 25);
    assert.equal(kpis.tierCounts.Healthy, 15);
    assert.equal(kpis.tierCounts.Watch, 5);
    assert.equal(kpis.tierCounts["At Risk"], 5);
    assert.equal(kpis.tierCounts["No Data"], 0);
  });

  it("puts a quarter of the book in the At Risk bucket", () => {
    assert.equal(kpis.totalArr, 1_494_469);
    assert.equal(kpis.arrAtRisk, 391_024);
    assert.ok(kpis.arrAtRiskPct > 0.25 && kpis.arrAtRiskPct < 0.27);
  });

  it("ranks by priority, so the most expensive problem is first", () => {
    assert.equal(summaries[0].account.slug, "pinnacle-manufacturing");
    assert.equal(summaries[0].health.tier, "At Risk");
    assert.ok(
      summaries.every((s) => {
        if (s.health.tier !== "Healthy") return true;
        const worst = worstSeverity(s.risks);
        // Healthy and no flag worth acting on -> nothing to prioritise.
        // Healthy with a High/Critical flag -> must NOT sort to zero.
        return worst !== null && (PRIORITY_RISK_FLOOR[worst] ?? 0) > 0
          ? s.priorityScore > 0
          : s.priorityScore === 0;
      }),
      "a healthy account is zero only when no risk demands a look",
    );
    // The floor raises a flagged Healthy account into the queue; it does not
    // let it jump a failing account of the same size. (Severity is held at High
    // on a Healthy account, so weight 2 against At Risk's 3 - ARR being equal,
    // the usage verdict still wins.)
    assert.ok(
      priorityScore("At Risk", 100_000) > priorityScore("Healthy", 100_000, "High"),
      "at equal ARR the usage tier must still outrank a commercial flag",
    );
    assert.ok(priorityScore("Healthy", 100_000, "High") > 0);
    assert.equal(priorityScore("Healthy", 100_000, "Medium"), 0, "Medium is diagnostic only");
    assert.equal(priorityScore("Healthy", 100_000, null), 0);
  });

  it("confirms the finding that motivates the whole dashboard: ARR does not follow usage", () => {
    const busiest = [...summaries].sort((a, b) => b.metrics.totalEvents - a.metrics.totalEvents);
    assert.equal(
      busiest[0].account.arrUsd,
      0,
      "the single most active account in the portfolio is on a free plan",
    );

    const richest = [...summaries].sort((a, b) => b.account.arrUsd - a.account.arrUsd);
    const top5events = richest.slice(0, 5).reduce((n, s) => n + s.metrics.totalEvents, 0);
    const bottom5events = richest.slice(-5).reduce((n, s) => n + s.metrics.totalEvents, 0);
    assert.ok(
      bottom5events > top5events,
      `the five cheapest accounts (${bottom5events} events) out-use the five most expensive (${top5events})`,
    );
  });
});

describe("named accounts behave as the analysis says", () => {
  it("Cedarline Insurance: alive on logins, dead on value", () => {
    const s = get("cedarline-insurance");
    assert.equal(s.metrics.byType.guide_created, 0);
    assert.equal(s.metrics.byType.guide_shared, 0);
    assert.equal(s.metrics.byType.guide_viewed, 0);
    assert.equal(s.metrics.byType.login, 13);
    assert.equal(s.health.tier, "At Risk");
    assert.ok(s.risks.some((r) => r.code === "no_core_value"));
    assert.equal(s.topRisk?.severity, "Critical");
  });

  it("Pinnacle Manufacturing: the most expensive problem in the book", () => {
    const s = get("pinnacle-manufacturing");
    assert.equal(s.account.arrUsd, 185_568);
    assert.equal(s.metrics.totalEvents, 4);
    assert.equal(s.metrics.activeUsersRecent, 1);
    assert.equal(s.health.tier, "At Risk");
    assert.equal(s.health.lowConfidence, true, "four events is not enough to be confident");
    assert.ok(s.risks.some((r) => r.code === "high_value_low_adoption"));
  });

  it("Redwood Studios: high ARR, silent for six weeks", () => {
    const s = get("redwood-studios");
    assert.ok((s.metrics.daysSinceLastEvent ?? 0) >= 40);
    assert.equal(s.health.tier, "At Risk");
    assert.ok(s.health.overrides.some((o) => o.code === "dormant"));
  });

  it("Quarrystone Consulting: what a healthy Enterprise account looks like", () => {
    const s = get("quarrystone-consulting");
    assert.equal(s.health.tier, "Healthy");
    assert.equal(s.health.score, 100);
    assert.equal(s.priorityScore, 0);
    assert.equal(s.health.overrides.length, 0);
  });

  it("Gladwell Education: healthy overall, so its decline is not screamed at the CSM", () => {
    const s = get("gladwell-education");
    assert.equal(s.health.tier, "Healthy");
    const decline = s.risks.find((r) => r.code === "usage_collapse");
    assert.ok(decline, "the decline is still reported");
    assert.notEqual(decline.severity, "Critical", "but not as an emergency");
  });

  it("Thistle & Vine: a downgrade is surfaced without touching the usage score", () => {
    const s = get("thistle-and-vine-events");
    assert.equal(s.account.planTier, "Enterprise", "the contract is the source of truth");
    assert.equal(s.metrics.planAtLastEvent, "Pro");
    const risk = s.risks.find((r) => r.code === "plan_downgrade");
    assert.ok(risk);
    assert.equal(risk.affectsHealth, false);
  });

  it("Thistle & Vine: Healthy on usage, but not sorted to the bottom of the queue", () => {
    const s = get("thistle-and-vine-events");
    assert.equal(s.health.tier, "Healthy", "a commercial flag must not move the usage score");
    assert.equal(worstSeverity(s.risks), "High");
    assert.ok(
      s.priorityScore > 0,
      "an account carrying a High risk cannot have zero priority - that reads as 'nothing to do'",
    );
    assert.ok(
      needsAttention(s.health.tier, s.risks),
      "and it must be inside the accounts-needing-attention count",
    );
  });

  it("Cobalt Financial: two workspaces, rolled into one verdict", () => {
    const s = get("cobalt-financial");
    assert.equal(s.metrics.workspaceCount, 2);
    assert.equal(
      s.metrics.workspaces.reduce((n, w) => n + w.events, 0),
      s.metrics.totalEvents,
      "the workspace breakdown must account for every event",
    );
  });
});

describe("priority and health are separate axes", () => {
  it("gives every High or Critical risk a non-zero priority, whatever the tier says", () => {
    const flagged = summaries.filter((s) => {
      const worst = worstSeverity(s.risks);
      return worst !== null && (PRIORITY_RISK_FLOOR[worst] ?? 0) > 0;
    });
    assert.ok(flagged.length > 0, "precondition: this export contains High/Critical risks");
    for (const s of flagged) {
      assert.ok(
        s.priorityScore > 0,
        `${s.account.slug}: ${worstSeverity(s.risks)} risk with priority ${s.priorityScore}`,
      );
    }
  });

  it("leaves health scores and tiers untouched by the priority floor", () => {
    // The floor lives in priorityScore alone. If it ever leaked into scoring,
    // this portfolio's shape would move.
    assert.equal(kpis.tierCounts.Healthy, 15);
    assert.equal(kpis.tierCounts.Watch, 5);
    assert.equal(kpis.tierCounts["At Risk"], 5);
    assert.equal(kpis.arrAtRisk, 391_024, "ARR at risk is still the At Risk tier's ARR, nothing more");
  });

  it("counts each account needing attention exactly once", () => {
    const expected = summaries.filter((s) => needsAttention(s.health.tier, s.risks));
    assert.equal(kpis.accountsNeedingAttention, expected.length);
    assert.equal(new Set(expected.map((s) => s.account.slug)).size, expected.length);

    // Every account below Healthy is in, including No Data.
    const belowHealthy = summaries.filter((s) => s.health.tier !== "Healthy");
    for (const s of belowHealthy) {
      assert.ok(needsAttention(s.health.tier, s.risks), `${s.account.slug} must be counted`);
    }

    // And the total is never the naive sum, which would drop or double-count.
    assert.equal(
      kpis.healthyNeedingReview,
      expected.filter((s) => s.health.tier === "Healthy").length,
    );
    assert.equal(
      kpis.accountsNeedingAttention,
      belowHealthy.length + kpis.healthyNeedingReview,
      "below-Healthy and flagged-Healthy are disjoint sets, so they add without overlap",
    );
    assert.ok(kpis.accountsNeedingAttention <= kpis.accounts);
  });
});

describe("the report says why a trend is missing, not just that it is", () => {
  it("names one of the three gates, and never blames volume on a high-volume account", () => {
    const seen = new Set<string>();
    for (const s of summaries) {
      const t = computeTrend(s.metrics, TREND.minEvents, TREND.minChange);
      if (t.reportable) {
        assert.equal(t.suppressedBecause, null);
        continue;
      }
      assert.ok(t.suppressedBecause, `${s.account.slug}: a suppressed trend must say which gate closed`);
      seen.add(t.suppressedBecause);

      if (t.suppressedBecause === "too_few_events") {
        assert.ok(s.metrics.totalEvents < TREND.minEvents);
      }
      if (t.suppressedBecause === "no_baseline") {
        assert.ok(s.metrics.totalEvents >= TREND.minEvents);
        assert.equal(s.metrics.eventsPriorPer30, 0);
      }
      if (t.suppressedBecause === "change_below_threshold") {
        assert.ok(
          s.metrics.totalEvents >= TREND.minEvents,
          `${s.account.slug}: a small change must not be reported as too few events`,
        );
        assert.ok(s.metrics.eventsPriorPer30 > 0);
        assert.ok(Math.abs(t.changePct ?? 1) < TREND.minChange);
      }
    }
    assert.ok(
      seen.has("too_few_events") && seen.has("change_below_threshold"),
      `this export must exercise both common gates (saw: ${[...seen].join(", ")})`,
    );
  });
});

describe("explainability is structural, not decorative", () => {
  it("gives every scored account exactly four pillars that sum to its score", () => {
    for (const s of summaries) {
      if (s.health.tier === "No Data") continue;
      assert.equal(s.health.pillars.length, 4, `${s.account.slug} must have four pillars`);
      assert.equal(
        s.health.pillars.reduce((n, p) => n + p.points, 0),
        s.health.score,
        `${s.account.slug}: the score must equal the sum of its stated reasons`,
      );
      for (const p of s.health.pillars) {
        assert.ok(p.evidence.length > 10, `${s.account.slug}/${p.key} needs a real sentence`);
        assert.ok(p.points <= p.maxPoints);
      }
    }
  });

  it("never states a verdict a CSM cannot trace", () => {
    for (const s of summaries) {
      if (s.health.tier !== s.health.tierFromScore) {
        assert.ok(
          s.health.overrides.length > 0,
          `${s.account.slug}: the tier differs from the score, so an override must say why`,
        );
      }
      for (const r of s.risks) {
        assert.ok(r.evidence.length > 10, `${s.account.slug}/${r.code} needs evidence`);
        assert.ok(r.whyItMatters.length > 20, `${s.account.slug}/${r.code} needs a business reason`);
        if (r.severity !== r.baseSeverity) {
          assert.ok(
            r.escalations.length > 0,
            `${s.account.slug}/${r.code}: severity moved, so it must say why`,
          );
        }
      }
    }
  });

  it("does not escalate on co-occurrence on an account it has barely seen", () => {
    // Matched on the exact strings risks.ts emits, imported rather than
    // retyped, so a reworded escalation cannot make this pass vacuously.
    let exercised = 0;

    for (const s of summaries) {
      if (!s.health.lowConfidence) continue;
      if (s.risks.length < SEVERITY_RULES.convergenceCount) continue;
      exercised += 1;

      const escalated = convergenceEscalation(s.risks.length);
      const withheld = convergenceWithheld(s.risks.length);

      for (const r of s.risks) {
        assert.ok(
          !r.escalations.includes(escalated),
          `${s.account.slug}/${r.code}: co-occurrence must not escalate on thin evidence`,
        );
      }
      assert.ok(
        s.risks.some((r) => r.escalations.includes(withheld)),
        `${s.account.slug}: the withheld escalation must be stated, not silently skipped`,
      );
      // The escalation is worth one level, so withholding it must leave every
      // risk at its own base strength once ARR is accounted for.
      for (const r of s.risks) {
        assert.ok(
          severityRank(r.severity) <= severityRank(r.baseSeverity) + 1,
          `${s.account.slug}/${r.code}: only the ARR term may move severity here`,
        );
      }
    }

    assert.ok(
      exercised >= 2,
      "precondition: this export must contain low-confidence accounts with several risks, or the test proves nothing",
    );
  });
});

describe("bad input is reported, not silently repaired", () => {
  const broken = normalize(
    [
      { company_name: "Fine Co", domain: "fine.example", plan_tier: "Pro", arr_usd: 1000, csm_owner: "A" },
      { company_name: "Bad Plan Co", domain: "bp.example", plan_tier: "Platinum", arr_usd: 500, csm_owner: "A" },
      { company_name: "Bad Arr Co", domain: "ba.example", plan_tier: "Pro", arr_usd: "not a number", csm_owner: "A" },
      { company_name: "Negative Arr Co", domain: "na.example", plan_tier: "Pro", arr_usd: -50, csm_owner: "A" },
    ] as RawAccount[],
    [
      {
        event_id: "e1",
        workspace_id: "ws_1",
        company_name: "Fine Co",
        event_type: "login",
        user_id: "u1",
        timestamp: "2026-09-01T20:00:00Z",
        plan_tier: "Diamond",
      },
    ] as RawEvent[],
  );

  function brokenIssue(code: string) {
    const i = broken.quality.issues.find((x) => x.code === code);
    assert.ok(i, `expected a quality check called ${code}`);
    return i;
  }

  it("names every account whose plan or ARR was replaced by a fallback", () => {
    const i = brokenIssue("substituted_values");
    assert.equal(i.severity, "warning");
    assert.equal(i.count, 4, "3 account fields plus 1 event plan");
    assert.match(i.detail, /Bad Plan Co/);
    assert.match(i.detail, /Bad Arr Co/);
    assert.match(i.detail, /Negative Arr Co/);
    assert.match(i.detail, /1 events? carried an unrecognised plan_tier/);
  });

  it("still applies the fallback, so the account stays visible", () => {
    const byName = new Map(broken.accounts.map((a) => [a.companyName, a]));
    assert.equal(byName.get("Bad Plan Co")?.planTier, "Free");
    assert.equal(byName.get("Bad Arr Co")?.arrUsd, 0);
    assert.equal(byName.get("Negative Arr Co")?.arrUsd, 0);
    assert.equal(broken.accounts.length, 4);
  });

  it("reports the clean case as checked rather than as nothing to say", () => {
    const i = issue("substituted_values");
    assert.equal(i.count, 0);
    assert.equal(i.severity, "info");
    assert.match(i.detail, /no fallback was applied/);
  });

  it("does not claim an independent future-date check it cannot run", () => {
    const i = issue("timestamp_anomalies");
    assert.equal(i.count, 0);
    assert.doesNotMatch(i.detail, /none are in the future/);
    assert.match(i.resolution, /circular/);
  });

  it("computes the hour-of-day gap instead of asserting it", () => {
    const i = issue("hour_of_day_gap");
    assert.equal(i.count, 10, "hours 09:00-18:59 UTC carry no events in this export");
    assert.match(i.detail, /09:00-19:00/);
    assert.doesNotMatch(i.detail, /generated/);
  });

  it("describes what actually happens to a shared workspace", () => {
    const i = issue("shared_workspaces");
    assert.doesNotMatch(i.resolution, /majority event count/);
  });
});

describe("filter input from the URL", () => {
  it("falls back to the default sort instead of producing broken SQL", () => {
    assert.equal(parseSort("nonsense"), "priority");
    assert.equal(parseSort(undefined), "priority");
    assert.equal(parseSort(""), "priority");
    assert.equal(parseSort("score"), "score");
    for (const k of SORT_KEYS) assert.equal(parseSort(k), k);
  });

  it("serves a list for an unknown sort rather than throwing", () => {
    const fallback = listAccounts({ sort: "'; DROP TABLE accounts; --" as SortKey });
    const expected = listAccounts({ sort: "priority" });
    assert.equal(fallback.length, expected.length);
    assert.deepEqual(
      fallback.map((a) => a.slug),
      expected.map((a) => a.slug),
    );
  });
});

describe("what the database holds matches what the model computed", () => {
  before(() => {
    assert.ok(
      fs.existsSync(DB_PATH),
      "run `npm run ingest` before the tests - `npm test` does it for you",
    );
  });

  it("re-derives ARR at risk from SQL alone", () => {
    const db = new DatabaseSync(DB_PATH, { readOnly: true });
    const row = db
      .prepare(
        `SELECT SUM(a.arr_usd) AS arr, COUNT(*) AS n
         FROM accounts a JOIN account_health h ON h.account_slug = a.slug
         WHERE h.tier = 'At Risk'`,
      )
      .get() as { arr: number; n: number };
    db.close();

    assert.equal(row.n, kpis.tierCounts["At Risk"]);
    assert.equal(row.arr, kpis.arrAtRisk);
  });

  it("stores every event and every account, with no rows invented or lost", () => {
    const db = new DatabaseSync(DB_PATH, { readOnly: true });
    const counts = db
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM events) AS events,
           (SELECT COUNT(*) FROM accounts) AS accounts,
           (SELECT COUNT(*) FROM account_health) AS health,
           (SELECT COUNT(DISTINCT user_id) FROM events) AS users,
           (SELECT COUNT(DISTINCT workspace_id) FROM events) AS workspaces`,
      )
      .get() as Record<string, number>;
    db.close();

    assert.equal(counts.events, 480);
    assert.equal(counts.accounts, 25);
    assert.equal(counts.health, 25, "every account must carry a verdict");
    assert.equal(counts.users, 186);
    assert.equal(counts.workspaces, 28);
  });

  it("agrees with the model on every account's tier and score", () => {
    const db = new DatabaseSync(DB_PATH, { readOnly: true });
    const rows = db
      .prepare(`SELECT account_slug, tier, score FROM account_health`)
      .all() as { account_slug: string; tier: string; score: number }[];
    db.close();

    assert.equal(rows.length, summaries.length);
    for (const row of rows) {
      const s = get(row.account_slug);
      assert.equal(row.tier, s.health.tier, `${row.account_slug}: stored tier drifted`);
      assert.equal(row.score, s.health.score, `${row.account_slug}: stored score drifted`);
    }
  });
});
