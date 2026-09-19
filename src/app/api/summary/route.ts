import { BAND_THRESHOLDS, getSummary } from "@/lib/service";
import { DIMENSIONS, TARGETS } from "@/lib/health";

/**
 * GET /api/summary
 *
 * Book-level roll-up for the overview, plus the model definition itself. The
 * model ships with the numbers on purpose: anything consuming this API can
 * show a reader what the score means without hardcoding a copy of the weights.
 */
export async function GET() {
  const summary = getSummary();

  return Response.json({
    ...summary,
    model: {
      bands: {
        healthy: `>= ${BAND_THRESHOLDS.good}`,
        watch: `${BAND_THRESHOLDS.warn}-${BAND_THRESHOLDS.good - 1}`,
        atRisk: `< ${BAND_THRESHOLDS.warn}`,
        noSignal: "held out of scoring - see /api/data-quality",
      },
      inputs: DIMENSIONS.map((d) => ({
        key: d.key,
        name: d.name,
        weight: d.weight,
        rationale: d.rationale,
      })),
      targets: TARGETS,
      targetsNote:
        "Calibrated to roughly the 80th percentile of this export. Re-run `npm run calibrate` against a new export before trusting them.",
    },
  });
}
