import { SEVERITY_ORDER, type HealthTier, type PillarKey, type PillarResult, type RiskSeverity } from "@/lib/types";
import { SEVERITY_STYLE, TIER_STYLE, initialsOf, money } from "@/lib/ui";

export { initialsOf, money };

/**
 * Each tier carries a distinct glyph as well as its colour. Green and amber
 * are near-indistinguishable under protanopia, so the shape and the label do
 * the work and the colour reinforces.
 */
function TierGlyph({ tier }: { tier: HealthTier }) {
  const common = { width: 11, height: 11, viewBox: "0 0 12 12", "aria-hidden": true as const };
  if (tier === "Healthy") {
    return (
      <svg {...common}>
        <path
          d="M2.4 6.3l2.2 2.2 5-5.3"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.7"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );
  }
  if (tier === "Watch") {
    return (
      <svg {...common}>
        <path
          d="M6 1.7l4.6 8.2H1.4Z"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.35"
          strokeLinejoin="round"
        />
        <path d="M6 4.9v2.1" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" />
        <circle cx="6" cy="8.5" r="0.62" fill="currentColor" />
      </svg>
    );
  }
  if (tier === "At Risk") {
    return (
      <svg {...common}>
        <circle cx="6" cy="6" r="4.6" fill="none" stroke="currentColor" strokeWidth="1.35" />
        <path d="M6 3.5v3" stroke="currentColor" strokeWidth="1.45" strokeLinecap="round" />
        <circle cx="6" cy="8.4" r="0.66" fill="currentColor" />
      </svg>
    );
  }
  return (
    <svg {...common}>
      <circle
        cx="6"
        cy="6"
        r="4.6"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.35"
        strokeDasharray="2.1 1.9"
      />
    </svg>
  );
}

/**
 * One glyph per pillar, so "Recency"/"Breadth"/"Depth"/"Consistency" are
 * recognisable by shape as well as by name - the same reasoning as TierGlyph
 * above, and drawn in the same hand: stroke-only, currentColor, no fill
 * beyond a small accent dot. Shared between the account page's pillar bars
 * and /method's pillar cards, so the same measure draws the same icon
 * wherever it appears.
 */
export function PillarGlyph({ pillarKey }: { pillarKey: PillarKey }) {
  const common = { width: 12, height: 12, viewBox: "0 0 12 12", "aria-hidden": true as const };
  if (pillarKey === "recency") {
    // A clock: the pillar is literally days-since-last-event.
    return (
      <svg {...common}>
        <circle cx="6" cy="6" r="4.5" fill="none" stroke="currentColor" strokeWidth="1.3" />
        <path
          d="M6 3.6v2.7l1.9 1.1"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.3"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );
  }
  if (pillarKey === "breadth") {
    // Two overlapping circles: reach across distinct people, not one loud user.
    return (
      <svg {...common}>
        <circle cx="4.5" cy="6" r="2.9" fill="none" stroke="currentColor" strokeWidth="1.25" opacity=".55" />
        <circle cx="7.5" cy="6" r="2.9" fill="none" stroke="currentColor" strokeWidth="1.25" />
      </svg>
    );
  }
  if (pillarKey === "depth") {
    // Stacked bars, growing: the pillar rewards content built up, not events.
    return (
      <svg {...common}>
        <path
          d="M3 3.4h6M2 6h8M1 8.6h10"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.3"
          strokeLinecap="round"
        />
      </svg>
    );
  }
  // consistency: a week strip, one box per week, the middle one lit - active
  // weeks rather than a single burst.
  return (
    <svg {...common}>
      <rect x="1.1" y="4.6" width="2.3" height="2.3" rx=".5" fill="none" stroke="currentColor" strokeWidth="1.1" />
      <rect x="4.85" y="4.6" width="2.3" height="2.3" rx=".5" fill="currentColor" opacity=".85" />
      <rect x="8.6" y="4.6" width="2.3" height="2.3" rx=".5" fill="none" stroke="currentColor" strokeWidth="1.1" />
    </svg>
  );
}

/**
 * A small flag: pole + notched pennant, in the same stroke-only hand as
 * TierGlyph and PillarGlyph. "A Healthy account still carrying a flag" is a
 * fact orthogonal to tier, so it gets its own glyph rather than borrowing a
 * tier's shape for a different meaning.
 */
function FlagGlyph() {
  return (
    <svg width="11" height="11" viewBox="0 0 12 12" aria-hidden="true">
      <path d="M2.3 1.6v8.8" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      <path d="M2.3 2.1 9.2 2.1 6.2 4.6 9.2 7.1 2.3 7.1Z" fill="currentColor" />
    </svg>
  );
}

/**
 * "N Healthy accounts still carry a flag" - built as a peer of TierChip (same
 * height, same pill shape) so it reads as one more count in the row instead
 * of a trailing sentence a reader has to parse to find the number. The full
 * explanation stays on the tooltip, but the glyph and the word "flagged" now
 * carry the meaning on their own without it.
 */
export function FlaggedChip({ count }: { count: number }) {
  return (
    <span
      className="inline-flex h-[21px] items-center gap-[5px] whitespace-nowrap rounded-[5px] bg-warn-wash pl-[6px] pr-[7px] text-[11.5px] font-medium text-warn-ink"
      title="Healthy on every usage pillar, but carrying a High or Critical flag that is not a usage problem"
    >
      <FlagGlyph />
      {count} flagged
    </span>
  );
}

export function TierChip({ tier, suffix }: { tier: HealthTier; suffix?: string }) {
  return (
    <span
      className={`inline-flex h-[21px] items-center gap-[5px] whitespace-nowrap rounded-[5px] pl-[6px] pr-[7px] text-[11.5px] font-medium ${TIER_STYLE[tier].chip}`}
    >
      <TierGlyph tier={tier} />
      {TIER_STYLE[tier].label}
      {suffix ? ` ${suffix}` : ""}
    </span>
  );
}

/**
 * A four-bar meter, one bar per step of SEVERITY_ORDER - the same list
 * risks.ts sorts by, so "how many bars are lit" and "how severe" can never
 * disagree. Bars, not four unrelated symbols, because severity is ordinal
 * (Critical is more of the same thing High is, not a different thing) -
 * unlike HealthTier, which is why TierGlyph draws a different shape per tier
 * instead of a meter.
 */
function SeverityGlyph({ severity }: { severity: RiskSeverity }) {
  const level = SEVERITY_ORDER.indexOf(severity) + 1;
  const bars = [
    { x: 0.7, h: 3.0 },
    { x: 3.5, h: 4.9 },
    { x: 6.3, h: 6.8 },
    { x: 9.1, h: 8.7 },
  ];
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true" className="shrink-0">
      {bars.map((b, i) => (
        <rect
          key={b.x}
          x={b.x}
          y={10.2 - b.h}
          width="1.7"
          height={b.h}
          rx=".4"
          fill={i < level ? "currentColor" : "none"}
          stroke="currentColor"
          strokeWidth={i < level ? "0" : "1"}
          opacity={i < level ? "1" : ".4"}
        />
      ))}
    </svg>
  );
}

export function SeverityChip({ severity }: { severity: RiskSeverity }) {
  return (
    <span
      className={`inline-flex h-[19px] items-center gap-[5px] whitespace-nowrap rounded-[4px] pl-[6px] pr-[7px] text-[10px] font-bold uppercase tracking-wider ${SEVERITY_STYLE[severity].chip}`}
    >
      <SeverityGlyph severity={severity} />
      {severity}
    </span>
  );
}

export function Card({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section
      className={`rounded-[11px] border border-hairline bg-surface shadow-[var(--card-shadow)] ${className}`}
    >
      {children}
    </section>
  );
}

export function CardHead({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children?: React.ReactNode;
}) {
  return (
    <header className="flex items-baseline gap-[10px] px-4 pt-[14px]">
      <h2 className="text-[13.5px] font-semibold tracking-[-0.005em]">{title}</h2>
      {hint ? <span className="ml-auto text-[11.5px] text-ink-3">{hint}</span> : null}
      {children}
    </header>
  );
}

/**
 * Progressive disclosure, on native `<details>`.
 *
 * Native because it costs nothing and already behaves: keyboard (Tab then
 * Enter or Space), touch, mouse, screen-reader expanded state, and find-in-page
 * on closed content in current browsers. It also works inside a server
 * component, so moving an explanation behind one of these does not drag a page
 * across the client boundary.
 *
 * The rule for what goes in here: the collapsed page must stand on its own.
 * A disclosure holds the derivation, the assumption or the business reasoning -
 * never a fact you would be wrong without.
 */
export function Disclosure({
  label,
  children,
  className = "",
}: {
  label: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <details className={`group ${className}`}>
      <summary className="flex cursor-pointer list-none items-center gap-[5px] py-[5px] text-[11.5px] text-ink-3 marker:hidden hover:text-ink-2 [&::-webkit-details-marker]:hidden">
        <svg
          width="9"
          height="9"
          viewBox="0 0 10 10"
          aria-hidden="true"
          className="shrink-0 transition-transform duration-150 group-open:rotate-90"
        >
          <path d="M3 1.5 7 5l-4 3.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        {label}
      </summary>
      <div className="pb-[6px] pt-[3px] text-[11.5px] leading-[1.55] text-ink-2">{children}</div>
    </details>
  );
}

/**
 * A row's worth of the 13-week activity series, drawn as a weekly line +
 * area. Weekly rather than daily: 90 points inside 68px is noise, and this
 * dataset's median account produces ~2 events a week, so a daily line would
 * be a staircase of zeroes with the odd spike, not a shape.
 */
export function Sparkline({
  weekly,
  tier,
  width = 68,
  height = 20,
}: {
  weekly: number[];
  tier: HealthTier;
  width?: number;
  height?: number;
}) {
  const n = weekly.length;
  if (n < 2) return <span className="text-ink-3">—</span>;
  const max = Math.max(...weekly) || 1;
  const px = (i: number) => (i / (n - 1)) * (width - 4) + 2;
  const py = (v: number) => height - 2.5 - (v / max) * (height - 6);

  let d = "";
  for (let i = 0; i < n; i += 1) d += `${i ? "L" : "M"}${px(i).toFixed(1)} ${py(weekly[i]).toFixed(1)} `;
  const area = `${d}L${px(n - 1).toFixed(1)} ${height - 1} L${px(0).toFixed(1)} ${height - 1} Z`;
  const c = TIER_STYLE[tier].mark;

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      width={width}
      height={height}
      preserveAspectRatio="none"
      aria-hidden="true"
      className="block"
    >
      <path d={area} fill={c} fillOpacity="0.1" />
      <path d={d} fill="none" stroke={c} strokeWidth="1.6" strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={px(n - 1).toFixed(1)} cy={py(weekly[n - 1]).toFixed(1)} r="2.1" fill={c} />
    </svg>
  );
}

/**
 * One row of "why this score": a pillar's label, its points out of its
 * maximum, and the evidence sentence underneath. The points shown here are
 * already the final contribution - the model has no separate weight-times-
 * subscore step to unpack, so this is simpler than a generic weighted-
 * dimension bar and that simplicity is itself part of the story: the score
 * is exactly the sum of these numbers, nothing is renormalised afterwards.
 *
 * `fact` replaces the full evidence sentence with the compact form from
 * facts.ts; `note` carries the one case where a number needs a word of context
 * to not read as a bug (depth's partial credit). With neither supplied the bar
 * falls back to the evidence sentence, so the component is still usable on its
 * own terms.
 */
export function PillarBar({
  pillar,
  fact,
  note,
}: {
  pillar: PillarResult;
  fact?: string;
  note?: string | null;
}) {
  const pct = (pillar.points / pillar.maxPoints) * 100;
  const fill = pct >= 70 ? "var(--good)" : pct >= 35 ? "var(--warn)" : "var(--crit)";
  return (
    <div className="border-b border-hairline py-[9px] last:border-b-0">
      <div className="mb-[5px] flex items-baseline gap-2">
        {/* Icon + label as one inline-flex unit, centered against each other
            (the same construction TierChip uses for TierGlyph) - the row
            around it stays baseline-aligned for the rest of the text. */}
        <span className="inline-flex items-center gap-[6px]">
          <span className="text-ink-3">
            <PillarGlyph pillarKey={pillar.key} />
          </span>
          <span className="text-[12.5px] font-medium">{pillar.label}</span>
        </span>
        <span className="num text-[11px] text-ink-3">of {pillar.maxPoints}</span>
        <span className="num ml-auto text-[12px] text-ink-2">
          <b className="font-semibold text-ink">{pillar.points}</b> pts
        </span>
      </div>
      <div className="flex items-center gap-[10px]">
        <div className="h-2 flex-1 overflow-hidden rounded-[4px] bg-track">
          <div className="h-2 rounded-r-[4px]" style={{ width: `${pct}%`, background: fill }} />
        </div>
      </div>
      <p className="num mt-[5px] text-[11.5px] text-ink-2">{fact ?? pillar.evidence}</p>
      {note && <p className="mt-[2px] text-[11px] text-ink-3">{note}</p>}
    </div>
  );
}
