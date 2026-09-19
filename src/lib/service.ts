import { BAND_LABELS, BAND_THRESHOLDS } from "./health";
import { buildBook, loadRaw, WINDOW_DAYS, type BuiltBook } from "./pipeline";
import type { AccountHealth, BandKey, BookSummary, DataQualityNote, PlanTier } from "./types";

/**
 * The single source of truth for computed health. Both the route handlers and
 * the server components call this, so the API and the UI can never disagree
 * about a number.
 *
 * The export is a static snapshot, so the whole book is computed once per
 * process and memoised. Swap this module for a warehouse query and nothing
 * upstream changes - see "What I'd build next" in the README.
 */
let cache: BuiltBook | null = null;

export function getBook(): BuiltBook {
  if (!cache) cache = buildBook(loadRaw());
  return cache;
}

export interface BookQuery {
  band?: BandKey[];
  plan?: PlanTier | "all";
  csm?: string | "all";
  q?: string;
  sort?: SortKey;
  dir?: "asc" | "desc";
}

export type SortKey = "score" | "name" | "arr" | "delta" | "plan" | "csm" | "activity";

export const SORT_KEYS: SortKey[] = ["score", "name", "arr", "delta", "plan", "csm", "activity"];

/** Unscored accounts sort last on every key, so the queue never leads with them. */
function compare(a: AccountHealth, b: AccountHealth, key: SortKey, dir: 1 | -1): number {
  const nullsLast = (x: number | null, y: number | null): number | null => {
    if (x === null && y === null) return 0;
    if (x === null) return 1;
    if (y === null) return -1;
    return null;
  };

  switch (key) {
    case "name":
      return a.name.localeCompare(b.name) * dir;
    case "plan": {
      const order: Record<PlanTier, number> = { Enterprise: 0, Pro: 1, Free: 2 };
      return (order[a.plan] - order[b.plan]) * dir;
    }
    case "csm":
      return a.csm.localeCompare(b.csm) * dir;
    case "arr":
      return (a.arr - b.arr) * dir;
    case "activity":
      return (a.metrics.events30 - b.metrics.events30) * dir;
    case "delta": {
      const n = nullsLast(a.scoreDelta, b.scoreDelta);
      if (n !== null) return n;
      return ((a.scoreDelta as number) - (b.scoreDelta as number)) * dir;
    }
    case "score":
    default: {
      const n = nullsLast(a.health.score, b.health.score);
      if (n !== null) return n;
      return ((a.health.score as number) - (b.health.score as number)) * dir;
    }
  }
}

export function queryAccounts(query: BookQuery = {}): AccountHealth[] {
  const { accounts } = getBook();
  const bands = query.band && query.band.length ? new Set(query.band) : null;
  const needle = query.q?.trim().toLowerCase();

  const filtered = accounts.filter((a) => {
    if (bands && !bands.has(a.health.band)) return false;
    if (query.plan && query.plan !== "all" && a.plan !== query.plan) return false;
    if (query.csm && query.csm !== "all" && a.csm !== query.csm) return false;
    if (needle) {
      const hay = `${a.name} ${a.domain} ${a.csm}`.toLowerCase();
      if (!hay.includes(needle)) return false;
    }
    return true;
  });

  const key = query.sort ?? "score";
  const dir = (query.dir ?? (key === "name" || key === "plan" || key === "csm" ? "asc" : "asc")) === "asc" ? 1 : -1;
  return [...filtered].sort((a, b) => compare(a, b, key, dir as 1 | -1));
}

export function getAccount(slug: string): AccountHealth | null {
  return getBook().accounts.find((a) => a.slug === slug) ?? null;
}

export function getDataQuality(): DataQualityNote[] {
  return getBook().dataQuality;
}

export function getCsmOwners(): string[] {
  return [...new Set(getBook().accounts.map((a) => a.csm))].sort();
}

const BAND_ORDER: BandKey[] = ["crit", "warn", "good", "none"];

export function getSummary(): BookSummary {
  const { accounts, snapshotUTC, totalEvents } = getBook();
  const scored = accounts.filter((a) => a.health.score !== null);
  const heldOut = accounts.filter((a) => a.health.score === null);

  const scores = scored.map((a) => a.health.score as number).sort((x, y) => x - y);
  const median = scores.length
    ? scores.length % 2
      ? scores[(scores.length - 1) / 2]
      : Math.round((scores[scores.length / 2 - 1] + scores[scores.length / 2]) / 2)
    : 0;

  const deltas = scored.map((a) => a.scoreDelta).filter((d): d is number => d !== null);
  const medianDelta = deltas.length
    ? Math.round(deltas.reduce((s, d) => s + d, 0) / deltas.length)
    : 0;

  const distribution = BAND_ORDER.map((band) => {
    const group = accounts.filter((a) => a.health.band === band);
    return {
      band,
      label: BAND_LABELS[band],
      accounts: group.length,
      arr: group.reduce((s, a) => s + a.arr, 0),
    };
  });

  return {
    snapshot: new Date(snapshotUTC).toISOString().slice(0, 10),
    windowDays: WINDOW_DAYS,
    totalEvents,
    accounts: accounts.length,
    scored: scored.length,
    heldOut: heldOut.length,
    arrTotal: accounts.reduce((s, a) => s + a.arr, 0),
    arrAtRisk: accounts
      .filter((a) => a.health.band === "crit")
      .reduce((s, a) => s + a.arr, 0),
    arrBelowHealthy: accounts
      .filter((a) => a.health.band === "crit" || a.health.band === "warn")
      .reduce((s, a) => s + a.arr, 0),
    medianScore: median,
    medianDelta,
    distribution,
  };
}

export { BAND_LABELS, BAND_THRESHOLDS, WINDOW_DAYS };

/** Parse the shared query-string contract used by both the pages and the API. */
export function parseQuery(sp: Record<string, string | string[] | undefined>): BookQuery {
  const one = (v: string | string[] | undefined): string | undefined =>
    Array.isArray(v) ? v[0] : v;

  const bandRaw = sp.band;
  const bandList = (Array.isArray(bandRaw) ? bandRaw : bandRaw ? [bandRaw] : [])
    .flatMap((b) => b.split(","))
    .map((b) => b.trim())
    .filter((b): b is BandKey => (["good", "warn", "crit", "none"] as string[]).includes(b));

  const sortRaw = one(sp.sort);
  const dirRaw = one(sp.dir);
  const planRaw = one(sp.plan);

  return {
    band: bandList,
    plan:
      planRaw === "Free" || planRaw === "Pro" || planRaw === "Enterprise" ? planRaw : "all",
    csm: one(sp.csm) || "all",
    q: one(sp.q) || "",
    sort: SORT_KEYS.includes(sortRaw as SortKey) ? (sortRaw as SortKey) : "score",
    dir: dirRaw === "desc" ? "desc" : "asc",
  };
}
