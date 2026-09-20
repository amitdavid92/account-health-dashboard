/**
 * The pipeline entry point: raw JSON -> SQLite, with a readable report.
 *
 *   npm run ingest
 *
 * The report it prints is not decoration. It is the artefact that proves which
 * data-quality checks ran and what they found, including the ones that came
 * back clean - which is the difference between "the data is fine" and "I did
 * not look".
 */

import fs from "node:fs";
import path from "node:path";

import { normalize } from "../src/lib/normalize";
import { buildPortfolioKpis, buildSummaries } from "../src/lib/pipeline";
import { writeDatabase, DB_PATH } from "../src/lib/db";
import { TREND } from "../src/lib/config";
import { computeTrend } from "../src/lib/metrics";
import type { RawAccount, RawEvent } from "../src/lib/types";

const DATA_DIR = path.join(process.cwd(), "data");

const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;

function readJson<T>(file: string): T {
  const full = path.join(DATA_DIR, file);
  if (!fs.existsSync(full)) {
    throw new Error(`Missing ${full}. Copy the provided export into ./data first.`);
  }
  return JSON.parse(fs.readFileSync(full, "utf8")) as T;
}

function rule(title: string) {
  console.log(`\n${bold(title)}\n${dim("─".repeat(78))}`);
}

function main() {
  const t0 = Date.now();

  const rawAccounts = readJson<RawAccount[]>("accounts.json");
  const rawEvents = readJson<RawEvent[]>("usage_events.json");

  const { accounts, events, snapshotMs, quality } = normalize(rawAccounts, rawEvents);
  const summaries = buildSummaries(accounts, events, snapshotMs);
  const kpis = buildPortfolioKpis(summaries, snapshotMs);

  writeDatabase({ summaries, events, quality, kpis });

  // -- Report ---------------------------------------------------------------

  rule("DATASET");
  const t = quality.totals;
  console.log(
    [
      `Accounts              ${t.accounts}`,
      `Events kept           ${t.events}${t.eventsDropped ? red(`  (${t.eventsDropped} dropped)`) : green("  (0 dropped)")}`,
      `Workspaces            ${t.workspaces}`,
      `Distinct users        ${t.users}`,
      `Window                ${t.windowStart.slice(0, 10)} → ${t.windowEnd.slice(0, 10)}  (${t.windowDays} days)`,
      `Snapshot ("today")    ${kpis.snapshotDate}  ${dim("— pinned to the latest event, never wall-clock")}`,
    ].join("\n"),
  );

  rule("DATA QUALITY");
  for (const issue of quality.issues) {
    const mark =
      issue.severity === "error" ? red("✗") : issue.severity === "warning" ? yellow("!") : green("✓");
    const count = issue.count > 0 ? ` ${bold(String(issue.count))}` : "";
    console.log(`${mark} ${issue.title}${count}`);
    console.log(`  ${dim(issue.detail)}`);
    console.log(`  ${dim(`→ ${issue.resolution}`)}`);
  }

  rule("HEALTH DISTRIBUTION");
  const money = (n: number) => `$${n.toLocaleString("en-US")}`;
  for (const tier of ["Healthy", "Watch", "At Risk", "No Data"] as const) {
    const group = summaries.filter((s) => s.health.tier === tier);
    if (!group.length && tier === "No Data") continue;
    const arr = group.reduce((sum, s) => sum + s.account.arrUsd, 0);
    console.log(
      `${tier.padEnd(9)} ${String(group.length).padStart(2)} accounts   ${money(arr).padStart(12)}`,
    );
  }
  console.log(
    `\n${bold("ARR at risk")}        ${money(kpis.arrAtRisk)}  (${Math.round(kpis.arrAtRiskPct * 100)}% of ${money(kpis.totalArr)})`,
  );

  rule("ACCOUNTS BY PRIORITY");
  console.log(
    dim(
      "company".padEnd(24) +
        "plan".padEnd(11) +
        "arr".padStart(9) +
        "score".padStart(7) +
        "  tier".padEnd(11) +
        "silent".padStart(7) +
        "  top risk",
    ),
  );
  for (const s of summaries) {
    const m = s.metrics;
    const tierColour =
      s.health.tier === "At Risk" ? red : s.health.tier === "Watch" ? yellow : green;
    console.log(
      s.account.companyName.slice(0, 23).padEnd(24) +
        s.account.planTier.padEnd(11) +
        money(s.account.arrUsd).padStart(9) +
        String(s.health.score).padStart(7) +
        "  " +
        tierColour(s.health.tier.padEnd(9)) +
        String(m.daysSinceLastEvent ?? "-").padStart(7) +
        "  " +
        (s.topRisk ? `${s.topRisk.severity}: ${s.topRisk.title}` : dim("—")) +
        (s.health.lowConfidence ? dim("  [low confidence]") : ""),
    );
  }

  rule("TREND GATE");
  const reportable = summaries.filter((s) => computeTrend(s.metrics, TREND.minEvents, TREND.minChange).reportable);
  console.log(
    dim(
      `Trend is computed for every account and reported for ${reportable.length} of ${summaries.length}.\n` +
        `Gate: at least ${TREND.minEvents} events in the window and a change of at least ${Math.round(TREND.minChange * 100)}%.\n` +
        `Below that, a 30-day comparison on a handful of events measures noise, not the customer.`,
    ),
  );
  for (const s of reportable) {
    const tr = computeTrend(s.metrics, TREND.minEvents, TREND.minChange);
    const arrow = tr.direction === "down" ? red("▼") : green("▲");
    console.log(
      `  ${arrow} ${s.account.companyName.padEnd(24)} ${Math.round((tr.changePct ?? 0) * 100)
        .toString()
        .padStart(5)}%   ${s.metrics.eventsRecent} events in last 30d vs ${s.metrics.eventsPriorPer30.toFixed(1)} per 30d before`,
    );
  }

  rule("OUTPUT");
  console.log(`SQLite written to ${path.relative(process.cwd(), DB_PATH)}`);
  console.log(dim(`Inspect it directly:  sqlite3 ${path.relative(process.cwd(), DB_PATH)}`));
  console.log(dim(`Completed in ${Date.now() - t0}ms`));
}

main();
