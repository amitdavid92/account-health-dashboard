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

import { normalize } from "../src/lib/normalize";
import { buildPortfolioKpis, buildSummaries } from "../src/lib/pipeline";
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
      summaries.every((s) => s.health.tier !== "Healthy" || s.priorityScore === 0),
      "a healthy account has nothing to prioritise",
    );
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

  it("does not escalate to Critical on an account it has barely seen", () => {
    for (const s of summaries) {
      if (!s.health.lowConfidence) continue;
      const converged = s.risks.filter((r) =>
        r.escalations.some((e) => e.startsWith("Raised one level:") && e.includes("independent risks")),
      );
      assert.equal(
        converged.length,
        0,
        `${s.account.slug}: convergence must not escalate on thin evidence`,
      );
    }
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
