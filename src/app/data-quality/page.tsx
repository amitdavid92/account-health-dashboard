/**
 * What the pipeline checked and what it found.
 *
 * Checks that passed are shown alongside checks that failed, because "no
 * duplicate events were found" and "duplicates were never looked for" are very
 * different statements about a dataset, and only one of them earns trust in
 * the numbers on the rest of the site. This is the same report the sidebar's
 * data-notes drawer summarises - this page is the full version.
 */

import Link from "next/link";
import { Card } from "@/components/primitives";
import { getQualityReport } from "@/lib/db";

export const metadata = { title: "Data quality — Account Health" };

const MARK = {
  info: { glyph: "✓", colour: "var(--good)", label: "Clean" },
  warning: { glyph: "!", colour: "var(--warn)", label: "Handled" },
  error: { glyph: "✕", colour: "var(--crit)", label: "Excluded" },
} as const;

export default function DataQualityPage() {
  const report = getQualityReport();
  const t = report.totals;
  const findings = report.issues.filter((i) => i.severity !== "info").length;

  return (
    <div className="mx-auto max-w-[820px] px-4 py-8 md:px-6">
      <Link href="/" className="mb-4 inline-flex items-center gap-[6px] text-[12.5px] text-ink-2 no-underline hover:text-ink">
        <svg width="13" height="13" viewBox="0 0 14 14" aria-hidden="true">
          <path d="M8.6 2.8 4.4 7l4.2 4.2" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        Portfolio
      </Link>

      <header className="mb-6">
        <h1 className="text-[21px] font-semibold tracking-[-0.015em]">Data quality</h1>
        <p className="mt-2 text-[13px] leading-[1.6] text-ink-2">
          {report.issues.length} checks ran against the raw export. {findings} found something; the
          rest came back clean and are listed anyway, so you can tell the difference between a
          dataset that is sound and one that was never examined.
        </p>
      </header>

      {t && (
        <Card className="mb-5 grid grid-cols-2 gap-4 p-4 text-[12.5px] sm:grid-cols-3 lg:grid-cols-6">
          {[
            ["Accounts", t.accounts],
            ["Events kept", t.events],
            ["Rows dropped", t.eventsDropped],
            ["Workspaces", t.workspaces],
            ["Users", t.users],
            ["Window", `${t.windowDays}d`],
          ].map(([label, value]) => (
            <div key={String(label)}>
              <div className="eyebrow">{label}</div>
              <div className="num mt-1 text-[17px] font-semibold">{value}</div>
            </div>
          ))}
          <div className="num col-span-full border-t border-hairline pt-3 text-[11.5px] text-ink-3">
            {t.windowStart.slice(0, 10)} → {t.windowEnd.slice(0, 10)} · &ldquo;today&rdquo; is pinned
            to the latest event ({report.snapshotDate}), never to the clock, so the same export
            always produces the same verdicts.
          </div>
        </Card>
      )}

      <ul className="flex flex-col gap-3">
        {report.issues.map((issue) => {
          const mark = MARK[issue.severity];
          const affected = issue.affectedAccounts ?? [];
          return (
            <li key={issue.code}>
              <Card className="p-4">
                <div className="flex items-start gap-3">
                  <span
                    aria-hidden
                    className="mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full text-[11px] font-bold"
                    style={{ background: "var(--inset)", color: mark.colour }}
                  >
                    {mark.glyph}
                  </span>
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-baseline gap-x-2">
                      <h2 className="text-[13px] font-medium">{issue.title}</h2>
                      <span className="text-[11px]" style={{ color: mark.colour }}>
                        {mark.label}
                      </span>
                      {issue.count > 0 && (
                        <span className="num text-[11px] text-ink-3">{issue.count} affected</span>
                      )}
                    </div>
                    <p className="mt-1 text-[12.5px] leading-[1.55] text-ink-2">{issue.detail}</p>
                    <p className="mt-1.5 text-[12.5px]">
                      <span className="text-ink-3">Decision: </span>
                      {issue.resolution}
                    </p>
                    {affected.length > 0 && (
                      <div className="mt-2 flex flex-wrap gap-2">
                        {affected.map((slug) => (
                          <Link
                            key={slug}
                            href={`/accounts/${slug}`}
                            className="rounded-[4px] bg-inset px-2 py-0.5 text-[11px] no-underline hover:underline"
                          >
                            {slug}
                          </Link>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              </Card>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
