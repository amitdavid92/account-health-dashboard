/**
 * How health is scored, rendered from the same constants the pipeline uses.
 *
 * This page imports config.ts directly rather than restating it in prose, so
 * the documented model and the computed model cannot drift apart. If someone
 * retunes a band, this page changes with it.
 */

import Link from "next/link";
import {
  BREADTH_BANDS,
  CONSISTENCY_BANDS,
  DEPTH_BANDS,
  DEPTH_CREATED_WEIGHT,
  LOW_CONFIDENCE_MIN_EVENTS,
  OVERRIDES,
  PILLARS,
  RECENCY_BANDS,
  SEVERITY_RULES,
  TIER_THRESHOLDS,
  TREND,
  WINDOW,
  type Band,
} from "@/lib/config";
import { Card, TierChip } from "@/components/primitives";

export const metadata = { title: "How health is scored — Account Health" };

function BandList({ bands, unit, unitOne }: { bands: readonly Band[]; unit: string; unitOne: string }) {
  return (
    <ul className="space-y-0.5 text-[12.5px] text-ink-2">
      {bands.map(([min, points], i) => {
        // Bands run highest-first, so the previous entry's minimum is this
        // band's exclusive upper bound. A band one wide reads as a single
        // number rather than "1-1".
        const upperExclusive = bands[i - 1]?.[0];
        const range =
          upperExclusive === undefined
            ? `${min}+`
            : upperExclusive - min === 1
              ? `${min}`
              : `${min}–${upperExclusive - 1}`;
        return (
          <li key={min} className="flex justify-between gap-4">
            <span className="num">
              {range} {range === "1" ? unitOne : unit}
            </span>
            <span className="num text-ink">{points} pts</span>
          </li>
        );
      })}
    </ul>
  );
}

export default function MethodPage() {
  const pillars = [
    {
      key: "recency" as const,
      bands: (
        <ul className="space-y-0.5 text-[12.5px] text-ink-2">
          {RECENCY_BANDS.map((b) => (
            <li key={b.points} className="flex justify-between gap-4">
              <span className="num">{b.maxDays === Infinity ? "60+" : `≤ ${b.maxDays}`} days</span>
              <span className="num text-ink">{b.points} pts</span>
            </li>
          ))}
        </ul>
      ),
    },
    { key: "breadth" as const, bands: <BandList bands={BREADTH_BANDS} unit="active users" unitOne="active user" /> },
    {
      key: "depth" as const,
      bands: <BandList bands={DEPTH_BANDS} unit="core-value points" unitOne="core-value point" />,
    },
    {
      key: "consistency" as const,
      bands: <BandList bands={CONSISTENCY_BANDS} unit="active weeks" unitOne="active week" />,
    },
  ];

  return (
    <div className="mx-auto max-w-[760px] px-4 py-8 md:px-6">
      <Link href="/" className="mb-4 inline-flex items-center gap-[6px] text-[12.5px] text-ink-2 no-underline hover:text-ink">
        <svg width="13" height="13" viewBox="0 0 14 14" aria-hidden="true">
          <path d="M8.6 2.8 4.4 7l4.2 4.2" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        Portfolio
      </Link>

      <header className="mb-7">
        <h1 className="text-[21px] font-semibold tracking-[-0.015em]">How health is scored</h1>
        <p className="mt-2 text-[13px] leading-[1.6] text-ink-2">
          Health is computed from product usage and nothing else. Four measures, 100 points, and a
          small number of facts that the arithmetic is not allowed to outvote. This page is
          generated from the same constants the pipeline runs on, so it cannot fall out of date.
        </p>
      </header>

      <section className="mb-7">
        <h2 className="mb-3 text-[14px] font-semibold">The four pillars</h2>
        <div className="grid gap-3 sm:grid-cols-2">
          {pillars.map((p) => (
            <Card key={p.key} className="p-4">
              <div className="mb-1 flex items-baseline justify-between">
                <h3 className="text-[13px] font-medium">{PILLARS[p.key].label}</h3>
                <span className="num text-[12px] text-ink-3">{PILLARS[p.key].max} pts</span>
              </div>
              <p className="mb-3 text-[12.5px] leading-[1.55] text-ink-2">{PILLARS[p.key].rationale}</p>
              {p.bands}
            </Card>
          ))}
        </div>
        <p className="mt-2 text-[11.5px] text-ink-3">
          Core-value points = guides created × {DEPTH_CREATED_WEIGHT} + guides shared, measured over
          the last {WINDOW.recentDays} days. Creation is weighted higher because it produces the
          asset; sharing distributes one that already exists.
        </p>
      </section>

      <section className="mb-7">
        <h2 className="mb-3 text-[14px] font-semibold">Tiers</h2>
        <Card className="flex flex-col gap-2 p-4">
          {(
            [
              ["Healthy", `${TIER_THRESHOLDS.healthy} and above`],
              ["Watch", `${TIER_THRESHOLDS.watch} to ${TIER_THRESHOLDS.healthy - 1}`],
              ["At Risk", `below ${TIER_THRESHOLDS.watch}`],
              ["No Data", "no events received at all"],
            ] as const
          ).map(([tier, range]) => (
            <div key={tier} className="flex items-center gap-3 text-[12.5px]">
              <TierChip tier={tier} />
              <span className="num text-ink-2">{range}</span>
            </div>
          ))}
        </Card>
      </section>

      <section className="mb-7">
        <h2 className="mb-1 text-[14px] font-semibold">Facts the score cannot outvote</h2>
        <p className="mb-3 text-[12.5px] leading-[1.6] text-ink-2">
          A weighted sum can always be outvoted by its other terms — an account that is broad,
          consistent and creative can absorb a lost recency pillar and still read Healthy a month
          after it went quiet. These three cap the tier after the arithmetic is done, and each one
          states its own reason on the account page.
        </p>
        <Card className="flex flex-col gap-[10px] p-4 text-[12.5px]">
          <p>
            <strong className="font-medium text-ink">Silent for {OVERRIDES.dormantDays}+ days → At Risk.</strong>{" "}
            <span className="text-ink-2">
              A customer who has not opened the product in a month is at risk regardless of how they
              looked before that.
            </span>
          </p>
          <p>
            <strong className="font-medium text-ink">Never created or shared a guide → cannot be Healthy.</strong>{" "}
            <span className="text-ink-2">
              The account is paying for a guide platform and producing no guides. Login volume does
              not change that.
            </span>
          </p>
          <p>
            <strong className="font-medium text-ink">{OVERRIDES.singleUserMax} or fewer active users → cannot be Healthy.</strong>{" "}
            <span className="text-ink-2">Usage resting on one person is one resignation away from zero.</span>
          </p>
        </Card>
      </section>

      <section className="mb-7">
        <h2 className="mb-1 text-[14px] font-semibold">Trend is computed, shown, and not scored</h2>
        <p className="text-[12.5px] leading-[1.6] text-ink-2">
          The median account in this portfolio produces 19 events in {WINDOW.totalDays} days.
          Comparing 30 days against 30 days on six events measures sampling noise, not customer
          behaviour, and a churn alert that fires on noise destroys a CSM&apos;s trust in the tool
          faster than no alert at all. So the comparison is reported only when the account has at
          least <strong className="font-medium text-ink">{TREND.minEvents} events</strong> in the
          window and the change is at least{" "}
          <strong className="font-medium text-ink">{Math.round(TREND.minChange * 100)}%</strong>. On
          this dataset that is 4 accounts out of 25, not 25 flapping arrows.
        </p>
      </section>

      <section className="mb-7">
        <h2 className="mb-1 text-[14px] font-semibold">Severity, and why it is not a label</h2>
        <p className="mb-3 text-[12.5px] leading-[1.6] text-ink-2">
          Each risk starts at a severity set by its own strength, then moves for reasons a CSM would
          recognise:
        </p>
        <Card className="flex flex-col gap-[10px] p-4 text-[12.5px]">
          <p>
            <strong className="font-medium text-ink">+1 level for a high-value account</strong>{" "}
            <span className="text-ink-2">
              (top {Math.round((1 - SEVERITY_RULES.highValueQuantile) * 100)}% of the book by ARR) —
              the same signal costs more if we are right. A risk whose definition already contains
              ARR is exempt, so the same fact is never counted twice.
            </span>
          </p>
          <p>
            <strong className="font-medium text-ink">
              +1 level when {SEVERITY_RULES.convergenceCount} or more risks fire together
            </strong>{" "}
            <span className="text-ink-2">
              — harder to explain away than any one alone. Withheld on low-confidence accounts,
              where several rules firing is the same thin evidence counted several times rather
              than independent corroboration.
            </span>
          </p>
          <p>
            <strong className="font-medium text-ink">Held at High when every health pillar is strong</strong>{" "}
            <span className="text-ink-2">
              — Critical means act this week. On a thriving account a single diagnostic flag is a
              conversation to have, not a fire to put out.
            </span>
          </p>
        </Card>
      </section>

      <section>
        <h2 className="mb-1 text-[14px] font-semibold">What is deliberately missing</h2>
        <ul className="flex flex-col gap-2 text-[12.5px] leading-[1.6] text-ink-2">
          <li>
            <strong className="font-medium text-ink">ARR is not in the score.</strong> An Enterprise
            account is not healthier for paying more. ARR decides who gets called first, which is a
            separate axis and a separate column.
          </li>
          <li>
            <strong className="font-medium text-ink">Total event count is not a KPI.</strong> It
            rewards noise: in this portfolio the two most active accounts are both on free plans
            worth $0, and ARR correlates <em>negatively</em> with usage.
          </li>
          <li>
            <strong className="font-medium text-ink">No hour-of-day or day-of-week analysis.</strong>{" "}
            The export contains no events at all between 09:00 and 19:00 UTC, which no real customer
            base produces. Building on that distribution would be inventing a finding.
          </li>
          <li>
            <strong className="font-medium text-ink">Per-user engagement is not scored.</strong> 186
            users produce between 1 and 8 events each. Users are counted, not ranked.
          </li>
          <li>
            <strong className="font-medium text-ink">An account with no events is never called At Risk.</strong>{" "}
            It is reported as No Data. Absence of evidence is as likely to be a broken pipeline as a
            lost customer, and those need opposite responses. Below {LOW_CONFIDENCE_MIN_EVENTS}{" "}
            events the verdict is shown but labelled low confidence.
          </li>
        </ul>
      </section>
    </div>
  );
}
