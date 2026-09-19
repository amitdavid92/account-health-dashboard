import Link from "next/link";
import { Shell } from "@/components/shell";
import {
  BAND_STYLE,
  BandChip,
  Card,
  CardHead,
  Delta,
  Sparkline,
  initialsOf,
  money,
} from "@/components/primitives";
import {
  BAND_THRESHOLDS,
  getSummary,
  parseQuery,
  queryAccounts,
  type SortKey,
} from "@/lib/service";
import type { AccountHealth, BandKey } from "@/lib/types";

export const metadata = {
  title: "Book of business · Account Health",
};

const COLUMNS: { key: SortKey | null; label: string; right?: boolean }[] = [
  { key: "name", label: "Account" },
  { key: "score", label: "Health" },
  { key: "delta", label: "30d" },
  { key: "arr", label: "ARR", right: true },
  { key: "plan", label: "Plan" },
  { key: "csm", label: "CSM" },
  { key: null, label: "Signal to act on" },
];

function sortHref(
  sp: Record<string, string | string[] | undefined>,
  key: SortKey,
  current: SortKey,
  dir: "asc" | "desc",
) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(sp)) {
    if (k === "sort" || k === "dir") continue;
    if (typeof v === "string") p.set(k, v);
    else if (Array.isArray(v)) v.forEach((x) => p.append(k, x));
  }
  p.set("sort", key);
  p.set("dir", current === key && dir === "asc" ? "desc" : "asc");
  return `/?${p.toString()}`;
}

export default async function OverviewPage({ searchParams }: PageProps<"/">) {
  const sp = await searchParams;
  const query = parseQuery(sp);
  const summary = getSummary();
  const rows = queryAccounts(query);
  const all = queryAccounts({});

  const activeBand = query.band && query.band.length === 1 ? query.band[0] : null;
  const byBand = (b: BandKey) => all.filter((a) => a.health.band === b);
  const movers = all
    .filter((a) => a.scoreDelta !== null)
    .sort((a, b) => (a.scoreDelta as number) - (b.scoreDelta as number))
    .slice(0, 5);

  const bigBelowHealthy = all.filter(
    (a) => (a.health.band === "crit" || a.health.band === "warn") && a.arr >= 90_000,
  );

  return (
    <Shell
      title="Book of business"
      activeBand={activeBand}
      plan={query.plan}
      csm={query.csm}
      q={query.q}
    >
      {/* ---------- stat tiles ---------- */}
      <div className="mb-3 grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Card className="flex flex-col gap-2 px-4 pb-[13px] pt-[14px]">
          <span className="text-[11.5px] text-ink-2">ARR below Healthy</span>
          <span className="flex items-end gap-[9px]">
            <span className="text-[44px] font-semibold leading-none tracking-[-0.02em]">
              {money(summary.arrBelowHealthy)}
            </span>
            <span className="pb-[2px] text-[12px] text-ink-3">of {money(summary.arrTotal)}</span>
          </span>
          <span className="text-[11.5px] text-ink-3">
            {Math.round((summary.arrBelowHealthy / Math.max(1, summary.arrTotal)) * 100)}% of book
            value · {money(summary.arrAtRisk)} of it at risk
          </span>
        </Card>

        <Card className="flex flex-col gap-2 px-4 pb-[13px] pt-[14px]">
          <span className="text-[11.5px] text-ink-2">Accounts needing attention</span>
          <span className="flex items-end gap-[9px]">
            <span className="text-[28px] font-semibold leading-none tracking-[-0.02em]">
              {byBand("crit").length + byBand("warn").length}
            </span>
            <span className="pb-[2px] text-[12px] text-ink-3">of {summary.scored} scored</span>
          </span>
          <span className="flex flex-wrap items-center gap-[6px] text-[11.5px] text-ink-3">
            <BandChip band="crit" suffix={String(byBand("crit").length)} />
            <BandChip band="warn" suffix={String(byBand("warn").length)} />
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
          <span className="text-[11.5px] text-ink-3">
            <Delta value={summary.medianDelta} /> mean change vs prior 30 days
          </span>
        </Card>

        <Card className="flex flex-col gap-2 px-4 pb-[13px] pt-[14px]">
          <span className="text-[11.5px] text-ink-2">Held out of scoring</span>
          <span className="flex items-end gap-[9px]">
            <span className="text-[28px] font-semibold leading-none tracking-[-0.02em]">
              {summary.heldOut}
            </span>
            <span className="pb-[2px] text-[12px] text-ink-3">no signal</span>
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
              {summary.distribution
                .filter((d) => d.accounts > 0)
                .map((d) => (
                  <Link
                    key={d.band}
                    href={`/?band=${d.band}`}
                    title={`${d.label}: ${d.accounts} accounts · ${money(d.arr)}`}
                    className="grid place-items-center rounded-[3px] no-underline transition hover:brightness-105"
                    style={{ flex: `${d.accounts} ${d.accounts} 0`, background: BAND_STYLE[d.band].mark }}
                  >
                    <span
                      className="num text-[11.5px] font-semibold text-white"
                      style={{ textShadow: "0 0 2px rgba(0,0,0,0.25)" }}
                    >
                      {d.accounts}
                    </span>
                  </Link>
                ))}
            </div>
            <div className="flex flex-wrap gap-x-4 gap-y-1">
              {summary.distribution.map((d) => (
                <span key={d.band} className="flex items-center gap-[7px] text-[12px] text-ink-2">
                  <i
                    className="h-[9px] w-[9px] shrink-0 rounded-[2.5px]"
                    style={{ background: BAND_STYLE[d.band].mark }}
                  />
                  {d.label} <b className="num font-medium text-ink">{d.accounts}</b>
                  <span className="num text-ink-3">{money(d.arr)}</span>
                </span>
              ))}
            </div>
            <div className="mt-[13px] flex flex-wrap gap-x-4 gap-y-[3px] border-t border-hairline pt-[11px] text-[11.5px] text-ink-3">
              <span>
                Bands: <b className="num font-medium text-ink-2">Healthy ≥ {BAND_THRESHOLDS.good}</b>
              </span>
              <span>
                <b className="num font-medium text-ink-2">
                  Watch {BAND_THRESHOLDS.warn}–{BAND_THRESHOLDS.good - 1}
                </b>
              </span>
              <span>
                <b className="num font-medium text-ink-2">At risk &lt; {BAND_THRESHOLDS.warn}</b>
              </span>
              <span>
                No signal — <b className="font-medium text-ink-2">held out</b>, never scored 0
              </span>
            </div>
          </div>
        </Card>

        <Card>
          <CardHead title="Biggest drops" hint="30-day score change" />
          <div className="px-2 pb-[10px] pt-3">
            {movers.map((a) => (
              <Link
                key={a.slug}
                href={`/accounts/${a.slug}`}
                className="grid grid-cols-[1fr_auto_auto] items-center gap-[10px] rounded-[7px] px-2 py-[7px] no-underline hover:bg-inset"
              >
                <span className="min-w-0">
                  <span className="block truncate text-[12.5px] font-medium text-ink">{a.name}</span>
                  <span className="block truncate text-[11px] text-ink-3">
                    {a.plan} · {money(a.arr)} · {a.csm}
                  </span>
                </span>
                <Sparkline series={a.daily} band={a.health.band} width={74} height={22} />
                <Delta value={a.scoreDelta} className="min-w-[34px] text-right text-[12.5px]" />
              </Link>
            ))}
          </div>
        </Card>
      </div>

      {/* ---------- triage queue ---------- */}
      <Card>
        <CardHead
          title="Triage queue"
          hint={`${rows.length} of ${summary.accounts} accounts · worst first`}
        />
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
                        <Link
                          href={sortHref(sp, c.key, query.sort ?? "score", query.dir ?? "asc")}
                          className="no-underline hover:text-ink"
                        >
                          {c.label}
                          {query.sort === c.key ? (
                            <span className="ml-1 text-[9px] opacity-45">
                              {query.dir === "asc" ? "▲" : "▼"}
                            </span>
                          ) : null}
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
                  <AccountRow key={a.slug} account={a} />
                ))}
              </tbody>
            </table>
          )}
        </div>
      </Card>

      {bigBelowHealthy.length > 0 ? (
        <p className="mt-[14px] flex items-start gap-2 text-[11.5px] text-ink-3">
          <span aria-hidden="true">◆</span>
          <span>
            <b className="font-medium text-ink">
              {bigBelowHealthy.length} accounts over {money(90_000)} ARR
            </b>{" "}
            are below Healthy:{" "}
            {bigBelowHealthy.map((a) => `${a.name} (${money(a.arr)})`).join(", ")}. These are where a
            CSM hour returns the most.
          </span>
        </p>
      ) : null}
    </Shell>
  );
}

function AccountRow({ account: a }: { account: AccountHealth }) {
  return (
    <tr className="hover:bg-inset">
      <td className="border-b border-hairline px-3 py-[9px] align-middle">
        <Link href={`/accounts/${a.slug}`} className="flex min-w-0 items-center gap-[9px] no-underline">
          <span className="grid h-[26px] w-[26px] shrink-0 place-items-center rounded-[7px] border border-hairline bg-inset text-[10.5px] font-semibold text-ink-2">
            {initialsOf(a.name)}
          </span>
          <span className="min-w-0">
            <span className="block text-[13px] font-medium tracking-[-0.005em] text-ink">
              {a.name}
            </span>
            <span className="flex items-center gap-[6px] whitespace-nowrap text-[11px] text-ink-3">
              <span className="truncate">{a.domain}</span>
              {a.workspaces.length > 1 ? (
                <span className="inline-flex h-[15px] shrink-0 items-center rounded-[4px] border border-hairline-strong px-1 text-[10px]">
                  {a.workspaces.length} workspaces
                </span>
              ) : null}
              {a.health.lowConfidence ? (
                <span
                  className="inline-flex h-[15px] shrink-0 items-center rounded-[4px] border border-hairline-strong px-1 text-[10px]"
                  title={a.health.confidenceNote}
                >
                  low volume
                </span>
              ) : null}
            </span>
          </span>
        </Link>
      </td>

      <td className="border-b border-hairline px-3 py-[9px] align-middle">
        <span className="flex items-center gap-[9px]">
          <span
            className={`num min-w-[22px] text-[14px] ${
              a.health.score === null ? "font-medium text-ink-3" : "font-semibold"
            }`}
          >
            {a.health.score ?? "—"}
          </span>
          <BandChip band={a.health.band} />
        </span>
      </td>

      <td className="border-b border-hairline px-3 py-[9px] align-middle">
        {a.health.score === null ? (
          <span className="text-ink-3">—</span>
        ) : (
          <span className="flex items-center gap-2">
            <Sparkline series={a.daily} band={a.health.band} />
            <Delta value={a.scoreDelta} className="text-[11.5px]" />
          </span>
        )}
      </td>

      <td className="num border-b border-hairline px-3 py-[9px] text-right align-middle font-medium">
        {money(a.arr)}
      </td>
      <td className="border-b border-hairline px-3 py-[9px] align-middle">
        <span className={`text-[11.5px] ${a.plan === "Enterprise" ? "font-medium text-ink" : "text-ink-2"}`}>
          {a.plan}
        </span>
      </td>
      <td className="border-b border-hairline px-3 py-[9px] align-middle text-[11.5px] text-ink-2">
        {a.csm}
      </td>
      <td className="border-b border-hairline px-3 py-[9px] align-middle text-[11.5px] text-ink-2">
        {a.signals[0]?.title ?? "—"}
      </td>
    </tr>
  );
}
