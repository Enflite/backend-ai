/**
 * flowEnsure.ts — per-tenant converge of the SyteLine form-customization
 * flow onto the Flows platform.
 *
 * The canonical pipeline definition lives in
 * flows/syteline-form-customization.flow.json at the repo root (the same
 * directory POST /flows/ensure converges). Before every run, the runner
 * calls ensureFlowLive: on first use it creates the flow, publishes v1,
 * and points the live alias at it; afterwards it republishes + re-points
 * only when the repo JSON drifts from the live version. The platform
 * runner always executes the frozen live version, so the pipeline is a
 * versioned flow in the full platform sense.
 */

import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { AppError } from '../errors.js';
import type { AuthContext } from '../authz/permissions.js';
import { flowDefinitionSchema, type FlowDefinition } from '../flows/flowTypes.js';
import {
  createFlow,
  definitionHash,
  getFlow,
  getLiveDefinition,
  publishVersion,
  setLiveAlias,
  updateFlowDraft,
} from '../flows/flowStore.js';

export const FORM_CUSTOMIZATION_FLOW_NAME = 'syteline-form-customization';

/**
 * Candidate locations for the repo-root `flows/` directory (same as the
 * platform's POST /flows/ensure; Windows-safe via node:path).
 */
function flowsRepoDirCandidates(): string[] {
  return [join(process.cwd(), 'flows'), join(process.cwd(), '..', 'flows')];
}

function findFlowsDir(): string {
  for (const dir of flowsRepoDirCandidates()) {
    try {
      if (statSync(dir).isDirectory()) return dir;
    } catch {
      // Try the next candidate.
    }
  }
  throw new Error('No flows/ directory found at the repo root');
}

/** Load + validate the repo's flow JSON. Throws on unreadable/invalid. */
export function loadFormCustomizationFlowJson(): FlowDefinition {
  const dir = findFlowsDir();
  const raw = readFileSync(join(dir, `${FORM_CUSTOMIZATION_FLOW_NAME}.flow.json`), 'utf8');
  const check = flowDefinitionSchema.safeParse(JSON.parse(raw) as unknown);
  if (!check.success) {
    throw new Error(
      `Invalid ${FORM_CUSTOMIZATION_FLOW_NAME}.flow.json: ` +
        check.error.issues
          .slice(0, 3)
          .map((issue) => issue.message)
          .join('; '),
    );
  }
  if (check.data.name !== FORM_CUSTOMIZATION_FLOW_NAME) {
    throw new Error(
      `Flow JSON name mismatch: expected "${FORM_CUSTOMIZATION_FLOW_NAME}", got "${check.data.name}"`,
    );
  }
  return check.data;
}

/**
 * Ensure the tenant's `syteline-form-customization` flow exists and its
 * live alias points at the repo's flow JSON. Converges idempotently:
 * cheap no-op when the live version already matches. Returns the live
 * version number.
 */
export async function ensureFlowLive(auth: AuthContext): Promise<number> {
  const { tenantId } = auth;
  const definition = loadFormCustomizationFlowJson();
  const repoHash = definitionHash(definition);

  let flow = await getFlow(tenantId, FORM_CUSTOMIZATION_FLOW_NAME);
  if (!flow) {
    flow = await createFlow(auth, definition);
  } else if (definitionHash(flow.draft) !== repoHash) {
    flow = await updateFlowDraft(tenantId, FORM_CUSTOMIZATION_FLOW_NAME, definition, auth.userId);
  }

  const live = await getLiveDefinition(tenantId, FORM_CUSTOMIZATION_FLOW_NAME);
  if (live && definitionHash(live.definition) === repoHash) {
    return live.version;
  }

  // Publish the repo JSON unless the latest version already holds it.
  const latest = flow.versions[flow.versions.length - 1];
  let version: number;
  if (latest && definitionHash(latest.definition) === repoHash) {
    version = latest.version;
  } else {
    const published = await publishVersion(tenantId, FORM_CUSTOMIZATION_FLOW_NAME, auth.userId);
    version = published.version.version;
  }

  // Point the live alias at it (If-Match revision guard; retry the race).
  for (let attempt = 0; attempt < 3; attempt++) {
    const current = await getFlow(tenantId, FORM_CUSTOMIZATION_FLOW_NAME);
    if (!current) throw new Error('Flow disappeared during ensureFlowLive');
    if (current.liveVersion === version) return version;
    try {
      await setLiveAlias(tenantId, FORM_CUSTOMIZATION_FLOW_NAME, version, current.revision);
      return version;
    } catch (error) {
      const mismatch = error instanceof AppError && error.code === 'REVISION_MISMATCH';
      if (!mismatch || attempt === 2) throw error;
    }
  }
  throw new Error('ensureFlowLive: could not set the live alias after retries');
}
