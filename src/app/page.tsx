import Link from "next/link";
import { Shell } from "@/components/shell";
import { Card, CardHead, Sparkline, TierChip, initialsOf, money } from "@/components/primitives";
import { listAccounts, getPortfolioKpis, getRawData, type AccountFilters, type AccountListRow } from "@/lib/db";
import { TIER_STYLE } from "@/lib/ui";
import { TIER_THRESHOLDS, SEVERITY_RULES } from "@/lib/config";
import { quantile } from "@/lib/risks";
import { scoresThirtyDaysAgo } from "@/lib/history";
import type { HealthTier } from "@/lib/types";

export const metadata = { title: "Book of business · Account Health" };

type SortKey = NonNullable<AccountFilters["sort"]>;

const COLUMNS: { key: SortKey | null; label: string; right?: boolean; dir: "asc" | "desc" }[] = [
  { key: "name", label: "Account", dir: "asc" },
  { key: "score", label: "Health", dir: "asc" },
  { key: null, label: "30d", dir: "asc" },
  { key: "arr", label: "ARR", right: true, dir: "desc" },
  { key: null, label: "Plan", dir: "asc" },
  { key: null, label: "CSM", dir: "asc" },
  { key: null, label: "Signal to act on", dir: "asc" },
];

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

function Delta({ value, className = "" }: { value: number | null; className?: string }) {
  if (value === null) return <span className="text-ink-3">—</span>;
  const tone = value > 0 ? "text-good-ink" : value < 0 ? "text-crit-ink" : "text-ink-3";
  const sign = value > 0 ? "+" : value < 0 ? "−" : "±";
  return (
    <span className={`num font-medium ${tone} ${className}`}>
      {sign}
      {Math.abs(value)}
    </span>
  );
}

export default async function OverviewPage({ searchParams }: PageProps<"/">) {
  const sp = await searchParams;
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

  const tier = one(sp.tier) as HealthTier | undefined;
  const plan = one(sp.plan);
  const csm = one(sp.csm);
  const q = one(sp.q);
  const sort = (one(sp.sort) as SortKey | undefined) ?? "priority";

  const summary = getPortfolioKpis();
  const rows = listAccounts({ tier, plan, csm, search: q, sort });
  const all = listAccounts({});

  // Per-tier ARR, computed from the full list rather than derived from the
  // KPI totals, so it stays correct even if an account ever lands in No Data.
  const arrByTier: Record<HealthTier, number> = { Healthy: 0, Watch: 0, "At Risk": 0, "No Data": 0 };
  for (const a of all) arrByTier[a.tier] += a.arrUsd;

  // The same top-quartile ARR cut the severity model uses (config.ts /
  // risks.ts), so "which accounts are big enough to flag here" is the exact
  // same line the risk engine already draws - not a second opinion.
  const highValueArr = quantile(all.map((a) => a.arrUsd), SEVERITY_RULES.highValueQuantile);
  const bigBelowHealthy = all.filter((a) => a.tier !== "Healthy" && a.arrUsd >= highValueArr);

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
  const movers = all
    .map((a) => ({ a, delta: deltaOf(a) }))
    .filter((m): m is { a: AccountListRow; delta: number } => m.delta !== null)
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
      <div className="mb-3 grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Card className="flex flex-col gap-2 px-4 pb-[13px] pt-[14px]">
          <span className="text-[11.5px] text-ink-2">ARR below Healthy</span>
          <span className="flex items-end gap-[9px]">
            <span className="text-[44px] font-semibold leading-none tracking-[-0.02em]">
              {money(summary.arrAtRisk + summary.arrWatch)}
            </span>
            <span className="pb-[2px] text-[12px] text-ink-3">of {money(summary.totalArr)}</span>
          </span>
          <span className="text-[11.5px] text-ink-3">
            {Math.round(((summary.arrAtRisk + summary.arrWatch) / Math.max(1, summary.totalArr)) * 100)}%
            of book value · {money(summary.arrAtRisk)} of it at risk
          </span>
        </Card>

        <Card className="flex flex-col gap-2 px-4 pb-[13px] pt-[14px]">
          <span className="text-[11.5px] text-ink-2">Accounts needing attention</span>
          <span className="flex items-end gap-[9px]">
            <span className="text-[28px] font-semibold leading-none tracking-[-0.02em]">
              {summary.tierCounts["At Risk"] + summary.tierCounts.Watch}
            </span>
            <span className="pb-[2px] text-[12px] text-ink-3">of {summary.accounts} accounts</span>
          </span>
          <span className="flex flex-wrap items-center gap-[6px] text-[11.5px] text-ink-3">
            <TierChip tier="At Risk" suffix={String(summary.tierCounts["At Risk"])} />
            <TierChip tier="Watch" suffix={String(summary.tierCounts.Watch)} />
          </span>
        </Card>

        <Card className="flex flex-col gap-2 px-4 pb-[13px] pt-[14px]">
          <span className="text-[11.5px] text-ink-2">Median health score</span>
          <span className="flex items-end gap-[9px]">
            <span className="text-[28px] font-semibold leading-none tracking-[-0.02em]">
              {summary.medianScore}
            </span>
            <span className="pb-[2px] text-[12px] text-ink-3">/ 100</span>
          </span>
          <span className="text-[11.5px] text-ink-3">Across every scored account</span>
        </Card>

        <Card className="flex flex-col gap-2 px-4 pb-[13px] pt-[14px]">
          <span className="text-[11.5px] text-ink-2">No Data</span>
          <span className="flex items-end gap-[9px]">
            <span className="text-[28px] font-semibold leading-none tracking-[-0.02em]">
              {summary.tierCounts["No Data"]}
            </span>
            <span className="pb-[2px] text-[12px] text-ink-3">no events received</span>
          </span>
          <span className="text-[11.5px] text-ink-3">
            Never scored 0 — an account we cannot see is a different problem
          </span>
        </Card>
      </div>

      {/* ---------- distribution + movers ---------- */}
      <div className="mb-3 grid grid-cols-1 items-start gap-3 xl:grid-cols-[1.25fr_1fr]">
        <Card>
          <CardHead title="Health distribution" hint={`${summary.accounts} accounts`} />
          <div className="px-4 pb-4 pt-[14px]">
            <div className="my-[14px] flex h-[34px] gap-[2px]">
              {distribution
                .filter((d) => summary.tierCounts[d.tier] > 0)
                .map((d) => (
                  <Link
                    key={d.tier}
                    href={`/?tier=${encodeURIComponent(d.tier)}`}
                    title={`${d.label}: ${summary.tierCounts[d.tier]} accounts · ${money(arrByTier[d.tier])}`}
                    className="grid place-items-center rounded-[3px] no-underline transition hover:brightness-105"
                    style={{
                      flex: `${summary.tierCounts[d.tier]} ${summary.tierCounts[d.tier]} 0`,
                      background: TIER_STYLE[d.tier].mark,
                    }}
                  >
                    <span
                      className="num text-[11.5px] font-semibold text-white"
                      style={{ textShadow: "0 0 2px rgba(0,0,0,0.25)" }}
                    >
                      {summary.tierCounts[d.tier]}
                    </span>
                  </Link>
                ))}
            </div>
            <div className="flex flex-wrap gap-x-4 gap-y-1">
              {distribution.map((d) => (
                <span key={d.tier} className="flex items-center gap-[7px] text-[12px] text-ink-2">
                  <i
                    className="h-[9px] w-[9px] shrink-0 rounded-[2.5px]"
                    style={{ background: TIER_STYLE[d.tier].mark }}
                  />
                  {d.label} <b className="num font-medium text-ink">{summary.tierCounts[d.tier]}</b>
                  <span className="num text-ink-3">{money(arrByTier[d.tier])}</span>
                </span>
              ))}
            </div>
            <div className="mt-[13px] flex flex-wrap gap-x-4 gap-y-[3px] border-t border-hairline pt-[11px] text-[11.5px] text-ink-3">
              <span>
                Bands: <b className="num font-medium text-ink-2">Healthy ≥ {TIER_THRESHOLDS.healthy}</b>
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
                No Data — <b className="font-medium text-ink-2">held out</b>, never scored 0
              </span>
            </div>
          </div>
        </Card>

        <Card>
          <CardHead title="Biggest drops" hint="30-day score change" />
          <div className="px-2 pb-[10px] pt-3">
            {movers.length === 0 ? (
              <p className="px-2 py-6 text-center text-[12.5px] text-ink-3">
                No account has 30 days of prior history yet.
              </p>
            ) : (
              movers.map(({ a, delta }) => (
                <Link
                  key={a.slug}
                  href={`/accounts/${a.slug}`}
                  className="grid grid-cols-[1fr_auto_auto] items-center gap-[10px] rounded-[7px] px-2 py-[7px] no-underline hover:bg-inset"
                >
                  <span className="min-w-0">
                    <span className="block truncate text-[12.5px] font-medium text-ink">
                      {a.companyName}
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
        <CardHead title="Triage queue" hint={`${rows.length} of ${summary.accounts} accounts · priority first`} />
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
      </Card>

      {bigBelowHealthy.length > 0 && (
        <p className="mt-[14px] flex items-start gap-2 text-[11.5px] text-ink-3">
          <span aria-hidden="true">◆</span>
          <span>
            <b className="font-medium text-ink">
              {bigBelowHealthy.length} accounts over {money(highValueArr)} ARR
            </b>{" "}
            (this book&rsquo;s own top-quartile cut — the same one severity uses) are below Healthy:{" "}
            {bigBelowHealthy.map((a) => `${a.companyName} (${money(a.arrUsd)})`).join(", ")}. These are
            where a CSM hour returns the most.
          </span>
        </p>
      )}
    </Shell>
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
              {a.lowConfidence && (
                <span
                  className="inline-flex h-[15px] shrink-0 items-center rounded-[4px] border border-hairline-strong px-1 text-[10px]"
                  title="Too few events in the window to characterise this account with confidence"
                >
                  low volume
                </span>
              )}
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
        </span>
      </td>

      <td className="border-b border-hairline px-3 py-[9px] align-middle">
        {a.tier === "No Data" ? (
          <span className="text-ink-3">—</span>
        ) : (
          <span className="flex items-center gap-2">
            <Sparkline weekly={a.sparkline} tier={a.tier} />
            <Delta value={delta} className="text-[11.5px]" />
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
