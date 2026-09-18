/**
 * Shared fixtures for the Phase-1 adversarial security test workstream.
 *
 * Two tenants, three users, and an auth-context builder. All IDs are valid
 * UUIDs so they survive zod `.uuid()` route validation — that matters because
 * an attacker-controlled string that fails validation is rejected before any
 * authorization logic runs, which would make "denied" assertions vacuous.
 */
import type { AuthContext, Classification, Permission } from '../../src/authz/permissions.js';

export const TENANT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
export const TENANT_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

export const USER_A1 = 'a1111111-1111-4111-8111-111111111111';
export const USER_A2 = 'a2222222-2222-4222-8222-222222222222';
export const USER_B1 = 'b1111111-1111-4111-8111-111111111111';

export const ROLE_A = 'aa000000-0000-4000-8000-000000000000';
export const ROLE_B = 'bb000000-0000-4000-8000-000000000000';
export const SESSION_A1 = 'a1000000-0000-4000-8000-000000000000';
export const SESSION_B1 = 'b1000000-0000-4000-8000-000000000000';

export const CONV_A1 = 'c0a11111-1111-4111-8111-111111111111';
export const CONV_A2 = 'c0a22222-2222-4222-8222-222222222222';
export const CONV_B1 = 'c0b11111-1111-4111-8111-111111111111';

export const DOC_A1 = 'd0a11111-1111-4111-8111-111111111111';
export const DOC_B1 = 'd0b11111-1111-4111-8111-111111111111';

export function authFor(
  userId: string,
  tenantId: string,
  overrides: Partial<AuthContext> = {}
): AuthContext {
  return {
    userId,
    tenantId,
    sessionId: tenantId === TENANT_A ? SESSION_A1 : SESSION_B1,
    roleId: tenantId === TENANT_A ? ROLE_A : ROLE_B,
    email: `${userId.slice(0, 8)}@example.test`,
    displayName: `User ${userId.slice(0, 8)}`,
    roleName: 'User',
    clearance: 'CONFIDENTIAL',
    permissions: ['chat:create', 'conversation:read', 'document:read', 'tool:use'] as Permission[],
    ...overrides,
  };
}

export const ALL_PERMISSIONS: Permission[] = [
  'chat:create',
  'conversation:read',
  'conversation:update',
  'conversation:delete',
  'document:read',
  'document:upload',
  'document:delete',
  'document:classify',
  'tool:use',
  'audit:read',
  'tenant:manage',
];

export type { Classification };
