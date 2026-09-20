/**
 * GET /api/accounts/:slug
 *
 * Everything the drill-down needs to justify a verdict without the caller
 * touching a raw event: the four pillar sentences with their points, any
 * overrides that capped the tier, the risk register with its severity
 * derivation, the 13-week activity series and the per-workspace split.
 */

import { NextResponse } from "next/server";
import { getAccountDetail, getSnapshotDate } from "@/lib/db";
import { TREND } from "@/lib/config";
import { computeTrend } from "@/lib/metrics";

export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params;

  try {
    const summary = getAccountDetail(slug);
    if (!summary) {
      return NextResponse.json({ error: `No account with slug "${slug}".` }, { status: 404 });
    }

    const trend = computeTrend(summary.metrics, TREND.minEvents, TREND.minChange);

    return NextResponse.json({
      snapshotDate: getSnapshotDate(),
      ...summary,
      // Reported only above the volume gate; see config.ts for why.
      trend: trend.reportable ? trend : { ...trend, changePct: null },
    });
  } catch (error) {
    return NextResponse.json(
      { error: (error as Error).message, hint: "Run `npm run ingest` to build data/health.db." },
      { status: 503 },
    );
  }
}
