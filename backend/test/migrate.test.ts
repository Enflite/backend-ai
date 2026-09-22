/**
 * migrate.test.ts — MongoDB migration runner unit tests (ADR-014).
 *
 * Tests the migration runner logic: version tracking, idempotency,
 * ordering, and the getAppliedVersions helper. Uses mocked MongoDB
 * collections. VALIDATED IN CI with mocks; real MongoDB behavior
 * REQUIRES REAL PRODUCTION INFRASTRUCTURE.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Migration } from '../src/db/migrate.js';

const { mockCollection, getDbMock } = vi.hoisted(() => {
  const mockCollection = {
    createIndex: vi.fn(),
    find: vi.fn(),
    insertOne: vi.fn(),
  };
  const getDbMock = vi.fn(async () => ({
    collection: vi.fn(() => mockCollection),
  }));
  return { mockCollection, getDbMock };
});

vi.mock('../src/db/mongo.js', () => ({
  getDb: getDbMock,
}));

import { runMigrations, getAppliedVersions } from '../src/db/migrate.js';

function mockFindCursor(docs: Array<{ version: string }>) {
  return {
    toArray: vi.fn().mockResolvedValue(docs),
    sort: vi.fn().mockReturnThis(),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockCollection.createIndex.mockResolvedValue(undefined);
  mockCollection.insertOne.mockResolvedValue({ acknowledged: true });
});

describe('runMigrations', () => {
  it('applies pending migrations in version order', async () => {
    const appliedOrder: string[] = [];
    const migrations: Migration[] = [
      {
        version: '002',
        description: 'second',
        up: async () => { appliedOrder.push('002'); },
      },
      {
        version: '001',
        description: 'first',
        up: async () => { appliedOrder.push('001'); },
      },
      {
        version: '003',
        description: 'third',
        up: async () => { appliedOrder.push('003'); },
      },
    ];

    mockCollection.find.mockReturnValue(mockFindCursor([]));

    await runMigrations(migrations);

    expect(appliedOrder).toEqual(['001', '002', '003']);
    expect(mockCollection.insertOne).toHaveBeenCalledTimes(3);
    expect(mockCollection.insertOne).toHaveBeenCalledWith(
      expect.objectContaining({ version: '001' })
    );
  });

  it('skips already-applied migrations (idempotent)', async () => {
    const upMock = vi.fn();
    const migrations: Migration[] = [
      { version: '001', description: 'first', up: upMock },
      { version: '002', description: 'second', up: upMock },
    ];

    mockCollection.find.mockReturnValue(
      mockFindCursor([{ version: '001' }, { version: '002' }])
    );

    await runMigrations(migrations);

    expect(upMock).not.toHaveBeenCalled();
    expect(mockCollection.insertOne).not.toHaveBeenCalled();
  });

  it('applies only pending migrations when some are already applied', async () => {
    const appliedOrder: string[] = [];
    const migrations: Migration[] = [
      {
        version: '001',
        description: 'first',
        up: async () => { appliedOrder.push('001'); },
      },
      {
        version: '002',
        description: 'second',
        up: async () => { appliedOrder.push('002'); },
      },
    ];

    mockCollection.find.mockReturnValue(mockFindCursor([{ version: '001' }]));

    await runMigrations(migrations);

    expect(appliedOrder).toEqual(['002']);
    expect(mockCollection.insertOne).toHaveBeenCalledTimes(1);
  });

  it('creates the unique version index', async () => {
    mockCollection.find.mockReturnValue(mockFindCursor([]));
    await runMigrations([]);
    expect(mockCollection.createIndex).toHaveBeenCalledWith(
      { version: 1 },
      { unique: true }
    );
  });

  it('records appliedAt timestamp when applying', async () => {
    mockCollection.find.mockReturnValue(mockFindCursor([]));
    const migrations: Migration[] = [
      { version: '001', description: 'test', up: async () => {} },
    ];

    await runMigrations(migrations);

    expect(mockCollection.insertOne).toHaveBeenCalledWith(
      expect.objectContaining({
        _id: '001',
        version: '001',
        appliedAt: expect.any(Date),
      })
    );
  });
});

describe('getAppliedVersions', () => {
  it('returns sorted version strings', async () => {
    const cursor = {
      toArray: vi.fn().mockResolvedValue([
        { version: '001' },
        { version: '002' },
        { version: '010' },
      ]),
      sort: vi.fn().mockReturnThis(),
    };
    mockCollection.find.mockReturnValue(cursor);

    const versions = await getAppliedVersions();

    expect(versions).toEqual(['001', '002', '010']);
    expect(mockCollection.find).toHaveBeenCalledWith(
      {},
      { projection: { version: 1 } }
    );
  });

  it('returns empty array when no migrations applied', async () => {
    const cursor = {
      toArray: vi.fn().mockResolvedValue([]),
      sort: vi.fn().mockReturnThis(),
    };
    mockCollection.find.mockReturnValue(cursor);

    const versions = await getAppliedVersions();
    expect(versions).toEqual([]);
  });
});
