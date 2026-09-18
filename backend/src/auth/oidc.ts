/**
 * oidc.ts — enterprise OIDC login (Authorization Code + PKCE).
 *
 * The primary enterprise login path, alongside the existing password login.
 * The flow:
 *
 *   1. GET /auth/oidc/login → server creates a state + PKCE pair, stores the
 *      verifier server-side (single-use, 10-minute expiry), and redirects
 *      the browser to the IdP's authorization endpoint.
 *   2. The IdP authenticates the user and redirects back to
 *      GET /auth/oidc/callback?code=…&state=….
 *   3. The server validates the state (single-use lookup), exchanges the
 *      code for tokens, verifies the ID token signature against the IdP's
 *      JWKS (issuer + audience + expiry checked by jose), extracts
 *      email/groups, auto-provisions the user into the existing tenant/role
 *      model, and issues a session through the normal session machinery
 *      (createSession + refresh cookie) — session/refresh semantics are
 *      unchanged from password login.
 *
 * Security notes:
 *  - PKCE (S256) is always used, even for confidential clients.
 *  - The ID token is verified cryptographically; userinfo is a fallback
 *    for email/groups only, never for identity.
 *  - Group→role mapping is config-driven; unknown groups and mappings to
 *    nonexistent roles fail closed to the least-privilege 'User' role.
 *  - Tokens leave the server only in the callback redirect's URL fragment
 *    (never the query string), so they stay out of server access logs.
 */

import { createHash, randomBytes } from 'node:crypto';
import { createLocalJWKSet, jwtVerify, type JSONWebKeySet } from 'jose';
import { config } from '../config.js';
import { query } from '../db/pool.js';
import { Errors } from '../errors.js';

export interface OidcDiscovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  userinfo_endpoint?: string;
  jwks_uri: string;
}

export interface OidcClaims {
  sub: string;
  email?: string;
  name?: string;
  groups: string[];
}

const DISCOVERY_CACHE_TTL_MS = 60 * 60 * 1000;
const AUTH_REQUEST_TTL_MS = 10 * 60 * 1000;
const OIDC_HTTP_TIMEOUT_MS = 10000;

let discoveryCache: { fetchedAt: number; doc: OidcDiscovery } | null = null;

const JWKS_CACHE_TTL_MS = 60 * 60 * 1000;
let jwksCache: { fetchedAt: number; jwksUri: string; keySet: ReturnType<typeof createLocalJWKSet> } | null = null;

/** Test seam: clear the cached discovery document and JWKS. */
export function clearOidcDiscoveryCache(): void {
  discoveryCache = null;
  jwksCache = null;
}

/** Fetches and caches the IdP JWKS as a local jose key set. */
async function getJwksKeySet(jwksUri: string): Promise<ReturnType<typeof createLocalJWKSet>> {
  if (jwksCache && jwksCache.jwksUri === jwksUri && Date.now() - jwksCache.fetchedAt < JWKS_CACHE_TTL_MS) {
    return jwksCache.keySet;
  }
  let response: Response;
  try {
    response = await fetch(jwksUri, { signal: AbortSignal.timeout(OIDC_HTTP_TIMEOUT_MS) });
  } catch {
    throw Errors.internal('OIDC JWKS fetch failed', undefined, 'OIDC_JWKS_FAILED');
  }
  if (!response.ok) throw Errors.internal('OIDC JWKS fetch failed', { status: response.status }, 'OIDC_JWKS_FAILED');
  const jwks = (await response.json()) as Partial<JSONWebKeySet>;
  if (!Array.isArray(jwks.keys)) {
    throw Errors.internal('OIDC JWKS is malformed', undefined, 'OIDC_JWKS_MALFORMED');
  }
  const keySet = createLocalJWKSet(jwks as JSONWebKeySet);
  jwksCache = { fetchedAt: Date.now(), jwksUri, keySet };
  return keySet;
}

function oidcEnabledOrThrow(): void {
  if (!config.OIDC_ENABLED) throw Errors.notFound('OIDC_DISABLED', 'Enterprise SSO is not enabled');
}

export async function discoverIssuer(): Promise<OidcDiscovery> {
  oidcEnabledOrThrow();
  if (discoveryCache && Date.now() - discoveryCache.fetchedAt < DISCOVERY_CACHE_TTL_MS) {
    return discoveryCache.doc;
  }
  const issuer = config.OIDC_ISSUER!;
  const wellKnown = new URL('/.well-known/openid-configuration', issuer.endsWith('/') ? issuer : `${issuer}/`);
  let response: Response;
  try {
    response = await fetch(wellKnown, { signal: AbortSignal.timeout(OIDC_HTTP_TIMEOUT_MS) });
  } catch (error) {
    throw Errors.internal('OIDC discovery failed', undefined, 'OIDC_DISCOVERY_FAILED');
  }
  if (!response.ok) throw Errors.internal('OIDC discovery failed', { status: response.status }, 'OIDC_DISCOVERY_FAILED');
  const doc = (await response.json()) as Partial<OidcDiscovery>;
  if (
    typeof doc.issuer !== 'string' ||
    typeof doc.authorization_endpoint !== 'string' ||
    typeof doc.token_endpoint !== 'string' ||
    typeof doc.jwks_uri !== 'string'
  ) {
    throw Errors.internal('OIDC discovery document is malformed', undefined, 'OIDC_DISCOVERY_MALFORMED');
  }
  // The discovery document must describe the issuer we configured: otherwise
  // a network attacker could redirect the flow at a different IdP.
  const normalized = (value: string) => value.replace(/\/+$/, '');
  if (normalized(doc.issuer) !== normalized(issuer)) {
    throw Errors.internal('OIDC issuer mismatch in discovery document', undefined, 'OIDC_ISSUER_MISMATCH');
  }
  const discovered: OidcDiscovery = {
    issuer: doc.issuer,
    authorization_endpoint: doc.authorization_endpoint,
    token_endpoint: doc.token_endpoint,
    userinfo_endpoint: doc.userinfo_endpoint,
    jwks_uri: doc.jwks_uri,
  };
  discoveryCache = { fetchedAt: Date.now(), doc: discovered };
  return discovered;
}

/** PKCE pair (RFC 7636): random verifier, S256 challenge. */
export function createPkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

export function createOidcState(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * Starts an OIDC login: persists the PKCE verifier keyed by state
 * (single-use, 10 minutes) and returns the IdP authorization URL.
 */
export async function buildAuthorizeUrl(): Promise<{ url: string; state: string }> {
  oidcEnabledOrThrow();
  const discovery = await discoverIssuer();
  const state = createOidcState();
  const { verifier, challenge } = createPkcePair();
  // Opportunistic cleanup of expired login attempts on each new one.
  await query('DELETE FROM oidc_auth_requests WHERE expires_at < NOW()');
  await query('INSERT INTO oidc_auth_requests (state, code_verifier, expires_at) VALUES ($1, $2, NOW() + ($3 || \' milliseconds\')::interval)', [
    state,
    verifier,
    AUTH_REQUEST_TTL_MS,
  ]);
  const url = new URL(discovery.authorization_endpoint);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', config.OIDC_CLIENT_ID!);
  url.searchParams.set('redirect_uri', config.OIDC_REDIRECT_URI!);
  url.searchParams.set('scope', config.OIDC_SCOPES);
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  return { url: url.toString(), state };
}

/**
 * Consumes the state (single-use: the row is deleted) and returns the stored
 * PKCE verifier, or null when the state is unknown or expired.
 */
export async function consumeOidcState(state: string): Promise<string | null> {
  const row = (
    await query<{ code_verifier: string }>(
      'DELETE FROM oidc_auth_requests WHERE state = $1 AND expires_at > NOW() RETURNING code_verifier',
      [state]
    )
  ).rows[0];
  return row?.code_verifier ?? null;
}

export interface OidcTokenSet {
  idToken: string;
  accessToken: string;
  expiresIn?: number;
}

/** Exchanges the authorization code for tokens at the IdP token endpoint. */
export async function exchangeCode(code: string, verifier: string): Promise<OidcTokenSet> {
  oidcEnabledOrThrow();
  const discovery = await discoverIssuer();
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: config.OIDC_REDIRECT_URI!,
    client_id: config.OIDC_CLIENT_ID!,
    code_verifier: verifier,
  });
  let response: Response;
  try {
    response = await fetch(discovery.token_endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        // Confidential client authentication per RFC 6749 §2.3.1.
        authorization: `Basic ${Buffer.from(`${config.OIDC_CLIENT_ID}:${config.OIDC_CLIENT_SECRET}`).toString('base64')}`,
      },
      body,
      signal: AbortSignal.timeout(OIDC_HTTP_TIMEOUT_MS),
    });
  } catch {
    throw Errors.internal('OIDC token exchange failed', undefined, 'OIDC_TOKEN_EXCHANGE_FAILED');
  }
  if (!response.ok) throw Errors.internal('OIDC token exchange failed', { status: response.status }, 'OIDC_TOKEN_EXCHANGE_FAILED');
  const tokens = (await response.json()) as { id_token?: string; access_token?: string; expires_in?: number };
  if (typeof tokens.id_token !== 'string' || typeof tokens.access_token !== 'string') {
    throw Errors.internal('OIDC token response is malformed', undefined, 'OIDC_TOKEN_MALFORMED');
  }
  return { idToken: tokens.id_token, accessToken: tokens.access_token, expiresIn: tokens.expires_in };
}

function asStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string');
  if (typeof value === 'string') return [value];
  return [];
}

/**
 * Verifies the ID token signature against the IdP JWKS and validates
 * issuer, audience, and expiry. Returns the identity claims the platform
 * trusts: sub, email, name, groups.
 *
 * The JWKS JSON is fetched through the same stub-able global fetch as the
 * rest of this module (jose's remote-JWKS helper bypasses global fetch in
 * Node, which would make timeouts and tests depend on raw https).
 */
export async function verifyIdToken(idToken: string): Promise<OidcClaims> {
  oidcEnabledOrThrow();
  const discovery = await discoverIssuer();
  const keySet = await getJwksKeySet(discovery.jwks_uri);
  let payload;
  try {
    ({ payload } = await jwtVerify(idToken, keySet, {
      issuer: discovery.issuer,
      audience: config.OIDC_CLIENT_ID!,
    }));
  } catch {
    throw Errors.unauthorized('OIDC_INVALID_ID_TOKEN', 'Identity token verification failed');
  }
  const email = typeof payload.email === 'string' ? payload.email : undefined;
  const name = typeof payload.name === 'string' ? payload.name : undefined;
  return {
    sub: String(payload.sub ?? ''),
    email,
    name,
    groups: asStringArray(payload[config.OIDC_GROUP_CLAIM]),
  };
}

/**
 * Fetches userinfo as a fallback for email/groups when the ID token does
 * not carry them. Never used for identity (sub) — only to fill gaps.
 */
export async function fetchUserinfo(accessToken: string): Promise<Partial<OidcClaims>> {
  const discovery = await discoverIssuer();
  if (!discovery.userinfo_endpoint) return {};
  let response: Response;
  try {
    response = await fetch(discovery.userinfo_endpoint, {
      headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' },
      signal: AbortSignal.timeout(OIDC_HTTP_TIMEOUT_MS),
    });
  } catch {
    return {};
  }
  if (!response.ok) return {};
  const info = (await response.json()) as Record<string, unknown>;
  return {
    email: typeof info.email === 'string' ? info.email : undefined,
    name: typeof info.name === 'string' ? info.name : undefined,
    groups: asStringArray(info[config.OIDC_GROUP_CLAIM]),
  };
}

/** Parses OIDC_ROLE_MAPPING (validated as JSON at boot when OIDC is enabled). */
export function parseRoleMapping(): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(config.OIDC_ROLE_MAPPING);
    if (typeof parsed === 'object' && parsed !== null) {
      const mapping: Record<string, string> = {};
      for (const [group, role] of Object.entries(parsed)) {
        if (typeof group === 'string' && typeof role === 'string') mapping[group] = role;
      }
      return mapping;
    }
  } catch {
    // Invalid JSON with OIDC disabled is ignored; with OIDC enabled the
    // server refuses to boot (see config.ts), so this is unreachable there.
  }
  return {};
}

/**
 * Maps IdP groups to an internal role name. Returns the mapped role when it
 * names a role that actually exists; otherwise null — the caller fails
 * closed to the least-privilege 'User' role.
 */
export async function resolveInternalRole(groups: string[]): Promise<string | null> {
  const mapping = parseRoleMapping();
  for (const group of groups) {
    const candidate = mapping[group];
    if (!candidate) continue;
    const row = (await query<{ name: string }>('SELECT name FROM roles WHERE name = $1', [candidate])).rows[0];
    if (row) return row.name;
    // Mapped to a role that does not exist: fail closed, keep looking.
  }
  return null;
}
