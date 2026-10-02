/**
 * index.ts — the SyteLine Automation Studio backend foundation's narrow
 * public interface.
 *
 * The Studio builds no workflow engine: automations compile to the
 * existing Flows platform. This module is the substrate: named SyteLine
 * connections (encrypted tokens + capability probes), the typed action
 * catalog bound to real operations, and single-action test execution
 * against the real upstream.
 *
 * Everything outside this module interacts with the Studio's backend ONLY
 * through this surface:
 *
 * - `studioRoutes` — Fastify route registration (`/api/v1/studio`)
 *
 * The module's internals (store, probe, catalog, execution) are never
 * imported directly by the rest of the codebase, and the module itself
 * depends only on stable platform seams: auth, authz, config, audit, the
 * shared credentialCrypto helper, and Mongo.
 */

export { studioRoutes } from './routes.js';
export { STUDIO_VERSION } from './version.js';
