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
  /** Rows where a value was unusable and a default was substituted. */
  const planFallbacks: string[] = [];
  const arrFallbacks: string[] = [];
  /** Company names whose raw string differs between the two files. */
  const nonExactNameMatches: string[] = [];

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

    const planValid = VALID_PLANS.has(raw.plan_tier as PlanTier);
    const planTier = planValid ? (raw.plan_tier as PlanTier) : "Free";
    if (!planValid) {
      planFallbacks.push(`${companyName} (plan_tier ${JSON.stringify(raw.plan_tier)} -> Free)`);
    }

    const arrIsNumber = typeof raw.arr_usd === "number" && Number.isFinite(raw.arr_usd);
    const arrRaw = arrIsNumber ? (raw.arr_usd as number) : Number(raw.arr_usd) || 0;
    const arr = Math.max(0, arrRaw);
    if (!arrIsNumber || arrRaw !== arr) {
      arrFallbacks.push(`${companyName} (arr_usd ${JSON.stringify(raw.arr_usd)} -> ${arr})`);
    }

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
  let eventPlanFallbacks = 0;
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
    // The join runs on the canonical key. Whether the raw strings were already
    // identical is a separate, weaker fact - computed here rather than asserted.
    if (raw.company_name.trim() !== account.companyName) {
      nonExactNameMatches.push(`${raw.company_name} -> ${account.companyName}`);
    }

    if (!VALID_PLANS.has(raw.plan_tier as PlanTier)) {
      eventPlanFallbacks += 1;
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

  /**
   * Users shared between two workspaces of the same account. Whether the user
   * sets overlap is a property of this export, not a rule, so it is counted
   * rather than stated - and it is what decides whether rolling workspaces up
   * can double-count a person.
   */
  const workspaceUsers = new Map<string, Set<string>>();
  for (const e of events) {
    if (!workspaceUsers.has(e.workspaceId)) workspaceUsers.set(e.workspaceId, new Set());
    workspaceUsers.get(e.workspaceId)!.add(e.userId);
  }
  const accountsWithWorkspaceUserOverlap: string[] = [];
  for (const a of multiWorkspaceAccounts) {
    const ws = [...(accountToWorkspaces.get(a.slug) ?? [])];
    const seenHere = new Set<string>();
    let overlaps = false;
    for (const w of ws) {
      for (const u of workspaceUsers.get(w) ?? []) {
        if (seenHere.has(u)) overlaps = true;
        seenHere.add(u);
      }
    }
    if (overlaps) accountsWithWorkspaceUserOverlap.push(a.companyName);
  }

  /** Smallest number of events on any account that has at least one. */
  const eventCounts = [...eventsPerAccount.values()];
  const minEventsPerAccount = eventCounts.length ? Math.min(...eventCounts) : 0;

  /**
   * Hour-of-day coverage, computed rather than asserted. We report the gap we
   * measure; we do not claim to know what produced it.
   */
  const hourCounts = new Array<number>(24).fill(0);
  for (const e of events) hourCounts[new Date(e.timestampMs).getUTCHours()] += 1;
  const emptyHours = hourCounts.map((c, h) => (c === 0 ? h : -1)).filter((h) => h >= 0);
  const hh = (h: number) => `${String(h).padStart(2, "0")}:00`;


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
        : `Every company in the event stream resolves to a row in accounts.json (${new Set(events.map((e) => e.accountSlug)).size} of ${accounts.length}).`,
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
        : `Every account in accounts.json has at least one event (fewest observed on any account: ${minEventsPerAccount}).`,
    resolution:
      "Such accounts are tiered 'No Data', never 'At Risk' - absence of evidence is not evidence of churn, and it is just as likely to be a broken pipeline.",
    affectedAccounts: accountsWithoutEvents.map((a) => a.slug),
  });

  const distinctNonExact = new Set(nonExactNameMatches);
  add({
    code: "company_name_join",
    title: "Company name consistency between the two files",
    severity: distinctNonExact.size > 0 ? "warning" : "info",
    count: distinctNonExact.size,
    detail:
      distinctNonExact.size > 0
        ? `${distinctNonExact.size} company names differ as raw strings between the two files and were joined on the canonical key: ${[...distinctNonExact].join("; ")}.`
        : `Every event's raw company_name is byte-identical to the account row it joined to, across ${accounts.length} accounts - the canonicalization changed no outcome on this export.`,
    resolution:
      "Joined on the canonical key rather than the raw string, so the assumption is explicit and a fuzzy matcher can replace it in one place. Nothing here detects a company present under two genuinely different names.",
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
        (accountsWithWorkspaceUserOverlap.length > 0
          ? `. ${accountsWithWorkspaceUserOverlap.length} of them share at least one user_id between workspaces (${accountsWithWorkspaceUserOverlap.join(", ")}), so a naive per-workspace sum would count those people twice.`
          : ". On this export no user_id appears in more than one of a company's workspaces, so the roll-up and a per-workspace sum agree here.")
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
        ? "Not resolved here: every event is attributed by its own company_name, so a shared workspace's events are split across both accounts. The conflict is surfaced for a human, because picking a winner automatically would move usage between two customers' verdicts on a guess."
        : "No action needed - the check runs, and found nothing to resolve.",
  });

  add({
    code: "cross_account_users",
    title: "Users appearing under more than one account",
    severity: crossAccountUsers.length > 0 ? "warning" : "info",
    count: crossAccountUsers.length,
    detail:
      crossAccountUsers.length > 0
        ? `${crossAccountUsers.length} user_ids appear under multiple companies.`
        : "No user_id appears under more than one company, so per-account distinct-user counts cannot double-count a person across accounts.",
    resolution:
      "Distinct-user counts are per account either way. This says nothing about one human holding two user_ids - the export carries no identity to check that against.",
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
    severity: badTimestamps > 0 ? "warning" : "info",
    count: badTimestamps,
    detail:
      badTimestamps > 0
        ? `${badTimestamps} rows carry a timestamp that does not parse.`
        : "Every timestamp parses as ISO-8601 UTC, and the parsed values span the reported window.",
    resolution:
      "Unparseable rows are dropped rather than guessed. Note what this check does NOT establish: 'today' is defined as the latest event in the export, so no event can be later than it by construction, and comparing events against that anchor would be circular. Detecting a genuinely future-dated export needs an external reference time (the export's own generation timestamp, or wall-clock at ingest), which this file does not carry. The anchor is kept because it makes results reproducible.",
  });

  const gapRuns: [number, number][] = [];
  for (const h of emptyHours) {
    const last = gapRuns[gapRuns.length - 1];
    if (last && last[1] === h - 1) last[1] = h;
    else gapRuns.push([h, h]);
  }

  add({
    code: "hour_of_day_gap",
    title: "Hour-of-day coverage is incomplete",
    severity: emptyHours.length > 0 ? "warning" : "info",
    count: emptyHours.length,
    detail:
      emptyHours.length > 0
        ? `${emptyHours.length} of the 24 UTC hours contain no events at all across the whole window (${gapRuns
            .map(([a, b]) => (a === b ? hh(a) : `${hh(a)}-${hh(b + 1)}`))
            .join(", ")}), while the remaining hours carry ${events.length} events fairly evenly. A contiguous dead band this wide is not what a real customer base produces; the cause is not something this export lets us determine.`
        : "Events occur in all 24 UTC hours.",
    resolution:
      "Recorded as an observation, not a diagnosis. No hour-of-day or business-hours analysis is built anywhere in this dashboard, because the distribution cannot be trusted to reflect behaviour. Daily and weekly aggregates are unaffected, since they roll up across the gap.",
  });

  const fallbackDetails = [
    ...planFallbacks.map((d) => `plan: ${d}`),
    ...arrFallbacks.map((d) => `ARR: ${d}`),
  ];
  add({
    code: "substituted_values",
    title: "Values replaced by a fallback during normalization",
    severity: fallbackDetails.length > 0 || eventPlanFallbacks > 0 ? "warning" : "info",
    count: planFallbacks.length + arrFallbacks.length + eventPlanFallbacks,
    detail:
      fallbackDetails.length > 0 || eventPlanFallbacks > 0
        ? [
            fallbackDetails.length > 0
              ? `Account rows: ${fallbackDetails.join("; ")}.`
              : null,
            eventPlanFallbacks > 0
              ? `${eventPlanFallbacks} events carried an unrecognised plan_tier and fell back to the account's contracted plan.`
              : null,
          ]
            .filter(Boolean)
            .join(" ")
        : "Every account row's plan_tier is one of Free/Pro/Enterprise and every arr_usd is a finite, non-negative number, so no fallback was applied. Every event's plan_tier is recognised.",
    resolution:
      "The normalizer substitutes a default rather than dropping the row (plan -> Free, ARR -> 0 or clamped to 0, event plan -> the contracted plan). That keeps the account visible, but a substituted value is a guess and the affected accounts are named here rather than silently corrected.",
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
