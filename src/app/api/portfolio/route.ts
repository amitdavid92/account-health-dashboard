/**
 * GET /api/portfolio
 *
 * The numbers on the landing page. Aggregated once during ingest rather than
 * on each request, so the KPI strip and the account list can never tell two
 * different stories about the same snapshot.
 */

import { NextResponse } from "next/server";
import { getPortfolioKpis, listAccounts } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const kpis = getPortfolioKpis();
    const atRisk = listAccounts({ tier: "At Risk", sort: "arr" });
    return NextResponse.json({
      ...kpis,
      atRiskAccounts: atRisk.map((a) => ({
        slug: a.slug,
        companyName: a.companyName,
        arrUsd: a.arrUsd,
        csmOwner: a.csmOwner,
        topRisk: a.topRisk,
      })),
    });
  } catch (error) {
    return NextResponse.json(
      { error: (error as Error).message, hint: "Run `npm run ingest` to build data/health.db." },
      { status: 503 },
    );
  }
}
