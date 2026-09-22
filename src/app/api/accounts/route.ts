/**
 * GET /api/accounts
 *
 * The worklist. Filtering and sorting happen in SQL against the flat columns
 * written during ingest, so this route never recomputes a verdict - it serves
 * the one that was computed and stored, which is what keeps the API, the UI and
 * the database incapable of disagreeing.
 *
 * Query params: tier, plan, csm, risk, search, sort=priority|score|arr|silent|name
 */

import { NextResponse } from "next/server";
import { getFilterOptions, getSnapshotDate, listAccounts, parseSort, type AccountFilters } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const plans = params.getAll("plan");

  const filters: AccountFilters = {
    tier: params.get("tier") ?? undefined,
    plan: plans.length ? plans : undefined,
    csm: params.get("csm") ?? undefined,
    risk: params.get("risk") ?? undefined,
    search: params.get("search") ?? undefined,
    sort: parseSort(params.get("sort")),
  };

  try {
    const accounts = listAccounts(filters);
    return NextResponse.json({
      snapshotDate: getSnapshotDate(),
      count: accounts.length,
      filters,
      options: getFilterOptions(),
      accounts,
    });
  } catch (error) {
    return NextResponse.json(
      { error: (error as Error).message, hint: "Run `npm run ingest` to build data/health.db." },
      { status: 503 },
    );
  }
}
