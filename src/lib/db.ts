/**
 * Storage layer, backed by SQLite through Node's built-in `node:sqlite`.
 *
 * Why a database at all for 480 rows: the point of this exercise is the data
 * layer, and the pipeline stages should be inspectable by something other than
 * the app that produced them. `sqlite3 data/health.db` lets you re-derive every
 * number in the UI with plain SQL, which is the check that catches pipeline
 * bugs that unit tests on pure functions never will.
 *
 * Why the built-in module rather than better-sqlite3: no native build step and
 * no dependency, so `npm install && npm run dev` works on any machine with a
 * current Node.
 *
 * Schema shape: flat columns for anything the API filters or sorts on, JSON
 * blobs for the evidence payloads. Health is computed once during ingest and
 * stored - the API serves a verdict, it does not recompute one, so what the UI
 * shows and what the database holds can never drift apart.
 */

import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import type {
  Account,
  AccountSummary,
  DataQualityReport,
  HealthTier,
  PlanTier,
  PortfolioKpis,
  UsageEvent,
} from "./types";

export const DB_PATH = path.join(process.cwd(), "data", "health.db");

let readConnection: DatabaseSync | null = null;

function connect(readOnly: boolean): DatabaseSync {
  return new DatabaseSync(DB_PATH, { readOnly });
}

/** Cached read-only handle for the request path. */
function db(): DatabaseSync {
  if (!readConnection) readConnection = connect(true);
  return readConnection;
}

// ---------------------------------------------------------------------------
// Write path (ingest only)
// ---------------------------------------------------------------------------

const SCHEMA = `
CREATE TABLE meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE accounts (
  slug                TEXT PRIMARY KEY,
  company_name        TEXT NOT NULL,
  domain              TEXT NOT NULL,
  plan_tier           TEXT NOT NULL,
  contract_start_date TEXT NOT NULL,
  arr_usd             INTEGER NOT NULL,
  csm_owner           TEXT NOT NULL
);

-- The raw event stream is kept as loaded so every derived number can be
-- re-derived from source without re-running the export.
CREATE TABLE events (
  event_id           TEXT PRIMARY KEY,
  account_slug       TEXT NOT NULL REFERENCES accounts(slug),
  workspace_id       TEXT NOT NULL,
  event_type         TEXT NOT NULL,
  user_id            TEXT NOT NULL,
  timestamp          TEXT NOT NULL,
  timestamp_ms       INTEGER NOT NULL,
  plan_tier_at_event TEXT NOT NULL
);
CREATE INDEX idx_events_account ON events(account_slug, timestamp_ms);
CREATE INDEX idx_events_workspace ON events(workspace_id);

CREATE TABLE account_health (
  account_slug          TEXT PRIMARY KEY REFERENCES accounts(slug),
  score                 INTEGER NOT NULL,
  tier                  TEXT NOT NULL,
  tier_from_score       TEXT NOT NULL,
  low_confidence        INTEGER NOT NULL,
  priority_score        REAL NOT NULL,
  -- Flat copies of the metrics the list view filters and sorts on.
  total_events          INTEGER NOT NULL,
  events_recent         INTEGER NOT NULL,
  active_users_recent   INTEGER NOT NULL,
  known_users           INTEGER NOT NULL,
  days_since_last_event INTEGER,
  workspace_count       INTEGER NOT NULL,
  guides_created        INTEGER NOT NULL,
  guides_shared         INTEGER NOT NULL,
  top_risk_code         TEXT,
  top_risk_title        TEXT,
  top_risk_severity     TEXT,
  risk_count            INTEGER NOT NULL,
  -- Evidence payloads: pillar sentences, overrides, weekly series, workspaces.
  health_json           TEXT NOT NULL,
  metrics_json          TEXT NOT NULL
);

CREATE TABLE account_risks (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  account_slug   TEXT NOT NULL REFERENCES accounts(slug),
  code           TEXT NOT NULL,
  title          TEXT NOT NULL,
  severity       TEXT NOT NULL,
  base_severity  TEXT NOT NULL,
  evidence       TEXT NOT NULL,
  why_it_matters TEXT NOT NULL,
  escalations    TEXT NOT NULL,
  affects_health INTEGER NOT NULL
);
CREATE INDEX idx_risks_account ON account_risks(account_slug);

CREATE TABLE data_quality_issues (
  code              TEXT PRIMARY KEY,
  title             TEXT NOT NULL,
  severity          TEXT NOT NULL,
  count             INTEGER NOT NULL,
  detail            TEXT NOT NULL,
  resolution        TEXT NOT NULL,
  affected_accounts TEXT NOT NULL
);
`;

export function writeDatabase(input: {
  summaries: AccountSummary[];
  events: UsageEvent[];
  quality: DataQualityReport;
  kpis: PortfolioKpis;
}): void {
  // A full rebuild, not a migration: the raw export is the only source of
  // truth, so the database is discarded and recreated on every run. That keeps
  // `npm run ingest` idempotent and makes stale rows impossible.
  for (const suffix of ["", "-wal", "-shm"]) {
    fs.rmSync(`${DB_PATH}${suffix}`, { force: true });
  }

  const conn = connect(false);
  conn.exec("PRAGMA journal_mode = WAL;");
  conn.exec(SCHEMA);

  const meta = conn.prepare("INSERT INTO meta (key, value) VALUES (?, ?)");
  meta.run("snapshot_date", input.kpis.snapshotDate);
  meta.run("generated_at", input.quality.generatedAt);
  meta.run("portfolio_kpis", JSON.stringify(input.kpis));
  meta.run("quality_totals", JSON.stringify(input.quality.totals));

  const insertAccount = conn.prepare(
    `INSERT INTO accounts (slug, company_name, domain, plan_tier, contract_start_date, arr_usd, csm_owner)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertEvent = conn.prepare(
    `INSERT INTO events (event_id, account_slug, workspace_id, event_type, user_id, timestamp, timestamp_ms, plan_tier_at_event)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertHealth = conn.prepare(
    `INSERT INTO account_health (
       account_slug, score, tier, tier_from_score, low_confidence, priority_score,
       total_events, events_recent, active_users_recent, known_users,
       days_since_last_event, workspace_count, guides_created, guides_shared,
       top_risk_code, top_risk_title, top_risk_severity, risk_count,
       health_json, metrics_json
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertRisk = conn.prepare(
    `INSERT INTO account_risks (account_slug, code, title, severity, base_severity, evidence, why_it_matters, escalations, affects_health)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertIssue = conn.prepare(
    `INSERT INTO data_quality_issues (code, title, severity, count, detail, resolution, affected_accounts)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );

  conn.exec("BEGIN");
  try {
    for (const s of input.summaries) {
      const a = s.account;
      insertAccount.run(
        a.slug,
        a.companyName,
        a.domain,
        a.planTier,
        a.contractStartDate,
        a.arrUsd,
        a.csmOwner,
      );
    }

    for (const e of input.events) {
      insertEvent.run(
        e.eventId,
        e.accountSlug,
        e.workspaceId,
        e.eventType,
        e.userId,
        e.timestamp,
        e.timestampMs,
        e.planTierAtEvent,
      );
    }

    for (const s of input.summaries) {
      const m = s.metrics;
      insertHealth.run(
        s.account.slug,
        s.health.score,
        s.health.tier,
        s.health.tierFromScore,
        s.health.lowConfidence ? 1 : 0,
        s.priorityScore,
        m.totalEvents,
        m.eventsRecent,
        m.activeUsersRecent,
        m.knownUsers,
        m.daysSinceLastEvent,
        m.workspaceCount,
        m.byType.guide_created,
        m.byType.guide_shared,
        s.topRisk?.code ?? null,
        s.topRisk?.title ?? null,
        s.topRisk?.severity ?? null,
        s.risks.length,
        JSON.stringify(s.health),
        JSON.stringify(m),
      );

      for (const r of s.risks) {
        insertRisk.run(
          s.account.slug,
          r.code,
          r.title,
          r.severity,
          r.baseSeverity,
          r.evidence,
          r.whyItMatters,
          JSON.stringify(r.escalations),
          r.affectsHealth ? 1 : 0,
        );
      }
    }

    for (const i of input.quality.issues) {
      insertIssue.run(
        i.code,
        i.title,
        i.severity,
        i.count,
        i.detail,
        i.resolution,
        JSON.stringify(i.affectedAccounts ?? []),
      );
    }

    conn.exec("COMMIT");
  } catch (err) {
    conn.exec("ROLLBACK");
    throw err;
  } finally {
    conn.close();
  }
}

// ---------------------------------------------------------------------------
// Read path (API)
// ---------------------------------------------------------------------------

export interface AccountListRow {
  slug: string;
  companyName: string;
  domain: string;
  planTier: string;
  contractStartDate: string;
  arrUsd: number;
  csmOwner: string;
  score: number;
  tier: HealthTier;
  lowConfidence: boolean;
  priorityScore: number;
  totalEvents: number;
  eventsRecent: number;
  activeUsersRecent: number;
  knownUsers: number;
  daysSinceLastEvent: number | null;
  workspaceCount: number;
  guidesCreated: number;
  guidesShared: number;
  riskCount: number;
  topRisk: { code: string; title: string; severity: string } | null;
  /** 13 weekly totals, oldest first - enough for the list sparkline. */
  sparkline: number[];
}

type Row = Record<string, unknown>;

function toListRow(r: Row): AccountListRow {
  const metrics = JSON.parse(String(r.metrics_json)) as AccountSummary["metrics"];
  return {
    slug: String(r.slug),
    companyName: String(r.company_name),
    domain: String(r.domain),
    planTier: String(r.plan_tier),
    contractStartDate: String(r.contract_start_date),
    arrUsd: Number(r.arr_usd),
    csmOwner: String(r.csm_owner),
    score: Number(r.score),
    tier: String(r.tier) as HealthTier,
    lowConfidence: Number(r.low_confidence) === 1,
    priorityScore: Number(r.priority_score),
    totalEvents: Number(r.total_events),
    eventsRecent: Number(r.events_recent),
    activeUsersRecent: Number(r.active_users_recent),
    knownUsers: Number(r.known_users),
    daysSinceLastEvent: r.days_since_last_event === null ? null : Number(r.days_since_last_event),
    workspaceCount: Number(r.workspace_count),
    guidesCreated: Number(r.guides_created),
    guidesShared: Number(r.guides_shared),
    riskCount: Number(r.risk_count),
    topRisk: r.top_risk_code
      ? {
          code: String(r.top_risk_code),
          title: String(r.top_risk_title),
          severity: String(r.top_risk_severity),
        }
      : null,
    sparkline: metrics.weekly.map((w) => w.total),
  };
}

export interface AccountFilters {
  tier?: string;
  /** One plan, several (OR'd together), or omitted for all plans. */
  plan?: string | string[];
  csm?: string;
  risk?: string;
  search?: string;
  sort?: "priority" | "score" | "arr" | "silent" | "name";
}

export type SortKey = NonNullable<AccountFilters["sort"]>;

const SORT_SQL: Record<SortKey, string> = {
  priority: "h.priority_score DESC, a.arr_usd DESC",
  score: "h.score ASC, a.arr_usd DESC",
  arr: "a.arr_usd DESC",
  silent: "h.days_since_last_event DESC NULLS FIRST, a.arr_usd DESC",
  name: "a.company_name ASC",
};

export const SORT_KEYS = Object.keys(SORT_SQL) as SortKey[];

/**
 * The one place a `sort` value from outside is turned into a key.
 *
 * SORT_SQL is interpolated into the ORDER BY clause, so an unrecognised value
 * would splice `undefined` into the SQL and fail the query. Every caller -
 * the page, the API route, the chat tool - resolves through here, so a
 * hand-typed `?sort=whatever` falls back to the default instead of erroring.
 */
export function parseSort(raw: unknown): SortKey {
  return typeof raw === "string" && raw in SORT_SQL ? (raw as SortKey) : "priority";
}

export function listAccounts(filters: AccountFilters = {}): AccountListRow[] {
  const where: string[] = [];
  const params: (string | number)[] = [];

  if (filters.tier) {
    where.push("h.tier = ?");
    params.push(filters.tier);
  }
  const plans = Array.isArray(filters.plan) ? filters.plan : filters.plan ? [filters.plan] : [];
  if (plans.length > 0) {
    where.push(`a.plan_tier IN (${plans.map(() => "?").join(",")})`);
    params.push(...plans);
  }
  if (filters.csm) {
    where.push("a.csm_owner = ?");
    params.push(filters.csm);
  }
  if (filters.risk) {
    where.push("EXISTS (SELECT 1 FROM account_risks r WHERE r.account_slug = a.slug AND r.code = ?)");
    params.push(filters.risk);
  }
  if (filters.search) {
    where.push("(LOWER(a.company_name) LIKE ? OR LOWER(a.domain) LIKE ?)");
    const like = `%${filters.search.toLowerCase()}%`;
    params.push(like, like);
  }

  const sql = `
    SELECT a.*, h.*
    FROM accounts a
    JOIN account_health h ON h.account_slug = a.slug
    ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
    ORDER BY ${SORT_SQL[parseSort(filters.sort)]}
  `;

  return db().prepare(sql).all(...params).map((r) => toListRow(r as Row));
}

export function getAccountDetail(slug: string): AccountSummary | null {
  const row = db()
    .prepare(
      `SELECT a.*, h.* FROM accounts a
       JOIN account_health h ON h.account_slug = a.slug
       WHERE a.slug = ?`,
    )
    .get(slug) as Row | undefined;

  if (!row) return null;

  const risks = db()
    .prepare(`SELECT * FROM account_risks WHERE account_slug = ? ORDER BY id`)
    .all(slug)
    .map((r) => {
      const rr = r as Row;
      return {
        code: String(rr.code),
        title: String(rr.title),
        severity: String(rr.severity),
        baseSeverity: String(rr.base_severity),
        evidence: String(rr.evidence),
        whyItMatters: String(rr.why_it_matters),
        escalations: JSON.parse(String(rr.escalations)) as string[],
        affectsHealth: Number(rr.affects_health) === 1,
      };
    }) as AccountSummary["risks"];

  return {
    account: {
      slug: String(row.slug),
      companyName: String(row.company_name),
      domain: String(row.domain),
      planTier: String(row.plan_tier) as AccountSummary["account"]["planTier"],
      contractStartDate: String(row.contract_start_date),
      arrUsd: Number(row.arr_usd),
      csmOwner: String(row.csm_owner),
    },
    health: JSON.parse(String(row.health_json)),
    metrics: JSON.parse(String(row.metrics_json)),
    risks,
    priorityScore: Number(row.priority_score),
    topRisk: risks[0] ?? null,
  };
}

export function getPortfolioKpis(): PortfolioKpis {
  const row = db().prepare(`SELECT value FROM meta WHERE key = 'portfolio_kpis'`).get() as
    | Row
    | undefined;
  if (!row) throw new Error("Database not ingested. Run `npm run ingest`.");
  return JSON.parse(String(row.value));
}

export function getSnapshotDate(): string {
  const row = db().prepare(`SELECT value FROM meta WHERE key = 'snapshot_date'`).get() as
    | Row
    | undefined;
  return row ? String(row.value) : "";
}

export function getQualityReport(): Pick<DataQualityReport, "totals" | "issues"> & {
  snapshotDate: string;
} {
  const totalsRow = db().prepare(`SELECT value FROM meta WHERE key = 'quality_totals'`).get() as
    | Row
    | undefined;
  const issues = db()
    .prepare(`SELECT * FROM data_quality_issues`)
    .all()
    .map((r) => {
      const rr = r as Row;
      return {
        code: String(rr.code),
        title: String(rr.title),
        severity: String(rr.severity) as "info" | "warning" | "error",
        count: Number(rr.count),
        detail: String(rr.detail),
        resolution: String(rr.resolution),
        affectedAccounts: JSON.parse(String(rr.affected_accounts)) as string[],
      };
    });

  return {
    snapshotDate: getSnapshotDate(),
    totals: totalsRow ? JSON.parse(String(totalsRow.value)) : null,
    issues,
  };
}

/**
 * The normalized `accounts` and `events` tables, read back into the exact
 * shapes `buildSummaries` expects.
 *
 * This is a pure read of data ingest already wrote - no score, cap or risk
 * rule lives here, and no value from the model changes by calling it. It
 * exists so a UI feature (a "score 30 days ago" comparison, in history.ts)
 * can re-run the real pipeline on an earlier snapshot instead of the app
 * inventing a second, parallel notion of trend.
 */
export function getRawData(): { accounts: Account[]; events: UsageEvent[]; snapshotMs: number } {
  const accounts = db()
    .prepare(`SELECT * FROM accounts`)
    .all()
    .map((r) => {
      const rr = r as Row;
      return {
        slug: String(rr.slug),
        companyName: String(rr.company_name),
        domain: String(rr.domain),
        planTier: String(rr.plan_tier) as PlanTier,
        contractStartDate: String(rr.contract_start_date),
        arrUsd: Number(rr.arr_usd),
        csmOwner: String(rr.csm_owner),
      };
    });

  const events = db()
    .prepare(`SELECT * FROM events ORDER BY timestamp_ms ASC`)
    .all()
    .map((r) => {
      const rr = r as Row;
      return {
        eventId: String(rr.event_id),
        workspaceId: String(rr.workspace_id),
        accountSlug: String(rr.account_slug),
        eventType: String(rr.event_type) as UsageEvent["eventType"],
        userId: String(rr.user_id),
        timestampMs: Number(rr.timestamp_ms),
        timestamp: String(rr.timestamp),
        planTierAtEvent: String(rr.plan_tier_at_event) as PlanTier,
      };
    });

  // The precise snapshot instant is the latest event's own timestamp - the
  // stored `snapshot_date` meta value is date-only (a display value), and
  // parsing it back would silently reintroduce the wall-clock-midnight bug
  // this pipeline exists to avoid.
  const snapshotMs = events.length ? events[events.length - 1].timestampMs : Date.now();
  return { accounts, events, snapshotMs };
}

export function getFilterOptions(): { csms: string[]; plans: string[]; risks: { code: string; title: string }[] } {
  const csms = db()
    .prepare(`SELECT DISTINCT csm_owner FROM accounts ORDER BY csm_owner`)
    .all()
    .map((r) => String((r as Row).csm_owner));
  const plans = db()
    .prepare(`SELECT DISTINCT plan_tier FROM accounts ORDER BY plan_tier`)
    .all()
    .map((r) => String((r as Row).plan_tier));
  const risks = db()
    .prepare(`SELECT code, title, COUNT(*) c FROM account_risks GROUP BY code ORDER BY c DESC`)
    .all()
    .map((r) => ({ code: String((r as Row).code), title: String((r as Row).title) }));
  return { csms, plans, risks };
}
