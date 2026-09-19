import { readFileSync } from "node:fs";
import { join } from "node:path";
import { computeHealth, BAND_LABELS } from "./health";
import type {
  AccountHealth,
  AccountMetrics,
  AccountRow,
  BandKey,
  DataQualityNote,
  EventType,
  PlanTier,
  Signal,
  UsageEvent,
  WorkspaceRollup,
} from "./types";

export const WINDOW_DAYS = 90;
const DAY_MS = 86_400_000;
const EVENT_TYPES: EventType[] = [
  "guide_created",
  "guide_viewed",
  "guide_shared",
  "user_invited",
  "login",
];

/* ------------------------------------------------------------------ *
 * Identity resolution
 * ------------------------------------------------------------------ */

/**
 * company_name is not a clean 1:1 with workspace_id, and the same account
 * arrives spelled several ways ("Orcus Retail Group", "Orcus Retail Grp.",
 * "ORCUS RETAIL GROUP"). Normalising for comparison only - the display name
 * always comes from accounts.json, which is the commercial source of truth.
 */
export function normalizeName(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[.,'']/g, "")
    .replace(/\b(inc|llc|ltd|limited|corp|corporation|co|group|grp|plc|gmbh|sa|bv)\b/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

export function slugify(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/&/g, "-and-")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Domain stem, e.g. northwind-analytics.com -> northwindanalytics */
function domainStem(domain: string): string {
  const host = domain.toLowerCase().replace(/^www\./, "");
  const label = host.split(".")[0] ?? host;
  return label.replace(/[^a-z0-9]/g, "");
}

/* ------------------------------------------------------------------ *
 * Loading
 * ------------------------------------------------------------------ */

function dataPath(file: string): string {
  return join(process.cwd(), "data", file);
}

export interface RawData {
  events: UsageEvent[];
  accounts: AccountRow[];
}

export function loadRaw(): RawData {
  const events = JSON.parse(readFileSync(dataPath("usage_events.json"), "utf8")) as UsageEvent[];
  const accounts = JSON.parse(readFileSync(dataPath("accounts.json"), "utf8")) as AccountRow[];
  return { events, accounts };
}

/* ------------------------------------------------------------------ *
 * Bucketing
 * ------------------------------------------------------------------ */

interface DayBucket {
  counts: Record<EventType, number>;
  users: Set<string>;
}

interface AccountBuckets {
  days: DayBucket[];
  workspaces: Map<string, number>;
  nameVariants: Set<string>;
  planByDay: (PlanTier | null)[];
  total: number;
}

function emptyBuckets(): AccountBuckets {
  return {
    days: Array.from({ length: WINDOW_DAYS }, () => ({
      counts: { guide_created: 0, guide_viewed: 0, guide_shared: 0, user_invited: 0, login: 0 },
      users: new Set<string>(),
    })),
    workspaces: new Map(),
    nameVariants: new Set(),
    planByDay: Array.from({ length: WINDOW_DAYS }, () => null),
    total: 0,
  };
}

/**
 * Snapshot = the day of the most recent event in the export, not "today".
 * Anchoring to wall-clock time would silently re-band every account as the
 * file ages, which is exactly the kind of drift that makes a dashboard
 * untrustworthy.
 */
export function snapshotFrom(events: UsageEvent[]): number {
  let max = 0;
  for (const e of events) {
    const t = Date.parse(e.timestamp);
    if (t > max) max = t;
  }
  const d = new Date(max);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

function dayIndex(timestamp: string, snapshotUTC: number): number {
  const t = Date.parse(timestamp);
  const d = new Date(t);
  const day = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  return WINDOW_DAYS - 1 - Math.round((snapshotUTC - day) / DAY_MS);
}

/* ------------------------------------------------------------------ *
 * Metrics
 * ------------------------------------------------------------------ */

/**
 * Metrics for a window ending at `endDay` (inclusive index into the buckets).
 * Passing an earlier endDay is how the 30-day-ago score is recomputed, so the
 * delta on screen comes from the same code path as the live score.
 */
function metricsFor(b: AccountBuckets, endDay: number): AccountMetrics {
  const from = (start: number, end: number, type: EventType) => {
    let n = 0;
    for (let i = Math.max(0, start); i <= end && i < WINDOW_DAYS; i += 1) n += b.days[i].counts[type];
    return n;
  };
  const allFrom = (start: number, end: number) => {
    let n = 0;
    for (let i = Math.max(0, start); i <= end && i < WINDOW_DAYS; i += 1) {
      for (const t of EVENT_TYPES) n += b.days[i].counts[t];
    }
    return n;
  };
  const usersFrom = (start: number, end: number) => {
    const s = new Set<string>();
    for (let i = Math.max(0, start); i <= end && i < WINDOW_DAYS; i += 1) {
      for (const u of b.days[i].users) s.add(u);
    }
    return s;
  };

  const w30Start = endDay - 29;
  const created30 = from(w30Start, endDay, "guide_created");
  const created90 = from(0, endDay, "guide_created");
  const viewed30 = from(w30Start, endDay, "guide_viewed");
  const viewed90 = from(0, endDay, "guide_viewed");
  const shared30 = from(w30Start, endDay, "guide_shared");
  const invited30 = from(w30Start, endDay, "user_invited");
  const logins30 = from(w30Start, endDay, "login");
  const events30 = allFrom(w30Start, endDay);
  const eventsPrior30 = allFrom(endDay - 59, w30Start - 1);
  const activeUsers30 = usersFrom(w30Start, endDay).size;
  const knownUsers = usersFrom(0, endDay).size;
  const totalEvents = allFrom(0, endDay);

  let lastCreate: number | null = null;
  let lastEvent: number | null = null;
  for (let i = Math.min(endDay, WINDOW_DAYS - 1); i >= 0; i -= 1) {
    const c = b.days[i].counts;
    const any = EVENT_TYPES.reduce((s, t) => s + c[t], 0);
    if (lastEvent === null && any > 0) lastEvent = i;
    if (lastCreate === null && c.guide_created > 0) lastCreate = i;
    if (lastEvent !== null && lastCreate !== null) break;
  }

  let runRateBeforeLastEvent = 0;
  if (lastEvent !== null) {
    const start = Math.max(0, lastEvent - 6);
    const span = lastEvent - start + 1;
    runRateBeforeLastEvent = allFrom(start, lastEvent) / span;
  }

  return {
    created30,
    created90,
    viewed30,
    viewed90,
    shared30,
    invited30,
    logins30,
    activeUsers30,
    knownUsers,
    events30,
    eventsPrior30,
    totalEvents,
    daysSinceLastCreate: lastCreate === null ? null : endDay - lastCreate,
    daysSinceLastEvent: lastEvent === null ? null : endDay - lastEvent,
    runRateBeforeLastEvent,
    viewsPerGuide: created90 === 0 ? 0 : viewed90 / created90,
    libraryViewRate: created90 === 0 ? 0 : viewed30 / created90,
    createsPerKnownSeat: created30 / Math.max(1, knownUsers),
  };
}

/* ------------------------------------------------------------------ *
 * Signals - the evidence list on the drill-down
 * ------------------------------------------------------------------ */

function buildSignals(a: {
  metrics: AccountMetrics;
  health: ReturnType<typeof computeHealth>;
  workspaces: WorkspaceRollup[];
  planTierChanges: { day: number; from: PlanTier; to: PlanTier }[];
  nameVariants: string[];
  scoreDelta: number | null;
  seatsKnown: number;
}): Signal[] {
  const out: Signal[] = [];
  const m = a.metrics;
  const days = (n: number | null) => (n === null ? "—" : `${n}d`);

  if (!a.health.scored) {
    out.push({
      level: "none",
      title:
        a.health.heldOutReason === "no_events"
          ? "No events in the window"
          : "Event stream stops mid-window",
      detail: a.health.heldOutDetail ?? "",
      age: days(m.daysSinceLastEvent),
    });
  }

  const dim = (k: string) => a.health.dimensions.find((d) => d.key === k);

  const creation = dim("creation");
  if (creation && a.health.scored && creation.subscore < 40) {
    out.push({
      level: "crit",
      title: `Creation at ${creation.subscore}/100`,
      detail: creation.evidence,
      age: days(m.daysSinceLastCreate),
    });
  }

  const breadth = dim("breadth");
  if (breadth && a.health.scored && breadth.subscore < 45) {
    out.push({
      level: m.activeUsers30 / Math.max(1, m.knownUsers) < 0.25 ? "crit" : "warn",
      title: `${Math.round((m.activeUsers30 / Math.max(1, m.knownUsers)) * 100)}% of known users active`,
      detail: `${m.activeUsers30} of ${m.knownUsers} seen in 30d — concentration risk if the champion leaves`,
      age: "30d",
    });
  }

  const value = dim("value");
  if (value && a.health.scored && value.subscore < 50) {
    out.push({
      level: "warn",
      title: `Library watched ${Math.round(m.libraryViewRate * 10) / 10}x per guide`,
      detail: `${m.viewed30} views in 30d across ~${m.created90} guides — content going unwatched`,
      age: "30d",
    });
  }

  if (a.health.scored && m.daysSinceLastCreate !== null && m.daysSinceLastCreate >= 14) {
    out.push({
      level: m.daysSinceLastCreate >= 30 ? "crit" : "warn",
      title: `Nothing created in ${m.daysSinceLastCreate} days`,
      detail:
        m.logins30 > 0
          ? `Still ${m.logins30} logins in 30d — people arrive but do not build`
          : "No logins in the last 30 days either",
      age: days(m.daysSinceLastCreate),
    });
  }

  if (a.scoreDelta !== null && a.scoreDelta <= -8) {
    out.push({
      level: "crit",
      title: `Score down ${Math.abs(a.scoreDelta)} points in 30 days`,
      detail: dim("momentum")?.evidence ?? "",
      age: "30d",
    });
  } else if (a.scoreDelta !== null && a.scoreDelta >= 8) {
    out.push({
      level: "good",
      title: `Score up ${a.scoreDelta} points in 30 days`,
      detail: dim("momentum")?.evidence ?? "",
      age: "30d",
    });
  }

  const collab = dim("collab");
  if (collab && a.health.scored && m.shared30 + m.invited30 === 0) {
    out.push({
      level: "warn",
      title: "No shares or invites in 30 days",
      detail: "Footprint static — the quietest early churn tell",
      age: "30d",
    });
  }

  if (a.workspaces.length > 1) {
    out.push({
      level: "warn",
      title: `Runs ${a.workspaces.length} workspaces`,
      detail: `Rolled up on domain: ${a.workspaces.map((w) => w.workspace_id).join(", ")}`,
      age: "—",
    });
  }

  if (a.nameVariants.length > 1) {
    out.push({
      level: "warn",
      title: `Name arrived ${a.nameVariants.length} ways in the export`,
      detail: a.nameVariants.map((n) => `"${n}"`).join(", "),
      age: "—",
    });
  }

  for (const c of a.planTierChanges) {
    out.push({
      level: "warn",
      title: `Plan changed ${c.from} → ${c.to} on day ${c.day + 1}`,
      detail: "accounts.json is treated as current truth; the change is kept as a signal",
      age: `${WINDOW_DAYS - c.day}d`,
    });
  }

  // Never leave the queue's "signal to act on" column empty: an account with
  // no threshold tripped still has a weakest input, and that is the useful
  // thing to tell a CSM.
  if (a.health.scored && out.length === 0) {
    const weakest = [...a.health.dimensions].sort((x, y) => x.subscore - y.subscore)[0];
    out.push({
      level: a.health.band === "good" ? "good" : "warn",
      title:
        a.health.band === "good"
          ? `No open risks · weakest is ${weakest.name.toLowerCase()}`
          : `Weakest input: ${weakest.name.toLowerCase()} at ${weakest.subscore}/100`,
      detail: weakest.evidence,
      age: "30d",
    });
  }

  return out;
}

/* ------------------------------------------------------------------ *
 * Build
 * ------------------------------------------------------------------ */

export interface BuiltBook {
  snapshotUTC: number;
  accounts: AccountHealth[];
  dataQuality: DataQualityNote[];
  totalEvents: number;
  unmappedWorkspaces: { workspace_id: string; events: number; company_name: string }[];
}

export function buildBook(raw: RawData): BuiltBook {
  const snapshotUTC = snapshotFrom(raw.events);

  // Resolve every account row to its lookup keys.
  const byNorm = new Map<string, AccountRow>();
  const byStem = new Map<string, AccountRow>();
  for (const row of raw.accounts) {
    byNorm.set(normalizeName(row.company_name), row);
    byStem.set(domainStem(row.domain), row);
  }

  const buckets = new Map<string, AccountBuckets>();
  const unmapped = new Map<string, { events: number; company_name: string }>();
  const workspaceOwner = new Map<string, string | null>();

  const resolve = (event: UsageEvent): AccountRow | null => {
    const norm = normalizeName(event.company_name);
    const direct = byNorm.get(norm);
    if (direct) return direct;
    // fall back to the domain stem - catches "Orcus Retail Grp." style drift
    const stem = norm.replace(/[^a-z0-9]/g, "");
    const viaStem = byStem.get(stem);
    if (viaStem) return viaStem;
    for (const [s, row] of byStem) {
      if (s.startsWith(stem) || stem.startsWith(s)) return row;
    }
    return null;
  };

  for (const e of raw.events) {
    let owner = workspaceOwner.get(e.workspace_id);
    if (owner === undefined) {
      const row = resolve(e);
      owner = row ? row.company_name : null;
      workspaceOwner.set(e.workspace_id, owner);
    }
    if (owner === null) {
      const cur = unmapped.get(e.workspace_id) ?? { events: 0, company_name: e.company_name };
      cur.events += 1;
      unmapped.set(e.workspace_id, cur);
      continue;
    }

    let b = buckets.get(owner);
    if (!b) {
      b = emptyBuckets();
      buckets.set(owner, b);
    }
    const di = dayIndex(e.timestamp, snapshotUTC);
    if (di < 0 || di >= WINDOW_DAYS) continue;

    b.days[di].counts[e.event_type] += 1;
    b.days[di].users.add(e.user_id);
    b.workspaces.set(e.workspace_id, (b.workspaces.get(e.workspace_id) ?? 0) + 1);
    b.nameVariants.add(e.company_name);
    b.planByDay[di] = e.plan_tier;
    b.total += 1;
  }

  const accounts: AccountHealth[] = raw.accounts.map((row) => {
    const b = buckets.get(row.company_name) ?? emptyBuckets();
    const metrics = metricsFor(b, WINDOW_DAYS - 1);
    const health = computeHealth(metrics);

    // Same code path, 30 days earlier, so the delta is apples to apples.
    const priorMetrics = metricsFor(b, WINDOW_DAYS - 31);
    const priorHealth = computeHealth(priorMetrics);
    const scorePrior = priorHealth.score;
    const scoreDelta =
      health.score !== null && scorePrior !== null ? health.score - scorePrior : null;

    const wsTotal = [...b.workspaces.values()].reduce((s, n) => s + n, 0) || 1;
    const workspaces: WorkspaceRollup[] = [...b.workspaces.entries()]
      .map(([workspace_id, events]) => ({ workspace_id, events, share: events / wsTotal }))
      .sort((x, y) => y.events - x.events);

    const planTierChanges: { day: number; from: PlanTier; to: PlanTier }[] = [];
    let seen: PlanTier | null = null;
    for (let i = 0; i < WINDOW_DAYS; i += 1) {
      const p = b.planByDay[i];
      if (p === null) continue;
      if (seen !== null && p !== seen) planTierChanges.push({ day: i, from: seen, to: p });
      seen = p;
    }

    const daily = b.days.map((d) => EVENT_TYPES.reduce((s, t) => s + d.counts[t], 0));
    const mix = EVENT_TYPES.reduce(
      (acc, t) => {
        acc[t] = b.days.reduce((s, d) => s + d.counts[t], 0);
        return acc;
      },
      {} as Record<EventType, number>,
    );

    const nameVariants = [...b.nameVariants];

    const base = {
      slug: slugify(row.company_name),
      name: row.company_name,
      domain: row.domain,
      plan: row.plan_tier,
      arr: row.arr_usd,
      csm: row.csm_owner,
      contractStart: row.contract_start_date,
      seatsKnown: metrics.knownUsers,
      workspaces,
      metrics,
      health,
      scorePrior,
      scoreDelta,
      daily,
      mix,
      planTierChanges,
      nameVariants,
    };

    return { ...base, signals: buildSignals({ ...base }) };
  });

  const unmappedWorkspaces = [...unmapped.entries()]
    .map(([workspace_id, v]) => ({ workspace_id, events: v.events, company_name: v.company_name }))
    .sort((a, b2) => b2.events - a.events);

  return {
    snapshotUTC,
    accounts,
    dataQuality: buildDataQuality(accounts, unmappedWorkspaces),
    totalEvents: raw.events.length,
    unmappedWorkspaces,
  };
}

/* ------------------------------------------------------------------ *
 * Data quality
 * ------------------------------------------------------------------ */

function buildDataQuality(
  accounts: AccountHealth[],
  unmapped: { workspace_id: string; events: number; company_name: string }[],
): DataQualityNote[] {
  const notes: DataQualityNote[] = [];

  const multiWs = accounts.filter((a) => a.workspaces.length > 1);
  if (multiWs.length) {
    notes.push({
      id: "multi-workspace",
      title: "Accounts running more than one workspace",
      count: multiWs.length,
      detail:
        multiWs
          .map((a) => `${a.name} (${a.workspaces.length})`)
          .join(", ") +
        ". company_name is not a clean 1:1 with workspace_id, so events are rolled up per account and every workspace stays visible on the drill-down.",
      rule: "Rule: normalise company_name, fall back to the domain stem, then sum events across workspaces.",
      accounts: multiWs.map((a) => a.slug),
    });
  }

  const aliased = accounts.filter((a) => a.nameVariants.length > 1);
  if (aliased.length) {
    notes.push({
      id: "name-variants",
      title: "Accounts whose name arrived more than one way",
      count: aliased.length,
      detail: aliased
        .map((a) => `${a.name}: ${a.nameVariants.map((n) => `"${n}"`).join(", ")}`)
        .join(" · "),
      rule: "Rule: normalise for matching only. The display name always comes from accounts.json, the commercial source of truth.",
      accounts: aliased.map((a) => a.slug),
    });
  }

  if (unmapped.length) {
    notes.push({
      id: "unmapped-workspaces",
      title: "Workspaces with events but no account row",
      count: unmapped.length,
      detail:
        unmapped
          .map((u) => `${u.workspace_id} ("${u.company_name}", ${u.events.toLocaleString()} events)`)
          .join(", ") +
        ". Excluded from every account score, and its ARR is unattributed.",
      rule: "Rule: surface as unmapped rather than dropping silently — it is either a missing account row or a churned workspace, and both need a human.",
    });
  }

  const noEvents = accounts.filter((a) => a.health.heldOutReason === "no_events");
  const gaps = accounts.filter((a) => a.health.heldOutReason === "suspected_gap");

  if (noEvents.length) {
    notes.push({
      id: "no-events",
      title: "Accounts with no events at all",
      count: noEvents.length,
      detail:
        noEvents.map((a) => a.name).join(", ") +
        ". Shown as No signal, never scored 0.",
      rule: "Rule: absence of data is not evidence of poor health. A zero would rank these above genuinely failing accounts in the queue.",
      accounts: noEvents.map((a) => a.slug),
    });
  }

  if (gaps.length) {
    notes.push({
      id: "ingestion-gaps",
      title: "Event streams that stop mid-window",
      count: gaps.length,
      detail: gaps
        .map(
          (a) =>
            `${a.name}: silent ${a.metrics.daysSinceLastEvent} days after running at ` +
            `${Math.round(a.metrics.runRateBeforeLastEvent * 10) / 10}/day`,
        )
        .join(" · ") + ". Real churn decays; a clean cut with no tail-off does not.",
      rule: "Rule: held out of scoring and flagged for a pipeline check before anyone calls the customer.",
      accounts: gaps.map((a) => a.slug),
    });
  }

  const planDrift = accounts.filter((a) => a.planTierChanges.length > 0);
  if (planDrift.length) {
    notes.push({
      id: "plan-drift",
      title: "Accounts whose plan_tier changed mid-window",
      count: planDrift.length,
      detail: planDrift
        .map((a) => `${a.name} (${a.planTierChanges.map((c) => `${c.from}→${c.to}`).join(", ")})`)
        .join(", ") + ". plan_tier on an event is as-of-event and drifts from accounts.json.",
      rule: "Rule: the account row is current truth for tier; the event-level change is kept as a timeline signal.",
      accounts: planDrift.map((a) => a.slug),
    });
  }

  notes.push({
    id: "weekend-cycle",
    title: "Weekend troughs are not dips",
    count: 0,
    detail:
      "Every account drops roughly two thirds on Saturday and Sunday. Momentum compares whole 30-day windows, never day over day, so the weekly cycle cannot read as decline.",
    rule: "Rule: compare equal-length windows with the same weekday composition.",
  });

  notes.push({
    id: "snapshot-anchor",
    title: "The window is anchored to the export, not to today",
    count: 0,
    detail:
      "Day 90 is the date of the most recent event in usage_events.json. Anchoring to wall-clock time would silently re-band every account as the file ages.",
    rule: "Rule: derive the snapshot from the data, and show it in the UI.",
  });

  return notes;
}

export { BAND_LABELS };
export type { BandKey };
