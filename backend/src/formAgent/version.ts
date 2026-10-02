/**
 * version.ts — independent versioning for the SyteLine Form AI Agent
 * product surface and its flow definition.
 *
 * backend-ai is the platform; the Form AI Agent is a product on it
 * (Runtype's Products model). The product and its flow definition are
 * versioned independently of the platform so the module can evolve —
 * and later be extracted — without a platform release.
 */

export const PRODUCT_NAME = 'SyteLine Form AI Agent';

/** Product version, surfaced in API responses. */
export const FORM_AGENT_VERSION = '1.0.0';

/**
 * The pipeline's version is owned by the Flows platform now: the live
 * version of the `syteline-form-customization` flow, converged from
 * flows/syteline-form-customization.flow.json at the repo root. The old
 * bespoke-flow version constant is retired.
 */
