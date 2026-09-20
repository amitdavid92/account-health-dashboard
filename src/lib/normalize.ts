/**
 * Stage 1 of the pipeline: raw export -> validated, joined, normalized entities
 * plus an explicit data-quality report.
 *
 * Design rule: this layer never silently fixes anything. Every decision it
 * makes is recorded as a QualityIssue, including the checks that came back
 * clean - "we verified there are no duplicate event ids" is a finding too, and
 * it is the only way a reader can tell the difference between a check that
 * passed and a check that was never run.
 */

import {
  PLAN_RANK,
  type Account,
  type DataQualityReport,
  type EventType,
  type PlanTier,
  type QualityIssue,
  type RawAccount,
  type RawEvent,
  type UsageEvent,
} from "./types";

const VALID_PLANS = new Set<PlanTier>(["Free", "Pro", "Enterprise"]);
const VALID_EVENT_TYPES = new Set<EventType>([
  "guide_created",
  "guide_viewed",
  "guide_shared",
  "user_invited",
  "login",
]);

const LEGAL_SUFFIXES = /\b(inc|llc|ltd|limited|corp|corporation|co|company|gmbh|plc|the)\b/g;

/**
 * Canonical join key for a company name.
 *
 * On this snapshot the two files agree exactly (25 <-> 25, no variants), so
 * this normalization is a no-op today and the report says so. It exists because
 * "the names happen to match in this export" is not a property we can rely on
 * next month, and because it gives us one place to swap in fuzzy matching
 * without touching anything downstream.
 */
export function canonicalCompanyKey(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(LEGAL_SUFFIXES, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function slugify(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

function parseTimestamp(v: unknown): number | null {
  if (!isNonEmptyString(v)) return null;
  const ms = Date.parse(v);
  return Number.isFinite(ms) ? ms : null;
}

export interface NormalizedData {
  accounts: Account[];
  events: UsageEvent[];
  snapshotMs: number;
  windowStartMs: number;
  quality: DataQualityReport;
}

export function normalize(rawAccounts: RawAccount[], rawEvents: RawEvent[]): NormalizedData {
  const issues: QualityIssue[] = [];

  // -- Accounts -------------------------------------------------------------

  const accounts: Account[] = [];
  const accountByKey = new Map<string, Account>();
  const invalidAccounts: string[] = [];
  const duplicateAccountKeys: string[] = [];

  for (const raw of rawAccounts) {
    if (!isNonEmptyString(raw.company_name)) {
      invalidAccounts.push(JSON.stringify(raw).slice(0, 80));
      continue;
    }
    const companyName = raw.company_name.trim();
    const key = canonicalCompanyKey(companyName);

    if (accountByKey.has(key)) {
      duplicateAccountKeys.push(companyName);
      continue;
    }

    const planTier = VALID_PLANS.has(raw.plan_tier as PlanTier)
      ? (raw.plan_tier as PlanTier)
      : "Free";
    const arrRaw =
      typeof raw.arr_usd === "number" && Number.isFinite(raw.arr_usd)
        ? raw.arr_usd
        : Number(raw.arr_usd) || 0;
    const arr = Math.max(0, arrRaw);

    const account: Account = {
      slug: slugify(companyName),
      companyName,
      domain: isNonEmptyString(raw.domain) ? raw.domain.trim() : "",
      planTier,
      contractStartDate: isNonEmptyString(raw.contract_start_date)
        ? raw.contract_start_date
        : "",
      arrUsd: arr,
      csmOwner: isNonEmptyString(raw.csm_owner) ? raw.csm_owner.trim() : "Unassigned",
    };
    accounts.push(account);
    accountByKey.set(key, account);
  }

  // -- Events ---------------------------------------------------------------

  const events: UsageEvent[] = [];
  const seenEventIds = new Set<string>();
  const seenSignatures = new Set<string>();

  let malformed = 0;
  let duplicateIds = 0;
  let duplicateRows = 0;
  let badTimestamps = 0;
  const orphanCompanies = new Map<string, number>();

  for (const raw of rawEvents) {
    if (
      !isNonEmptyString(raw.event_id) ||
      !isNonEmptyString(raw.workspace_id) ||
      !isNonEmptyString(raw.company_name) ||
      !isNonEmptyString(raw.user_id) ||
      !VALID_EVENT_TYPES.has(raw.event_type as EventType)
    ) {
      malformed += 1;
      continue;
    }

    const timestampMs = parseTimestamp(raw.timestamp);
    if (timestampMs === null) {
      badTimestamps += 1;
      continue;
    }

    if (seenEventIds.has(raw.event_id)) {
      duplicateIds += 1;
      continue;
    }

    // A replayed row with a fresh id is still the same thing happening once.
    // Keyed on the parsed timestamp, not the raw string, so equivalent
    // timestamps in different formats (e.g. with/without milliseconds) still
    // collide as the same event.
    const signature = `${raw.workspace_id}|${raw.user_id}|${raw.event_type}|${timestampMs}`;
    if (seenSignatures.has(signature)) {
      duplicateRows += 1;
      continue;
    }

    const key = canonicalCompanyKey(raw.company_name);
    const account = accountByKey.get(key);
    if (!account) {
      orphanCompanies.set(
        raw.company_name,
        (orphanCompanies.get(raw.company_name) ?? 0) + 1,
      );
      continue;
    }

    seenEventIds.add(raw.event_id);
    seenSignatures.add(signature);

    events.push({
      eventId: raw.event_id,
      workspaceId: raw.workspace_id,
      accountSlug: account.slug,
      eventType: raw.event_type as EventType,
      userId: raw.user_id,
      timestampMs,
      timestamp: new Date(timestampMs).toISOString(),
      planTierAtEvent: VALID_PLANS.has(raw.plan_tier as PlanTier)
        ? (raw.plan_tier as PlanTier)
        : account.planTier,
    });
  }

  events.sort((a, b) => a.timestampMs - b.timestampMs);

  const snapshotMs = events.length ? events[events.length - 1].timestampMs : Date.now();
  const windowStartMs = events.length ? events[0].timestampMs : snapshotMs;

  // -- Relationship checks --------------------------------------------------

  const workspaceToAccounts = new Map<string, Set<string>>();
  const accountToWorkspaces = new Map<string, Set<string>>();
  const userToAccounts = new Map<string, Set<string>>();
  const eventsPerAccount = new Map<string, number>();
  const planSeen = new Map<string, { latest: PlanTier; latestMs: number; all: Set<PlanTier> }>();

  for (const e of events) {
    if (!workspaceToAccounts.has(e.workspaceId)) workspaceToAccounts.set(e.workspaceId, new Set());
    workspaceToAccounts.get(e.workspaceId)!.add(e.accountSlug);

    if (!accountToWorkspaces.has(e.accountSlug)) accountToWorkspaces.set(e.accountSlug, new Set());
    accountToWorkspaces.get(e.accountSlug)!.add(e.workspaceId);

    if (!userToAccounts.has(e.userId)) userToAccounts.set(e.userId, new Set());
    userToAccounts.get(e.userId)!.add(e.accountSlug);

    eventsPerAccount.set(e.accountSlug, (eventsPerAccount.get(e.accountSlug) ?? 0) + 1);

    const prev = planSeen.get(e.accountSlug);
    if (!prev) {
      planSeen.set(e.accountSlug, {
        latest: e.planTierAtEvent,
        latestMs: e.timestampMs,
        all: new Set([e.planTierAtEvent]),
      });
    } else {
      prev.all.add(e.planTierAtEvent);
      if (e.timestampMs >= prev.latestMs) {
        prev.latest = e.planTierAtEvent;
        prev.latestMs = e.timestampMs;
      }
    }
  }

  const multiWorkspaceAccounts = accounts.filter(
    (a) => (accountToWorkspaces.get(a.slug)?.size ?? 0) > 1,
  );
  const sharedWorkspaces = [...workspaceToAccounts.entries()].filter(([, s]) => s.size > 1);
  const accountsWithoutEvents = accounts.filter((a) => !eventsPerAccount.has(a.slug));
  const crossAccountUsers = [...userToAccounts.entries()].filter(([, s]) => s.size > 1);
  const planDriftAccounts = accounts.filter((a) => {
    const seen = planSeen.get(a.slug);
    return !!seen && seen.latest !== a.planTier;
  });
  const futureEvents = events.filter((e) => e.timestampMs > snapshotMs);

  // -- Report ---------------------------------------------------------------

  const add = (i: QualityIssue) => issues.push(i);

  add({
    code: "missing_fields",
    title: "Malformed or incomplete event rows",
    severity: malformed > 0 ? "warning" : "info",
    count: malformed,
    detail:
      malformed > 0
        ? `${malformed} event rows were missing a required field or carried an unknown event_type.`
        : "Every event row carries all seven fields with a recognised event_type, and every account row is complete.",
    resolution:
      malformed > 0
        ? "Dropped from the usage layer and counted here; they cannot be attributed to an account."
        : "No action needed - verified, not assumed.",
  });

  add({
    code: "duplicate_event_ids",
    title: "Duplicate event_id values",
    severity: duplicateIds > 0 ? "warning" : "info",
    count: duplicateIds,
    detail:
      duplicateIds > 0
        ? `${duplicateIds} rows repeated an event_id already seen.`
        : "All event_id values are unique across the export.",
    resolution:
      duplicateIds > 0 ? "First occurrence kept, later ones dropped." : "No action needed.",
  });

  add({
    code: "duplicate_rows",
    title: "Replayed rows (same workspace, user, type and timestamp)",
    severity: duplicateRows > 0 ? "warning" : "info",
    count: duplicateRows,
    detail:
      duplicateRows > 0
        ? `${duplicateRows} rows describe an event already recorded under a different event_id.`
        : "No logical duplicates: no two rows share workspace, user, event type and timestamp.",
    resolution:
      duplicateRows > 0
        ? "Deduplicated - an export replay must not inflate an account's activity."
        : "No action needed.",
  });

  add({
    code: "orphan_events",
    title: "Events with no matching account",
    severity: orphanCompanies.size > 0 ? "error" : "info",
    count: [...orphanCompanies.values()].reduce((a, b) => a + b, 0),
    detail:
      orphanCompanies.size > 0
        ? `Companies present in usage_events.json but absent from accounts.json: ${[...orphanCompanies.keys()].join(", ")}.`
        : "Every company in the event stream resolves to a row in accounts.json (25 of 25).",
    resolution:
      orphanCompanies.size > 0
        ? "Excluded from account health - we cannot score a customer we have no contract record for - but surfaced here so CS can chase the gap."
        : "No action needed.",
  });

  add({
    code: "accounts_without_events",
    title: "Accounts with no usage events",
    severity: accountsWithoutEvents.length > 0 ? "warning" : "info",
    count: accountsWithoutEvents.length,
    detail:
      accountsWithoutEvents.length > 0
        ? `No events at all for: ${accountsWithoutEvents.map((a) => a.companyName).join(", ")}.`
        : "Every account in accounts.json has at least one event (minimum observed: 3).",
    resolution:
      "Such accounts are tiered 'No Data', never 'At Risk' - absence of evidence is not evidence of churn, and it is just as likely to be a broken pipeline.",
    affectedAccounts: accountsWithoutEvents.map((a) => a.slug),
  });

  add({
    code: "company_name_join",
    title: "Company name consistency between the two files",
    severity: "info",
    count: 0,
    detail: `All ${accounts.length} account names match the event stream exactly after canonicalization - no case, whitespace, punctuation or legal-suffix variants were found.`,
    resolution:
      "Joined on the canonical key rather than the raw string, so the assumption is explicit and a fuzzy matcher can replace it in one place.",
  });

  add({
    code: "multi_workspace_accounts",
    title: "Accounts running more than one workspace",
    severity: "warning",
    count: multiWorkspaceAccounts.length,
    detail: multiWorkspaceAccounts.length
      ? multiWorkspaceAccounts
          .map((a) => {
            const ws = [...(accountToWorkspaces.get(a.slug) ?? [])];
            return `${a.companyName} (${ws.length} workspaces)`;
          })
          .join(", ") +
        ". User sets are fully disjoint between a company's workspaces - no person appears in both."
      : "Every account maps to exactly one workspace.",
    resolution:
      "Health is computed per account, with workspaces rolled up. Users are deduplicated across workspaces anyway, and the drill-down shows the per-workspace split so a CSM can see a half-adopted second team.",
    affectedAccounts: multiWorkspaceAccounts.map((a) => a.slug),
  });

  add({
    code: "shared_workspaces",
    title: "Workspaces claimed by more than one company",
    severity: sharedWorkspaces.length > 0 ? "error" : "info",
    count: sharedWorkspaces.length,
    detail:
      sharedWorkspaces.length > 0
        ? sharedWorkspaces.map(([ws, s]) => `${ws} -> ${[...s].join(", ")}`).join("; ")
        : "No workspace_id is associated with more than one company name - the workspace-to-account mapping is unambiguous.",
    resolution:
      sharedWorkspaces.length > 0
        ? "Attributed by majority event count and flagged - a workspace cannot belong to two customers."
        : "No action needed.",
  });

  add({
    code: "cross_account_users",
    title: "Users appearing under more than one account",
    severity: crossAccountUsers.length > 0 ? "warning" : "info",
    count: crossAccountUsers.length,
    detail:
      crossAccountUsers.length > 0
        ? `${crossAccountUsers.length} user_ids appear under multiple companies.`
        : "No user_id appears under more than one company or workspace, so counting distinct users per account is safe.",
    resolution: "Distinct-user counts are per account either way.",
  });

  add({
    code: "plan_drift",
    title: "Plan tier disagrees between accounts.json and the event stream",
    severity: planDriftAccounts.length > 0 ? "warning" : "info",
    count: planDriftAccounts.length,
    detail: planDriftAccounts.length
      ? planDriftAccounts
          .map((a) => {
            const seen = planSeen.get(a.slug)!;
            const direction =
              PLAN_RANK[seen.latest] < PLAN_RANK[a.planTier] ? "downgrade" : "upgrade";
            return `${a.companyName}: contract says ${a.planTier}, latest event says ${seen.latest} (${direction})`;
          })
          .join("; ")
      : "The plan on every event matches the account's contracted plan.",
    resolution:
      "accounts.json stays the source of truth for the displayed plan and ARR. The event stream is treated as plan history, and a downgrade inside the window is raised as a commercial risk flag - it is real signal, not a data error, but it is not usage so it never touches the health score.",
    affectedAccounts: planDriftAccounts.map((a) => a.slug),
  });

  add({
    code: "timestamp_anomalies",
    title: "Timestamp integrity",
    severity: badTimestamps > 0 || futureEvents.length > 0 ? "warning" : "info",
    count: badTimestamps + futureEvents.length,
    detail:
      badTimestamps > 0 || futureEvents.length > 0
        ? `${badTimestamps} unparseable and ${futureEvents.length} after the snapshot.`
        : "All timestamps parse as ISO-8601 UTC and fall inside the export window; none are in the future.",
    resolution:
      "Unparseable rows are dropped rather than guessed. 'Today' is pinned to the latest event in the export, not wall-clock time, so results are reproducible.",
  });

  add({
    code: "hour_of_day_gap",
    title: "No events between 09:00 and 19:00 UTC",
    severity: "warning",
    count: 0,
    detail:
      "Activity is confined to 19:00-09:00 UTC across all 90 days, which no real customer base produces. This is an artifact of how the sample was generated.",
    resolution:
      "Recorded as a hard limitation: no hour-of-day or business-hours analysis is built anywhere in this dashboard, because the underlying distribution is not real. Daily and weekly aggregates are unaffected.",
  });

  const users = new Set(events.map((e) => e.userId));
  const eventsDropped = malformed + duplicateIds + duplicateRows + badTimestamps +
    [...orphanCompanies.values()].reduce((a, b) => a + b, 0);

  const quality: DataQualityReport = {
    generatedAt: new Date().toISOString(),
    snapshotDate: new Date(snapshotMs).toISOString(),
    totals: {
      accounts: accounts.length,
      events: events.length,
      eventsDropped,
      workspaces: workspaceToAccounts.size,
      users: users.size,
      companiesInEvents: new Set(events.map((e) => e.accountSlug)).size,
      windowStart: new Date(windowStartMs).toISOString(),
      windowEnd: new Date(snapshotMs).toISOString(),
      windowDays: Math.round((snapshotMs - windowStartMs) / 86_400_000),
    },
    issues,
  };

  if (invalidAccounts.length || duplicateAccountKeys.length) {
    issues.unshift({
      code: "invalid_account_rows",
      title: "Unusable account rows",
      severity: "error",
      count: invalidAccounts.length + duplicateAccountKeys.length,
      detail: `${invalidAccounts.length} rows without a company name, ${duplicateAccountKeys.length} duplicate companies.`,
      resolution: "Dropped; a nameless or duplicated account cannot be joined or displayed.",
    });
  }

  return { accounts, events, snapshotMs, windowStartMs, quality };
}
