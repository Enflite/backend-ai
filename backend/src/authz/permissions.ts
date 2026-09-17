export const CLASSIFICATIONS = [
  'PUBLIC',
  'INTERNAL',
  'CONFIDENTIAL',
  'PROPRIETARY',
  'CUI',
] as const;

export type Classification = (typeof CLASSIFICATIONS)[number];

export function classificationRank(classification: Classification): number {
  return CLASSIFICATIONS.indexOf(classification);
}

export function canAccessClassification(
  userClearance: Classification,
  resourceClassification: Classification
): boolean {
  const userRank = classificationRank(userClearance);
  const resourceRank = classificationRank(resourceClassification);
  if (userRank === -1 || resourceRank === -1) return false;
  return userRank >= resourceRank;
}

export const PERMISSIONS = [
  'chat:create',
  'conversation:read',
  'conversation:delete',
  'document:upload',
  'document:read',
  'document:delete',
  'model:use',
  'model:manage',
  'tool:use',
  'tool:admin',
  'audit:read',
  'user:manage',
  'tenant:manage',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

export const ROLE_PERMISSIONS: Record<string, readonly Permission[]> = {
  User: [
    'chat:create',
    'conversation:read',
    'conversation:delete',
    'document:upload',
    'document:read',
    'model:use',
    'tool:use',
  ],
  Admin: PERMISSIONS,
  'Security Admin': [
    'audit:read',
    'user:manage',
    'tenant:manage',
    'conversation:read',
    'document:read',
  ],
  'AI Admin': [
    'model:manage',
    'model:use',
    'tool:admin',
    'tool:use',
    'chat:create',
    'conversation:read',
    'document:read',
  ],
  Developer: [
    'chat:create',
    'conversation:read',
    'document:upload',
    'document:read',
    'model:use',
    'tool:use',
  ],
  'Read Only': ['conversation:read', 'document:read'],
};

export interface AuthContext {
  userId: string;
  email: string;
  displayName: string;
  clearance: Classification;
  tenantId: string;
  roleId: string;
  roleName: string;
  permissions: Permission[];
}
