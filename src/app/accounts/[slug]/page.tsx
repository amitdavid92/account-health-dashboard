import Link from "next/link";
import { notFound } from "next/navigation";
import { Shell } from "@/components/shell";
import { Card, CardHead, PillarBar, SeverityChip, TierChip, money } from "@/components/primitives";
import { TrendChart } from "@/components/trend-chart";
import { getAccountDetail, getRawData } from "@/lib/db";
import { scoresThirtyDaysAgo } from "@/lib/history";
import { trendFor } from "@/lib/pipeline";
import { TIER_STYLE, silenceLabel } from "@/lib/ui";
import { WINDOW } from "@/lib/config";
import type { AccountSummary, EventType, HealthTier } from "@/lib/types";

export async function generateMetadata({ params }: PageProps<"/accounts/[slug]">) {
  const { slug } = await params;
  const detail = getAccountDetail(slug);
  return { title: detail ? `${detail.account.companyName} · Account Health` : "Account not found" };
}

/* Categorical hues for the event mix, in a fixed validated order - never
   cycled, and never the status colours, so a series can't impersonate a
   state. login stays grey on purpose - an all-login account should look
   empty, not colourful (see Cedarline Insurance). */
const MIX: { key: EventType; label: string }[] = [
  { key: "guide_created", label: "Guide created" },
  { key: "guide_viewed", label: "Guide viewed" },
  { key: "guide_shared", label: "Guide shared" },
  { key: "user_invited", label: "User invited" },
  { key: "login", label: "Login" },
];

function Fact({ k, v, muted }: { k: string; v: string; muted?: boolean }) {
  return (
    <div className="flex flex-col gap-px py-[2px]">
      <dt className="text-[10.5px] uppercase tracking-[0.04em] text-ink-3">{k}</dt>
      <dd className={`num text-[13px] ${muted ? "text-ink-2" : "font-medium"}`}>{v}</dd>
    </div>
  );
}

function HealthRing({ score, tier }: { score: number; tier: HealthTier }) {
  const R = 52;
  const C = 2 * Math.PI * R;
  const scored = tier !== "No Data";
  const pct = score / 100;
  const colour = TIER_STYLE[tier].mark;
  /* Track is a wash of the fill's own hue, so the meter reads as one object
     rather than a coloured arc sitting on unrelated grey. */
  const track = scored ? TIER_STYLE[tier].wash : "var(--track)";

  return (
    <div className="relative h-[128px] w-[128px] shrink-0">
      <svg width="128" height="128" viewBox="0 0 128 128" aria-hidden="true" className="block -rotate-90">
        <circle cx="64" cy="64" r={R} fill="none" stroke={track} strokeWidth="11" />
        {scored && (
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
        )}
      </svg>
      <div className="absolute inset-0 grid place-content-center gap-px text-center">
        <div
          className={`font-semibold leading-none tracking-[-0.02em] ${
            scored ? "text-[34px]" : "text-[22px] text-ink-3"
          }`}
        >
          {scored ? score : "—"}
        </div>
        <div className="text-[10.5px] text-ink-3">{scored ? "of 100" : "not scored"}</div>
      </div>
    </div>
  );
}

/** The weakest pillar - the cheapest place to move the score, or the thing
 *  costing it the most, depending on which way the account is heading. */
function weakestPillar(detail: AccountSummary) {
  return [...detail.health.pillars].sort(
    (a, b) => a.points / a.maxPoints - b.points / b.maxPoints,
  )[0];
}

/**
 * The "what to do" sentence. When an override capped the tier, that override
 * *is* the binding constraint - it is the reason the score could not decide
 * on its own - so it leads. Otherwise the weakest pillar is the cheapest
 * lever, exactly as it would be with no caps in play.
 */
function WhatToDo({ detail }: { detail: AccountSummary }) {
  const { health, account } = detail;

  if (health.tier === "No Data") {
    return (
      <p className="text-[12.5px] text-ink-2">
        <b className="font-medium text-ink">Do not call yet.</b> {health.confidenceNote}
      </p>
    );
  }

  const weakest = weakestPillar(detail);
  const lead = health.overrides[0];

  return (
    <>
      <p className="text-[12.5px] text-ink-2">
        {health.tier === "At Risk" ? (
          <b className="font-medium text-ink">Act this week.</b>
        ) : health.tier === "Watch" ? (
          <b className="font-medium text-ink">Watch.</b>
        ) : (
          <b className="font-medium text-ink">Healthy.</b>
        )}{" "}
        {lead ? (
          <>{lead.reason}</>
        ) : (
          <>
            The weakest input is <b className="font-medium text-ink">{weakest.label.toLowerCase()}</b>{" "}
            at {weakest.points}/{weakest.maxPoints} points
            {health.tier === "Healthy"
              ? "; nothing here needs intervention."
              : " — the cheapest place to move this score."}
          </>
        )}
      </p>
      {detail.topRisk && (
        <p className="mt-1 text-[11.5px] text-ink-3">
          Top risk: <b className="font-medium text-ink-2">{detail.topRisk.title}</b> ({detail.topRisk.severity})
        </p>
      )}
      {health.lowConfidence && health.confidenceNote && (
        <p className="mt-1 text-[11.5px] text-warn-ink">{health.confidenceNote}</p>
      )}
      {account.arrUsd > 0 && (
        <p className="mt-1 text-[11.5px] text-ink-3">
          Priority is {money(account.arrUsd)} ARR weighted by tier - ARR itself is never part of the
          score above.
        </p>
      )}
    </>
  );
}

export default async function AccountPage({ params }: PageProps<"/accounts/[slug]">) {
  const { slug } = await params;
  const detail = getAccountDetail(slug);
  if (!detail) notFound();

  const { account, health, metrics, risks } = detail;
  const trend = trendFor(detail);

  const raw = getRawData();
  const prior = scoresThirtyDaysAgo(raw.accounts, raw.events, raw.snapshotMs);
  const before = prior.get(slug) ?? null;
  const delta = before === null || health.tier === "No Data" ? null : health.score - before;

  const weekly = metrics.weekly.map((w) => w.total);
  const mixTotal = MIX.reduce((s, m) => s + metrics.byType[m.key], 0);
  const recentWeeks = Math.ceil(WINDOW.recentDays / 7);

  return (
    <Shell title={account.companyName}>
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
        <HealthRing score={health.score} tier={health.tier} />

        <div className="flex min-w-0 flex-[1_1_260px] flex-col gap-[9px]">
          <div className="flex flex-wrap items-center gap-[10px]">
            <h2 className="text-[21px] font-semibold tracking-[-0.02em]">{account.companyName}</h2>
            <TierChip tier={health.tier} />
            {metrics.workspaceCount > 1 && (
              <span className="inline-flex h-[15px] items-center rounded-[4px] border border-hairline-strong px-1 text-[10px] text-ink-3">
                {metrics.workspaceCount} workspaces
              </span>
            )}
          </div>

          <dl className="flex flex-wrap gap-x-6 gap-y-0">
            <Fact k="ARR" v={money(account.arrUsd)} />
            <Fact k="Plan" v={account.planTier} />
            <Fact k="Known users" v={String(metrics.knownUsers)} />
            <Fact k="CSM" v={account.csmOwner} />
            <Fact k="Customer since" v={account.contractStartDate} />
            <Fact k="Domain" v={account.domain} muted />
          </dl>
        </div>

        <div className="flex flex-[1_1_240px] flex-col gap-[5px] self-stretch rounded-[9px] border border-hairline bg-inset px-3 py-[10px]">
          <span className="eyebrow">What to do</span>
          <WhatToDo detail={detail} />
        </div>
      </Card>

      <div className="mb-3 grid grid-cols-1 items-start gap-3 xl:grid-cols-[1.05fr_1fr]">
        {/* ---------- the decomposition ---------- */}
        <Card>
          <CardHead title="Why this score" hint="four inputs · fixed points" />
          <div className="px-4 pb-[14px] pt-[6px]">
            {health.tier === "No Data" ? (
              <div className="py-6">
                <p className="mb-[6px] text-[13px] font-medium text-ink">Held out of scoring</p>
                <p className="text-[12.5px] leading-[1.55] text-ink-2">{health.confidenceNote}</p>
                <p className="mt-[10px] text-[12px] text-ink-3">
                  A score of 0 would rank this above genuinely failing accounts in the triage queue,
                  so it is surfaced as its own state instead.
                </p>
              </div>
            ) : (
              <>
                {health.pillars.map((p) => (
                  <PillarBar key={p.key} pillar={p} />
                ))}
                <div className="mt-1 flex items-baseline gap-2 border-t border-hairline-strong pb-[2px] pt-3">
                  <span className="text-[12.5px] font-medium">Health score</span>
                  <span className="num ml-auto text-[15px] font-bold">{health.score} / 100</span>
                </div>
                <p className="mt-[7px] text-[11.5px] text-ink-3">
                  The four points above sum exactly to the score - nothing is renormalised after.
                </p>

                {health.overrides.length > 0 && (
                  <div className="mt-3 border-t border-hairline pt-3">
                    <p className="mb-[6px] text-[11px] font-medium uppercase tracking-[0.05em] text-ink-3">
                      {health.tier === health.tierFromScore
                        ? `Capped below Healthy — the raw score already said ${health.tierFromScore}`
                        : `Overruled the score — ${health.score} points alone would have said ${health.tierFromScore}`}
                    </p>
                    <ul className="flex flex-col gap-[6px]">
                      {health.overrides.map((o) => (
                        <li key={o.code} className="text-[11.5px] leading-[1.5] text-ink-2">
                          {o.reason}{" "}
                          <span className="text-ink-3">(caps the tier at {o.cappedAt})</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </>
            )}
          </div>
        </Card>

        <div className="flex flex-col gap-3">
          <Card>
            <CardHead
              title="Weekly activity"
              hint={
                trend.reportable && trend.changePct !== null
                  ? `${trend.direction === "down" ? "▼" : "▲"} ${Math.abs(Math.round(trend.changePct * 100))}% vs prior ${WINDOW.priorDays}d`
                  : "all event types"
              }
            />
            <TrendChart weekly={weekly} tier={health.tier} recentWeeks={recentWeeks} />
            {!trend.reportable && (
              <p className="px-4 pb-3 -mt-1 text-[11px] text-ink-3">
                Trend not reported: {metrics.totalEvents} events in {WINDOW.totalDays} days is too few
                for a 30-day comparison to mean anything.
              </p>
            )}
          </Card>

          <Card>
            <CardHead title="Event mix" hint={`${mixTotal.toLocaleString()} events`} />
            {mixTotal === 0 ? (
              <p className="px-4 py-6 text-center text-[13px] text-ink-3">No events in the window.</p>
            ) : (
              <>
                <div className="flex gap-[2px] px-4 pb-1 pt-[14px]">
                  {MIX.filter((m) => metrics.byType[m.key] > 0).map((m) => {
                    const v = metrics.byType[m.key];
                    const pct = (v / mixTotal) * 100;
                    return (
                      <div
                        key={m.key}
                        title={`${m.label}: ${v.toLocaleString()}`}
                        className="grid h-[30px] place-items-center rounded-[3px]"
                        style={{ flex: `${v} ${v} 0`, background: `var(--mix-${m.key})` }}
                      >
                        {pct > 9 && (
                          <span
                            className="num text-[11px] font-semibold text-white"
                            style={{ textShadow: "0 0 2px rgba(0,0,0,.3)" }}
                          >
                            {Math.round(pct)}%
                          </span>
                        )}
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
                      {m.label} <b className="num font-medium text-ink">{metrics.byType[m.key].toLocaleString()}</b>
                    </span>
                  ))}
                </div>
              </>
            )}
          </Card>

          <Card>
            <CardHead title="Workspaces" hint="rolled up to this account" />
            <div className="mt-2">
              {metrics.workspaces.length === 0 ? (
                <p className="px-4 py-4 text-[12.5px] text-ink-3">
                  No workspace produced events in the window.
                </p>
              ) : (
                metrics.workspaces.map((w) => {
                  const share = metrics.totalEvents > 0 ? w.events / metrics.totalEvents : 0;
                  return (
                    <div
                      key={w.workspaceId}
                      className="grid grid-cols-[1fr_auto_auto_auto] items-center gap-3 border-b border-hairline px-4 py-[9px] text-[12.5px] last:border-b-0"
                    >
                      <span className="font-mono text-[12px]">{w.workspaceId}</span>
                      <span className="h-[6px] w-[64px] overflow-hidden rounded-[3px] bg-track">
                        <i
                          className="block h-[6px] rounded-[3px]"
                          style={{ width: `${Math.round(share * 100)}%`, background: "var(--accent)" }}
                        />
                      </span>
                      <span className="num min-w-[34px] text-right text-ink-2">{Math.round(share * 100)}%</span>
                      <span className="num min-w-[64px] text-right text-ink-3">
                        {silenceLabel(w.daysSinceLastEvent)}
                      </span>
                    </div>
                  );
                })
              )}
            </div>
            {(metrics.workspaceCount > 1 || metrics.planDowngraded) && (
              <p className="border-t border-hairline px-4 pb-[14px] pt-[11px] text-[11.5px] text-ink-3">
                {metrics.workspaceCount > 1 &&
                  "Rolled up to the account, with each person counted once even though the workspaces' user sets do not overlap. "}
                {metrics.planDowngraded &&
                  `Contract says ${account.planTier}; events have been arriving as ${metrics.planAtLastEvent}. The contract stays the source of truth for plan and ARR here - the drift is reported as a risk below.`}
              </p>
            )}
          </Card>
        </div>
      </div>

      <Card>
        <CardHead title="Risks" hint="evidence behind the score" />
        <div className="mt-2">
          {risks.length === 0 ? (
            <p className="px-4 py-4 text-[12.5px] text-ink-3">No risk rule fires on this account.</p>
          ) : (
            risks.map((r) => (
              <div
                key={r.code}
                className="grid grid-cols-[16px_1fr_auto] items-start gap-[10px] border-b border-hairline px-4 py-[10px] last:border-b-0"
              >
                <span
                  className="mt-[5px] inline-block h-2 w-2 justify-self-center rounded-full"
                  style={{
                    background:
                      r.severity === "Critical"
                        ? "var(--crit)"
                        : r.severity === "Low"
                          ? "var(--none)"
                          : "var(--warn)",
                  }}
                />
                <span className="text-[12.5px]">
                  {r.title}
                  {r.affectsHealth && (
                    <span className="ml-[6px] text-[10px] font-semibold uppercase tracking-wider text-ink-3">
                      affects health
                    </span>
                  )}
                  <em className="mt-[2px] block text-[11.5px] not-italic text-ink-2">{r.evidence}</em>
                  <em className="mt-[2px] block text-[11.5px] not-italic text-ink-3">{r.whyItMatters}</em>
                  {r.escalations.length > 0 && (
                    <em className="mt-[3px] block text-[11px] not-italic text-ink-3">
                      {r.baseSeverity}
                      {r.severity !== r.baseSeverity ? ` → ${r.severity}` : ""} · {r.escalations.join(" · ")}
                    </em>
                  )}
                </span>
                <SeverityChip severity={r.severity} />
              </div>
            ))
          )}
        </div>
      </Card>

      <p className="mt-[14px] text-[11.5px] text-ink-3">
        Score 30 days ago:{" "}
        <b className="num font-medium text-ink-2">{before ?? "—"}</b> · change{" "}
        {delta === null ? (
          <span className="text-ink-3">—</span>
        ) : (
          <span className={`num font-medium ${delta > 0 ? "text-good-ink" : delta < 0 ? "text-crit-ink" : "text-ink-3"}`}>
            {delta > 0 ? "+" : delta < 0 ? "−" : "±"}
            {Math.abs(delta)}
          </span>
        )}{" "}
        · recomputed through the same code path on a window ending 30 days earlier, so the delta is
        apples to apples.
      </p>
    </Shell>
  );
}
