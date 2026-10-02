/**
 * api/syteline.ts — SyteLine UI automation ops via the generic tool endpoint.
 *
 * Covers credential management (syteline.ui.listCredentials /
 * saveCredentials / deleteCredentials) and session lifecycle
 * (syteline.ui.startSession / endSession). The list tool never returns secret
 * material; passwords travel only in the save call body over the existing
 * authed channel and are never logged, rendered, or retained here.
 *
 * API gaps found during discovery (backend/src/tools/sytelineUi.ts):
 * - There is no syteline.ui.listSessions tool: active sessions are not
 *   listable. The UI panel states this plainly instead of inventing state.
 * - syteline.ui.deleteCredentials takes no parameters and no credential id:
 *   the saved credential is per-user (save replaces), so revoke applies to
 *   the user's single saved credential set.
 */
import { executeTool } from './tools';
import type { DataClassification } from '../types';

/** Username/label metadata only — the list tool never returns secret material. */
export interface SytelineCredential {
  username: string;
  label?: string;
  updatedAt: string;
  lastUsedAt?: string;
}

export interface SaveSytelineCredentialsInput {
  username: string;
  password: string;
  label?: string;
}

export interface SytelineSession {
  sessionId: string;
  startedAt: string;
  url: string;
}

function unwrapList<T>(result: { credentials?: T } | T): T {
  // Tool results wrap the payload as { credentials: [...] }; unwrap one level.
  if (result && typeof result === 'object' && !Array.isArray(result) && 'credentials' in result) {
    return (result as { credentials: T }).credentials;
  }
  return result as T;
}

export async function listSytelineCredentials(
  classification: DataClassification,
): Promise<SytelineCredential[]> {
  const { result } = await executeTool<{ credentials?: SytelineCredential[] } | SytelineCredential[]>(
    'syteline.ui.listCredentials',
    {},
    classification,
  );
  return unwrapList(result);
}

export async function saveSytelineCredentials(
  classification: DataClassification,
  input: SaveSytelineCredentialsInput,
  confirmed: boolean,
): Promise<{ saved: boolean; username: string; updatedAt: string }> {
  // syteline.ui.saveCredentials is destructive (it replaces any saved
  // credentials): the tool gateway enforces the confirmation gate, so the UI
  // must confirm first and pass confirmed=true.
  const parameters: Record<string, unknown> = {
    username: input.username,
    password: input.password,
  };
  if (input.label) parameters.label = input.label;
  const { result } = await executeTool<{ saved: boolean; username: string; updatedAt: string }>(
    'syteline.ui.saveCredentials',
    parameters,
    classification,
    confirmed,
  );
  return result;
}

export async function deleteSytelineCredentials(
  classification: DataClassification,
  confirmed: boolean,
): Promise<{ deleted: boolean }> {
  // Destructive (revokes the user's saved credentials): confirmed=true after
  // an explicit UI confirmation.
  const { result } = await executeTool<{ deleted: boolean }>(
    'syteline.ui.deleteCredentials',
    {},
    classification,
    confirmed,
  );
  return result;
}

export async function startSytelineSession(
  classification: DataClassification,
): Promise<SytelineSession> {
  // Reuses the existing logged-in session when one is present; the backend
  // exposes no session-listing tool, so the panel cannot enumerate sessions.
  const { result } = await executeTool<SytelineSession>(
    'syteline.ui.startSession',
    {},
    classification,
  );
  return result;
}

export async function endSytelineSession(
  classification: DataClassification,
): Promise<{ ended: boolean }> {
  const { result } = await executeTool<{ ended: boolean }>(
    'syteline.ui.endSession',
    {},
    classification,
  );
  return result;
}
