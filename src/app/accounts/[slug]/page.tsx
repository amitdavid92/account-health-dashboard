import Link from "next/link";
import { notFound } from "next/navigation";
import { Shell } from "@/components/shell";
import { Card, CardHead, Disclosure, PillarBar, SeverityChip, TierChip, money } from "@/components/primitives";
import { TrendChart } from "@/components/trend-chart";
import { getAccountDetail, getRawData } from "@/lib/db";
import {
  confidenceFact,
  depthPartialCredit,
  overrideFact,
  pillarFact,
  riskFact,
  splitOverrides,
} from "@/lib/facts";
import { scoresThirtyDaysAgo } from "@/lib/history";
import { trendFor } from "@/lib/pipeline";
import { suggestedAction } from "@/lib/recommendations";
import { SEVERITY_STYLE, TIER_STYLE, silenceLabel } from "@/lib/ui";
import { TREND, WINDOW } from "@/lib/config";
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

/** A short amber badge. Used where a caveat must stay visible but must not
 *  cost a paragraph - the paragraph lives one disclosure away. */
function LowConfidenceBadge({ detail }: { detail: AccountSummary }) {
  return (
    <span className="mt-[6px] flex flex-wrap items-center gap-x-[6px] gap-y-[3px] text-[11.5px]">
      <span className="inline-flex h-[17px] shrink-0 items-center rounded-[4px] bg-warn-wash px-[6px] text-[10px] font-semibold uppercase tracking-wider text-warn-ink">
        Low confidence
      </span>
      <span className="num text-ink-2">{confidenceFact(detail.metrics)}</span>
    </span>
  );
}

/**
 * The action box: one recommendation, the facts behind it, and nothing else
 * above the fold.
 *
 * Health and priority are separate axes, and this box has to hold both without
 * contradicting itself. An account can be Healthy on all four usage pillars and
 * still carry a High flag that needs a human - the tier stays Healthy, because
 * nothing commercial moves a usage score, but the suggested action comes from
 * the flag rather than from the tier.
 *
 * "Suggested action" is the honest label: it is a fixed mapping from the
 * leading risk (recommendations.ts), not something the data proves. The
 * derivation, the priority formula and the confidence paragraph sit in the
 * disclosure, which is the only thing in this box a CSM can skip.
 */
function WhatToDo({ detail }: { detail: AccountSummary }) {
  const { health, account, metrics, topRisk } = detail;
  const action = suggestedAction(health.tier, topRisk);

  // One or two short facts: the leading risk's own number, then recency - the
  // two things a CSM checks before picking up the phone.
  const facts =
    health.tier === "No Data"
      ? [`No events in the ${WINDOW.totalDays}-day window`]
      : [
          topRisk ? riskFact(topRisk, metrics, account) : pillarFact("breadth", metrics),
          pillarFact("recency", metrics),
        ];

  return (
    <>
      <p className="text-[12.5px] leading-[1.5] text-ink-2">
        <b className="font-medium text-ink">Suggested action:</b> {action}
      </p>
      <p className="num mt-[5px] text-[11.5px] text-ink-2">{facts.join(" · ")}</p>

      {/* No Data is already stated in full by the fact line above, and "Only 0
          events" reads as a bug rather than a caveat - the badge is for the
          account that was scored on thin evidence, which is the case a reader
          can otherwise miss. */}
      {health.lowConfidence && health.tier !== "No Data" && <LowConfidenceBadge detail={detail} />}

      <Disclosure label="How this is decided" className="mt-[7px] border-t border-hairline pt-[3px]">
        <p>
          The action is a fixed mapping from the highest-severity risk already detected on this
          account — a triage convention, not a prediction. Where no rule fired it falls back to
          wording for the tier, which says only that nothing was flagged, not that the account is
          safe.
        </p>
        {health.confidenceNote && <p className="mt-[6px]">{health.confidenceNote}</p>}
        {account.arrUsd > 0 && (
          <p className="mt-[6px]">
            Ordering in the triage queue weights {money(account.arrUsd)} ARR by tier, taking a floor
            from the most severe risk where there is one. It is an operational call order, not a
            churn forecast — and ARR is never part of the health score above. See{" "}
            <Link href="/method">how health is scored</Link>.
          </p>
        )}
      </Disclosure>
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
  const { binding, nonBinding } = splitOverrides(health);

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
              <div className="py-5">
                <p className="mb-[5px] text-[13px] font-medium text-ink">Held out of scoring</p>
                <p className="text-[12.5px] text-ink-2">
                  No usage events were received for this account in the window.
                </p>
                <Disclosure label="What to check" className="mt-[7px]">
                  <p>{health.confidenceNote}</p>
                </Disclosure>
              </div>
            ) : (
              <>
                {health.pillars.map((p) => (
                  <PillarBar
                    key={p.key}
                    pillar={p}
                    fact={pillarFact(p.key, metrics)}
                    note={depthPartialCredit(metrics, p)}
                  />
                ))}
                <div className="mt-1 flex items-baseline gap-2 border-t border-hairline-strong pb-[2px] pt-[10px]">
                  <span className="text-[12.5px] font-medium">Health score</span>
                  <span className="num ml-auto text-[15px] font-bold">{health.score} / 100</span>
                </div>

                {/* A cap that changed the verdict is the reason for the tier, so
                    it stays visible. A cap that agreed with the score changed
                    nothing, and showing it as though it decided the outcome
                    would overstate what happened - it goes in the disclosure. */}
                {binding.length > 0 && (
                  <div className="mt-[10px] border-t border-hairline pt-[9px]">
                    <p className="mb-[5px] text-[11px] font-medium uppercase tracking-[0.05em] text-ink-3">
                      Tier overruled the score
                    </p>
                    <ul className="flex flex-col gap-[4px]">
                      {binding.map((o) => (
                        <li key={o.code} className="text-[11.5px] text-ink-2">
                          <span className="num font-medium text-ink">
                            {health.tierFromScore} → {health.tier}
                          </span>{" "}
                          · {overrideFact(o, metrics)}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                <Disclosure
                  label="How this score is calculated"
                  className="mt-[8px] border-t border-hairline pt-[3px]"
                >
                  <p>
                    Each input scores into a fixed band and the four results are added. The points
                    above sum exactly to the score — nothing is weighted or renormalised afterwards.
                    Full bands and thresholds: <Link href="/method">how health is scored</Link>.
                  </p>
                  <ul className="mt-[7px] flex flex-col gap-[5px]">
                    {health.pillars.map((p) => (
                      <li key={p.key}>
                        <b className="font-medium text-ink">
                          {p.label} {p.points}/{p.maxPoints}
                        </b>{" "}
                        — {p.evidence}
                      </li>
                    ))}
                  </ul>
                  {nonBinding.length > 0 && (
                    <>
                      <p className="mt-[9px] font-medium text-ink">
                        Limits that applied but did not change the tier
                      </p>
                      <ul className="mt-[4px] flex flex-col gap-[5px]">
                        {nonBinding.map((o) => (
                          <li key={o.code}>
                            {o.reason}{" "}
                            <span className="text-ink-3">
                              (caps the tier at {o.cappedAt}; the score alone already said{" "}
                              {health.tierFromScore})
                            </span>
                          </li>
                        ))}
                      </ul>
                    </>
                  )}
                </Disclosure>
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
              <div className="-mt-1 px-4 pb-[10px]">
                <p className="text-[11.5px] text-ink-3">
                  {trend.suppressedBecause === "too_few_events"
                    ? "Trend unavailable · insufficient events"
                    : trend.suppressedBecause === "no_baseline"
                      ? "Trend unavailable · no prior baseline"
                      : "Change below the display threshold"}
                </p>
                <Disclosure label="Why this is not shown" className="mt-[1px]">
                  {trend.suppressedBecause === "too_few_events" ? (
                    <p>
                      {metrics.totalEvents} events in {WINDOW.totalDays} days is below the{" "}
                      {TREND.minEvents}-event floor this dashboard requires before comparing one
                      30-day window against another.
                    </p>
                  ) : trend.suppressedBecause === "no_baseline" ? (
                    <p>
                      No events at all in the {WINDOW.priorDays} days before the recent window, so
                      there is no denominator to express a change against.
                    </p>
                  ) : (
                    <p>
                      The last {WINDOW.recentDays} days are{" "}
                      {trend.changePct !== null
                        ? `${trend.changePct >= 0 ? "+" : "−"}${Math.abs(Math.round(trend.changePct * 100))}%`
                        : "within"}{" "}
                      against the prior run rate, below the{" "}
                      {Math.round(TREND.minChange * 100)}% this dashboard requires before showing a
                      direction.
                    </p>
                  )}
                  <p className="mt-[6px]">
                    Both thresholds are display choices for a low-volume dataset, not a test of
                    statistical significance — none is performed. Trend is never scored. See{" "}
                    <Link href="/method">how health is scored</Link>.
                  </p>
                </Disclosure>
              </div>
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
        <CardHead title="Risks" hint={risks.length ? `${risks.length} detected` : undefined} />
        <div className="mt-2">
          {risks.length === 0 ? (
            <p className="px-4 py-4 text-[12.5px] text-ink-3">
              No risk rule fired on this account in this window.
            </p>
          ) : (
            risks.map((r) => (
              <div
                key={r.code}
                className="grid grid-cols-[16px_1fr_auto] items-start gap-[10px] border-b border-hairline px-4 py-[9px] last:border-b-0"
              >
                <span
                  className="mt-[5px] inline-block h-2 w-2 justify-self-center rounded-full"
                  style={{ background: SEVERITY_STYLE[r.severity].mark }}
                />
                <span className="min-w-0 text-[12.5px]">
                  {r.title}
                  {r.affectsHealth && (
                    <span className="ml-[6px] text-[10px] font-semibold uppercase tracking-wider text-ink-3">
                      affects health
                    </span>
                  )}
                  <em className="num mt-[2px] block text-[11.5px] not-italic text-ink-2">
                    {riskFact(r, metrics, account)}
                  </em>
                  <Disclosure label="Details" className="mt-[1px]">
                    <p>{r.evidence}</p>
                    <p className="mt-[5px]">{r.whyItMatters}</p>
                    <p className="mt-[5px] text-ink-3">
                      {r.baseSeverity} (base)
                      {r.severity !== r.baseSeverity ? ` → ${r.severity}` : ""}
                      {r.escalations.length > 0 ? ` · ${r.escalations.join(" · ")}` : ""}
                    </p>
                  </Disclosure>
                </span>
                <SeverityChip severity={r.severity} />
              </div>
            ))
          )}
        </div>
      </Card>

      <div className="mt-[12px]">
        <p className="text-[11.5px] text-ink-3">
          30-day score change · reconstructed:{" "}
          <b className="num font-medium text-ink-2">{before ?? "—"}</b> →{" "}
          <b className="num font-medium text-ink-2">{health.tier === "No Data" ? "—" : health.score}</b>{" "}
          {delta === null ? (
            <span className="text-ink-3">—</span>
          ) : (
            <span className={`num font-medium ${delta > 0 ? "text-good-ink" : delta < 0 ? "text-crit-ink" : "text-ink-3"}`}>
              ({delta > 0 ? "+" : delta < 0 ? "−" : "±"}
              {Math.abs(delta)})
            </span>
          )}
          {health.lowConfidence && (
            <span className="ml-[6px] inline-flex h-[16px] items-center rounded-[4px] bg-warn-wash px-[5px] text-[10px] font-semibold uppercase tracking-wider text-warn-ink">
              Low confidence
            </span>
          )}
        </p>
        <Disclosure label="How this comparison is produced">
          <p>
            Not a verdict recorded at the time — no health history is stored. This re-runs the same
            code path over the events of this export that predate that day, so it can only see what
            the export itself covers.
          </p>
          {health.lowConfidence && (
            <p className="mt-[6px]">
              On {metrics.totalEvents} events in the window, both ends of this comparison rest on
              very little activity. Read the direction, not the size.
            </p>
          )}
        </Disclosure>
      </div>
    </Shell>
  );
}
