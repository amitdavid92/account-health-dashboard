import Link from "next/link";
import { notFound } from "next/navigation";
import { Shell } from "@/components/shell";
import { BAND_STYLE, BandChip, Card, CardHead, Delta, money } from "@/components/primitives";
import { TrendChart } from "@/components/trend-chart";
import { getAccount, getBook } from "@/lib/service";
import type { AccountHealth, EventType } from "@/lib/types";

export async function generateStaticParams() {
  return getBook().accounts.map((a) => ({ slug: a.slug }));
}

export async function generateMetadata({ params }: PageProps<"/accounts/[slug]">) {
  const { slug } = await params;
  const account = getAccount(slug);
  return { title: account ? `${account.name} · Account Health` : "Account not found" };
}

/* Categorical hues for the event mix, in a fixed validated order - never
   cycled, and never the status colours, so a series can't impersonate a state. */
const MIX: { key: EventType; label: string; light: string; dark: string }[] = [
  { key: "guide_created", label: "Guide created", light: "#2a78d6", dark: "#3987e5" },
  { key: "guide_viewed", label: "Guide viewed", light: "#eb6834", dark: "#d95926" },
  { key: "guide_shared", label: "Guide shared", light: "#1baf7a", dark: "#199e70" },
  { key: "user_invited", label: "User invited", light: "#4a3aa7", dark: "#9085e9" },
  { key: "login", label: "Login", light: "#8b8b94", dark: "#71717a" },
];

export default async function AccountPage({ params }: PageProps<"/accounts/[slug]">) {
  const { slug } = await params;
  const account = getAccount(slug);
  if (!account) notFound();

  const weakest = [...account.health.dimensions].sort(
    (a, b) => a.subscore - b.subscore || b.weight - a.weight,
  )[0];

  const cutAtDay =
    account.health.heldOutReason === "suspected_gap" && account.metrics.daysSinceLastEvent !== null
      ? account.daily.length - 1 - account.metrics.daysSinceLastEvent
      : null;

  const mixTotal = MIX.reduce((s, m) => s + (account.mix[m.key] ?? 0), 0);

  return (
    <Shell title={account.name}>
      <Link
        href="/"
        className="mb-[10px] inline-flex items-center gap-[6px] py-1 text-[12.5px] text-ink-2 no-underline hover:text-ink"
      >
        <svg width="13" height="13" viewBox="0 0 14 14" aria-hidden="true">
          <path
            d="M8.6 2.8 4.4 7l4.2 4.2"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
        Triage queue
      </Link>

      <Card className="mb-3 flex flex-wrap items-center gap-5 px-5 py-[18px]">
        <HealthRing account={account} />

        <div className="flex min-w-0 flex-[1_1_260px] flex-col gap-[9px]">
          <div className="flex flex-wrap items-center gap-[10px]">
            <h2 className="text-[21px] font-semibold tracking-[-0.02em]">{account.name}</h2>
            <BandChip band={account.health.band} />
            {account.workspaces.length > 1 ? (
              <span className="inline-flex h-[15px] items-center rounded-[4px] border border-hairline-strong px-1 text-[10px] text-ink-3">
                {account.workspaces.length} workspaces
              </span>
            ) : null}
          </div>

          <dl className="flex flex-wrap gap-x-6 gap-y-0">
            <Fact k="ARR" v={money(account.arr)} />
            <Fact k="Plan" v={account.plan} />
            <Fact k="Known seats" v={String(account.metrics.knownUsers)} />
            <Fact k="CSM" v={account.csm} />
            <Fact k="Customer since" v={account.contractStart} />
            <Fact k="Domain" v={account.domain} muted />
          </dl>
        </div>

        <div className="flex flex-[1_1_240px] flex-col gap-[5px] self-stretch rounded-[9px] border border-hairline bg-inset px-3 py-[10px]">
          <span className="eyebrow">What to do</span>
          <p className="text-[12.5px] text-ink-2">
            {!account.health.scored ? (
              <>
                <b className="font-medium text-ink">Do not call yet.</b> No usable signal in the
                window — check the pipeline before a CSM spends an hour on this.
              </>
            ) : account.health.band === "crit" ? (
              <>
                <b className="font-medium text-ink">Act this week.</b> The binding constraint is{" "}
                <b className="font-medium text-ink">{weakest.name.toLowerCase()}</b> at{" "}
                {weakest.subscore}/100 — costing{" "}
                {((100 - weakest.subscore) * weakest.weight).toFixed(1)} of the{" "}
                {100 - (account.health.score ?? 0)} points this account is short.
              </>
            ) : account.health.band === "warn" ? (
              <>
                <b className="font-medium text-ink">Watch.</b> The weakest input is{" "}
                <b className="font-medium text-ink">{weakest.name.toLowerCase()}</b> at{" "}
                {weakest.subscore}/100 — the cheapest place to move this score.
              </>
            ) : (
              <>
                <b className="font-medium text-ink">Healthy.</b> The weakest input is{" "}
                <b className="font-medium text-ink">{weakest.name.toLowerCase()}</b> at{" "}
                {weakest.subscore}/100; nothing here needs intervention.
              </>
            )}
          </p>
          {account.health.lowConfidence && account.health.confidenceNote ? (
            <p className="mt-1 text-[11.5px] text-warn-ink">{account.health.confidenceNote}</p>
          ) : null}
        </div>
      </Card>

      <div className="mb-3 grid grid-cols-1 items-start gap-3 xl:grid-cols-[1.05fr_1fr]">
        {/* ---------- the decomposition ---------- */}
        <Card>
          <CardHead title="Why this score" hint="six inputs · fixed weights" />
          <div className="px-4 pb-[14px] pt-[6px]">
            {!account.health.scored ? (
              <div className="py-6">
                <p className="mb-[6px] text-[13px] font-medium text-ink">Held out of scoring</p>
                <p className="text-[12.5px] leading-[1.55] text-ink-2">
                  {account.health.heldOutDetail}
                </p>
                <p className="mt-[10px] text-[12px] text-ink-3">
                  A score of 0 would rank this above genuinely failing accounts in the triage queue,
                  so it is surfaced as its own state instead.
                </p>
              </div>
            ) : (
              <>
                {account.health.dimensions.map((d) => {
                  const fill =
                    d.subscore >= 70 ? "var(--good)" : d.subscore >= 40 ? "var(--warn)" : "var(--crit)";
                  return (
                    <div key={d.key} className="border-b border-hairline py-[11px] last:border-b-0">
                      <div className="mb-[6px] flex items-baseline gap-2">
                        <span className="text-[12.5px] font-medium">{d.name}</span>
                        <span className="num text-[11px] text-ink-3">
                          weight {Math.round(d.weight * 100)}%
                        </span>
                        <span className="num ml-auto text-[12px] text-ink-2">
                          <b className="font-semibold text-ink">{d.contribution.toFixed(1)}</b> pts
                        </span>
                      </div>
                      <div className="flex items-center gap-[10px]">
                        <div className="h-2 flex-1 overflow-hidden rounded-[4px] bg-track">
                          <div
                            className="h-2 rounded-r-[4px]"
                            style={{ width: `${d.subscore}%`, background: fill }}
                          />
                        </div>
                        <span className="num min-w-[30px] text-right text-[11.5px] text-ink-3">
                          {d.subscore}
                        </span>
                      </div>
                      <p className="mt-[5px] text-[11.5px] text-ink-2">{d.evidence}</p>
                    </div>
                  );
                })}
                <div className="mt-1 flex items-baseline gap-2 border-t border-hairline-strong pb-[2px] pt-3">
                  <span className="text-[12.5px] font-medium">Health score</span>
                  <span className="num ml-auto text-[15px] font-bold">
                    {account.health.score} / 100
                  </span>
                </div>
                <p className="mt-[7px] text-[11.5px] text-ink-3">
                  Weights sum to 100%, so the score is exactly the sum of the contributions above.
                </p>
              </>
            )}
          </div>
        </Card>

        <div className="flex flex-col gap-3">
          <Card>
            <CardHead title="Daily activity" hint="all event types" />
            <TrendChart series={account.daily} band={account.health.band} cutAtDay={cutAtDay} />
          </Card>

          <Card>
            <CardHead title="Event mix" hint={`${mixTotal.toLocaleString()} events`} />
            {mixTotal === 0 ? (
              <p className="px-4 py-6 text-center text-[13px] text-ink-3">
                No events in the window.
              </p>
            ) : (
              <>
                <div className="flex gap-[2px] px-4 pb-1 pt-[14px]">
                  {MIX.filter((m) => (account.mix[m.key] ?? 0) > 0).map((m) => {
                    const v = account.mix[m.key] ?? 0;
                    const pct = (v / mixTotal) * 100;
                    return (
                      <div
                        key={m.key}
                        title={`${m.label}: ${v.toLocaleString()}`}
                        className="grid h-[30px] place-items-center rounded-[3px]"
                        style={{ flex: `${v} ${v} 0`, background: `var(--mix-${m.key})` }}
                      >
                        {pct > 9 ? (
                          <span
                            className="num text-[11px] font-semibold text-white"
                            style={{ textShadow: "0 0 2px rgba(0,0,0,.3)" }}
                          >
                            {Math.round(pct)}%
                          </span>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
                <div className="flex flex-wrap gap-x-[14px] gap-y-1 px-4 pb-[14px] pt-1">
                  {MIX.map((m) => (
                    <span key={m.key} className="flex items-center gap-[7px] text-[12px] text-ink-2">
                      <i
                        className="h-[9px] w-[9px] shrink-0 rounded-[2.5px]"
                        style={{ background: `var(--mix-${m.key})` }}
                      />
                      {m.label}{" "}
                      <b className="num font-medium text-ink">
                        {(account.mix[m.key] ?? 0).toLocaleString()}
                      </b>
                    </span>
                  ))}
                </div>
              </>
            )}
          </Card>

          <Card>
            <CardHead title="Workspaces" hint="rolled up to this account" />
            <div className="mt-2">
              {account.workspaces.length === 0 ? (
                <p className="px-4 py-4 text-[12.5px] text-ink-3">
                  No workspace produced events in the window.
                </p>
              ) : (
                account.workspaces.map((w) => (
                  <div
                    key={w.workspace_id}
                    className="grid grid-cols-[1fr_auto_auto] items-center gap-3 border-b border-hairline px-4 py-[9px] text-[12.5px] last:border-b-0"
                  >
                    <span className="font-mono text-[12px]">{w.workspace_id}</span>
                    <span className="h-[6px] w-[84px] overflow-hidden rounded-[3px] bg-track">
                      <i
                        className="block h-[6px] rounded-[3px]"
                        style={{ width: `${Math.round(w.share * 100)}%`, background: "var(--accent)" }}
                      />
                    </span>
                    <span className="num min-w-[38px] text-right text-ink-2">
                      {Math.round(w.share * 100)}%
                    </span>
                  </div>
                ))
              )}
            </div>
            <p className="border-t border-hairline px-4 pb-[14px] pt-[11px] text-[11.5px] text-ink-3">
              {account.workspaces.length > 1
                ? "Joined on domain, not company_name — the name is not a clean 1:1 with workspace_id in the export."
                : "Single workspace. Still joined on domain, so a second one appears here automatically."}
              {account.nameVariants.length > 1
                ? ` Name arrived ${account.nameVariants.length} ways: ${account.nameVariants
                    .map((n) => `"${n}"`)
                    .join(", ")}.`
                : ""}
            </p>
          </Card>
        </div>
      </div>

      <Card>
        <CardHead title="Signals" hint="evidence behind the score" />
        <div className="mt-2">
          {account.signals.length === 0 ? (
            <p className="px-4 py-4 text-[12.5px] text-ink-3">No notable signals.</p>
          ) : (
            account.signals.map((s, i) => (
              <div
                key={`${s.title}-${i}`}
                className="grid grid-cols-[16px_1fr_auto] items-start gap-[10px] border-b border-hairline px-4 py-[10px] last:border-b-0"
              >
                <i
                  className="mt-[5px] h-2 w-2 justify-self-center rounded-full"
                  style={{ background: BAND_STYLE[s.level].mark }}
                />
                <span className="text-[12.5px]">
                  {s.title}
                  <em className="mt-[1px] block text-[11.5px] not-italic text-ink-3">{s.detail}</em>
                </span>
                <span className="num whitespace-nowrap text-[11px] text-ink-3">{s.age}</span>
              </div>
            ))
          )}
        </div>
      </Card>

      <p className="mt-[14px] text-[11.5px] text-ink-3">
        Score 30 days ago: <b className="num font-medium text-ink-2">{account.scorePrior ?? "—"}</b>{" "}
        · change <Delta value={account.scoreDelta} /> · recomputed through the same code path on a
        window ending 30 days earlier, so the delta is apples to apples.
      </p>
    </Shell>
  );
}

function Fact({ k, v, muted }: { k: string; v: string; muted?: boolean }) {
  return (
    <div className="flex flex-col gap-px py-[2px]">
      <dt className="text-[10.5px] uppercase tracking-[0.04em] text-ink-3">{k}</dt>
      <dd className={`num text-[13px] ${muted ? "text-ink-2" : "font-medium"}`}>{v}</dd>
    </div>
  );
}

function HealthRing({ account }: { account: AccountHealth }) {
  const R = 52;
  const C = 2 * Math.PI * R;
  const pct = (account.health.score ?? 0) / 100;
  const colour = BAND_STYLE[account.health.band].mark;
  /* Track is a wash of the fill's own hue, so the meter reads as one object
     rather than a coloured arc sitting on unrelated grey. */
  const track = account.health.scored
    ? `var(--${account.health.band}-wash)`
    : "var(--track)";

  return (
    <div className="relative h-[128px] w-[128px] shrink-0">
      <svg width="128" height="128" viewBox="0 0 128 128" aria-hidden="true" className="block -rotate-90">
        <circle cx="64" cy="64" r={R} fill="none" stroke={track} strokeWidth="11" />
        {account.health.scored ? (
          <circle
            cx="64"
            cy="64"
            r={R}
            fill="none"
            stroke={colour}
            strokeWidth="11"
            strokeLinecap="round"
            strokeDasharray={`${(C * pct).toFixed(1)} ${C.toFixed(1)}`}
          />
        ) : null}
      </svg>
      <div className="absolute inset-0 grid place-content-center gap-px text-center">
        <div
          className={`font-semibold leading-none tracking-[-0.02em] ${
            account.health.scored ? "text-[34px]" : "text-[22px] text-ink-3"
          }`}
        >
          {account.health.score ?? "—"}
        </div>
        <div className="text-[10.5px] text-ink-3">
          {account.health.scored ? "of 100" : "not scored"}
        </div>
      </div>
    </div>
  );
}
