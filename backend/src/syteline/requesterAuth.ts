/**
 * requesterAuth.ts — shared seam: resolve a requester's LIVE auth context
 * at run time, through the same permission resolution as login.
 *
 * Used by the SyteLine task runner and the SyteLine Form AI Agent runner.
 * Returns null when the user is gone, deactivated, no longer a member of
 * the tenant, or their tenant/role records are missing. Work created
 * before a demotion must not keep running after revocation — runners fail
 * closed on anything but a live grant.
 */

import { getDb } from '../db/mongo.js';
import type { AuthContext, Classification } from '../authz/permissions.js';
import { buildAuth, type MembershipRow } from '../auth/routes.js';

export interface RequesterRef {
  _id: string;
  requesterUserId: string;
  tenantId: string;
}

export async function liveRequesterAuth(task: RequesterRef): Promise<AuthContext | null> {
  const db = await getDb();
  const user = await db.collection<{
    _id: string; email: string; passwordHash: string; displayName: string;
    isActive: boolean; clearance: Classification;
  }>('users').findOne({ _id: task.requesterUserId });
  if (!user || user.isActive === false) return null;
  const membership = await db.collection<{ _id: string; userId: string; tenantId: string; roleId: string }>(
    'memberships',
  ).findOne({ userId: task.requesterUserId, tenantId: task.tenantId });
  if (!membership) return null;
  const [tenant, role] = await Promise.all([
    db.collection<{ _id: string; name: string }>('tenants').findOne({ _id: membership.tenantId }),
    db.collection<{ _id: string; name: string }>('roles').findOne({ _id: membership.roleId }),
  ]);
  if (!tenant || !role) return null;
  const row: MembershipRow = {
    tenantId: membership.tenantId,
    tenantName: tenant.name,
    roleId: membership.roleId,
    roleName: role.name,
  };
  const base = await buildAuth(
    {
      id: user._id, email: user.email, passwordHash: user.passwordHash,
      displayName: user.displayName, isActive: user.isActive, clearance: user.clearance,
    },
    row,
  );
  return { ...base, sessionId: `runner:${task._id}` };
}
