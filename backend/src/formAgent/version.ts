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
 * Version of the form-customization flow definition (flow.ts). Bumped
 * whenever the pipeline's steps, contracts, or blocked semantics change.
 * Stored on every flow run so a future Flows platform can reconcile
 * runs against the definition that executed them.
 */
export const FORM_CUSTOMIZATION_FLOW_VERSION = '1.0.0';
