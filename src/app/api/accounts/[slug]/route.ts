import { getAccount } from "@/lib/service";

/**
 * GET /api/accounts/:slug
 *
 * The drill-down payload: the score, every input with its subscore, weight,
 * contribution and the raw evidence behind it, plus the workspace roll-up and
 * the daily series. This is the "why did it score that" contract - a client
 * should never have to recompute anything to explain a score.
 */
export async function GET(_request: Request, ctx: RouteContext<"/api/accounts/[slug]">) {
  const { slug } = await ctx.params;
  const account = getAccount(slug);

  if (!account) {
    return Response.json(
      { error: "not_found", message: `No account with slug "${slug}".` },
      { status: 404 },
    );
  }

  return Response.json({
    slug: account.slug,
    name: account.name,
    domain: account.domain,
    plan: account.plan,
    arr_usd: account.arr,
    csm_owner: account.csm,
    contract_start_date: account.contractStart,
    health: {
      score: account.health.score,
      band: account.health.band,
      scored: account.health.scored,
      heldOutReason: account.health.heldOutReason ?? null,
      heldOutDetail: account.health.heldOutDetail ?? null,
      lowConfidence: account.health.lowConfidence,
      confidenceNote: account.health.confidenceNote ?? null,
      // weights sum to 1, so contributions sum to score - by construction
      inputs: account.health.dimensions,
    },
    scorePrior30d: account.scorePrior,
    scoreDelta30d: account.scoreDelta,
    metrics: account.metrics,
    workspaces: account.workspaces,
    nameVariants: account.nameVariants,
    planTierChanges: account.planTierChanges,
    eventMix: account.mix,
    dailyEvents: account.daily,
    signals: account.signals,
  });
}
