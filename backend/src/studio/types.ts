/**
 * types.ts — shared types for the SyteLine Automation Studio backend
 * foundation (connections, capability probe, action catalog, test
 * execution).
 *
 * The Studio's backend is the substrate the automation builder stands on:
 * named SyteLine connections (an API keyed endpoint, not a scraped UI),
 * a capability probe that honestly records what each connection's upstream
 * actually supports, a typed action catalog bound to real operations, and
 * single-action test execution against the real upstream. Automations
 * themselves compile to the existing Flows platform — this module builds
 * no workflow engine.
 */

import { z } from 'zod';
import type { EncryptedCredential } from '../secrets/credentialCrypto.js';

// ---------------------------------------------------------------------------
// Connections
// ---------------------------------------------------------------------------

/** The well-known connection id backed by the SYTELINE_BASE_URL /
 *  SYTELINE_API_TOKEN env pair. Never persisted to Mongo: it is the seeded
 *  "default" so current behavior keeps working with zero migration. */
export const DEFAULT_CONNECTION_ID = 'default';

export interface CapabilityProbeStatus {
  /** e.g. 'syteline.getItem' (catalog action id) or a candidate write op id. */
  operationId: string;
  /** HTTP method + path the probe hit, for the operator's own reading. */
  probedMethod: string;
  probedPath: string;
  /** ok = upstream answered 2xx; unsupported = the upstream has no such
   *  endpoint (404/405/501); error = anything else (auth, timeout, 5xx). */
  status: 'ok' | 'unsupported' | 'error';
  /** 2xx → the status code; anything else → the code that landed, if any. */
  httpStatus?: number;
  /** Human-readable, token-free note (e.g. '404 Not Found', 'timeout'). */
  detail?: string;
  probedAt: string;
}

export interface StudioConnectionDoc {
  _id: string;
  tenantId: string;
  /** Operator-visible, unique per tenant (case-insensitive). */
  name: string;
  /** Environment label: TRN, PRD, DEV, ... */
  environment: string;
  baseUrl: string;
  /** Bearer token, AES-256-GCM encrypted. NEVER decrypted except at the
   *  single request-time use, then zero-filled. */
  encryptedToken: EncryptedCredential;
  /** Last capability probe; absent until the connection is tested/saved. */
  probe?: {
    probedAt: string;
    reachable: boolean;
    operations: CapabilityProbeStatus[];
  };
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
  lastTestedAt?: Date;
}

/** The wire shape: everything except secret material. */
export interface ConnectionPublicView {
  id: string;
  name: string;
  environment: string;
  baseUrl: string;
  hasToken: true;
  probe?: StudioConnectionDoc['probe'];
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  lastTestedAt?: string;
  /** True for the env-backed 'default' connection (read-only, not in Mongo). */
  envBacked: boolean;
}

export const connectionCreateSchema = z.object({
  name: z.string().trim().min(1).max(80),
  environment: z.string().trim().min(1).max(20),
  baseUrl: z.string().trim().min(1).max(500),
  /** Bearer token stored encrypted; may not be blank. */
  token: z.string().min(1).max(4096),
});

export const connectionUpdateSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  environment: z.string().trim().min(1).max(20).optional(),
  baseUrl: z.string().trim().min(1).max(500).optional(),
  /** Omit to keep the existing token. */
  token: z.string().min(1).max(4096).optional(),
});

export const connectionIdParam = z.object({ id: z.string().min(1).max(120) });

// ---------------------------------------------------------------------------
// Action catalog
// ---------------------------------------------------------------------------

/** The two execution substrates an action can run against. */
export type ActionSubstrate = 'api' | 'ui';

export interface CatalogActionDefinition {
  /** Stable id, e.g. 'syteline.getItem'. */
  id: string;
  title: string;
  description: string;
  substrate: ActionSubstrate;
  /** Zod schema for the action's params; `.shape` is published as JSON
   *  Schema for the builder UI. */
  paramsSchema: z.ZodTypeAny;
  /** True when the action mutates SyteLine state. Flagging only here:
   *  enforcement comes in a later slice. */
  destructive: boolean;
  /** Permission the caller must hold to test this action. */
  requiredPermission: 'studio:run';
  /** Bound operation: method + path template on the connection's upstream. */
  operation?: {
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
    path: string;
  };
  /**
   * When true the action is REAL: it binds to the operation above and is
   * gated on a successful capability probe of that operation. When false
   * the catalog still lists the entry — with `supported: false` and an
   * honest reason — because the upstream has no such endpoint today. No
   * fake operations, ever.
   */
  knownReal: boolean;
  /** For knownReal actions only: probe the operation; for the rest the
   *  upstream lacks the endpoint and this is the honest reason. */
  unsupportedReason?: string;
}

export interface CatalogActionView {
  id: string;
  title: string;
  description: string;
  substrate: ActionSubstrate;
  destructive: boolean;
  requiredPermission: string;
  supported: boolean;
  supportReason: string;
  /** Operation the action binds to, when it binds to anything real. */
  operation?: { method: string; path: string };
  /** Param shape as JSON Schema (from the zod schema). */
  paramsJsonSchema: unknown;
}

// ---------------------------------------------------------------------------
// Single-action test execution
// ---------------------------------------------------------------------------

export const testActionInputSchema = z.object({
  connectionId: z.string().min(1).max(120),
  actionId: z.string().min(1).max(120),
  /** Validated against the catalog entry's params schema at execution. */
  params: z.record(z.string(), z.unknown()),
});

export interface ActionTestRequestView {
  method: string;
  /** The URL the test actually hit, token-free (never log/return secrets). */
  url: string;
  params: Record<string, unknown>;
}

export interface ActionTestResult {
  request: ActionTestRequestView;
  response: {
    /** Upstream HTTP status, or null when the request never completed. */
    status: number | null;
    /** Response body, capped (truncated: true when capped). */
    bodyTruncated: { truncated: boolean; preview: string };
    durationMs: number;
  };
  connectionId: string;
  actionId: string;
  executedAt: string;
}
