export const CLASSIFICATIONS = [
  'PUBLIC',
  'INTERNAL',
  'CONFIDENTIAL',
  'PROPRIETARY',
  'CUI',
  'UNKNOWN',
] as const;

export type Classification = (typeof CLASSIFICATIONS)[number];

export function classificationRank(classification: Classification): number {
  if (classification === 'UNKNOWN') return -1;
  return CLASSIFICATIONS.indexOf(classification);
}

export function canAccessClassification(
  userClearance: Classification,
  resourceClassification: Classification
): boolean {
  if (userClearance === 'UNKNOWN' || resourceClassification === 'UNKNOWN') return false;
  const userRank = classificationRank(userClearance);
  const resourceRank = classificationRank(resourceClassification);
  if (userRank === -1 || resourceRank === -1) return false;
  return userRank >= resourceRank;
}

export const PERMISSIONS = [
  'chat:create',
  'conversation:read',
  'conversation:update',
  'conversation:delete',
  'document:upload',
  'document:read',
  'document:delete',
  'document:classify',
  'model:use',
  'model:manage',
  'tool:use',
  'syteline:read',
  'syteline:forms',
  'syteline:ui',
  'flows:manage',
  'flows:run',
  'schedules:manage',
  'schedules:run',
  'repo:read',
  'repo:manage',
  'audit:read',
  'tenant:manage',
  'retention:manage',
  'memory:read',
  'memory:write',
  'feedback:submit',
  'feedback:curate',
  'finetune:manage',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

export const ROLE_PERMISSIONS: Record<string, readonly Permission[]> = {
  User: [
    'chat:create',
    'conversation:read',
    'conversation:update',
    'conversation:delete',
    'document:upload',
    'document:read',
    'model:use',
    'tool:use',
    'syteline:read',
    // Default-open: every user can drive the SyteLine form-project tools.
    // Form-project PRs still require human review (never auto-merged).
    'syteline:forms',
    'repo:read',
    'memory:read',
    'memory:write',
    'feedback:submit',
    // All-grant posture (Jake, 2026-10-02): every role holds every
    // permission for now; checks stay enforced.
    'schedules:manage',
    'schedules:run',
  ],
  Admin: PERMISSIONS,
  'Security Admin': [
    'audit:read',
    'tenant:manage',
    'conversation:read',
    'document:read',
    'document:classify',
    'retention:manage',
    // All-grant posture (Jake, 2026-10-02).
    'schedules:manage',
    'schedules:run',
  ],
  'AI Admin': [
    'model:manage',
    'model:use',
    'tool:use',
    'syteline:read',
    'syteline:forms',
    // UI automation drives SyteLine as the user: privileged, granted here
    // (and seeded by migration 031) but never to User or Developer roles.
    'syteline:ui',
    // Flows: deterministic versioned pipelines (ADR-022). Authoring flows
    // (flows:manage) and running them (flows:run) are privileged: a flow
    // executes tools as its requester, so both stay Admin / AI Admin only
    // (seeded by migration 033).
    'flows:manage',
    'flows:run',
    // Schedules: run flows on a timetable (ADR-023). All-grant posture
    // (Jake, 2026-10-02): every role holds every permission for now
    // (seeded by migration 034).
    'schedules:manage',
    'schedules:run',
    'feedback:curate',
    'finetune:manage',
    'repo:read',
    'repo:manage',
    'chat:create',
    'conversation:read',
    'document:read',
    'memory:read',
    'memory:write',
  ],
  Developer: [
    'chat:create',
    'conversation:read',
    'conversation:update',
    'document:upload',
    'document:read',
    'model:use',
    'tool:use',
    'syteline:read',
    'syteline:forms',
    'repo:read',
    'memory:read',
    'memory:write',
    'feedback:submit',
    // All-grant posture (Jake, 2026-10-02).
    'schedules:manage',
    'schedules:run',
  ],
  'Read Only': [
    'conversation:read',
    'document:read',
    'memory:read',
    // All-grant posture (Jake, 2026-10-02).
    'schedules:manage',
    'schedules:run',
  ],
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
  sessionId: string;
}
