import type { BandKey } from "@/lib/types";

export const BAND_STYLE: Record<BandKey, { chip: string; mark: string; label: string }> = {
  good: { chip: "bg-good-wash text-good-ink", mark: "var(--good)", label: "Healthy" },
  warn: { chip: "bg-warn-wash text-warn-ink", mark: "var(--warn)", label: "Watch" },
  crit: { chip: "bg-crit-wash text-crit-ink", mark: "var(--crit)", label: "At risk" },
  none: { chip: "bg-none-wash text-none-ink", mark: "var(--none)", label: "No signal" },
};

/**
 * Each band carries a distinct glyph as well as its colour. Green and amber
 * are near-indistinguishable under protanopia, so the shape and the label do
 * the work and the colour reinforces.
 */
function BandGlyph({ band }: { band: BandKey }) {
  const common = { width: 11, height: 11, viewBox: "0 0 12 12", "aria-hidden": true as const };
  if (band === "good") {
    return (
      <svg {...common}>
        <path d="M2.4 6.3l2.2 2.2 5-5.3" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  }
  if (band === "warn") {
    return (
      <svg {...common}>
        <path d="M6 1.7l4.6 8.2H1.4Z" fill="none" stroke="currentColor" strokeWidth="1.35" strokeLinejoin="round" />
        <path d="M6 4.9v2.1" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" />
        <circle cx="6" cy="8.5" r="0.62" fill="currentColor" />
      </svg>
    );
  }
  if (band === "crit") {
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
      <circle cx="6" cy="6" r="4.6" fill="none" stroke="currentColor" strokeWidth="1.35" strokeDasharray="2.1 1.9" />
    </svg>
  );
}

export function BandChip({ band, suffix }: { band: BandKey; suffix?: string }) {
  return (
    <span
      className={`inline-flex h-[21px] items-center gap-[5px] whitespace-nowrap rounded-[5px] pl-[6px] pr-[7px] text-[11.5px] font-medium ${BAND_STYLE[band].chip}`}
    >
      <BandGlyph band={band} />
      {BAND_STYLE[band].label}
      {suffix ? ` ${suffix}` : ""}
    </span>
  );
}

export function Delta({ value, className = "" }: { value: number | null; className?: string }) {
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

export function money(v: number): string {
  if (v === 0) return "$0";
  if (v >= 1e6) return `$${(v / 1e6).toFixed(v >= 1e7 ? 0 : 2).replace(/\.00$/, "")}M`;
  if (v >= 1e3) return `$${Math.round(v / 1e3)}K`;
  return `$${v}`;
}

export function initialsOf(name: string): string {
  return name
    .replace(/[^A-Za-z ]/g, "")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0])
    .join("")
    .toUpperCase();
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
 * Weekly buckets, not daily: 90 points inside 68px is noise, and the 60-70%
 * weekend trough would read as a dip it is not.
 */
export function weeklyBuckets(series: number[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < series.length; i += 7) {
    let sum = 0;
    for (let j = i; j < Math.min(i + 7, series.length); j += 1) sum += series[j];
    out.push(sum);
  }
  return out;
}

export function Sparkline({
  series,
  band,
  width = 68,
  height = 20,
}: {
  series: number[];
  band: BandKey;
  width?: number;
  height?: number;
}) {
  const pts = weeklyBuckets(series);
  const n = pts.length;
  if (n < 2) return <span className="text-ink-3">—</span>;
  const max = Math.max(...pts) || 1;
  const px = (i: number) => (i / (n - 1)) * (width - 4) + 2;
  const py = (v: number) => height - 2.5 - (v / max) * (height - 6);

  let d = "";
  for (let i = 0; i < n; i += 1) d += `${i ? "L" : "M"}${px(i).toFixed(1)} ${py(pts[i]).toFixed(1)} `;
  const area = `${d}L${px(n - 1).toFixed(1)} ${height - 1} L${px(0).toFixed(1)} ${height - 1} Z`;
  const c = BAND_STYLE[band].mark;

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
      <circle cx={px(n - 1).toFixed(1)} cy={py(pts[n - 1]).toFixed(1)} r="2.1" fill={c} />
    </svg>
  );
}
