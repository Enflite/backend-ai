/**
 * formCustomizations.test.ts — the SyteLine Form AI Agent product surface
 * (`/api/v1/form-customizations`) and its flow runner.
 *
 * - POST: JSON and multipart inputs; the five-input contract; XML
 *   well-formedness + form-name match; CSV shape validation; byte-exact
 *   staging for uploads vs. normalized staging for inline content; size
 *   limits; kill-switch (403 FEATURE_DISABLED); `syteline:forms`
 *   permission gate (real requirePermission) + Admin/AI Admin role gate
 * - GET list/get: requester sees own, admins see tenant's, strangers 403
 * - cancel: requester or admin; terminal requests are not re-cancelled
 * - mark-merged: awaiting_review → completed (human records the review-PR merge)
 * - flow runner: atomic claim (no double-claim), preconditions fail
 *   closed, the 8-step flow end to end (intake → validate-inputs →
 *   backup-originals → compare-trn-prd → plan-changes (agent judgment) →
 *   apply-changes-trn → verify → open-pr) → awaiting_review with the PR
 *   link; missing-production-original blocks with FormSync guidance;
 *   TRN/PRD drift blocks; invalid judge decision blocks; PRs are opened,
 *   never merged
 * - flow definition: declarative steps with inputs/outputs, versioned
 *   alongside the product version
 * - knowledge pack: versioned, in sync with docs/form-customization-sop.md
 *
 * All persistence is in-memory; the model judge, deck build, GitHub PR
 * open, GitHub availability, requester auth, and the malware boundary are
 * stubbed. VALIDATED IN CI; real MongoDB, GitHub, npm, and the model
 * REQUIRE PRODUCTION INFRASTRUCTURE.
 */
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import multipart from '@fastify/multipart';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const { getDbMock } = vi.hoisted(() => ({ getDbMock: vi.fn() }));
const { recordAuditMock } = vi.hoisted(() => ({ recordAuditMock: vi.fn() }));
const { currentAuth } = vi.hoisted(() => ({
  currentAuth: {
    userId: 'user-1',
    email: 'user-1@example.test',
    displayName: 'Test User',
    clearance: 'INTERNAL',
    tenantId: 'tenant-a',
    roleId: 'role-1',
    roleName: 'Admin',
    permissions: ['syteline:forms', 'tenant:manage'],
    sessionId: 'session-1',
  } as Record<string, unknown>,
}));
const { liveRequesterAuthMock } = vi.hoisted(() => ({ liveRequesterAuthMock: vi.fn() }));
const { githubAvailable } = vi.hoisted(() => ({ githubAvailable: { value: true } }));
const { malwareVerdict } = vi.hoisted(() => ({ malwareVerdict: { value: 'CLEAN' } }));

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
// NOTE: authz/middleware.js is intentionally NOT mocked — the real
// requirePermission('syteline:forms') gate is exercised.
vi.mock('../src/syteline/requesterAuth.js', () => ({
  liveRequesterAuth: liveRequesterAuthMock,
}));
vi.mock('../src/syteline/forms/github.js', () => ({
  githubPrAvailable: () => githubAvailable.value,
}));
vi.mock('../src/documents/malware.js', () => ({
  malwareScanner: {
    scan: async () => ({ verdict: malwareVerdict.value, scanner: 'test-stub' }),
  },
}));

import { AppError } from '../src/errors.js';
import { config } from '../src/config.js';
import {
  FORM_AGENT_VERSION,
  PRODUCT_NAME,
  FORM_CUSTOMIZATION_FLOW_NAME,
  formAgentRoutes,
  processRequestedCustomizations,
  kickFormAgentRunner,
  startFormAgentScheduler,
  stopFormAgentScheduler,
} from '../src/formAgent/index.js';
import { overrideFlowAgentFn } from '../src/flows/flowRunner.js';
import { overrideDeckBuild, overrideOpenPr } from '../src/formAgent/steps.js';
import { isFormAgentSchedulerRunning } from '../src/formAgent/scheduler.js';
import { blockCustomization, claimCustomization, saveCustomizationPlan } from '../src/formAgent/store.js';
import {
  assertWellFormedXml,
  validateFormXml,
  parseCsv,
  parseIdoPropertiesCsv,
  parseSqlColumnsCsv,
} from '../src/formAgent/types.js';
import { assertExportBytes } from '../src/syteline/forms/index.js';
import { FORM_CUSTOMIZATION_KNOWLEDGE, FORM_CUSTOMIZATION_KNOWLEDGE_VERSION } from '../src/formAgent/knowledge.js';

// Real BOM / CRLF characters (an older fixture used the literal text
// "\uFEFF" and "\r\n" instead of the characters — that bug is fixed here).
const BOM = '\uFEFF';
const CRLF = '\r\n';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function fixtureExport(): string {
  const lines = [
    `<?xml version="1.0" encoding="utf-8"?>`,
    `<Form Name="Lots">`,
    `         <Variables>`,
    `            <Variable Name="fds_DataSource">`,
    `               <Value>SL.SLLots</Value>`,
    `            </Variable>`,
    `         </Variables>`,
    `         <Components>`,
    `            <Component Name="Tab1">`,
    `               <DeviceID>-1</DeviceID>`,
    `               <Type>13</Type>`,
    `               <TabOrder>0</TabOrder>`,
    `               <TopPos>0</TopPos>`,
    `               <LeftPos>0</LeftPos>`,
    `               <Height>10</Height>`,
    `               <ListHeight>2</ListHeight>`,
    `               <Width>50</Width>`,
    `               <Caption>s&General</Caption>`,
    `               <MaxCharacters>0</MaxCharacters>`,
    `               <ContainerName />`,
    `               <ContainerSequence>0</ContainerSequence>`,
    `               <Binding>0</Binding>`,
    `            </Component>`,
    `            <Component Name="SourceEdit">`,
    `               <DeviceID>-1</DeviceID>`,
    `               <Type>1</Type>`,
    `               <TabOrder>5</TabOrder>`,
    `               <TopPos>25.6555555555556</TopPos>`,
    `               <LeftPos>34.4285714285714</LeftPos>`,
    `               <Height>1.3</Height>`,
    `               <ListHeight>2</ListHeight>`,
    `               <Width>22</Width>`,
    `               <Caption>C(SourceStatic)</Caption>`,
    `               <MaxCharacters>0</MaxCharacters>`,
    `               <ContainerName>Tab1</ContainerName>`,
    `               <ContainerSequence>20</ContainerSequence>`,
    `               <DataSource>object.lot.Source</DataSource>`,
    `               <Binding>1</Binding>`,
    `            </Component>`,
    `         </Components>`,
    `</Form>`,
  ];
  return BOM + lines.join(CRLF) + CRLF;
}

const IDO_CSV = 'name,dataType,description\r\nlot,string,Lot number\r\nitem,string,Item\r\n';
const SQL_CSV = 'name,type,nullable\r\nlot,nvarchar(20),NO\r\nitem,nvarchar(30),NO\r\n';

/** A byte-for-byte production original identical to the TRN export. */
function productionOriginalAttachment() {
  return {
    filename: 'Lots.production.original.xml',
    contentBase64: Buffer.from(fixtureExport(), 'utf8').toString('base64'),
  };
}

function validJsonBody(extra: Record<string, unknown> = {}) {
  return {
    formName: 'Lots',
    title: 'Add test field',
    instructions: ['Add a text field "Test" to the General tab'],
    formXml: fixtureExport(),
    idoPropertiesCsv: IDO_CSV,
    sqlColumnsCsv: SQL_CSV,
    ...extra,
  };
}

/** The judged plan decision (validated against the schema by the test judge). */
const PLAN = {
  aliasPrefix: 'lot',
  idoName: 'SLLots',
  tableName: 'lot',
  fields: [
    {
      field: 'Uf_ENF_Test',
      caption: 'Test',
      kind: 'text',
      container: 'Tab1',
      top: 30,
      labelLeft: 26,
      labelWidth: 7.5,
      editLeft: 34.43,
      editWidth: 22,
    },
  ],
  relabels: [],
  resizes: [],
  designNotes: 'Add Uf_ENF_Test via UET on the lot table.',
  openItems: ['Alias assumed until Staging check A.'],
};

function fakeTemplate(): string {
  const root = mkdtempSync(join(tmpdir(), 'form-api-tpl-'));
  const pt = join(root, 'project-template');
  mkdirSync(join(pt, 'tools'), { recursive: true });
  mkdirSync(join(pt, 'plan'), { recursive: true });
  mkdirSync(join(root, 'branding', 'assets'), { recursive: true });
  mkdirSync(join(root, 'branding', 'icons'), { recursive: true });
  writeFileSync(join(pt, 'AGENTS.md'), '# SOP master copy — stays identical\n');
  writeFileSync(join(pt, 'README.md'), '# {{REPO}}\n\nForm: {{FORM}}. Title: {{TITLE}}.\n');
  writeFileSync(join(pt, 'tools', 'apply_form_changes.py'), '# {{FORM}} build\n');
  writeFileSync(join(pt, 'plan', 'deck.config.js'), 'module.exports = { title: "{{TITLE}}" };\n');
  writeFileSync(join(root, 'branding', 'assets', 'enflite-logo.png'), 'logo-bytes');
  writeFileSync(join(root, 'branding', 'icons', 'i1_white.png'), 'icon-bytes');
  writeFileSync(join(root, 'branding', 'icons', 'README.md'), '# icons\n');
  return root;
}

// ---------------------------------------------------------------------------
// In-memory Mongo
// ---------------------------------------------------------------------------

function matches(doc: Record<string, any>, filter: Record<string, any>): boolean {
  return Object.entries(filter).every(([key, value]) => {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      if ('$in' in value) return (value.$in as unknown[]).includes(doc[key]);
      if ('$nin' in value) return !(value.$nin as unknown[]).includes(doc[key]);
      return false;
    }
    return doc[key] === value;
  });
}

function getPath(doc: Record<string, any>, parts: string[]): unknown {
  let target: unknown = doc;
  for (const part of parts) {
    if (typeof target !== 'object' || target === null) return undefined;
    target = (target as Record<string, any>)[part];
  }
  return target;
}

function setPath(doc: Record<string, any>, path: string, value: unknown): void {
  const parts = path.split('.');
  let target: Record<string, any> = doc;
  for (let i = 0; i < parts.length - 1; i += 1) {
    const key = parts[i]!;
    if (typeof target[key] !== 'object' || target[key] === null) target[key] = {};
    target = target[key];
  }
  target[parts[parts.length - 1]!] = value;
}

function applyUpdate(doc: Record<string, any>, update: Record<string, any>): void {
  for (const [key, value] of Object.entries(update.$set ?? {})) setPath(doc, key, value);
  for (const [key, value] of Object.entries(update.$push ?? {})) {
    const arr = getPath(doc, key.split('.'));
    if (Array.isArray(arr)) arr.push(value);
  }
}

function memoryCollection(seed: Array<Record<string, any>> = []) {
  const docs = new Map<string, Record<string, any>>();
  for (const doc of seed) docs.set(doc._id, { ...doc });
  return {
    insertOne: vi.fn(async (doc: Record<string, any>) => {
      docs.set(doc._id, { ...doc });
      return { insertedId: doc._id };
    }),
    findOne: vi.fn(async (filter: Record<string, any>) => {
      for (const doc of docs.values()) if (matches(doc, filter)) return { ...doc };
      return null;
    }),
    find: vi.fn((filter: Record<string, any> = {}) => {
      const rows = [...docs.values()].filter((doc) => matches(doc, filter));
      let sortSpec: Record<string, number> | null = null;
      let limitN: number | null = null;
      const cursor: any = {
        sort: vi.fn((spec: Record<string, number>) => {
          sortSpec = spec;
          return cursor;
        }),
        limit: vi.fn((n: number) => {
          limitN = n;
          return cursor;
        }),
        toArray: vi.fn(async () => {
          let out = rows.map((r) => ({ ...r }));
          if (sortSpec) {
            const entry = Object.entries(sortSpec)[0];
            if (entry) {
              const [key, dir] = entry;
              out = [...out].sort((a, b) => {
                const av = a[key];
                const bv = b[key];
                if (av === bv) return 0;
                return (av < bv ? -1 : 1) * (dir === -1 ? -1 : 1);
              });
            }
          }
          if (limitN !== null) out = out.slice(0, limitN);
          return out;
        }),
      };
      return cursor;
    }),
    findOneAndUpdate: vi.fn(async (filter: Record<string, any>, update: Record<string, any>, opts: Record<string, any> = {}) => {
      for (const doc of docs.values()) {
        if (matches(doc, filter)) {
          applyUpdate(doc, update);
          return opts.returnDocument === 'after' ? { ...doc } : null;
        }
      }
      return null;
    }),
    updateOne: vi.fn(async (filter: Record<string, any>, update: Record<string, any>) => {
      for (const doc of docs.values()) {
        if (matches(doc, filter)) {
          applyUpdate(doc, update);
          return { matchedCount: 1, modifiedCount: 1 };
        }
      }
      return { matchedCount: 0, modifiedCount: 0 };
    }),
    __docs: docs,
  };
}

function memoryDb() {
  const collections = new Map<string, ReturnType<typeof memoryCollection>>();
  const collection = (name: string) => {
    if (!collections.has(name)) collections.set(name, memoryCollection());
    return collections.get(name)!;
  };
  return { collection, __collections: collections };
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const savedConfig: Record<string, unknown> = {};
function setConfig(key: string, value: unknown): void {
  if (!(key in savedConfig)) savedConfig[key] = (config as Record<string, unknown>)[key];
  (config as Record<string, unknown>)[key] = value;
}
function restoreConfig(): void {
  for (const [key, value] of Object.entries(savedConfig)) (config as Record<string, unknown>)[key] = value;
  for (const key of Object.keys(savedConfig)) delete savedConfig[key];
}

let db: ReturnType<typeof memoryDb>;
let projectsDir: string;
let templateDir: string;
let app: ReturnType<typeof Fastify>;

function setAuth(permissions: string[], userId = 'user-1', roleName = 'Admin'): void {
  Object.assign(currentAuth, {
    userId,
    email: `${userId}@example.test`,
    roleName,
    permissions,
  });
}

beforeEach(async () => {
  db = memoryDb();
  getDbMock.mockImplementation(async () => ({ collection: db.collection }));
  recordAuditMock.mockReset();
  liveRequesterAuthMock.mockReset();
  liveRequesterAuthMock.mockImplementation(async () => ({
    ...currentAuth,
    // syteline:forms for the product precondition; flows:run for the
    // platform runner's own run-time permission check.
    permissions: ['syteline:forms', 'flows:run'],
  }));
  githubAvailable.value = true;
  malwareVerdict.value = 'CLEAN';
  setAuth(['syteline:forms', 'tenant:manage'], 'user-1', 'Admin');
  projectsDir = mkdtempSync(join(tmpdir(), 'form-api-projects-'));
  templateDir = fakeTemplate();
  setConfig('FORM_CUSTOMIZATION_API_ENABLED', true);
  // The runner stays OFF by default so POST's kickFormAgentRunner() is a
  // no-op and tests drive the sweep explicitly (deterministic, no races).
  setConfig('FORM_CUSTOMIZATION_RUNNER_ENABLED', false);
  setConfig('SYTELINE_FORM_PROJECTS_DIR', projectsDir);
  setConfig('SYTELINE_FORM_TEMPLATES_DIR', templateDir);
  overrideFlowAgentFn(null);
  overrideDeckBuild(null);
  overrideOpenPr(null);
  app = Fastify();
  app.setErrorHandler((error: any, _req: any, reply: any) => {
    if (error instanceof AppError) {
      return reply.status(error.statusCode).send({ error: { code: error.code, message: error.message } });
    }
    return reply.status(500).send({ error: { code: 'INTERNAL', message: 'Internal server error' } });
  });
  await app.register(multipart);
  await app.register(formAgentRoutes, { prefix: '/api/v1' });
  await app.ready();
});

afterEach(async () => {
  await app.close().catch(() => undefined);
  stopFormAgentScheduler();
  rmSync(projectsDir, { recursive: true, force: true });
  rmSync(templateDir, { recursive: true, force: true });
  restoreConfig();
  overrideFlowAgentFn(null);
  overrideDeckBuild(null);
  overrideOpenPr(null);
});

async function postJson(body: unknown) {
  return app.inject({ method: 'POST', url: '/api/v1/form-customizations', payload: body });
}

function multipartPayload(parts: { name: string; filename?: string; contentType?: string; value: string | Buffer }[]): { payload: Buffer; headers: Record<string, string> } {
  const boundary = '----testboundary1234';
  const chunks: Buffer[] = [];
  for (const part of parts) {
    chunks.push(Buffer.from(`--${boundary}\r\n`, 'utf8'));
    if (part.filename) {
      chunks.push(Buffer.from(`Content-Disposition: form-data; name="${part.name}"; filename="${part.filename}"\r\n`, 'utf8'));
      chunks.push(Buffer.from(`Content-Type: ${part.contentType ?? 'application/octet-stream'}\r\n\r\n`, 'utf8'));
      chunks.push(Buffer.isBuffer(part.value) ? part.value : Buffer.from(part.value, 'utf8'));
    } else {
      chunks.push(Buffer.from(`Content-Disposition: form-data; name="${part.name}"\r\n\r\n`, 'utf8'));
      chunks.push(Buffer.isBuffer(part.value) ? part.value : Buffer.from(part.value, 'utf8'));
    }
    chunks.push(Buffer.from('\r\n', 'utf8'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`, 'utf8'));
  return {
    payload: Buffer.concat(chunks),
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
  };
}

// ---------------------------------------------------------------------------
// Input validators
// ---------------------------------------------------------------------------

describe('input validators', () => {
  it('accepts well-formed XML', () => {
    expect(() => assertWellFormedXml('<Form><A/><B>x</B></Form>')).not.toThrow();
    expect(() => assertWellFormedXml('<?xml version="1.0"?><!-- c --><Form><![CDATA[<x>]]></Form>')).not.toThrow();
  });

  it('rejects malformed XML with a user-facing message', () => {
    expect(() => assertWellFormedXml('<Form><A></B></Form>')).toThrow(/mismatched tags/);
    expect(() => assertWellFormedXml('<Form><A>')).toThrow(/unclosed tag/);
    expect(() => assertWellFormedXml('<A/><B/>')).toThrow(/more than one root/);
    expect(() => assertWellFormedXml('not xml at all')).toThrow(/no root element/);
  });

  it('requires the form name in the XML to match', () => {
    expect(() => validateFormXml(fixtureExport(), 'Lots')).not.toThrow();
    expect(() => validateFormXml(fixtureExport(), 'Incidents')).toThrow(/Lots/);
  });

  it('parses CSVs with quotes and CRLF', () => {
    const parsed = parseCsv('name,type\r\n"a,b",string\r\nc,date\r\n', 'Test CSV');
    expect(parsed.header).toEqual(['name', 'type']);
    expect(parsed.rows).toEqual([['a,b', 'string'], ['c', 'date']]);
  });

  it('rejects ragged and empty CSVs', () => {
    expect(() => parseCsv('a,b\r\n1\r\n', 'Test CSV')).toThrow(/row 2 has 1 fields/);
    expect(() => parseCsv('', 'Test CSV')).toThrow(/empty/);
    expect(() => parseCsv('a,b\r\n', 'Test CSV')).toThrow(/no data rows/);
  });

  it('requires the IDO/SQL shape (a name-like first column)', () => {
    expect(() => parseIdoPropertiesCsv('foo,bar\r\n1,2\r\n')).toThrow(/property-name-like/);
    expect(parseIdoPropertiesCsv('Property,DataType\r\nlot,string\r\n').header).toEqual(['Property', 'DataType']);
    expect(() => parseSqlColumnsCsv('foo,bar\r\n1,2\r\n')).toThrow(/column-name-like/);
    expect(parseSqlColumnsCsv('Column,Type\r\nlot,nvarchar\r\n').rowCount).toBe(1);
  });

  it('enforces byte-exact FormSync exports (BOM + CRLF)', () => {
    const bytes = Buffer.from(fixtureExport(), 'utf8');
    expect(() => assertExportBytes(bytes, 'Lots.trn.original.xml')).not.toThrow();
    expect(() => assertExportBytes(Buffer.from(fixtureExport().replace(/^\uFEFF/, ''), 'utf8'), 'x.xml')).toThrow(/BOM/);
    expect(() => assertExportBytes(Buffer.from(fixtureExport().replace(/\r\n/g, '\n'), 'utf8'), 'x.xml')).toThrow(/CRLF/);
  });
});

// ---------------------------------------------------------------------------
// POST /form-customizations — JSON
// ---------------------------------------------------------------------------

describe('POST /form-customizations (JSON)', () => {
  it('creates a request and stages the five inputs (202 + product version)', async () => {
    const res = await postJson(validJsonBody());
    expect(res.statusCode).toBe(202);
    const body = res.json();
    expect(body.status).toBe('requested');
    expect(body.formName).toBe('Lots');
    expect(typeof body.id).toBe('string');
    expect(body.product).toEqual({ name: 'SyteLine Form AI Agent', version: FORM_AGENT_VERSION });
    expect(body.product.name).toBe(PRODUCT_NAME);

    // Staged under .inbox/<runId>/ inside the projects dir.
    const inboxDir = join(projectsDir, '.inbox', body.id);
    expect(readFileSync(join(inboxDir, 'form.xml'), 'utf8')).toContain('<Form Name="Lots">');
    expect(readFileSync(join(inboxDir, 'ido.csv'), 'utf8')).toBe(IDO_CSV);
    expect(readFileSync(join(inboxDir, 'sql.csv'), 'utf8')).toBe(SQL_CSV);
    const manifest = JSON.parse(readFileSync(join(inboxDir, 'manifest.json'), 'utf8'));
    expect(manifest.inlineNormalized).toBe(true);
    // Inline content is normalized to CRLF+BOM on staging.
    const staged = readFileSync(join(inboxDir, 'form.xml'));
    expect(staged[0]).toBe(0xef);
    expect(staged.includes(Buffer.from('\r\n'))).toBe(true);
    expect(recordAuditMock).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'FORM_CUSTOMIZATION_REQUESTED', success: true }),
    );
  });

  it('stages JSON attachments under the inbox', async () => {
    const res = await postJson(
      validJsonBody({ attachments: [{ filename: 'notes.txt', content: 'extra context' }] }),
    );
    expect(res.statusCode).toBe(202);
    const inboxDir = join(projectsDir, '.inbox', res.json().id);
    expect(readFileSync(join(inboxDir, 'attachments', 'notes.txt'), 'utf8')).toBe('extra context');
  });

  it('refuses while the API kill-switch is off (403 FEATURE_DISABLED)', async () => {
    setConfig('FORM_CUSTOMIZATION_API_ENABLED', false);
    const res = await postJson(validJsonBody());
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('FEATURE_DISABLED');
    expect(res.json().error.message).toContain('SyteLine Form AI Agent');
  });

  it('requires the syteline:forms permission (real gate, never the model)', async () => {
    setAuth(['chat:create'], 'user-1', 'Admin');
    const res = await postJson(validJsonBody());
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('AUTHORIZATION_FAILURE');
  });

  it('is Admin / AI Admin only — other roles are refused', async () => {
    setAuth(['syteline:forms'], 'user-1', 'User');
    const refused = await postJson(validJsonBody());
    expect(refused.statusCode).toBe(403);
    expect(refused.json().error.code).toBe('FORBIDDEN');

    setAuth(['syteline:forms'], 'user-1', 'AI Admin');
    const allowed = await postJson(validJsonBody());
    expect(allowed.statusCode).toBe(202);
  });

  it('validates the request shape with clear codes', async () => {
    const res = await postJson({ formName: 'Lots' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
    expect(JSON.stringify(res.json().error.details)).toContain('instructions');
  });

  it('rejects malformed form XML with a user-facing message', async () => {
    const res = await postJson(validJsonBody({ formXml: '<Form><A></B></Form>' }));
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
    expect(res.json().error.details.part).toBe('formXml');
    expect(res.json().error.message).toContain('mismatched tags');
  });

  it('rejects a form name that does not match the XML', async () => {
    const res = await postJson(validJsonBody({ formName: 'Incidents' }));
    expect(res.statusCode).toBe(400);
    expect(res.json().error.details.part).toBe('formXml');
  });

  it('rejects CSVs without the expected shape', async () => {
    const badIdo = await postJson(validJsonBody({ idoPropertiesCsv: 'foo,bar\r\n1,2\r\n' }));
    expect(badIdo.statusCode).toBe(400);
    expect(badIdo.json().error.details.part).toBe('idoPropertiesCsv');
    const badSql = await postJson(validJsonBody({ sqlColumnsCsv: 'foo,bar\r\n1,2\r\n' }));
    expect(badSql.statusCode).toBe(400);
    expect(badSql.json().error.details.part).toBe('sqlColumnsCsv');
  });

  it('rejects unsafe attachment names and duplicates', async () => {
    const unsafe = await postJson(validJsonBody({ attachments: [{ filename: '../evil.txt', content: 'x' }] }));
    expect(unsafe.statusCode).toBe(400);
    const dup = await postJson(
      validJsonBody({ attachments: [{ filename: 'a.txt', content: 'x' }, { filename: 'a.txt', content: 'y' }] }),
    );
    expect(dup.statusCode).toBe(400);
    expect(dup.json().error.message).toContain('Duplicate attachment filename');
  });

  it('rejects oversized attachments', async () => {
    const big = Buffer.alloc(200 * 1024 + 1, 'a').toString('base64');
    const res = await postJson(validJsonBody({ attachments: [{ filename: 'big.bin', contentBase64: big }] }));
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
  });
});

// ---------------------------------------------------------------------------
// POST /form-customizations — multipart
// ---------------------------------------------------------------------------

describe('POST /form-customizations (multipart)', () => {
  function multipartBody(extraParts: { name: string; filename?: string; contentType?: string; value: string | Buffer }[] = []) {
    return multipartPayload([
      { name: 'formName', value: 'Lots' },
      { name: 'title', value: 'Add test field' },
      { name: 'instructions', value: JSON.stringify(['Add a text field "Test" to the General tab']) },
      { name: 'formXml', filename: 'Lots.trn.original.xml', contentType: 'application/xml', value: Buffer.from(fixtureExport(), 'utf8') },
      { name: 'idoPropertiesCsv', filename: 'ido.csv', contentType: 'text/csv', value: IDO_CSV },
      { name: 'sqlColumnsCsv', filename: 'sql.csv', contentType: 'text/csv', value: SQL_CSV },
      ...extraParts,
    ]);
  }

  it('accepts file parts and stages them byte-exact', async () => {
    const { payload, headers } = multipartBody();
    const res = await app.inject({ method: 'POST', url: '/api/v1/form-customizations', payload, headers });
    expect(res.statusCode).toBe(202);
    const id = res.json().id;
    const stagedBytes = readFileSync(join(projectsDir, '.inbox', id, 'form.xml'));
    expect(stagedBytes.equals(Buffer.from(fixtureExport(), 'utf8'))).toBe(true);
    const manifest = JSON.parse(readFileSync(join(projectsDir, '.inbox', id, 'manifest.json'), 'utf8'));
    expect(manifest.inlineNormalized).toBe(false);
  });

  it('accepts repeatable attachment parts and newline-delimited instructions', async () => {
    const { payload, headers } = multipartPayload([
      { name: 'formName', value: 'Lots' },
      { name: 'title', value: 'Add test field' },
      { name: 'instructions', value: 'Do a thing\nDo another thing' },
      { name: 'formXml', filename: 'Lots.trn.original.xml', value: Buffer.from(fixtureExport(), 'utf8') },
      { name: 'idoPropertiesCsv', filename: 'ido.csv', value: IDO_CSV },
      { name: 'sqlColumnsCsv', filename: 'sql.csv', value: SQL_CSV },
      { name: 'attachments', filename: 'a.txt', value: 'first' },
      { name: 'attachments[]', filename: 'b.txt', value: 'second' },
    ]);
    const res = await app.inject({ method: 'POST', url: '/api/v1/form-customizations', payload, headers });
    expect(res.statusCode).toBe(202);
    const inboxDir = join(projectsDir, '.inbox', res.json().id);
    expect(readFileSync(join(inboxDir, 'attachments', 'a.txt'), 'utf8')).toBe('first');
    expect(readFileSync(join(inboxDir, 'attachments', 'b.txt'), 'utf8')).toBe('second');
  });

  it('refuses non-byte-exact XML uploads with a FormSync message', async () => {
    const lfXml = fixtureExport().replace(/\r\n/g, '\n').replace(/^\uFEFF/, '');
    const { payload, headers } = multipartPayload([
      { name: 'formName', value: 'Lots' },
      { name: 'title', value: 'Add test field' },
      { name: 'instructions', value: JSON.stringify(['Do a thing']) },
      { name: 'formXml', filename: 'x.xml', contentType: 'application/xml', value: Buffer.from(lfXml, 'utf8') },
      { name: 'idoPropertiesCsv', filename: 'ido.csv', value: IDO_CSV },
      { name: 'sqlColumnsCsv', filename: 'sql.csv', value: SQL_CSV },
    ]);
    const res = await app.inject({ method: 'POST', url: '/api/v1/form-customizations', payload, headers });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
    expect(res.json().error.message).toContain('FormSync');
  });

  it('rejects oversized attachment parts (413)', async () => {
    const big = Buffer.alloc(200 * 1024 + 1, 'a');
    const { payload, headers } = multipartBody([
      { name: 'attachments', filename: 'big.bin', value: big },
    ]);
    const res = await app.inject({ method: 'POST', url: '/api/v1/form-customizations', payload, headers });
    expect(res.statusCode).toBe(413);
    expect(res.json().error.code).toBe('PART_TOO_LARGE');
  });
});

// ---------------------------------------------------------------------------
// GET list / get + cancel + mark-merged
// ---------------------------------------------------------------------------

describe('GET /form-customizations, cancel, mark-merged', () => {
  it('lists own requests; admins see the tenant’s', async () => {
    await postJson(validJsonBody());
    setAuth(['syteline:forms'], 'user-2', 'AI Admin');
    await postJson(validJsonBody({ formName: 'Incidents', formXml: fixtureExport().replace('Name="Lots"', 'Name="Incidents"') }));
    const own = await app.inject({ method: 'GET', url: '/api/v1/form-customizations' });
    expect(own.statusCode).toBe(200);
    expect(own.json().items).toHaveLength(1);
    expect(own.json().items[0].formName).toBe('Incidents');
    expect(own.json().items[0]).not.toHaveProperty('authSnapshot');

    setAuth(['syteline:forms', 'tenant:manage'], 'user-1', 'Admin');
    const all = await app.inject({ method: 'GET', url: '/api/v1/form-customizations' });
    expect(all.json().items).toHaveLength(2);
    const filtered = await app.inject({ method: 'GET', url: '/api/v1/form-customizations?status=requested' });
    expect(filtered.json().items).toHaveLength(2);
    const limited = await app.inject({ method: 'GET', url: '/api/v1/form-customizations?limit=1' });
    expect(limited.json().items).toHaveLength(1);
  });

  it('returns the full request record with product + flow versions', async () => {
    const created = await postJson(validJsonBody());
    const res = await app.inject({ method: 'GET', url: `/api/v1/form-customizations/${created.json().id}` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.id).toBe(created.json().id);
    expect(body.status).toBe('requested');
    expect(body.product).toEqual({ name: 'SyteLine Form AI Agent', version: FORM_AGENT_VERSION });
    expect(body.flow).toEqual({ name: 'syteline-form-customization', version: 'live' });
    expect(body.steps).toHaveLength(1);
    expect(body.steps[0].name).toBe('intake');
    expect(body.steps[0].status).toBe('done');
    expect(body).not.toHaveProperty('authSnapshot');
  });

  it('omits the plan until stored, then exposes the validated plan', async () => {
    const created = await postJson(validJsonBody());
    const id = created.json().id;
    const before = await app.inject({ method: 'GET', url: `/api/v1/form-customizations/${id}` });
    expect(before.statusCode).toBe(200);
    expect(before.json()).not.toHaveProperty('plan');

    const plan = {
      aliasPrefix: 'lot',
      idoName: 'SLLots',
      tableName: 'lot',
      fields: [
        {
          field: 'Uf_ENF_Priority',
          caption: 'Priority',
          kind: 'text',
          container: 'GeneralTab',
          top: 10,
          labelLeft: 4,
          labelWidth: 20,
          editLeft: 26,
          editWidth: 40,
        },
      ],
      relabels: [{ component: 'LotsEdit', newCaption: 'Lot' }],
      resizes: [{ component: 'LotsEdit', changes: { Width: 200 } }],
      designNotes: 'Adds one UET field bound to lot.',
      openItems: ['Alias assumed until Staging check A.'],
    };
    await saveCustomizationPlan('tenant-a', id, plan);
    const after = await app.inject({ method: 'GET', url: `/api/v1/form-customizations/${id}` });
    expect(after.statusCode).toBe(200);
    expect(after.json().plan).toEqual(plan);
    expect(after.json()).not.toHaveProperty('authSnapshot');
  });

  it('refuses strangers with 403 (no existence leak via 404 for unknown ids)', async () => {
    const created = await postJson(validJsonBody());
    setAuth(['syteline:forms'], 'user-2', 'AI Admin');
    const res = await app.inject({ method: 'GET', url: `/api/v1/form-customizations/${created.json().id}` });
    expect(res.statusCode).toBe(403);
    const unknown = await app.inject({ method: 'GET', url: '/api/v1/form-customizations/does-not-exist' });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json().error.code).toBe('NOT_FOUND');
  });

  it('cancels a requested request; terminal ones stay put (409)', async () => {
    const created = await postJson(validJsonBody());
    const id = created.json().id;
    const cancelled = await app.inject({ method: 'POST', url: `/api/v1/form-customizations/${id}/cancel` });
    expect(cancelled.statusCode).toBe(200);
    expect(cancelled.json().status).toBe('cancelled');
    const again = await app.inject({ method: 'POST', url: `/api/v1/form-customizations/${id}/cancel` });
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe('REQUEST_ALREADY_TERMINAL');
  });

  it('a non-requester cannot cancel', async () => {
    const created = await postJson(validJsonBody());
    setAuth(['syteline:forms'], 'user-2', 'AI Admin');
    const res = await app.inject({ method: 'POST', url: `/api/v1/form-customizations/${created.json().id}/cancel` });
    expect(res.statusCode).toBe(403);
  });

  it('mark-merged moves awaiting_review to completed; otherwise 409', async () => {
    const created = await postJson(validJsonBody());
    const id = created.json().id;
    // Not yet awaiting review → conflict.
    const early = await app.inject({ method: 'POST', url: `/api/v1/form-customizations/${id}/mark-merged` });
    expect(early.statusCode).toBe(409);

    // Simulate the runner having finished: claim + block via the store.
    const claimed = await claimCustomization('tenant-a', id, 'runner-test');
    expect(claimed).not.toBeNull();
    await blockCustomization('tenant-a', id, 'trn-prd-drift', 'drift');
    const stillBlocked = await app.inject({ method: 'POST', url: `/api/v1/form-customizations/${id}/mark-merged` });
    expect(stillBlocked.statusCode).toBe(409);
    expect(stillBlocked.json().error.code).toBe('REQUEST_ALREADY_TERMINAL');
  });
});

// ---------------------------------------------------------------------------
// Flow runner
// ---------------------------------------------------------------------------

describe('flow runner', () => {
  const openedPrs: Array<{ prUrl: string; branch: string; base: string; prTitle: string; prBody: string }> = [];

  /** Judge stub: the platform agent step returns the plan JSON directly. */
  function judgeWith(plan: unknown) {
    overrideFlowAgentFn(async () => JSON.stringify(plan));
  }

  beforeEach(() => {
    openedPrs.length = 0;
    judgeWith(PLAN);
    overrideDeckBuild(async (_deck: unknown, projectDir: string) => {
      const pptx = join(projectDir, 'plan', 'Lots_Implementation_Plan.pptx');
      mkdirSync(join(projectDir, 'plan'), { recursive: true });
      writeFileSync(pptx, 'fake-pptx');
      return pptx;
    });
    overrideOpenPr(async (args: { repo: string; projectDir: string; branch: string; base: string; prTitle: string; prBody: string }) => {
      openedPrs.push({ prUrl: 'https://github.com/Enflite/Lots/pull/1', ...args });
      return { prUrl: 'https://github.com/Enflite/Lots/pull/1' };
    });
  });

  async function createRunnable(extra: Record<string, unknown> = {}) {
    const res = await postJson(validJsonBody({ attachments: [productionOriginalAttachment()], ...extra }));
    expect(res.statusCode).toBe(202);
    return res.json().id as string;
  }

  /** Explicit, deterministic sweep: the runner is on only for this call. */
  async function runSweep() {
    setConfig('FORM_CUSTOMIZATION_RUNNER_ENABLED', true);
    try {
      return await processRequestedCustomizations();
    } finally {
      setConfig('FORM_CUSTOMIZATION_RUNNER_ENABLED', false);
    }
  }

  it('runs the full flow and reports the review PR (never merges)', async () => {
    const id = await createRunnable();
    const sweep = await runSweep();
    expect(sweep).toEqual({ claimed: 1, succeeded: 1, blocked: 0 });

    const res = await app.inject({ method: 'GET', url: `/api/v1/form-customizations/${id}` });
    const body = res.json();
    expect(body.status).toBe('awaiting_review');
    expect(body.prUrl).toBe('https://github.com/Enflite/Lots/pull/1');
    expect(body.repoUrl).toBe('https://github.com/Enflite/Lots');
    expect(body.resultSummary).toContain('SyteLine Form AI Agent');
    expect(body.resultSummary).toContain('Uf_ENF_Test');
    expect(body.evidence.originals.trn).toBe('original/Lots.trn.original.xml');
    expect(body.evidence.originals.sha256Prefix).toMatch(/^[0-9a-f]{16}$/);
    expect(body.evidence.openItems).toContain('Alias assumed until Staging check A.');
    expect(body.steps.map((s: any) => `${s.name}:${s.status}`)).toEqual([
      'intake:done',
      'validate-inputs:done',
      'backup-originals:done',
      'compare-trn-prd:done',
      'plan-changes:done',
      'apply-changes-trn:done',
      'verify:done',
      'open-pr:done',
    ]);

    // The built form XML carries the new Uf_ENF_* component...
    const projectDir = join(projectsDir, `Lots-${id.slice(0, 8)}`);
    const built = readFileSync(join(projectDir, 'Lots.xml'), 'utf8');
    expect(built).toContain('Uf_ENF_Test');
    // ...the docs, and the rollback originals.
    expect(existsSync(join(projectDir, 'docs', 'Implementation-Plan.md'))).toBe(true);
    expect(existsSync(join(projectDir, 'README.md'))).toBe(true);
    expect(existsSync(join(projectDir, 'original', 'README.md'))).toBe(true);
    expect(existsSync(join(projectDir, 'original', 'Lots.trn.original.xml'))).toBe(true);
    expect(existsSync(join(projectDir, 'original', 'Lots.production.original.xml'))).toBe(true);
    expect(existsSync(join(projectDir, 'plan', 'Lots_Implementation_Plan.pptx'))).toBe(true);
    // The inbox is cleaned up after a successful run.
    expect(existsSync(join(projectsDir, '.inbox', id))).toBe(false);
  });

  it('opens (never merges) the PR on a feature branch', async () => {
    await createRunnable();
    await runSweep();
    expect(openedPrs).toHaveLength(1);
    const pr = openedPrs[0]!;
    expect(pr.base).toBe('main');
    expect(pr.branch.startsWith('form-ai/lots-')).toBe(true);
    expect(pr.prTitle).toContain('[SyteLine Form AI Agent]');
    expect(pr.prBody).toContain('never merged by automation');
  });

  it('claims atomically — a second claim loses', async () => {
    const id = await createRunnable();
    const first = await claimCustomization('tenant-a', id, 'runner-a');
    expect(first).not.toBeNull();
    expect(first!.status).toBe('in_progress');
    const second = await claimCustomization('tenant-a', id, 'runner-b');
    expect(second).toBeNull();
  });

  it('blocks when the production original is missing (FormSync guidance)', async () => {
    const res = await postJson(validJsonBody());
    const id = res.json().id;
    const sweep = await runSweep();
    expect(sweep).toEqual({ claimed: 1, succeeded: 0, blocked: 1 });
    const body = (await app.inject({ method: 'GET', url: `/api/v1/form-customizations/${id}` })).json();
    expect(body.status).toBe('blocked');
    expect(body.blockedReason).toBe('missing-production-original');
    expect(body.blockedDetail).toContain('FormSync');
    expect(body.blockedDetail).toContain('*.production.original.xml');
    expect(body.steps.map((s: any) => `${s.name}:${s.status}`)).toContain('backup-originals:failed');
  });

  it('stops the build when TRN and production originals differ', async () => {
    const drifted = {
      filename: 'Lots.production.original.xml',
      contentBase64: Buffer.from(fixtureExport().replace('SourceEdit', 'SourceEdited'), 'utf8').toString('base64'),
    };
    const res = await postJson(validJsonBody({ attachments: [drifted] }));
    const id = res.json().id;
    const sweep = await runSweep();
    expect(sweep).toEqual({ claimed: 1, succeeded: 0, blocked: 1 });
    const body = (await app.inject({ method: 'GET', url: `/api/v1/form-customizations/${id}` })).json();
    expect(body.status).toBe('blocked');
    expect(body.blockedReason).toBe('trn-prd-drift');
    expect(body.blockedDetail).toContain('STOP');
  });

  it('blocks on an invalid judge decision with a user-facing reason', async () => {
    judgeWith({ aliasPrefix: 'lot' /* missing required fields */ });
    const id = await createRunnable();
    await runSweep();
    const body = (await app.inject({ method: 'GET', url: `/api/v1/form-customizations/${id}` })).json();
    expect(body.status).toBe('blocked');
    expect(body.blockedReason).toBe('invalid-requirements');
    expect(body.blockedDetail).toContain('SyteLine Form AI Agent');
  });

  it('blocks when the requester lost the syteline:forms permission (precondition)', async () => {
    liveRequesterAuthMock.mockImplementation(async () => ({ ...currentAuth, permissions: [] }));
    const id = await createRunnable();
    await runSweep();
    const body = (await app.inject({ method: 'GET', url: `/api/v1/form-customizations/${id}` })).json();
    expect(body.status).toBe('blocked');
    expect(body.blockedReason).toBe('requester-lost-permission');
  });

  it('blocks when GitHub is unavailable (precondition, no half-run)', async () => {
    githubAvailable.value = false;
    const id = await createRunnable();
    const sweep = await runSweep();
    expect(sweep).toEqual({ claimed: 1, succeeded: 0, blocked: 1 });
    const body = (await app.inject({ method: 'GET', url: `/api/v1/form-customizations/${id}` })).json();
    expect(body.status).toBe('blocked');
    expect(body.blockedReason).toBe('missing-github-token');
    // No project dir was scaffolded — the flow never half-ran.
    expect(existsSync(join(projectsDir, `Lots-${id.slice(0, 8)}`))).toBe(false);
  });

  it('quarantines infected parts at the malware boundary', async () => {
    malwareVerdict.value = 'INFECTED';
    const id = await createRunnable();
    await runSweep();
    const body = (await app.inject({ method: 'GET', url: `/api/v1/form-customizations/${id}` })).json();
    expect(body.status).toBe('blocked');
    expect(body.blockedReason).toBe('attachment-quarantined');
  });

  it('a cancelled request is never resurrected by the sweep', async () => {
    const id = await createRunnable();
    await app.inject({ method: 'POST', url: `/api/v1/form-customizations/${id}/cancel` });
    const sweep = await runSweep();
    expect(sweep).toEqual({ claimed: 0, succeeded: 0, blocked: 0 });
    const body = (await app.inject({ method: 'GET', url: `/api/v1/form-customizations/${id}` })).json();
    expect(body.status).toBe('cancelled');
  });

  it('mark-merged completes a run that reached awaiting_review', async () => {
    const id = await createRunnable();
    await runSweep();
    const merged = await app.inject({ method: 'POST', url: `/api/v1/form-customizations/${id}/mark-merged` });
    expect(merged.statusCode).toBe(200);
    expect(merged.json().status).toBe('completed');
    const again = await app.inject({ method: 'POST', url: `/api/v1/form-customizations/${id}/mark-merged` });
    expect(again.statusCode).toBe(409);
  });

  it('is a no-op while the runner kill-switch is off', async () => {
    await createRunnable();
    setConfig('FORM_CUSTOMIZATION_RUNNER_ENABLED', false);
    const sweep = await processRequestedCustomizations();
    expect(sweep).toEqual({ claimed: 0, succeeded: 0, blocked: 0 });
  });

  it('kicks are no-ops while disabled', () => {
    setConfig('FORM_CUSTOMIZATION_RUNNER_ENABLED', false);
    expect(() => kickFormAgentRunner()).not.toThrow();
  });

  it('scheduler starts and stops', () => {
    expect(isFormAgentSchedulerRunning()).toBe(false);
    startFormAgentScheduler();
    expect(isFormAgentSchedulerRunning()).toBe(true);
    stopFormAgentScheduler();
    expect(isFormAgentSchedulerRunning()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Flow definition: declarative, versioned, the first Flow
// ---------------------------------------------------------------------------

describe('form-customization flow definition', () => {
  const flowJsonPath = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'flows', `${FORM_CUSTOMIZATION_FLOW_NAME}.flow.json`);
  const flowJson = JSON.parse(readFileSync(flowJsonPath, 'utf8')) as {
    name: string;
    inputs: Record<string, unknown>;
    steps: Array<{ id: string; kind: string; tool?: string; prompt?: string; outputSchema?: unknown; params?: Record<string, unknown> }>;
  };

  it('declares the pipeline steps in order with the platform step kinds', () => {
    expect(flowJson.name).toBe(FORM_CUSTOMIZATION_FLOW_NAME);
    expect(flowJson.steps.map((s) => s.id)).toEqual([
      'intake',
      'validate_inputs',
      'backup_originals',
      'compare_trn_prd',
      'plan_changes',
      'apply_changes_trn',
      'verify',
      'open_pr',
    ]);
    expect(flowJson.steps.map((s) => s.kind)).toEqual([
      'tool',
      'tool',
      'tool',
      'tool',
      'agent',
      'tool',
      'tool',
      'tool',
    ]);
    // Tool steps reference the formagent.* platform tools.
    for (const step of flowJson.steps.filter((s) => s.kind === 'tool')) {
      expect(step.tool, `${step.id} tool`).toMatch(/^formagent\./);
    }
    // Exactly one agent step — the planner seam — with the plan output schema.
    const agents = flowJson.steps.filter((s) => s.kind === 'agent');
    expect(agents.map((s) => s.id)).toEqual(['plan_changes']);
    expect(agents[0]!.prompt).toContain('PLAN CONTRACT');
    expect(agents[0]!.outputSchema).toMatchObject({ type: 'object' });
  });

  it('declares the five request inputs', () => {
    for (const key of ['formXml', 'idoPropertiesCsv', 'sqlColumnsCsv', 'instructions']) {
      expect(flowJson.inputs[key], `input ${key}`).toBeTruthy();
    }
    // Attachments ride as parallel name+content arrays.
    expect(flowJson.inputs['attachmentNames']).toBeTruthy();
    expect(flowJson.inputs['attachmentContents']).toBeTruthy();
  });

  it('keeps the agent prompt in sync with the planner constants', async () => {
    const { CUSTOMIZATION_PLANNER_SYSTEM_PROMPT, PLAN_AGENT_PROMPT_TEMPLATE } = await import('../src/formAgent/steps.js');
    const agent = flowJson.steps.find((s) => s.id === 'plan_changes')!;
    expect(agent.prompt).toBe(`${CUSTOMIZATION_PLANNER_SYSTEM_PROMPT}\n\n${PLAN_AGENT_PROMPT_TEMPLATE}`);
  });

  it('keeps the agent outputSchema aligned with the plan zod schema', async () => {
    const { customizationPlanSchema } = await import('../src/formAgent/steps.js');
    const agent = flowJson.steps.find((s) => s.id === 'plan_changes')!;
    const schema = agent.outputSchema as {
      properties: Record<string, { type?: string; pattern?: string; maxItems?: number }>;
      required: string[];
    };
    // Spot-check the load-bearing constraints (full zod↔JSON-Schema
    // equivalence isn't derivable without a converter; the pattern and
    // the field cap are what the pipeline depends on).
    for (const key of ['aliasPrefix', 'idoName', 'tableName', 'fields', 'designNotes']) {
      expect(schema.properties[key], `outputSchema property ${key}`).toBeTruthy();
      expect(schema.required).toContain(key);
    }
    expect(schema.properties['fields']!.maxItems).toBe(20);
    const fieldPattern = (schema.properties['fields'] as any).items.properties.field.pattern as string;
    expect(fieldPattern).toBe('^Uf_ENF_[A-Za-z0-9]+$');
    // The zod schema's field-name rule matches the JSON Schema pattern.
    const fieldsArray = customizationPlanSchema.shape.fields as unknown as {
      _def: { innerType: { element: { shape: { field: { safeParse: (v: unknown) => { success: boolean } } } } } };
    };
    const fieldSchema = fieldsArray._def.innerType.element.shape.field;
    expect(fieldSchema.safeParse('Uf_ENF_Test').success).toBe(true);
    expect(fieldSchema.safeParse('Bad_Name').success).toBe(false);
  });

  it('is versioned by the Flows platform', () => {
    expect(FORM_CUSTOMIZATION_FLOW_NAME).toBe('syteline-form-customization');
    expect(FORM_AGENT_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    expect(PRODUCT_NAME).toBe('SyteLine Form AI Agent');
  });
});

// ---------------------------------------------------------------------------
// Knowledge pack sync
// ---------------------------------------------------------------------------

describe('form-customization SOP knowledge pack', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const docPath = join(here, '..', '..', 'docs', 'form-customization-sop.md');

  // Compared case-insensitively: the pack is SHOUTING CASE, the doc is
  // sentence case; the anchors pin the shared substance.
  const SYNC_ANCHORS = [
    'Uf_ENF_',
    'TRN-first',
    'BOM',
    'CRLF',
    'FormSync',
    'purple highlighting',
    'Staging check A',
    'never merge it',
    'procedure 07',
    'SQL Tables',
    'deterministic rebuild',
    'property patterns',
  ];

  it('is versioned', () => {
    expect(FORM_CUSTOMIZATION_KNOWLEDGE_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('stays in sync with the human-readable SOP doc', () => {
    const doc = readFileSync(docPath, 'utf8');
    const packLower = FORM_CUSTOMIZATION_KNOWLEDGE.toLowerCase();
    const docLower = doc.toLowerCase();
    for (const anchor of SYNC_ANCHORS) {
      const needle = anchor.toLowerCase();
      expect(packLower, `pack missing: ${anchor}`).toContain(needle);
      expect(docLower, `doc missing: ${anchor}`).toContain(needle);
    }
    // The forbidden term may appear only to forbid it (a NEVER rule
    // necessarily names what it prohibits); it must never be used
    // affirmatively in user-facing text.
    const affirmativeUse = (text: string): boolean =>
      text
        .split('\n')
        .some((line) => line.includes('Application Studio') && !/NEVER/i.test(line));
    expect(affirmativeUse(FORM_CUSTOMIZATION_KNOWLEDGE), 'pack uses the forbidden term affirmatively').toBe(false);
    expect(affirmativeUse(doc), 'doc uses the forbidden term affirmatively').toBe(false);
  });
});
