import { beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import { assertClassificationAllowed } from '../src/authz/classification.js';
import { resolveUploadClassification } from '../src/documents/uploadClassification.js';
import { AppError } from '../src/errors.js';

const { tenantQuery, recordedPermissions } = vi.hoisted(() => ({
  tenantQuery: vi.fn(),
  recordedPermissions: [] as string[],
}));
const { listApprovedModelsForUser, getApprovedModelForUser } = vi.hoisted(() => ({
  listApprovedModelsForUser: vi.fn(),
  getApprovedModelForUser: vi.fn(),
}));

vi.mock('../src/db/pool.js', () => ({ tenantQuery }));
vi.mock('../src/ai/gateway/modelRegistry.js', () => ({
  listApprovedModelsForUser,
  getApprovedModelForUser,
}));
vi.mock('../src/auth/middleware.js', () => ({
  // PUBLIC-clearance user without document:classify.
  requireAuth: (req: any, _reply: any, done: () => void) => {
    req.auth = {
      userId: '11111111-1111-4111-8111-111111111111',
      tenantId: '22222222-2222-4222-8222-222222222222',
      sessionId: '33333333-3333-4333-8333-333333333333',
      roleId: '44444444-4444-4444-8444-444444444444',
      email: 'user@example.test',
      displayName: 'User',
      roleName: 'User',
      clearance: 'PUBLIC',
      permissions: ['chat:create', 'conversation:read', 'conversation:update'],
    };
    done();
  },
}));
vi.mock('../src/authz/middleware.js', () => ({
  requirePermission: (name: string) => {
    recordedPermissions.push(name);
    return (_req: any, _reply: any, done: () => void) => done();
  },
}));
vi.mock('../src/rag/retrieval.js', () => ({
  retrieveAuthorizedContext: vi.fn(),
}));
vi.mock('../src/ai/gateway/gateway.js', () => ({
  gatewayStream: vi.fn(),
}));

import { conversationRoutes } from '../src/conversations/routes.js';
import { chatRoutes } from '../src/chat/routes.js';

function deniedByClassification(fn: () => void): void {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe('CLASSIFICATION_DENIED');
    expect((error as AppError).statusCode).toBe(403);
    return;
  }
  throw new Error('expected CLASSIFICATION_DENIED');
}

describe('classification assertion policy', () => {
  it('allows classifications at or below clearance', () => {
    expect(() => assertClassificationAllowed('CUI', 'CUI')).not.toThrow();
    expect(() => assertClassificationAllowed('CUI', 'PUBLIC')).not.toThrow();
    expect(() => assertClassificationAllowed('INTERNAL', 'INTERNAL')).not.toThrow();
  });

  it('denies classifications above clearance and UNKNOWN', () => {
    deniedByClassification(() => assertClassificationAllowed('PUBLIC', 'INTERNAL'));
    deniedByClassification(() => assertClassificationAllowed('PUBLIC', 'CUI'));
    deniedByClassification(() => assertClassificationAllowed('INTERNAL', 'CONFIDENTIAL'));
    deniedByClassification(() => assertClassificationAllowed('CUI', 'UNKNOWN'));
    deniedByClassification(() => assertClassificationAllowed('UNKNOWN', 'PUBLIC'));
  });
});

describe('resolveUploadClassification', () => {
  it('defaults PUBLIC users to PUBLIC and others to INTERNAL', () => {
    expect(resolveUploadClassification('PUBLIC', undefined, false)).toBe('PUBLIC');
    expect(resolveUploadClassification('INTERNAL', undefined, false)).toBe('INTERNAL');
  });

  it('rejects explicit requests without document:classify instead of silently downgrading', () => {
    try {
      resolveUploadClassification('PUBLIC', 'CUI', false);
    } catch (error) {
      expect((error as AppError).code).toBe('CLASSIFICATION_DENIED');
      return;
    }
    throw new Error('expected rejection');
  });

  it('rejects an explicitly empty classification value', () => {
    // Without document:classify: 403 (it is a request, not an omission).
    try {
      resolveUploadClassification('INTERNAL', '', false);
      throw new Error('expected CLASSIFICATION_DENIED');
    } catch (error) {
      expect((error as AppError).code).toBe('CLASSIFICATION_DENIED');
    }
    // With document:classify: 400 (empty is not a valid label).
    try {
      resolveUploadClassification('INTERNAL', '', true);
      throw new Error('expected INVALID_CLASSIFICATION');
    } catch (error) {
      expect((error as AppError).code).toBe('INVALID_CLASSIFICATION');
    }
  });

  it('lets document:classify holders request at-or-below clearance', () => {
    expect(resolveUploadClassification('CONFIDENTIAL', 'INTERNAL', true)).toBe('INTERNAL');
    expect(resolveUploadClassification('CONFIDENTIAL', 'CONFIDENTIAL', true)).toBe('CONFIDENTIAL');
  });

  it('denies above-clearance and UNKNOWN requests even with the permission', () => {
    deniedByClassification(() => resolveUploadClassification('INTERNAL', 'CUI', true));
    try {
      resolveUploadClassification('CUI', 'UNKNOWN', true);
    } catch (error) {
      expect((error as AppError).code).toBe('INVALID_CLASSIFICATION');
      return;
    }
    throw new Error('expected INVALID_CLASSIFICATION');
  });
});

describe('conversation classification enforcement (route level)', () => {
  beforeEach(() => {
    tenantQuery.mockReset();
    listApprovedModelsForUser.mockReset();
    getApprovedModelForUser.mockReset();
  });

  async function buildConversationsApp() {
    const app = Fastify();
    await app.register(conversationRoutes);
    return app;
  }

  it('rejects creating a conversation above the caller clearance', async () => {
    const app = await buildConversationsApp();
    const response = await app.inject({
      method: 'POST',
      url: '/conversations',
      payload: { title: 'x', classification: 'CUI' },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().code).toBe('CLASSIFICATION_DENIED');
    expect(tenantQuery).not.toHaveBeenCalled();
    await app.close();
  });

  it('creates a conversation at the caller clearance', async () => {
    listApprovedModelsForUser.mockResolvedValue([{ id: 'm1' }]);
    getApprovedModelForUser.mockResolvedValue({ id: 'm1', name: 'model' });
    tenantQuery.mockResolvedValue({ rows: [{ id: 'c1', classification: 'PUBLIC' }] });
    const app = await buildConversationsApp();
    const response = await app.inject({
      method: 'POST',
      url: '/conversations',
      payload: { title: 'x', classification: 'PUBLIC' },
    });
    expect(response.statusCode).toBe(201);
    await app.close();
  });

  it('requires conversation:update (not just read) to rename a conversation', async () => {
    recordedPermissions.length = 0;
    const app = await buildConversationsApp();
    // Registration order: GET, POST, GET :id, GET :id/messages, PATCH :id, DELETE :id
    expect(recordedPermissions).toEqual([
      'conversation:read',
      'chat:create',
      'conversation:read',
      'conversation:read',
      'conversation:update',
      'conversation:delete',
    ]);
    await app.close();
  });
});

describe('chat classification enforcement (route level)', () => {
  beforeEach(() => {
    tenantQuery.mockReset();
    listApprovedModelsForUser.mockReset();
    getApprovedModelForUser.mockReset();
  });

  it('rejects a chat turn asserting a classification above clearance', async () => {
    const app = Fastify();
    await app.register(chatRoutes);
    const response = await app.inject({
      method: 'POST',
      url: '/chat',
      payload: { content: 'hello', classification: 'CONFIDENTIAL' },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().code).toBe('CLASSIFICATION_DENIED');
    await app.close();
  });
});
