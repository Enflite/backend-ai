/**
 * version.ts — independent versioning for the APS Planning Agent product
 * surface (`/api/v1/aps/*`).
 *
 * backend-ai is the platform; the APS Planning Agent is a product on it
 * (Runtype's Products model). The product surface is versioned
 * independently of the platform so the module can evolve — and later be
 * extracted — without a platform release.
 *
 * The deterministic pipeline itself (the exception-resolution flows and
 * the aps.* tool substrate) is owned by the sibling coordinator and
 * versioned there; this module only names the flows it invokes
 * (SUBSTRATE_FLOW_NAMES) through the Flows platform.
 */

export const PRODUCT_NAME = 'APS Planning Agent';

/** Product version, surfaced in API responses. */
export const APS_PLANNING_VERSION = '1.0.0';

/**
 * Names of the sibling-owned Flows-platform flows this module invokes.
 * The flows are authored and versioned by the sibling coordinator
 * (backend/src/aps/, flows/aps-exception-*.flow.json); this module never
 * defines or forks them — it only invokes the live alias by name.
 * See docs/aps-planning-agent/contracts.md for the seam contract.
 */
export const SUBSTRATE_FLOW_NAMES = {
  analysis: 'aps-exception-analysis',
  verify: 'aps-exception-verify',
} as const;
