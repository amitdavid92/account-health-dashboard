import type { HealthTier, PillarResult, RiskSeverity } from "@/lib/types";
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

export function SeverityChip({ severity }: { severity: RiskSeverity }) {
  return (
    <span
      className={`inline-flex h-[19px] items-center whitespace-nowrap rounded-[4px] px-[7px] text-[10px] font-bold uppercase tracking-wider ${SEVERITY_STYLE[severity].chip}`}
    >
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
 */
export function PillarBar({ pillar }: { pillar: PillarResult }) {
  const pct = (pillar.points / pillar.maxPoints) * 100;
  const fill = pct >= 70 ? "var(--good)" : pct >= 35 ? "var(--warn)" : "var(--crit)";
  return (
    <div className="border-b border-hairline py-[11px] last:border-b-0">
      <div className="mb-[6px] flex items-baseline gap-2">
        <span className="text-[12.5px] font-medium">{pillar.label}</span>
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
      <p className="mt-[5px] text-[11.5px] text-ink-2">{pillar.evidence}</p>
    </div>
  );
}
