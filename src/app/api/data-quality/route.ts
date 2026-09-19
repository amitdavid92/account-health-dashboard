import { getBook, getDataQuality } from "@/lib/service";

/**
 * GET /api/data-quality
 *
 * Every judgement call the pipeline made about messy input, with the rule that
 * drove it. Exposed as an endpoint rather than buried in a README because the
 * people who need it most - a CSM about to phone a customer - are looking at
 * the dashboard, not the repo.
 */
export async function GET() {
  const { unmappedWorkspaces, accounts } = getBook();

  return Response.json({
    notes: getDataQuality(),
    unmappedWorkspaces,
    heldOut: accounts
      .filter((a) => !a.health.scored)
      .map((a) => ({
        slug: a.slug,
        name: a.name,
        arr_usd: a.arr,
        reason: a.health.heldOutReason,
        detail: a.health.heldOutDetail,
        daysSinceLastEvent: a.metrics.daysSinceLastEvent,
        eventsInWindow: a.metrics.totalEvents,
      })),
    lowConfidence: accounts
      .filter((a) => a.health.lowConfidence)
      .map((a) => ({
        slug: a.slug,
        name: a.name,
        score: a.health.score,
        note: a.health.confidenceNote,
      })),
  });
}
