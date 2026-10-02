/**
 * sytelineTaskEvidenceRoutes.test.ts — GET /syteline-tasks/:id/evidence/:evidenceId.
 *
 * - 200 streams the PNG bytes with content-type image/png (requester and admin)
 * - 404 for unknown task, another user's task (no existence leak — same 404),
 *   evidence not on the task, and missing file on disk
 * - 400 for a malformed evidence id (strict UUID shape, no traversal)
 * - 403 FEATURE_DISABLED while SYTELINE_UI_ENABLED=false
 * - 403 AUTHORIZATION_FAILURE without the syteline:ui permission
 * - the access audit carries identifiers only — never evidence bytes
 *
 * Evidence files are written through the real storeScreenshotEvidence
 * (real fs layout, temp dir); the DB, audit sink, and requireAuth are
 * mocked. The real requirePermission middleware is used. VALIDATED IN CI;
 * real screenshots REQUIRE REAL SYTELINE.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';

const { getDbMock } = vi.hoisted(() => ({ getDbMock: vi.fn() }));
const { recordAuditMock } = vi.hoisted(() => ({ recordAuditMock: vi.fn() }));
const { currentAuth } = vi.hoisted(() => ({
  currentAuth: {} as Record<string, unknown>,
}));

vi.mock('../src/db/mongo.js', () => ({ getDb: getDbMock }));
vi.mock('../src/audit/audit.js', () => ({
  recordAudit: recordAuditMock,
  sanitizeReason: (reason?: string | null) => reason ?? null,
}));
vi.mock('../src/auth/middleware.js', () => ({
  requireAuth: (req: any, _reply: any, done: () => void) => {
    req.auth = currentAuth;
    done();
  },
}));

import { AppError } from '../src/errors.js';
import { config } from '../src/config.js';
import { sytelineTaskRoutes } from '../src/syteline/tasks/routes.js';
import { storeScreenshotEvidence } from '../src/tools/sytelineUi.js';
import type { SytelineTaskDoc } from '../src/syteline/tasks/taskTypes.js';

const PNG = Buffer.from('fake-png-evidence-bytes-0123456789');

function authFor(userId: string, permissions: string[]): Record<string, unknown> {
  return {
    userId,
    tenantId: 'tenant-a',
    email: `${userId}@example.test`,
    displayName: 'Test User',
    clearance: 'INTERNAL',
    roleId: 'role-1',
    roleName: permissions.includes('tenant:manage') ? 'Admin' : 'User',
    permissions,
    sessionId: 'sess-1',
  };
}

const ADMIN = () => authFor('user-admin', ['syteline:ui', 'tenant:manage']);
const REQUESTER = () => authFor('user-req', ['syteline:ui']);
const OTHER = () => authFor('user-other', ['syteline:ui']);
const NOPERM = () => authFor('user-basic', ['chat:create']);

let tasks: Map<string, SytelineTaskDoc>;
let evidenceId: string;
let taskId: string;
let evidenceDir: string;

function taskDoc(overrides: Partial<SytelineTaskDoc> = {}): SytelineTaskDoc {
  const now = new Date();
  return {
    _id: taskId,
    tenantId: 'tenant-a',
    requesterUserId: 'user-req',
    title: 'Check order',
    goal: 'Check why the order is late',
    status: 'completed',
    plan: [],
    steps: [
      { action: 'readScreen', status: 'ok', evidenceIds: [evidenceId] },
    ],
    autoApproveWrites: false,
    authSnapshot: {
      userId: 'user-req',
      tenantId: 'tenant-a',
      email: 'user-req@example.test',
      displayName: 'Req',
      clearance: 'INTERNAL',
      roleId: 'role-1',
      roleName: 'User',
      permissions: ['syteline:ui'],
      classification: 'INTERNAL',
    },
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

async function buildApp() {
  const app = Fastify();
  app.setErrorHandler((error: unknown, _req, reply) => {
    if (error instanceof AppError) {
      return reply
        .status(error.statusCode)
        .send({ error: { code: error.code, message: error.message } });
    }
    return reply.status(500).send({ error: { code: 'INTERNAL', message: 'internal' } });
  });
  app.addHook('onRequest', (req: any, _reply, done) => {
    req.requestId = 'req-1';
    done();
  });
  await app.register(sytelineTaskRoutes);
  return app;
}

beforeEach(async () => {
  vi.clearAllMocks();
  tasks = new Map();
  taskId = randomUUID();
  evidenceId = randomUUID();
  evidenceDir = mkdtempSync(join(tmpdir(), 'task-evidence-'));
  const cfg = config as Record<string, unknown>;
  cfg.SYTELINE_UI_ENABLED = true;
  cfg.SYTELINE_UI_EVIDENCE_DIR = evidenceDir;

  getDbMock.mockImplementation(async () => ({
    collection: (name: string) => {
      if (name !== 'syteline_tasks') throw new Error(`unexpected collection ${name}`);
      return {
        findOne: vi.fn(async (filter: Record<string, unknown>) => {
          const doc = tasks.get(filter._id as string) ?? null;
          if (doc && doc.tenantId !== filter.tenantId) return null;
          return doc ? structuredClone(doc) : null;
        }),
      };
    },
  }));
  recordAuditMock.mockResolvedValue(undefined);
  Object.assign(currentAuth, ADMIN());

  tasks.set(taskId, taskDoc());
  const stored = await storeScreenshotEvidence(
    authFor('user-admin', ['syteline:ui', 'tenant:manage']) as never,
    PNG,
    'req-1',
  );
  // storeScreenshotEvidence generates its own id — point the task at it.
  evidenceId = stored.evidenceId;
  tasks.set(taskId, taskDoc());
});

function getEvidence(app: any, id: string, evId: string) {
  return app.inject({
    method: 'GET',
    url: `/syteline-tasks/${id}/evidence/${evId}`,
  });
}

describe('GET /syteline-tasks/:id/evidence/:evidenceId', () => {
  it('streams the PNG bytes to the requester', async () => {
    Object.assign(currentAuth, REQUESTER());
    const app = await buildApp();
    const res = await getEvidence(app, taskId, evidenceId);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('image/png');
    expect(res.headers['content-length']).toBe(String(PNG.length));
    expect(res.body).toBe(PNG.toString());
  });

  it('streams to an admin who is not the requester', async () => {
    Object.assign(currentAuth, ADMIN());
    const app = await buildApp();
    const res = await getEvidence(app, taskId, evidenceId);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('image/png');
  });

  it('audits the read with identifiers only — never evidence bytes', async () => {
    Object.assign(currentAuth, REQUESTER());
    const app = await buildApp();
    await getEvidence(app, taskId, evidenceId);
    const reads = recordAuditMock.mock.calls.filter(
      (call: unknown[]) =>
        (call[0] as { action: string }).action === 'SYTELINE_TASK_EVIDENCE_READ',
    );
    expect(reads).toHaveLength(1);
    const meta = (reads[0]![0] as { metadata: Record<string, unknown> }).metadata;
    expect(meta.taskId).toBe(taskId);
    expect(meta.evidenceId).toBe(evidenceId);
    expect(JSON.stringify(meta)).not.toContain(PNG.toString('base64'));
  });

  it('404s an unknown task', async () => {
    const app = await buildApp();
    const res = await getEvidence(app, randomUUID(), evidenceId);
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('TASK_NOT_FOUND');
  });

  it("404s another user's task — no existence leak", async () => {
    Object.assign(currentAuth, OTHER());
    const app = await buildApp();
    const res = await getEvidence(app, taskId, evidenceId);
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('TASK_NOT_FOUND');
  });

  it('404s an evidence id that is not on the task', async () => {
    const app = await buildApp();
    const res = await getEvidence(app, taskId, randomUUID());
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('EVIDENCE_NOT_FOUND');
  });

  it('400s a malformed evidence id (strict UUID shape, no traversal)', async () => {
    const app = await buildApp();
    const res = await getEvidence(app, taskId, 'not-a-uuid');
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
  });

  it('404s when the file is missing on disk', async () => {
    rmSync(evidenceDir, { recursive: true, force: true });
    const app = await buildApp();
    const res = await getEvidence(app, taskId, evidenceId);
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('EVIDENCE_NOT_FOUND');
  });

  it('403s while SYTELINE_UI_ENABLED=false', async () => {
    (config as Record<string, unknown>).SYTELINE_UI_ENABLED = false;
    const app = await buildApp();
    const res = await getEvidence(app, taskId, evidenceId);
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('FEATURE_DISABLED');
  });

  it('403s without the syteline:ui permission', async () => {
    Object.assign(currentAuth, NOPERM());
    const app = await buildApp();
    const res = await getEvidence(app, taskId, evidenceId);
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('AUTHORIZATION_FAILURE');
  });
});
