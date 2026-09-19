/**
 * Generates data/usage_events.json + data/accounts.json.
 *
 * These stand in for the exercise's attached export until the real files land.
 * Drop the real files into data/ and delete this script — nothing in src/
 * imports it. The point of generating rather than hand-writing is that the
 * pipeline in src/lib has to earn its scores from raw events, and the
 * deliberate messiness in the brief is reproduced here on purpose:
 *
 *   - Orcus Retail Group  3 workspaces, company_name spelled 3 different ways
 *   - Northwind Analytics 2 workspaces under one contract
 *   - ws_8841             events with no matching accounts.json row
 *   - Brightline Tutors   account row, zero events
 *   - Mint Hill Schools   event stream stops dead mid-window (ingestion gap)
 *   - Thornbury Media     plan_tier changes Free -> Pro mid-window
 *   - every account       60-70% weekend troughs
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SNAPSHOT = Date.parse("2026-09-12T00:00:00Z");
const DAYS = 90;
const DAY_MS = 86_400_000;

/** Mulberry32 - deterministic, so regenerating gives an identical export. */
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * profile fields
 *   creates      baseline guide_created per day at the start of the window
 *   trend        linear drift applied across the window (-1 .. +1)
 *   viewsPer     guide_viewed emitted per guide_created
 *   sharesPer30  guide_shared per 30 days
 *   invitesPer30 user_invited per 30 days
 *   activeShare  share of known users active in the trailing 30 days
 *   createGap    force no guide_created in the final N days
 *   cutAt        all events stop at this day index (ingestion gap)
 *   silent       emit nothing at all
 */
const ACCOUNTS = [
  { name: "Corvus Security", domain: "corvussec.com", plan: "Enterprise", arr: 175000, csm: "Dana Okafor",
    start: "2024-02-19", seats: 64, ws: [["ws_1042", 1]], seed: 11,
    creates: 1.30, trend: 0.22, viewsPer: 8.4, sharesPer30: 22, invitesPer30: 9, activeShare: 0.58 },

  { name: "Kestrel Labs", domain: "kestrel-labs.io", plan: "Enterprise", arr: 210000, csm: "Dana Okafor",
    start: "2023-11-03", seats: 88, ws: [["ws_2231", 1]], seed: 23,
    creates: 1.5, trend: -0.88, viewsPer: 6.1, sharesPer30: 3, invitesPer30: 0, activeShare: 0.14, createGap: 17 },

  { name: "Northwind Analytics", domain: "northwind-analytics.com", plan: "Enterprise", arr: 148000, csm: "Ravi Menon",
    start: "2024-06-11", seats: 52, ws: [["ws_3310", 0.71], ["ws_3311", 0.29]], seed: 37,
    creates: 0.80, trend: 0.08, viewsPer: 9.1, sharesPer30: 14, invitesPer30: 4, activeShare: 0.50,
    aliases: ["Northwind Analytics", "Northwind Analytics Inc."] },

  { name: "Orcus Retail Group", domain: "orcusretail.com", plan: "Pro", arr: 34000, csm: "Ravi Menon",
    start: "2024-09-27", seats: 31, ws: [["ws_4402", 0.52], ["ws_4403", 0.31], ["ws_4419", 0.17]], seed: 41,
    creates: 0.50, trend: 0.34, viewsPer: 7.2, sharesPer30: 11, invitesPer30: 6, activeShare: 0.46,
    aliases: ["Orcus Retail Group", "Orcus Retail Grp.", "ORCUS RETAIL GROUP"] },

  { name: "Lumen Dental", domain: "lumendental.co", plan: "Pro", arr: 22000, csm: "Priya Shah",
    start: "2025-01-14", seats: 18, ws: [["ws_5150", 1]], seed: 53,
    creates: 0.32, trend: 0.18, viewsPer: 6.8, sharesPer30: 7, invitesPer30: 2, activeShare: 0.68 },

  { name: "Quarry Software", domain: "quarry.dev", plan: "Pro", arr: 37000, csm: "Priya Shah",
    start: "2025-03-02", seats: 26, ws: [["ws_6071", 1]], seed: 67,
    creates: 0.26, trend: 0.92, viewsPer: 5.9, sharesPer30: 13, invitesPer30: 8, activeShare: 0.44 },

  { name: "Halden Medical", domain: "haldenmedical.com", plan: "Enterprise", arr: 96000, csm: "Ravi Menon",
    start: "2024-04-30", seats: 47, ws: [["ws_7712", 1]], seed: 71,
    creates: 0.40, trend: -0.34, viewsPer: 3.1, sharesPer30: 4, invitesPer30: 1, activeShare: 0.28 },

  { name: "Ostara Bio", domain: "ostarabio.com", plan: "Enterprise", arr: 118000, csm: "Dana Okafor",
    start: "2024-08-08", seats: 39, ws: [["ws_8120", 1]], seed: 83,
    creates: 0.40, trend: -0.04, viewsPer: 7.0, sharesPer30: 6, invitesPer30: 2, activeShare: 0.40 },

  { name: "Ardent Logistics", domain: "ardentlogistics.com", plan: "Enterprise", arr: 132000, csm: "Priya Shah",
    start: "2023-07-21", seats: 71, ws: [["ws_9004", 1]], seed: 97,
    creates: 0.34, trend: -0.2, viewsPer: 6.6, sharesPer30: 3, invitesPer30: 0, activeShare: 0.22 },

  { name: "Thornbury Media", domain: "thornburymedia.com", plan: "Pro", arr: 41000, csm: "Dana Okafor",
    start: "2024-10-05", seats: 29, ws: [["ws_1188", 1]], seed: 103,
    creates: 0.62, trend: -0.78, viewsPer: 4.6, sharesPer30: 1, invitesPer30: 0, activeShare: 0.28,
    createGap: 14, planChange: { day: 34, from: "Free", to: "Pro" } },

  { name: "Petra Civil", domain: "petracivil.com", plan: "Pro", arr: 19000, csm: "Ravi Menon",
    start: "2025-02-11", seats: 14, ws: [["ws_1290", 1]], seed: 109,
    creates: 0.42, trend: -0.92, viewsPer: 4.1, sharesPer30: 0, invitesPer30: 0, activeShare: 0.21, createGap: 34 },

  { name: "Fenwick Partners", domain: "fenwickpartners.law", plan: "Free", arr: 0, csm: "Unassigned",
    start: "2025-05-19", seats: 9, ws: [["ws_1355", 1]], seed: 127,
    creates: 0.16, trend: -0.7, viewsPer: 3.4, sharesPer30: 1, invitesPer30: 0, activeShare: 0.30, createGap: 19 },

  { name: "Sable & Roe", domain: "sableroe.com", plan: "Free", arr: 0, csm: "Unassigned",
    start: "2025-06-30", seats: 6, ws: [["ws_1401", 1]], seed: 131,
    creates: 0.10, trend: 0.55, viewsPer: 3.6, sharesPer30: 2, invitesPer30: 1, activeShare: 0.55 },

  { name: "Vantage Freight", domain: "vantagefreight.com", plan: "Pro", arr: 28000, csm: "Priya Shah",
    start: "2024-12-08", seats: 22, ws: [["ws_1466", 1]], seed: 139,
    creates: 0.26, trend: -0.14, viewsPer: 5.8, sharesPer30: 5, invitesPer30: 1, activeShare: 0.42 },

  // account row, zero events - signed up 21 days before the snapshot
  { name: "Brightline Tutors", domain: "brightlinetutors.org", plan: "Free", arr: 0, csm: "Unassigned",
    start: "2026-08-22", seats: 4, ws: [["ws_1512", 1]], seed: 149, silent: true },

  // healthy, then the stream stops dead on day 41 with no tail-off
  { name: "Mint Hill Schools", domain: "minthill.k12.us", plan: "Pro", arr: 16000, csm: "Ravi Menon",
    start: "2024-03-17", seats: 25, ws: [["ws_1573", 1]], seed: 151,
    creates: 0.85, trend: 0.02, viewsPer: 5.8, sharesPer30: 9, invitesPer30: 5, activeShare: 0.52, cutAt: 41 }
];

/** Events from a workspace that has no row in accounts.json at all. */
const ORPHAN = {
  name: "Vesper Interactive", ws: "ws_8841", seed: 211,
  creates: 0.5, trend: 0.1, viewsPer: 6.2, sharesPer30: 5, invitesPer30: 2, users: 12, plan: "Pro"
};

const events = [];
let seq = 0;

function eventId() {
  seq += 1;
  return "evt_" + String(seq).padStart(6, "0");
}
function stamp(day, r) {
  // business hours, UTC, with a plausible spread
  const hour = 8 + Math.floor(r() * 11);
  const min = Math.floor(r() * 60);
  const sec = Math.floor(r() * 60);
  return new Date(SNAPSHOT - (DAYS - 1 - day) * DAY_MS + hour * 3600000 + min * 60000 + sec * 1000).toISOString();
}
function weekendFactor(day) {
  // day 0 is the oldest; anchor so the cycle is stable across accounts
  const dow = (day + 3) % 7;
  return dow === 5 || dow === 6 ? 0.34 : 1;
}
function pick(arr, r) {
  return arr[Math.floor(r() * arr.length)];
}

/**
 * Heavy-tail user picker. In real product data a minority of seats generate
 * most events and many seats are near-dormant; uniform picking made every
 * known user active in every 30-day window, which pegged adoption breadth at
 * 100 for the entire book.
 */
function weightedPicker(arr) {
  const w = arr.map((_, i) => 1 / Math.pow(i + 1, 1.35));
  const total = w.reduce((s, x) => s + x, 0);
  const cum = [];
  let acc = 0;
  for (const x of w) { acc += x / total; cum.push(acc); }
  return (r) => {
    const u = r();
    for (let i = 0; i < cum.length; i += 1) if (u <= cum[i]) return arr[i];
    return arr[arr.length - 1];
  };
}
function poisson(mean, r) {
  if (mean <= 0) return 0;
  // small means only - good enough and deterministic
  let n = 0;
  let p = Math.exp(-mean);
  let acc = p;
  const u = r();
  while (u > acc && n < 40) {
    n += 1;
    p = (p * mean) / n;
    acc += p;
  }
  return n;
}

function emitAccount(a) {
  const r = rng(a.seed);
  const wsIds = a.ws.map(([id]) => id);
  const wsWeights = a.ws.map(([, w]) => w);
  const names = a.aliases && a.aliases.length ? a.aliases : [a.name];

  const knownUsers = Math.max(3, Math.round(a.seats * 0.82));
  const users = Array.from({ length: knownUsers }, (_, i) => `usr_${a.seed}_${i + 1}`);

  /**
   * activeShare is the share active at the END of the window. The cohort ramps
   * to it smoothly from a start share implied by the trend, rather than
   * switching at day 60 - an earlier version did the latter and mechanically
   * depressed momentum for every account, healthy ones included.
   */
  const endShare = a.activeShare ?? 0.5;
  const startShare = Math.max(0.08, Math.min(0.95, endShare - (a.trend ?? 0) * 0.3));
  const shareAt = (day) => startShare + (endShare - startShare) * (day / (DAYS - 1));

  const wsFor = () => {
    const u = r();
    let acc = 0;
    for (let i = 0; i < wsIds.length; i += 1) {
      acc += wsWeights[i];
      if (u <= acc) return wsIds[i];
    }
    return wsIds[wsIds.length - 1];
  };
  const nameFor = () => (names.length === 1 ? names[0] : pick(names, r));
  const planAt = (day) => {
    if (a.planChange) return day < a.planChange.day ? a.planChange.from : a.planChange.to;
    return a.plan;
  };

  const push = (day, type, user) => {
    events.push({
      event_id: eventId(),
      workspace_id: wsFor(),
      company_name: nameFor(),
      event_type: type,
      user_id: user,
      timestamp: stamp(day, r),
      plan_tier: planAt(day)
    });
  };

  for (let day = 0; day < DAYS; day += 1) {
    if (a.cutAt !== undefined && day >= a.cutAt) continue;

    const daysFromEnd = DAYS - 1 - day;
    const drift = 1 + (a.trend ?? 0) * (day / (DAYS - 1));
    const wf = weekendFactor(day);

    const cohortSize = Math.max(1, Math.round(knownUsers * shareAt(day)));
    const cohort = users.slice(0, cohortSize);
    const creatorCohort = cohort.slice(0, Math.max(1, Math.round(cohortSize * 0.45)));
    const pickUser = weightedPicker(cohort);
    const pickCreator = weightedPicker(creatorCohort);

    const inCreateGap = a.createGap !== undefined && daysFromEnd < a.createGap;
    const created = inCreateGap ? 0 : poisson(a.creates * drift * wf, r);
    for (let i = 0; i < created; i += 1) push(day, "guide_created", pickCreator(r));

    // views track the library, not only today's creations
    const viewMean = a.creates * (a.viewsPer ?? 5) * drift * wf * (inCreateGap ? 0.45 : 1);
    const viewed = poisson(viewMean, r);
    for (let i = 0; i < viewed; i += 1) push(day, "guide_viewed", pickUser(r));

    const shared = poisson(((a.sharesPer30 ?? 0) / 30) * drift * wf, r);
    for (let i = 0; i < shared; i += 1) push(day, "guide_shared", pickCreator(r));

    const invited = poisson(((a.invitesPer30 ?? 0) / 30) * drift * wf, r);
    for (let i = 0; i < invited; i += 1) push(day, "user_invited", pickCreator(r));

    const logins = poisson(cohort.length * 0.09 * wf * Math.max(0.5, drift), r);
    for (let i = 0; i < logins; i += 1) push(day, "login", pickUser(r));
  }
}

function emitOrphan(o) {
  const r = rng(o.seed);
  const users = Array.from({ length: o.users }, (_, i) => `usr_${o.seed}_${i + 1}`);
  for (let day = 0; day < DAYS; day += 1) {
    const drift = 1 + o.trend * (day / (DAYS - 1));
    const wf = weekendFactor(day);
    const push = (type) => {
      events.push({
        event_id: eventId(),
        workspace_id: o.ws,
        company_name: o.name,
        event_type: type,
        user_id: pick(users, r),
        timestamp: stamp(day, r),
        plan_tier: o.plan
      });
    };
    for (let i = 0, n = poisson(o.creates * drift * wf, r); i < n; i += 1) push("guide_created");
    for (let i = 0, n = poisson(o.creates * o.viewsPer * drift * wf, r); i < n; i += 1) push("guide_viewed");
    for (let i = 0, n = poisson((o.sharesPer30 / 30) * wf, r); i < n; i += 1) push("guide_shared");
    for (let i = 0, n = poisson((o.invitesPer30 / 30) * wf, r); i < n; i += 1) push("user_invited");
    for (let i = 0, n = poisson(users.length * 0.14 * wf, r); i < n; i += 1) push("login");
  }
}

for (const a of ACCOUNTS) if (!a.silent) emitAccount(a);
emitOrphan(ORPHAN);

events.sort((x, y) => (x.timestamp < y.timestamp ? -1 : x.timestamp > y.timestamp ? 1 : 0));
// re-number so event_id order matches timestamp order, like a real export
events.forEach((e, i) => { e.event_id = "evt_" + String(i + 1).padStart(6, "0"); });

const accountRows = ACCOUNTS.map((a) => ({
  company_name: a.name,
  domain: a.domain,
  plan_tier: a.plan,
  contract_start_date: a.start,
  arr_usd: a.arr,
  csm_owner: a.csm
}));

mkdirSync(join(ROOT, "data"), { recursive: true });
writeFileSync(join(ROOT, "data", "usage_events.json"), JSON.stringify(events), "utf8");
writeFileSync(join(ROOT, "data", "accounts.json"), JSON.stringify(accountRows, null, 2), "utf8");

const byType = events.reduce((m, e) => ((m[e.event_type] = (m[e.event_type] || 0) + 1), m), {});
console.log(`usage_events.json  ${events.length.toLocaleString()} events`);
console.log(`accounts.json      ${accountRows.length} accounts`);
console.log("by type            " + Object.entries(byType).map(([k, v]) => `${k}=${v}`).join("  "));
console.log("workspaces         " + new Set(events.map((e) => e.workspace_id)).size);
