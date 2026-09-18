/**
 * oidc.ts — enterprise OIDC login (Authorization Code + PKCE).
 *
 * The primary enterprise login path, alongside the existing password login.
 * The flow:
 *
 *   1. GET /auth/oidc/login → server creates a state + PKCE pair + nonce,
 *      stores the verifier and nonce server-side (single-use, 10-minute
 *      expiry), and redirects the browser to the IdP's authorization
 *      endpoint.
 *   2. The IdP authenticates the user and redirects back to
 *      GET /auth/oidc/callback?code=…&state=….
 *   3. The server validates the state (single-use lookup), exchanges the
 *      code for tokens, verifies the ID token signature against the IdP's
 *      JWKS (issuer + audience + expiry + subject + nonce checked),
 *      extracts email/groups, auto-provisions the user into the existing
 *      tenant/role model keyed by the verified (issuer, subject) identity,
 *      and issues a session through the normal session machinery
 *      (createSession + refresh cookie) — session/refresh semantics are
 *      unchanged from password login.
 *
 * Security notes:
 *  - PKCE (S256) is always used, even for confidential clients.
 *  - The ID token is verified cryptographically, including the nonce
 *    binding it to the authorization request; userinfo is a fallback
 *    for email/groups only, never for identity.
 *  - Identity is the verified (issuer, subject) pair — email is
 *    provisioning data only and never the identity key.
 *  - Group→role mapping is config-driven; unknown groups and mappings to
 *    nonexistent roles fail closed to the least-privilege 'User' role.
 *  - Tokens leave the server only in the callback redirect's URL fragment
 *    (never the query string), so they stay out of server access logs.
 */

import { createHash, randomBytes } from 'node:crypto';
import { createLocalJWKSet, jwtVerify, type JSONWebKeySet } from 'jose';
import { config, isAllowedOidcUrl } from '../config.js';
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

export interface VerifiedOidcIdentity extends OidcClaims {
  /** The issuer the discovery document was verified against. */
  issuer: string;
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
  // OIDC Discovery §3: the well-known URI is the issuer identifier with
  // `/.well-known/openid-configuration` appended to its path — an issuer
  // with a path (e.g. https://idp/realms/enflite) discovers at
  // https://idp/realms/enflite/.well-known/openid-configuration. Building
  // it as an absolute path against the issuer origin would silently drop
  // the realm path and discover the wrong tenant's document.
  const base = issuer.endsWith('/') ? issuer.slice(0, -1) : issuer;
  const wellKnown = `${base}/.well-known/openid-configuration`;
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
  // Transport security: the IdP's endpoints must be HTTPS (plain HTTP only
  // for loopback development IdPs). A network attacker that can tamper with
  // the discovery document could otherwise downgrade the whole flow.
  const endpoints: Array<[name: string, endpoint: string | undefined]> = [
    ['authorization_endpoint', discovered.authorization_endpoint],
    ['token_endpoint', discovered.token_endpoint],
    ['jwks_uri', discovered.jwks_uri],
    ['userinfo_endpoint', discovered.userinfo_endpoint],
  ];
  for (const [name, endpoint] of endpoints) {
    if (endpoint !== undefined && !isAllowedOidcUrl(endpoint)) {
      throw Errors.internal(`OIDC discovery endpoint ${name} must use HTTPS`, undefined, 'OIDC_INSECURE_ENDPOINT');
    }
  }
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
 * Starts an OIDC login: persists the PKCE verifier and the nonce keyed by
 * state (single-use, 10 minutes) and returns the IdP authorization URL.
 */
export async function buildAuthorizeUrl(): Promise<{ url: string; state: string }> {
  oidcEnabledOrThrow();
  const discovery = await discoverIssuer();
  const state = createOidcState();
  const { verifier, challenge } = createPkcePair();
  const nonce = createOidcState();
  // Opportunistic cleanup of expired login attempts on each new one.
  await query('DELETE FROM oidc_auth_requests WHERE expires_at < NOW()');
  await query(
    'INSERT INTO oidc_auth_requests (state, code_verifier, nonce, expires_at) VALUES ($1, $2, $3, NOW() + ($4 || \' milliseconds\')::interval)',
    [state, verifier, nonce, AUTH_REQUEST_TTL_MS]
  );
  const url = new URL(discovery.authorization_endpoint);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', config.OIDC_CLIENT_ID!);
  url.searchParams.set('redirect_uri', config.OIDC_REDIRECT_URI!);
  url.searchParams.set('scope', config.OIDC_SCOPES);
  url.searchParams.set('state', state);
  url.searchParams.set('nonce', nonce);
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  return { url: url.toString(), state };
}

export interface ConsumedOidcState {
  verifier: string;
  nonce: string;
}

/**
 * Consumes the state (single-use: the row is deleted) and returns the stored
 * PKCE verifier and nonce, or null when the state is unknown or expired.
 */
export async function consumeOidcState(state: string): Promise<ConsumedOidcState | null> {
  const row = (
    await query<{ code_verifier: string; nonce: string | null }>(
      'DELETE FROM oidc_auth_requests WHERE state = $1 AND expires_at > NOW() RETURNING code_verifier, nonce',
      [state]
    )
  ).rows[0];
  if (!row || !row.nonce) return null;
  return { verifier: row.code_verifier, nonce: row.nonce };
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
 * issuer, audience, expiry, subject, and — when an expected nonce is
 * supplied — the nonce (replay protection binding this token to the
 * authorization request that produced it). Returns the identity claims the
 * platform trusts: sub, email, name, groups.
 *
 * Identity is the verified (issuer, sub) pair. The email claim is
 * provisioning data only and never the identity key.
 *
 * The JWKS JSON is fetched through the same stub-able global fetch as the
 * rest of this module (jose's remote-JWKS helper bypasses global fetch in
 * Node, which would make timeouts and tests depend on raw https).
 */
export async function verifyIdToken(idToken: string, expectedNonce?: string): Promise<VerifiedOidcIdentity> {
  oidcEnabledOrThrow();
  const discovery = await discoverIssuer();
  const keySet = await getJwksKeySet(discovery.jwks_uri);
  const verifyOptions = {
    issuer: discovery.issuer,
    audience: config.OIDC_CLIENT_ID!,
  };
  let payload;
  try {
    ({ payload } = await jwtVerify(idToken, keySet, verifyOptions));
  } catch (error) {
    // The cached JWKS no longer contains the signing key (key rotation at
    // the IdP): drop the cache and retry verification EXACTLY ONCE against
    // a freshly fetched key set. The retry never refreshes again, so there
    // is no refresh loop — a second failure fails closed.
    if ((error as { code?: unknown })?.code === 'ERR_JWKS_NO_MATCHING_KEY') {
      jwksCache = null;
      const refreshedKeySet = await getJwksKeySet(discovery.jwks_uri);
      try {
        ({ payload } = await jwtVerify(idToken, refreshedKeySet, verifyOptions));
      } catch {
        throw Errors.unauthorized('OIDC_INVALID_ID_TOKEN', 'Identity token verification failed');
      }
    } else {
      throw Errors.unauthorized('OIDC_INVALID_ID_TOKEN', 'Identity token verification failed');
    }
  }
  if (typeof payload.sub !== 'string' || payload.sub.length === 0) {
    throw Errors.unauthorized('OIDC_INVALID_ID_TOKEN', 'Identity token has no subject');
  }
  if (expectedNonce !== undefined && payload.nonce !== expectedNonce) {
    throw Errors.unauthorized('OIDC_INVALID_ID_TOKEN', 'Identity token nonce mismatch');
  }
  const claimString = (name: string): string | undefined => {
    const value = payload[name];
    return typeof value === 'string' && value.length > 0 ? value : undefined;
  };
  return {
    issuer: discovery.issuer,
    sub: payload.sub,
    email: claimString(config.OIDC_EMAIL_CLAIM),
    name: claimString(config.OIDC_NAME_CLAIM),
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
  const claimString = (name: string): string | undefined => {
    const value = info[name];
    return typeof value === 'string' && value.length > 0 ? value : undefined;
  };
  return {
    email: claimString(config.OIDC_EMAIL_CLAIM),
    name: claimString(config.OIDC_NAME_CLAIM),
    groups: asStringArray(info[config.OIDC_GROUP_CLAIM]),
  };
}

/** Parses OIDC_ROLE_MAPPING (validated as JSON at boot when OIDC is enabled). */
export function parseRoleMapping(): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(config.OIDC_ROLE_MAPPING);
    // Arrays are typeof 'object' but are not a group->role mapping; reject
    // them defensively here too (with OIDC enabled the boot check in
    // config.ts already refuses to start).
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
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
