/**
 * The chat assistant's tool surface.
 *
 * Every tool is a thin, read-only wrapper over `db.ts` - the same storage
 * layer the pages and the /api routes call. The model never computes a score,
 * a risk, or an ARR figure itself; it only asks for numbers that were already
 * produced by the ingest pipeline and reports them. That keeps a chat answer
 * incapable of disagreeing with what the dashboard itself shows.
 *
 * Responses are trimmed, not the raw AccountSummary/AccountListRow shapes:
 * the 13-week chart series and the per-workspace breakdown exist for the UI,
 * not for a sentence-length answer, and leaving them out keeps each tool
 * result small.
 */

import { Type, type FunctionDeclaration } from "@google/genai";
import {
  getAccountDetail,
  getPortfolioKpis,
  getQualityReport,
  listAccounts,
  type AccountFilters,
  type AccountListRow,
} from "./db";
import { slugify } from "./normalize";
import type { AccountSummary } from "./types";

export const CHAT_TOOLS: FunctionDeclaration[] = [
  {
    name: "list_accounts",
    description:
      "List accounts, optionally filtered and sorted. Use `search` to find accounts by a partial company name or domain. Returns each account's health tier and score, ARR, CSM owner, days since last activity, and its top risk - enough to answer 'which accounts are X' questions without opening each one.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        tier: {
          type: Type.STRING,
          enum: ["Healthy", "Watch", "At Risk", "No Data"],
          description: "Filter to one health tier.",
        },
        plan: {
          type: Type.STRING,
          enum: ["Free", "Pro", "Enterprise"],
          description: "Filter to one contracted plan.",
        },
        csm: { type: Type.STRING, description: "Filter to one CSM owner's exact name." },
        risk: {
          type: Type.STRING,
          description:
            'Filter to accounts where this risk code fires, e.g. "dormant", "single_user", "no_core_value", "usage_collapse", "plan_downgrade".',
        },
        search: {
          type: Type.STRING,
          description: "Case-insensitive partial match against company name or domain.",
        },
        sort: {
          type: Type.STRING,
          enum: ["priority", "score", "arr", "silent", "name"],
          description:
            '"priority" (default) is ARR-weighted risk - the order a CSM should work the list. "silent" sorts by days since last activity.',
        },
      },
    },
  },
  {
    name: "get_account_detail",
    description:
      'Full health breakdown for one account: score, tier, every pillar\'s evidence, any overrides that capped the tier, and every risk with why it matters. This is the tool for "why does X score what it scores" or "what is wrong with X" questions. Accepts a company name, slug, or domain - fuzzy matched, so partial names work.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        company: {
          type: Type.STRING,
          description:
            'Company name, slug, or domain, e.g. "Pinnacle", "pinnacle-manufacturing", or a partial name.',
        },
      },
      required: ["company"],
    },
  },
  {
    name: "get_portfolio_summary",
    description:
      'Portfolio-wide KPIs: total ARR, ARR at risk, tier counts, dormant/single-user/no-core-usage account counts, median score. Use this for "how is the whole book doing" questions rather than adding up individual accounts.',
    parameters: { type: Type.OBJECT, properties: {} },
  },
  {
    name: "get_data_quality",
    description:
      "The data-quality report: every check the ingest pipeline ran against the raw export, what it found, and what was done about it. Use this for questions about data trustworthiness, dropped rows, or known limitations - e.g. whether an odd-looking number is a data issue.",
    parameters: { type: Type.OBJECT, properties: {} },
  },
];

function projectListRow(r: AccountListRow) {
  return {
    slug: r.slug,
    companyName: r.companyName,
    domain: r.domain,
    planTier: r.planTier,
    arrUsd: r.arrUsd,
    csmOwner: r.csmOwner,
    tier: r.tier,
    score: r.score,
    lowConfidence: r.lowConfidence,
    daysSinceLastEvent: r.daysSinceLastEvent,
    activeUsersRecent: r.activeUsersRecent,
    riskCount: r.riskCount,
    topRisk: r.topRisk,
  };
}

function projectAccountDetail(s: AccountSummary) {
  return {
    account: {
      companyName: s.account.companyName,
      domain: s.account.domain,
      planTier: s.account.planTier,
      arrUsd: s.account.arrUsd,
      csmOwner: s.account.csmOwner,
      contractStartDate: s.account.contractStartDate,
    },
    health: {
      score: s.health.score,
      tier: s.health.tier,
      tierFromScore: s.health.tierFromScore,
      lowConfidence: s.health.lowConfidence,
      confidenceNote: s.health.confidenceNote,
      pillars: s.health.pillars.map((p) => ({
        label: p.label,
        points: p.points,
        maxPoints: p.maxPoints,
        evidence: p.evidence,
      })),
      overrides: s.health.overrides.map((o) => ({ reason: o.reason, cappedAt: o.cappedAt })),
    },
    metrics: {
      totalEvents: s.metrics.totalEvents,
      eventsRecent: s.metrics.eventsRecent,
      daysSinceLastEvent: s.metrics.daysSinceLastEvent,
      knownUsers: s.metrics.knownUsers,
      activeUsersRecent: s.metrics.activeUsersRecent,
      workspaceCount: s.metrics.workspaceCount,
      loginShare: s.metrics.loginShare,
      planAtLastEvent: s.metrics.planAtLastEvent,
      planDowngraded: s.metrics.planDowngraded,
    },
    risks: s.risks.map((r) => ({
      title: r.title,
      severity: r.severity,
      evidence: r.evidence,
      whyItMatters: r.whyItMatters,
      escalations: r.escalations,
      affectsHealth: r.affectsHealth,
    })),
  };
}

/** Exact slug first, then a fuzzy name/domain search, so both "pinnacle-manufacturing" and "pinnacle" resolve. */
function resolveAccount(
  company: string,
): AccountSummary | { ambiguous: AccountListRow[] } | null {
  const bySlug = getAccountDetail(slugify(company));
  if (bySlug) return bySlug;

  const matches = listAccounts({ search: company } satisfies AccountFilters);
  if (matches.length === 1) return getAccountDetail(matches[0].slug);
  if (matches.length > 1) return { ambiguous: matches };
  return null;
}

export async function runChatTool(name: string, input: unknown): Promise<string> {
  switch (name) {
    case "list_accounts": {
      const filters = (input ?? {}) as AccountFilters;
      const rows = listAccounts(filters).map(projectListRow);
      return JSON.stringify({ count: rows.length, accounts: rows });
    }

    case "get_account_detail": {
      const { company } = input as { company: string };
      const resolved = resolveAccount(company);
      if (resolved === null) {
        return JSON.stringify({ error: `No account matches "${company}".` });
      }
      if ("ambiguous" in resolved) {
        return JSON.stringify({
          ambiguous: true,
          candidates: resolved.ambiguous.map((r) => ({
            companyName: r.companyName,
            domain: r.domain,
          })),
          note: "More than one account matches - ask which one, or call again with the exact company name.",
        });
      }
      return JSON.stringify(projectAccountDetail(resolved));
    }

    case "get_portfolio_summary":
      return JSON.stringify(getPortfolioKpis());

    case "get_data_quality":
      return JSON.stringify(getQualityReport());

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}
