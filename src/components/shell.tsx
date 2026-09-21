import Link from "next/link";
import { Suspense } from "react";
import { TIER_STYLE, money } from "@/lib/ui";
import { Logo } from "./Logo";
import { DataNotesDrawer, MultiSelectFilter, SearchBox, SelectFilter, ThemeToggle } from "./chrome";
import { ChatAssistant } from "./chat";
import { getFilterOptions, getPortfolioKpis, getQualityReport } from "@/lib/db";
import type { HealthTier } from "@/lib/types";

/** Sidebar order: most urgent first, so the queue a CSM cares about is on top. */
const NAV_TIERS: HealthTier[] = ["At Risk", "Watch", "Healthy", "No Data"];

export function Shell({
  title,
  activeTier,
  plan = [],
  csm,
  q,
  children,
}: {
  title: string;
  activeTier?: HealthTier | null;
  plan?: string[];
  csm?: string;
  q?: string;
  children: React.ReactNode;
}) {
  const summary = getPortfolioKpis();
  const notes = getQualityReport().issues;
  const owners = getFilterOptions().csms;
  const windowDays = getQualityReport().totals?.windowDays ?? 90;

  const qs = (tier: HealthTier | null) => {
    const p = new URLSearchParams();
    if (tier) p.set("tier", tier);
    for (const pl of plan) p.append("plan", pl);
    if (csm && csm !== "all") p.set("csm", csm);
    if (q) p.set("q", q);
    const s = p.toString();
    return s ? `/?${s}` : "/";
  };

  return (
    <div className="flex min-h-full flex-col md:flex-row">
      <aside className="flex shrink-0 gap-[14px] overflow-x-auto border-b border-hairline bg-surface px-4 py-3 md:sticky md:top-0 md:h-screen md:w-[208px] md:flex-col md:gap-[22px] md:overflow-visible md:border-b-0 md:border-r md:px-3 md:py-[18px]">
        <Link href="/" className="flex items-center gap-[9px] px-2 no-underline">
          <Logo size={18} />
          <span className="whitespace-nowrap">
            <span className="block text-[13.5px] font-semibold tracking-[-0.01em] text-ink">
              Account Health
            </span>
            <span className="block text-[10.5px] text-ink-3">CS &amp; Sales · internal</span>
          </span>
        </Link>

        <nav className="flex gap-1 md:flex-col md:gap-px">
          <Link
            href={qs(null)}
            aria-current={!activeTier ? "page" : undefined}
            className={`flex items-center gap-[9px] whitespace-nowrap rounded-[7px] px-[9px] py-[7px] text-[13px] no-underline ${
              !activeTier ? "bg-accent-wash font-medium text-accent-ink" : "text-ink-2 hover:bg-inset hover:text-ink"
            }`}
          >
            <svg width="13" height="13" viewBox="0 0 14 14" aria-hidden="true" className="shrink-0">
              <rect x="1.6" y="2.2" width="10.8" height="2.4" rx="1" fill="currentColor" opacity=".85" />
              <rect x="1.6" y="6" width="10.8" height="2" rx="1" fill="currentColor" opacity=".55" />
              <rect x="1.6" y="9.4" width="10.8" height="2" rx="1" fill="currentColor" opacity=".35" />
            </svg>
            All accounts
            <span className="num ml-auto hidden text-[11px] text-ink-3 md:inline">
              {summary.accounts}
            </span>
          </Link>

          {NAV_TIERS.map((tier) => (
            <Link
              key={tier}
              href={qs(tier)}
              aria-current={activeTier === tier ? "page" : undefined}
              className={`flex items-center gap-[9px] whitespace-nowrap rounded-[7px] px-[9px] py-[7px] text-[13px] no-underline ${
                activeTier === tier
                  ? "bg-accent-wash font-medium text-accent-ink"
                  : "text-ink-2 hover:bg-inset hover:text-ink"
              }`}
            >
              <span
                className="h-[7px] w-[7px] shrink-0 rounded-full"
                style={{ background: TIER_STYLE[tier].mark }}
              />
              {TIER_STYLE[tier].label}
              <span className="num ml-auto hidden text-[11px] text-ink-3 md:inline">
                {summary.tierCounts[tier] ?? 0}
              </span>
            </Link>
          ))}
        </nav>

        <div className="ml-auto flex flex-col gap-[10px] md:ml-0 md:mt-auto md:px-2">
          <span className="hidden w-fit items-center gap-[6px] rounded-[6px] border border-hairline bg-inset px-2 py-[5px] text-[11px] text-ink-2 md:inline-flex">
            {windowDays}-day window
          </span>
          <p className="hidden text-[10.5px] leading-[1.45] text-ink-3 md:block">
            Snapshot {summary.snapshotDate}
            <br />
            {summary.accounts} accounts · {money(summary.totalArr)} ARR
          </p>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header
          className="sticky z-20 flex flex-wrap items-center gap-3 border-b border-hairline bg-canvas px-4 py-3 md:px-6"
          style={{ top: "env(safe-area-inset-top, 0px)" }}
        >
          <h1 className="text-[15px] font-semibold tracking-[-0.01em]">{title}</h1>
          <span className="flex-1" />
          {/* These read the URL, which is not known while a page is being
              prerendered - so they sit behind a boundary sized like the real
              controls, and the layout does not shift when they hydrate. */}
          <Suspense
            fallback={
              <span aria-hidden="true" className="flex gap-3">
                <span className="h-[30px] w-[210px] rounded-[7px] border border-hairline-strong bg-surface" />
                <span className="h-[30px] w-[110px] rounded-[7px] border border-hairline-strong bg-surface" />
                <span className="h-[30px] w-[96px] rounded-[7px] border border-hairline-strong bg-surface" />
              </span>
            }
          >
            <SearchBox initial={q ?? ""} />
            <SelectFilter
              name="csm"
              label="Filter by CSM owner"
              value={csm ?? "all"}
              options={[{ value: "all", label: "All CSMs" }, ...owners.map((o) => ({ value: o, label: o }))]}
            />
            <MultiSelectFilter
              name="plan"
              label="Filter by plan tier"
              values={plan}
              allLabel="All plans"
              options={[
                { value: "Enterprise", label: "Enterprise" },
                { value: "Pro", label: "Pro" },
                { value: "Free", label: "Free" },
              ]}
            />
          </Suspense>
          <DataNotesDrawer notes={notes} />
          <ChatAssistant />
          <ThemeToggle />
        </header>

        <main className="w-full max-w-[1480px] px-4 pb-14 pt-5 md:px-6">{children}</main>
      </div>
    </div>
  );
}
