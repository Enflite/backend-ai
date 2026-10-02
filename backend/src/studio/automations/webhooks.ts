/**
 * webhooks.ts — webhook trigger tokens for Studio automations.
 *
 * The token is the credential: 256 bits from a CSPRNG, hex-encoded
 * (unguessable). Only the sha256 hash is ever persisted
 * (`deployment.webhookTokenHash`); the raw token is returned exactly once —
 * in the deploy response that issues it — and never logged, audited, or
 * returned again. Rotation issues a new token and invalidates the old one
 * atomically with the automation update.
 */

import { createHash, randomBytes } from 'node:crypto';
import { getDb } from '../../db/mongo.js';
import { AUTOMATIONS_COLLECTION } from './store.js';
import type { StudioAutomationDoc } from './types.js';

export function hashWebhookToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** Issue a fresh token: returns the raw token (show once) and its hash (store). */
export function issueWebhookToken(): { token: string; tokenHash: string } {
  const token = randomBytes(32).toString('hex');
  return { token, tokenHash: hashWebhookToken(token) };
}

/**
 * Find the automation a webhook token belongs to. The lookup is global
 * (not tenant-scoped): the token itself is the 256-bit bearer credential,
 * like an API key — presenting it IS the authorization, and everything the
 * fire does (run creation, tool execution, audit) is scoped to the
 * automation's own tenant. The raw token is never echoed back (unknown
 * token → null, and callers must not include it in errors or logs).
 */
export async function findAutomationByWebhookToken(
  token: string,
): Promise<StudioAutomationDoc | null> {
  if (!token || token.length > 256) return null;
  const db = await getDb();
  const doc = await db
    .collection<StudioAutomationDoc>(AUTOMATIONS_COLLECTION)
    .findOne({
      'deployment.webhookTokenHash': hashWebhookToken(token),
      'deployment.status': 'deployed',
      'deployment.triggerKind': 'webhook',
    });
  return doc;
}
