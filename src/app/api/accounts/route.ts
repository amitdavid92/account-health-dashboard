import { getSummary, parseQuery, queryAccounts } from "@/lib/service";

/**
 * GET /api/accounts
 *
 * Query contract (shared verbatim with the UI's URL state, so any view in the
 * dashboard is reproducible as an API call):
 *   band=crit,warn,good,none   repeatable or comma-separated
 *   plan=Free|Pro|Enterprise
 *   csm=<owner>
 *   q=<name, domain or owner substring>
 *   sort=score|name|arr|delta|plan|csm|activity
 *   dir=asc|desc
 *
 * Returns the list shape the triage queue needs - not the full drill-down,
 * which is a separate call per account.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const sp: Record<string, string | string[]> = {};
  for (const key of url.searchParams.keys()) {
    const all = url.searchParams.getAll(key);
    sp[key] = all.length > 1 ? all : all[0];
  }

  const query = parseQuery(sp);
  const accounts = queryAccounts(query);

  return Response.json({
    meta: {
      snapshot: getSummary().snapshot,
      windowDays: getSummary().windowDays,
      returned: accounts.length,
      total: getSummary().accounts,
      query,
    },
    accounts: accounts.map((a) => ({
      slug: a.slug,
      name: a.name,
      domain: a.domain,
      plan: a.plan,
      arr_usd: a.arr,
      csm_owner: a.csm,
      contract_start_date: a.contractStart,
      workspaces: a.workspaces.length,
      health: {
        score: a.health.score,
        band: a.health.band,
        scored: a.health.scored,
        heldOutReason: a.health.heldOutReason ?? null,
        lowConfidence: a.health.lowConfidence,
      },
      scoreDelta30d: a.scoreDelta,
      events30d: a.metrics.events30,
      topSignal: a.signals[0]?.title ?? null,
    })),
  });
}
