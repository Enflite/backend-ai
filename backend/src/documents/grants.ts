/**
 * grants.ts — document_permissions grant resolution (the sparse principal
 * convention).
 *
 * Extracted from documents/routes.ts so product surfaces that reference
 * documents by id (e.g. the APS Planning Agent's report intake) enforce
 * the same owner-or-grant rule as the documents API itself.
 */

import { ClientSession, Db } from 'mongodb';

/**
 * Owner-or-grant predicate pieces. MongoDB has no joins, so the old
 * `document_permissions` LEFT JOIN + EXISTS membership subqueries become
 * explicit lookups: the caller's department/group IDs are resolved first,
 * then grants match on exactly one principal field (the sparse unique index
 * convention: absent principal fields are omitted, never null).
 */
/** Principal conditions for the sparse document_permissions convention. Exported for the transactional call sites in routes.ts. */
export async function principalOrConditions(
  db: Db,
  userId: string,
  roleId: string | null | undefined,
  session?: ClientSession
): Promise<Record<string, unknown>[]> {
  const opts = session ? { session } : undefined;
  const [deptRows, groupRows] = await Promise.all([
    db.collection<{ departmentId: string }>('department_memberships')
      .find({ userId }, { ...opts, projection: { departmentId: 1 } }).toArray(),
    db.collection<{ groupId: string }>('security_group_memberships')
      .find({ userId }, { ...opts, projection: { groupId: 1 } }).toArray(),
  ]);
  const or: Record<string, unknown>[] = [{ userId }];
  // Guarded: an unguarded `{ roleId: null }` would match every grant whose
  // roleId is absent (sparse convention), widening access.
  if (roleId) or.push({ roleId });
  const departmentIds = deptRows.map((row) => row.departmentId);
  const groupIds = groupRows.map((row) => row.groupId);
  if (departmentIds.length > 0) or.push({ departmentId: { $in: departmentIds } });
  if (groupIds.length > 0) or.push({ groupId: { $in: groupIds } });
  return or;
}

/** Document IDs the caller may read via an explicit grant (owner handled separately). */
export async function grantedDocumentIds(
  db: Db,
  tenantId: string,
  userId: string,
  roleId: string | null | undefined,
  session?: ClientSession
): Promise<string[]> {
  const grants = await db.collection<{ documentId: string }>('document_permissions')
    .find(
      { tenantId, canRead: true, $or: await principalOrConditions(db, userId, roleId, session) },
      { ...(session ? { session } : {}), projection: { documentId: 1 } }
    ).toArray();
  return [...new Set(grants.map((grant) => grant.documentId))];
}
