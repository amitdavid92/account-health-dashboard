/**
 * The suggested next action for an account.
 *
 * This is a fixed lookup from the leading risk that the model already ranked -
 * it does not reorder risks, invent a severity, or consult anything. It is a
 * triage convention written down, and the UI labels it "Suggested action" for
 * that reason: it is what a CSM would usually do next, not a conclusion the
 * data proves.
 *
 * Every action is phrased as a question to ask the customer rather than a
 * finding to act on. The dashboard can see that usage fell; it cannot see why,
 * and the difference between "they churned" and "their champion went on leave"
 * is a conversation, not a metric.
 */

import type { HealthTier, Risk } from "./types";

const BY_RISK_CODE: Record<string, string> = {
  single_user: "Verify the single-user dependency with the account owner",
  dormant: "Ask the account owner what changed in their usage",
  usage_collapse: "Ask the account owner what changed in their usage",
  adoption_collapse: "Ask the account owner why the wider team stopped using it",
  no_core_value: "Ask what is blocking guide creation or sharing",
  login_only_recent: "Ask what is blocking guide creation or sharing",
  plan_downgrade: "Confirm the current plan with the account owner",
  no_audience: "Ask how guides are being distributed and consumed",
  high_value_low_adoption: "Review adoption against the contract with the account owner",
  no_data: "Check data coverage and workspace mapping before drawing a usage conclusion",
};

/**
 * When no rule fired, say something modest and tier-appropriate.
 *
 * Deliberately not "no risk": no rule firing means no rule fired, which is not
 * the same as an account being safe. Twelve of the twenty-five accounts here
 * land in the Healthy branch, so this wording carries half the book.
 */
const BY_TIER: Record<HealthTier, string> = {
  Healthy: "No follow-up indicated by the usage signals in this window",
  Watch: "Review usage at the next scheduled check-in",
  "At Risk": "Review the score breakdown before the next renewal conversation",
  "No Data": BY_RISK_CODE.no_data,
};

/** The leading risk decides; with no risk, the tier does. */
export function suggestedAction(tier: HealthTier, topRisk: Risk | null): string {
  if (topRisk) return BY_RISK_CODE[topRisk.code] ?? BY_TIER[tier];
  return BY_TIER[tier];
}
