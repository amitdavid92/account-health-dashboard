/**
 * Presentation helpers shared by the pages.
 *
 * Every status here maps our real model types - HealthTier and RiskSeverity,
 * exactly as health.ts and risks.ts define them - onto the status colour
 * scale. No presentation code renames or reshapes what the model produces;
 * it only decides how each value is drawn.
 */

import type { HealthTier, RiskSeverity } from "./types";

export function money(v: number): string {
  if (v === 0) return "$0";
  if (v >= 1e6) return `$${(v / 1e6).toFixed(v >= 1e7 ? 0 : 2).replace(/\.00$/, "")}M`;
  if (v >= 1e4) return `$${Math.round(v / 1e3)}K`;
  return `$${v.toLocaleString("en-US")}`;
}

/**
 * One status entry per HealthTier, each with a chip class, a mark colour
 * (for dots, sparkline strokes, chart fills) and a text-safe ink colour.
 * Healthy/Watch/At Risk/No Data map onto good/warn/crit/none respectively -
 * the tier names a CSM reads are ours; the colour steps are the design
 * system's.
 */
export const TIER_STYLE: Record<
  HealthTier,
  { chip: string; mark: string; ink: string; wash: string; label: string }
> = {
  Healthy: {
    chip: "bg-good-wash text-good-ink",
    mark: "var(--good)",
    ink: "var(--good-ink)",
    wash: "var(--good-wash)",
    label: "Healthy",
  },
  Watch: {
    chip: "bg-warn-wash text-warn-ink",
    mark: "var(--warn)",
    ink: "var(--warn-ink)",
    wash: "var(--warn-wash)",
    label: "Watch",
  },
  "At Risk": {
    chip: "bg-crit-wash text-crit-ink",
    mark: "var(--crit)",
    ink: "var(--crit-ink)",
    wash: "var(--crit-wash)",
    label: "At Risk",
  },
  "No Data": {
    chip: "bg-none-wash text-none-ink",
    mark: "var(--none)",
    ink: "var(--none-ink)",
    wash: "var(--none-wash)",
    label: "No Data",
  },
};

/**
 * Risk severity uses the same four-step scale as tiers, but Medium sits
 * between Watch and At Risk rather than reusing Watch outright - Low is the
 * quiet "none" step, Medium and High both read as warn (amber) since our
 * model does not separate them by hue, and Critical is crit (red).
 */
export const SEVERITY_STYLE: Record<
  RiskSeverity,
  { chip: string; mark: string; ink: string }
> = {
  Low: { chip: "bg-none-wash text-none-ink", mark: "var(--none)", ink: "var(--none-ink)" },
  Medium: { chip: "bg-warn-wash text-warn-ink", mark: "var(--warn)", ink: "var(--warn-ink)" },
  High: { chip: "bg-warn-wash text-warn-ink", mark: "var(--warn)", ink: "var(--warn-ink)" },
  Critical: { chip: "bg-crit-wash text-crit-ink", mark: "var(--crit)", ink: "var(--crit-ink)" },
};

export function silenceLabel(days: number | null): string {
  if (days === null) return "never";
  if (days === 0) return "today";
  if (days === 1) return "yesterday";
  return `${days}d ago`;
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
