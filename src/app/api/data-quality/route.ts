/**
 * GET /api/data-quality
 *
 * The checks the pipeline ran and what each one found - including the ones that
 * came back clean, because "no duplicates were found" and "duplicates were
 * never checked for" are very different statements about a dataset.
 */

import { NextResponse } from "next/server";
import { getQualityReport } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return NextResponse.json(getQualityReport());
  } catch (error) {
    return NextResponse.json(
      { error: (error as Error).message, hint: "Run `npm run ingest` to build data/health.db." },
      { status: 503 },
    );
  }
}
