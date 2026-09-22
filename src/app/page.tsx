import Link from "next/link";
import { Shell } from "@/components/shell";
import { Card, CardHead, Disclosure, FlagGlyph, FlaggedChip, Sparkline, TierChip, initialsOf, money } from "@/components/primitives";
import {
  listAccounts,
  getRawData,
  parseSort,
  type AccountListRow,
  type SortKey,
} from "@/lib/db";
import { TIER_STYLE } from "@/lib/ui";
import { PRIORITY_RISK_FLOOR, TIER_THRESHOLDS, SEVERITY_RULES, WINDOW } from "@/lib/config";
import { median } from "@/lib/pipeline";
import { quantile } from "@/lib/risks";
import { scoresThirtyDaysAgo } from "@/lib/history";
import type { HealthTier, RiskSeverity } from "@/lib/types";

export const metadata = { title: "Book of business · Account Health" };


const COLUMNS: {
  key: SortKey | null;
  label: string;
  sub?: string;
  right?: boolean;
  dir: "asc" | "desc";
}[] = [
  { key: "name", label: "Account", dir: "asc" },
  { key: "score", label: "Health", dir: "asc" },
  // Two stacked lines rather than one long one: the cell holds two different
  // measures and both get named, without widening the column.
  { key: null, label: "Activity 13w", sub: "Score Δ 30d", dir: "asc" },
  { key: "arr", label: "ARR", right: true, dir: "desc" },
  { key: null, label: "Plan", dir: "asc" },
  { key: null, label: "CSM", dir: "asc" },
  { key: null, label: "Signal to act on", dir: "asc" },
];

/**
 * Portfolio-shaped totals, re-derived from whatever set of accounts is
 * actually on screen.
 *
 * Everything on this page used to read `getPortfolioKpis()` - a single JSON
 * blob computed once at ingest over the *whole* book - regardless of which
 * tier, plan, CSM or search filter was active. That made the stat tiles,
 * both distribution bars and Biggest drops silently describe a different set
 * of accounts than the table directly below them: filter to Pro-only and the
 * "$503K of $1.49M" tile kept quoting the entire portfolio.
 *
 * This mirrors buildPortfolioKpis in pipeline.ts field for field (down to
 * importing the same `median` helper so the two can never disagree), but
 * runs over the flat, already-filtered `AccountListRow[]` the page already
 * has in hand, so no health, tier or risk computation is touched - it is
 * exactly the same aggregation `arrByTier` below already did inline, just
 * organised into one place instead of scattered per tile.
 */
/**
 * Same rule as pipeline.ts's needsAttention(tier, risks): a Healthy account
 * still counts if its worst risk clears the priority floor. topRisk is
 * already that worst risk - risks.ts sorts by severity before storing it -
 * so this is the identical check, just read off the flat row instead of a
 * full Risk[] array.
 *
 * Exposed as its own function (not just inlined in summariseView's loop) so
 * a single row can ask the same question about itself - the KPI tile's count
 * and the flag icons visible in the table can then never disagree, because
 * both call this.
 */
function isHealthyButFlagged(a: AccountListRow): boolean {
  if (a.tier !== "Healthy") return false;
  const floor = a.topRisk ? (PRIORITY_RISK_FLOOR[a.topRisk.severity as RiskSeverity] ?? 0) : 0;
  return floor > 0;
}

function summariseView(rows: AccountListRow[]) {
  const tierCounts: Record<HealthTier, number> = { Healthy: 0, Watch: 0, "At Risk": 0, "No Data": 0 };
  const arrByTier: Record<HealthTier, number> = { Healthy: 0, Watch: 0, "At Risk": 0, "No Data": 0 };
  let totalArr = 0;
  let arrAtRisk = 0;
  let arrWatch = 0;
  let accountsNeedingAttention = 0;
  let healthyNeedingReview = 0;

  for (const a of rows) {
    tierCounts[a.tier] += 1;
    arrByTier[a.tier] += a.arrUsd;
    totalArr += a.arrUsd;
    if (a.tier === "At Risk") arrAtRisk += a.arrUsd;
    if (a.tier === "Watch") arrWatch += a.arrUsd;

    // Everything below Healthy counts on its own; a Healthy account counts
    // too if isHealthyButFlagged says so.
    if (a.tier !== "Healthy" || isHealthyButFlagged(a)) {
      accountsNeedingAttention += 1;
      if (a.tier === "Healthy") healthyNeedingReview += 1;
    }
  }

  return {
    accounts: rows.length,
    totalArr,
    arrAtRisk,
    arrWatch,
    tierCounts,
    arrByTier,
    accountsNeedingAttention,
    healthyNeedingReview,
    medianScore: median(rows.filter((a) => a.tier !== "No Data").map((a) => a.score)),
  };
}

function sortHref(sp: Record<string, string | string[] | undefined>, key: SortKey) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(sp)) {
    if (k === "sort") continue;
    if (typeof v === "string") p.set(k, v);
    else if (Array.isArray(v)) v.forEach((x) => p.append(k, x));
  }
  p.set("sort", key);
  return `/?${p.toString()}`;
}

/** Shared by the triage table and Biggest drops, so the same caveat reads the
 *  same way in both places. Text, not colour alone - and never only a tooltip. */
function LowVolumeBadge() {
  return (
    <span
      className="inline-flex h-[15px] shrink-0 items-center rounded-[4px] border border-hairline-strong px-1 text-[10px] text-ink-3"
      title="Too few events in the window to characterise this account with confidence"
    >
      low volume
    </span>
  );
}

function Delta({
  value,
  className = "",
  title,
}: {
  value: number | null;
  className?: string;
  title?: string;
}) {
  if (value === null) return <span className="text-ink-3">—</span>;
  const tone = value > 0 ? "text-good-ink" : value < 0 ? "text-crit-ink" : "text-ink-3";
  const sign = value > 0 ? "+" : value < 0 ? "−" : "±";
  return (
    <span title={title} className={`num font-medium ${tone} ${className}`}>
      {sign}
      {Math.abs(value)}
    </span>
  );
}

export default async function OverviewPage({ searchParams }: PageProps<"/">) {
  const sp = await searchParams;
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

  const tier = one(sp.tier) as HealthTier | undefined;
  const plan = Array.isArray(sp.plan) ? sp.plan : sp.plan ? [sp.plan] : [];
  const csm = one(sp.csm);
  const q = one(sp.q);
  const sort = parseSort(one(sp.sort));

  const rows = listAccounts({ tier, plan, csm, search: q, sort });
  // The unfiltered book, kept for exactly two things that must NOT track the
  // active filters: the "X of N total" denominator on the triage queue, and
  // the high-value ARR threshold just below. That threshold is the same
  // top-quartile cut risks.ts baked into every account's severity at ingest
  // time (SEVERITY_RULES.highValueQuantile, computed once over the whole
  // book) - recomputing it from a filtered subset would silently redefine
  // "high value" away from what each risk's own "+1 for top-quartile ARR"
  // escalation already used, which would be a second, disagreeing threshold.
  const all = listAccounts({});

  // Everything else on this page - the stat tiles, both distribution bars,
  // Biggest drops - is derived from `rows`, the same filtered set the table
  // below shows. See summariseView's own comment for why.
  const view = summariseView(rows);

  const highValueArr = quantile(all.map((a) => a.arrUsd), SEVERITY_RULES.highValueQuantile);
  const bigBelowHealthy = rows.filter((a) => a.tier !== "Healthy" && a.arrUsd >= highValueArr);

  // "Score 30 days ago": re-run the same pure pipeline on an earlier
  // snapshot (history.ts) rather than storing any history. See that file.
  const raw = getRawData();
  const prior = scoresThirtyDaysAgo(raw.accounts, raw.events, raw.snapshotMs);
  const deltaOf = (a: AccountListRow): number | null => {
    const before = prior.get(a.slug);
    return before === null || before === undefined || a.tier === "No Data"
      ? null
      : a.score - before;
  };
  // Drops only, and only among the currently filtered accounts - a card
  // headed "Biggest drops" that lists a +6 because nothing fell, or that
  // shows a drop excluded by the active plan filter, is misleading either way.
  const movers = rows
    .map((a) => ({ a, delta: deltaOf(a) }))
    .filter((m): m is { a: AccountListRow; delta: number } => m.delta !== null && m.delta < 0)
    .sort((x, y) => x.delta - y.delta)
    .slice(0, 5);

  const distribution: { tier: HealthTier; label: string }[] = [
    { tier: "At Risk", label: "At Risk" },
    { tier: "Watch", label: "Watch" },
    { tier: "Healthy", label: "Healthy" },
    { tier: "No Data", label: "No Data" },
  ];

  return (
    <Shell title="Book of business" activeTier={tier ?? null} plan={plan} csm={csm} q={q}>
      {/* ---------- stat tiles ---------- */}
      <div className="mb-[10px] grid grid-cols-1 gap-[10px] sm:grid-cols-2 xl:grid-cols-4">
        <Card className="flex flex-col gap-[6px] px-4 pb-[10px] pt-[11px]">
          <span className="text-[11.5px] text-ink-2">ARR below Healthy</span>
          <span className="flex items-end gap-[9px]">
            <span className="text-[44px] font-semibold leading-none tracking-[-0.02em]">
              {money(view.arrAtRisk + view.arrWatch)}
            </span>
            <span className="pb-[2px] text-[12px] text-ink-3">of {money(view.totalArr)}</span>
          </span>
          <span className="text-[11.5px] text-ink-3">
            {Math.round(((view.arrAtRisk + view.arrWatch) / Math.max(1, view.totalArr)) * 100)}%
            of book value · {money(view.arrAtRisk)} of it at risk
          </span>
        </Card>

        {/* Counted per account, not per reason: everything below Healthy
            (No Data included - an account we cannot see needs a pipeline
            question answered), plus Healthy accounts carrying a High or
            Critical flag. An account qualifying twice is still one call. */}
        <Card className="flex flex-col gap-[6px] px-4 pb-[10px] pt-[11px]">
          <span className="text-[11.5px] text-ink-2">Accounts needing attention</span>
          <span className="flex items-end gap-[9px]">
            <span className="text-[28px] font-semibold leading-none tracking-[-0.02em]">
              {view.accountsNeedingAttention}
            </span>
            <span className="pb-[2px] text-[12px] text-ink-3">of {view.accounts} accounts</span>
          </span>
          <span className="flex flex-wrap items-center gap-[6px] text-[11.5px] text-ink-3">
            <TierChip tier="At Risk" suffix={String(view.tierCounts["At Risk"])} />
            <TierChip tier="Watch" suffix={String(view.tierCounts.Watch)} />
            {view.tierCounts["No Data"] > 0 && (
              <TierChip tier="No Data" suffix={String(view.tierCounts["No Data"])} />
            )}
            {view.healthyNeedingReview > 0 && <FlaggedChip count={view.healthyNeedingReview} />}
          </span>
        </Card>

        <Card className="flex flex-col gap-[6px] px-4 pb-[10px] pt-[11px]">
          <span className="text-[11.5px] text-ink-2">Median health score</span>
          <span className="flex items-end gap-[9px]">
            <span className="text-[28px] font-semibold leading-none tracking-[-0.02em]">
              {view.medianScore}
            </span>
            <span className="pb-[2px] text-[12px] text-ink-3">/ 100</span>
          </span>
          <span className="text-[11.5px] text-ink-3">Across every scored account shown</span>
        </Card>

        <Card className="flex flex-col gap-[6px] px-4 pb-[10px] pt-[11px]">
          <span className="text-[11.5px] text-ink-2">No Data</span>
          <span className="flex items-end gap-[9px]">
            <span className="text-[28px] font-semibold leading-none tracking-[-0.02em]">
              {view.tierCounts["No Data"]}
            </span>
            <span className="pb-[2px] text-[12px] text-ink-3">no events received</span>
          </span>
          <span className="text-[11.5px] text-ink-3">Accounts without usage data</span>
          <Disclosure label="What to check">
            No events could mean the customer stopped, or that their data isn&rsquo;t reaching us - a
            broken export or an unmapped workspace. Those need opposite responses, so check data
            coverage before treating this as a churn signal.
          </Disclosure>
        </Card>
      </div>

      {/* ---------- distribution + movers ---------- */}
      <div className="mb-3 grid grid-cols-1 gap-3 xl:grid-cols-[1.25fr_1fr]">
        <Card className="flex flex-col">
          <CardHead
            title="Health distribution"
            hint={`${view.accounts} accounts · ${money(view.totalArr)}`}
          />
          <div className="flex flex-1 flex-col px-4 pb-4 pt-[14px]">
            {/* The same four tiers measured two ways. The bars are meant to
                disagree: most of the count sits in Healthy, and a quarter of
                the money does not - that gap is the argument for keeping
                health and priority on separate axes. */}
            <DistributionBar
              label="By account"
              hint={`${view.accounts} accounts`}
              segments={distribution.map((d) => ({
                tier: d.tier,
                value: view.tierCounts[d.tier],
                text: String(view.tierCounts[d.tier]),
                title: `${d.label}: ${view.tierCounts[d.tier]} accounts · ${money(view.arrByTier[d.tier])}`,
              }))}
            />
            <DistributionBar
              label="By ARR"
              hint={money(view.totalArr)}
              segments={distribution.map((d) => ({
                tier: d.tier,
                value: view.arrByTier[d.tier],
                text: money(view.arrByTier[d.tier]),
                title: `${d.label}: ${money(view.arrByTier[d.tier])} · ${view.tierCounts[d.tier]} accounts`,
              }))}
            />
            <div className="mb-[13px] mt-[15px] flex flex-wrap gap-x-4 gap-y-1">
              {distribution.map((d) => (
                <span key={d.tier} className="flex items-center gap-[7px] text-[12px] text-ink-2">
                  <i
                    className="h-[9px] w-[9px] shrink-0 rounded-[2.5px]"
                    style={{ background: TIER_STYLE[d.tier].mark }}
                  />
                  {d.label} <b className="num font-medium text-ink">{view.tierCounts[d.tier]}</b>
                  <span className="num text-ink-3">{money(view.arrByTier[d.tier])}</span>
                </span>
              ))}
            </div>
            <div className="mt-auto border-t border-hairline pt-[4px]">
              <Disclosure label="Scoring rules">
                <span className="flex flex-wrap gap-x-4 gap-y-[3px]">
                  <span>
                    <b className="num font-medium text-ink-2">Healthy ≥ {TIER_THRESHOLDS.healthy}</b>
                  </span>
                  <span>
                    <b className="num font-medium text-ink-2">
                      Watch {TIER_THRESHOLDS.watch}–{TIER_THRESHOLDS.healthy - 1}
                    </b>
                  </span>
                  <span>
                    <b className="num font-medium text-ink-2">At risk &lt; {TIER_THRESHOLDS.watch}</b>
                  </span>
                  <span>
                    No Data — <b className="font-medium text-ink-2">no usage received</b>
                  </span>
                </span>
                <p className="mt-[6px]">
                  Scored out of 100 from product usage only — ARR and plan are never inputs. Full
                  bands, caps and thresholds: <Link href="/method">how health is scored</Link>.
                </p>
              </Disclosure>
            </div>
          </div>
        </Card>

        <Card>
          <CardHead title="Biggest drops" hint="30-day score change · reconstructed" />
          <div className="px-2 pb-[10px] pt-3">
            {movers.length === 0 ? (
              <p className="px-2 py-6 text-center text-[12.5px] text-ink-3">
                No account scores lower than it did 30 days ago.
                <br />
                <span className="text-[11.5px]">
                  Comparison is reconstructed from this export, not stored history.
                </span>
              </p>
            ) : (
              movers.map(({ a, delta }) => (
                <Link
                  key={a.slug}
                  href={`/accounts/${a.slug}`}
                  className="grid grid-cols-[1fr_auto_auto] items-center gap-[10px] rounded-[7px] px-2 py-[7px] no-underline hover:bg-inset"
                >
                  <span className="min-w-0">
                    <span className="flex min-w-0 items-center gap-[6px]">
                      <span className="truncate text-[12.5px] font-medium text-ink">
                        {a.companyName}
                      </span>
                      {/* Its own chip rather than trailing text, so the row's
                          truncate can never eat the caveat. */}
                      {a.lowConfidence && <LowVolumeBadge />}
                    </span>
                    <span className="block truncate text-[11px] text-ink-3">
                      {a.planTier} · {money(a.arrUsd)} · {a.csmOwner}
                    </span>
                  </span>
                  <Sparkline weekly={a.sparkline} tier={a.tier} width={74} height={22} />
                  <Delta value={delta} className="min-w-[34px] text-right text-[12.5px]" />
                </Link>
              ))
            )}
          </div>
        </Card>
      </div>

      {/* ---------- triage queue ---------- */}
      <Card>
        {/* Denominator is the whole book on purpose - this line tells you how
            much the active filters narrowed things down, which needs the true
            total, not the filtered count everything else on this page uses. */}
        <CardHead title="Triage queue" hint={`${rows.length} of ${all.length} accounts · priority first`} />
        <div className="mt-2 overflow-x-auto">
          {rows.length === 0 ? (
            <p className="px-4 py-10 text-center text-[13px] text-ink-3">
              No accounts match these filters.
              <br />
              <span className="text-[12px]">Clear a filter to widen the queue.</span>
            </p>
          ) : (
            <table className="w-full min-w-[940px] border-collapse">
              <thead>
                <tr>
                  {COLUMNS.map((c) => (
                    <th
                      key={c.label}
                      scope="col"
                      className={`whitespace-nowrap border-b border-hairline px-3 py-[10px] text-[11px] font-medium uppercase tracking-[0.05em] text-ink-3 ${
                        c.right ? "text-right" : "text-left"
                      }`}
                    >
                      {c.key ? (
                        <Link href={sortHref(sp, c.key)} className="no-underline hover:text-ink">
                          {c.label}
                          {sort === c.key && (
                            <span className="ml-1 text-[9px] opacity-45">
                              {c.dir === "asc" ? "▲" : "▼"}
                            </span>
                          )}
                        </Link>
                      ) : (
                        c.label
                      )}
                      {c.sub && <span className="block text-ink-3 opacity-80">{c.sub}</span>}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((a) => (
                  <AccountRow key={a.slug} account={a} delta={deltaOf(a)} />
                ))}
              </tbody>
            </table>
          )}
        </div>
        {rows.length > 0 && (
          <div className="border-t border-hairline px-4 py-[4px]">
            <Disclosure label="How to read the activity and score-change column">
              <p>
                The two marks in that column measure different things. The sparkline is weekly event
                volume over {WINDOW.chartWeeks} weeks. The number is the change in the health score
                against 30 days ago, reconstructed by re-running the pipeline over the earlier part
                of this export — no health history is stored.
              </p>
              <p className="mt-[6px]">
                On accounts marked <b className="font-medium text-ink-2">low volume</b> both ends of
                that comparison rest on very little activity, so read the direction rather than the
                size.
              </p>
            </Disclosure>
          </div>
        )}
      </Card>

      {bigBelowHealthy.length > 0 && (
        <p className="mt-[14px] flex items-start gap-2 text-[11.5px] text-ink-3">
          <span aria-hidden="true">◆</span>
          <span>
            <b className="font-medium text-ink">
              {bigBelowHealthy.length} accounts over {money(highValueArr)} ARR
            </b>{" "}
            are below Healthy:{" "}
            {bigBelowHealthy.map((a) => `${a.companyName} (${money(a.arrUsd)})`).join(", ")}. These are
            where a CSM hour returns the most.
          </span>
        </p>
      )}
    </Shell>
  );
}

/**
 * One proportional bar across the four tiers. Each segment links to the same
 * tier filter the sidebar uses, so the bar is navigation as well as a picture.
 */
function DistributionBar({
  label,
  hint,
  segments,
}: {
  label: string;
  hint: string;
  segments: { tier: HealthTier; value: number; text: string; title: string }[];
}) {
  const total = segments.reduce((sum, s) => sum + s.value, 0);

  return (
    <div className="mb-[14px] last:mb-0">
      <div className="mb-[6px] flex items-baseline justify-between gap-3">
        <span className="eyebrow">{label}</span>
        <span className="num text-[11px] text-ink-3">{hint}</span>
      </div>
      <div className="flex h-[30px] gap-[2px]">
        {segments
          .filter((s) => s.value > 0)
          .map((s) => (
            <Link
              key={s.tier}
              href={`/?tier=${encodeURIComponent(s.tier)}`}
              title={s.title}
              className="grid place-items-center overflow-hidden rounded-[3px] no-underline transition hover:brightness-105"
              style={{ flex: `${s.value} ${s.value} 0`, background: TIER_STYLE[s.tier].mark }}
            >
              {/* Below this share the segment is too narrow to hold its own
                  label without clipping. The legend under the bars and the
                  hover title still carry the number. */}
              {s.value / total >= 0.09 && (
                <span
                  className="num text-[11.5px] font-semibold text-white"
                  style={{ textShadow: "0 0 2px rgba(0,0,0,0.25)" }}
                >
                  {s.text}
                </span>
              )}
            </Link>
          ))}
      </div>
    </div>
  );
}

function AccountRow({ account: a, delta }: { account: AccountListRow; delta: number | null }) {
  return (
    <tr className="hover:bg-inset">
      <td className="border-b border-hairline px-3 py-[9px] align-middle">
        <Link href={`/accounts/${a.slug}`} className="flex min-w-0 items-center gap-[9px] no-underline">
          <span className="grid h-[26px] w-[26px] shrink-0 place-items-center rounded-[7px] border border-hairline bg-inset text-[10.5px] font-semibold text-ink-2">
            {initialsOf(a.companyName)}
          </span>
          <span className="min-w-0">
            <span className="block text-[13px] font-medium tracking-[-0.005em] text-ink">
              {a.companyName}
            </span>
            <span className="flex items-center gap-[6px] whitespace-nowrap text-[11px] text-ink-3">
              <span className="truncate">{a.domain}</span>
              {a.workspaceCount > 1 && (
                <span className="inline-flex h-[15px] shrink-0 items-center rounded-[4px] border border-hairline-strong px-1 text-[10px]">
                  {a.workspaceCount} workspaces
                </span>
              )}
              {a.lowConfidence && <LowVolumeBadge />}
            </span>
          </span>
        </Link>
      </td>

      <td className="border-b border-hairline px-3 py-[9px] align-middle">
        <span className="flex items-center gap-[9px]">
          <span
            className={`num min-w-[22px] text-[14px] ${a.tier === "No Data" ? "font-medium text-ink-3" : "font-semibold"}`}
          >
            {a.tier === "No Data" ? "—" : a.score}
          </span>
          <TierChip tier={a.tier} />
          {/* Qualifies the chip right where it sits, rather than trusting a
              reader to scan all the way to Signal to act on: Healthy is a
              usage verdict, and this account still has something a human
              should look at. Same rule the KPI tile's "N flagged" count uses,
              so the two can never disagree. */}
          {isHealthyButFlagged(a) && (
            <span
              className="text-flag-ink"
              title={`${a.topRisk?.title} (${a.topRisk?.severity}) — see Signal to act on`}
            >
              <FlagGlyph />
            </span>
          )}
        </span>
      </td>

      <td className="border-b border-hairline px-3 py-[9px] align-middle">
        {a.tier === "No Data" ? (
          <span className="text-ink-3">—</span>
        ) : (
          <span className="flex items-center gap-2">
            {/* Two different measures side by side - the column header names
                both, and the disclosure under the table explains them. The
                "low volume" badge on the name cell carries the caveat, so it
                is not repeated here. */}
            <span title={`Weekly event volume, last ${WINDOW.chartWeeks} weeks`}>
              <Sparkline weekly={a.sparkline} tier={a.tier} />
            </span>
            <Delta
              value={delta}
              className="text-[11.5px]"
              title={
                a.lowConfidence
                  ? `Health score vs 30 days ago (reconstructed). Only ${a.totalEvents} events in the window — read the direction, not the size.`
                  : "Health score vs 30 days ago (reconstructed from this export)"
              }
            />
          </span>
        )}
      </td>

      <td className="num border-b border-hairline px-3 py-[9px] text-right align-middle font-medium">
        {money(a.arrUsd)}
      </td>
      <td className="border-b border-hairline px-3 py-[9px] align-middle">
        <span className={`text-[11.5px] ${a.planTier === "Enterprise" ? "font-medium text-ink" : "text-ink-2"}`}>
          {a.planTier}
        </span>
      </td>
      <td className="border-b border-hairline px-3 py-[9px] align-middle text-[11.5px] text-ink-2">
        {a.csmOwner}
      </td>
      <td className="border-b border-hairline px-3 py-[9px] align-middle text-[11.5px] text-ink-2">
        {a.topRisk?.title ?? "—"}
      </td>
    </tr>
  );
}
