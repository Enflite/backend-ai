/**
 * documentFormats.test.ts — document format support: PPTX, code files, and a
 * full audit that every allowlisted format genuinely extracts end to end.
 *
 * Owner ask: "pdf files and everything" / "it needs to be able to work with
 * csv files, pptx.. code files you name it". Coverage (deterministic;
 * provider boundary mocked):
 *
 * 1. Audit: every allowlisted text format (PDF, DOCX, XLSX, PPTX, CSV, TXT,
 *    Markdown, HTML) round-trips — upload validation accepts it AND
 *    extraction yields the real text. An allowlist entry that extracts to
 *    nothing (or throws) fails this test.
 * 2. PPTX: PK magic-byte validation, renamed-.docx rejection via OOXML
 *    content types, per-slide sections in numeric order with stable
 *    slide:N source locations.
 * 3. Code files: a broad extension set (+ extensionless Dockerfile/Makefile/
 *    gitignore/.env) accepted as inert plain text; binaries masquerading as
 *    code (NUL bytes, high control-char ratio, invalid UTF-8) rejected.
 * 4. True executables/installers (.exe/.dll/.msi/.com/.scr/.sys/.so/.dylib)
 *    stay rejected with UNSUPPORTED_FILE_TYPE.
 * 5. Chat routing: PPTX/code documents split to the RAG text path (never
 *    vision), authorized like any other text document.
 * 6. Acceptance: an attached PPTX + a question reaches the (mocked) model as
 *    extracted slide text and yields a grounded answer — no "Document type
 *    is not supported" anywhere.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Buffer } from 'node:buffer';
import ExcelJS from 'exceljs';

const { getDbMock, tenantOpMock } = vi.hoisted(() => {
  const getDbMock = vi.fn();
  const tenantOpMock = vi.fn(async (_tenantId: string, cb: (db: any) => Promise<any>) => cb(await getDbMock()));
  return { getDbMock, tenantOpMock };
});
const { recordAudit } = vi.hoisted(() => ({ recordAudit: vi.fn() }));

vi.mock('../src/db/mongo.js', () => ({
  getDb: getDbMock,
  tenantOp: tenantOpMock,
}));
vi.mock('../src/audit/audit.js', () => ({ recordAudit }));

import { Errors } from '../src/errors.js';
import {
  PPTX_MIME_TYPE,
  detectMimeType,
  isCodeFile,
} from '../src/documents/fileValidation.js';
import { extractDocument } from '../src/documents/extraction.js';
import { chunkSections } from '../src/documents/ingestion.js';
import { wrapRetrievedContext } from '../src/chat/systemPrompt.js';
import { buildSystemPrompt } from '../src/chat/systemPrompt.js';
import { runAgenticLoop, type AgenticLoopOptions } from '../src/chat/agenticLoop.js';
import type { GatewayEvent } from '../src/ai/gateway/gateway.js';
import type { AuthContext } from '../src/authz/permissions.js';
import type { ApprovedModel } from '../src/ai/gateway/modelRegistry.js';
import type { ChatMessage } from '../src/ai/providers/types.js';

const enc = new TextEncoder();

function expectThrowCode(fn: () => unknown, code: string) {
  try {
    fn();
  } catch (error) {
    expect(error).toMatchObject({ code });
    return;
  }
  throw new Error(`expected throw with code ${code}`);
}

async function expectThrowCodeAsync(fn: () => Promise<unknown>, code: string) {
  try {
    await fn();
  } catch (error) {
    expect(error).toMatchObject({ code });
    return;
  }
  throw new Error(`expected throw with code ${code}`);
}

/* ------------------------------------------------------------------ */
/* Fixtures: minimal but byte-valid documents                          */
/* ------------------------------------------------------------------ */

const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n += 1) {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  CRC_TABLE[n] = c;
}
function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (const byte of data) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * Minimal stored (uncompressed) ZIP builder — deterministic, no new
 * dependencies. Enough for the OOXML fixtures below.
 */
function storedZip(entries: Array<[string, Uint8Array]>): Uint8Array {
  const chunks: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, data] of entries) {
    const nameBytes = enc.encode(name);
    const crc = crc32(data);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(8, 0, true); // stored
    local.setUint32(14, crc, true);
    local.setUint32(18, data.length, true);
    local.setUint32(22, data.length, true);
    local.setUint16(26, nameBytes.length, true);
    chunks.push(Buffer.from(local.buffer), Buffer.from(nameBytes), Buffer.from(data));
    const dir = new DataView(new ArrayBuffer(46));
    dir.setUint32(0, 0x02014b50, true);
    dir.setUint16(28, nameBytes.length, true);
    dir.setUint32(20, data.length, true);
    dir.setUint32(24, data.length, true);
    dir.setUint32(42, offset, true);
    central.push(Buffer.from(dir.buffer), Buffer.from(nameBytes));
    offset += 30 + nameBytes.length + data.length;
  }
  const centralStart = offset;
  const centralSize = central.reduce((sum, part) => sum + part.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, entries.length, true);
  end.setUint16(10, entries.length, true);
  end.setUint32(12, centralSize, true);
  end.setUint32(16, centralStart, true);
  return new Uint8Array(Buffer.concat([...chunks, ...central, Buffer.from(end.buffer)]));
}

const OFFICE_RELS =
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
  '</Relationships>';

function pdfBytes(): Uint8Array {
  return enc.encode(
    '%PDF-1.4\n' +
      '1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n' +
      '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n' +
      '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj\n' +
      '4 0 obj<</Length 44>>stream\n' +
      'BT /F1 24 Tf 100 700 Td (Hello PDF audit) Tj ET\n' +
      'endstream\n' +
      'endobj\n' +
      '5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj\n' +
      'trailer<</Root 1 0 R>>\n'
  );
}

function docxBytes(): Uint8Array {
  return storedZip([
    ['[Content_Types].xml', enc.encode('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>')],
    ['_rels/.rels', enc.encode(OFFICE_RELS)],
    ['word/document.xml', enc.encode('<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Docx audit text</w:t></w:r></w:p></w:body></w:document>')],
  ]);
}

async function xlsxBytes(): Promise<Uint8Array> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Sheet1');
  sheet.addRow(['Xlsx', 'audit', 'text']);
  const buffer = await workbook.xlsx.writeBuffer();
  return new Uint8Array(buffer);
}

function slideXml(text: string): Uint8Array {
  return enc.encode(
    `<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">` +
      `<p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>${text}</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`
  );
}

function pptxBytes(): Uint8Array {
  return storedZip([
    ['[Content_Types].xml', enc.encode('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/></Types>')],
    // Deliberately out of order: extraction must sort numerically.
    ['ppt/slides/slide10.xml', slideXml('Tenth slide audit')],
    ['ppt/slides/slide1.xml', slideXml('Slide one audit text')],
    ['ppt/slides/slide2.xml', slideXml('Second slide audit')],
  ]);
}

/** A .docx renamed to .pptx: valid ZIP, wrong OOXML content type. */
function renamedDocxAsPptx(): Uint8Array {
  return docxBytes();
}

/* ------------------------------------------------------------------ */
/* 1. Audit: every allowlisted text format genuinely extracts           */
/* ------------------------------------------------------------------ */

describe('format audit — allowlisted formats extract end to end', () => {
  it.each([
    { ext: '.pdf', mime: 'application/pdf', marker: 'Hello PDF audit', bytes: () => pdfBytes() },
    { ext: '.docx', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', marker: 'Docx audit text', bytes: () => docxBytes() },
    { ext: '.pptx', mime: PPTX_MIME_TYPE, marker: 'Slide one audit text', bytes: () => pptxBytes() },
    { ext: '.csv', mime: 'text/csv', marker: 'part-1,12', bytes: () => enc.encode('sku,qty\npart-1,12\npart-2,7\n') },
    { ext: '.txt', mime: 'text/plain', marker: 'plain text audit', bytes: () => enc.encode('plain text audit\nsecond line') },
    { ext: '.md', mime: 'text/markdown', marker: '# Audit', bytes: () => enc.encode('# Audit\n\nSome *markdown* content.') },
    { ext: '.html', mime: 'text/html', marker: 'Approved content', bytes: () => enc.encode('<h1>Policy</h1><p>Approved content</p><script>stealSecrets()</script>') },
  ])('$ext validates, extracts, and chunks to real text', async ({ ext, mime, marker, bytes }) => {
    const data = bytes();
    // Upload gate: no "Document type is not supported".
    expect(detectMimeType(`audit${ext}`, data)).toBe(mime);
    // Extraction yields the real text (not empty, not an error).
    const sections = await extractDocument(data, mime);
    expect(sections.length).toBeGreaterThan(0);
    expect(sections.map((section) => section.text).join('\n')).toContain(marker);
    // And it survives chunking for the RAG pipeline.
    const chunks = chunkSections(sections);
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.map((chunk) => chunk.text).join('\n')).toContain(marker);
  });

  it('xlsx validates and extracts cell text', async () => {
    const data = await xlsxBytes();
    const mime = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    expect(detectMimeType('audit.xlsx', data)).toBe(mime);
    const sections = await extractDocument(data, mime);
    expect(sections.map((section) => section.text).join('\n')).toContain('Xlsx');
  });
});

/* ------------------------------------------------------------------ */
/* 2. PPTX specifics                                                    */
/* ------------------------------------------------------------------ */

describe('pptx validation and extraction', () => {
  it('accepts a real presentation by ZIP magic bytes', () => {
    expect(detectMimeType('deck.pptx', pptxBytes())).toBe(PPTX_MIME_TYPE);
    expect(detectMimeType('DECK.PPTX', pptxBytes())).toBe(PPTX_MIME_TYPE);
  });

  it('rejects non-ZIP bytes claiming to be a presentation', () => {
    expectThrowCode(() => detectMimeType('deck.pptx', enc.encode('not a zip at all')), 'FILE_SIGNATURE_MISMATCH');
  });

  it('extracts one section per slide, in numeric order, with stable locations', async () => {
    const sections = await extractDocument(pptxBytes(), PPTX_MIME_TYPE);
    expect(sections).toHaveLength(3);
    expect(sections[0]).toMatchObject({ text: 'Slide one audit text', section: 'Slide 1', sourceLocation: 'slide:1' });
    expect(sections[1]).toMatchObject({ text: 'Second slide audit', section: 'Slide 2', sourceLocation: 'slide:2' });
    expect(sections[2]).toMatchObject({ text: 'Tenth slide audit', section: 'Slide 10', sourceLocation: 'slide:10' });
  });

  it('rejects a renamed .docx via OOXML content types (not just the extension)', async () => {
    // Upload gate only checks the PK magic — the content-type check happens
    // at extraction, where a renamed docx must fail loudly, never extract
    // as if it were a deck.
    expect(detectMimeType('renamed.pptx', renamedDocxAsPptx())).toBe(PPTX_MIME_TYPE);
    await expectThrowCodeAsync(() => extractDocument(renamedDocxAsPptx(), PPTX_MIME_TYPE), 'EXTRACTION_FAILED');
  });

  it('fails closed on a malformed archive', async () => {
    const truncated = pptxBytes().slice(0, 40);
    await expectThrowCodeAsync(() => extractDocument(truncated, PPTX_MIME_TYPE), 'INVALID_ARCHIVE');
  });
});

/* ------------------------------------------------------------------ */
/* 3. Code files: accepted as inert text, binaries rejected             */
/* ------------------------------------------------------------------ */

describe('code files', () => {
  const codeSample = 'def plan(demand):\n    return mrp_run(demand)  # SyteLine helper\n';

  it.each([
    '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.java', '.cs',
    '.cpp', '.c', '.h', '.hpp', '.go', '.rs', '.rb', '.php', '.swift',
    '.kt', '.scala', '.sql', '.json', '.jsonl', '.yaml', '.yml', '.toml',
    '.xml', '.css', '.scss', '.log', '.sh', '.bash', '.ps1', '.bat',
    '.cmd', '.pl', '.lua', '.dart', '.r', '.vue', '.svelte',
  ])('accepts %s as inert plain text', (ext) => {
    const bytes = enc.encode(codeSample);
    expect(isCodeFile(`snippet${ext}`)).toBe(true);
    expect(detectMimeType(`snippet${ext}`, bytes)).toBe('text/plain');
  });

  it.each(['Dockerfile', 'Makefile', 'gitignore', '.env'])('accepts extensionless %s as text', (name) => {
    expect(isCodeFile(name)).toBe(true);
    expect(detectMimeType(name, enc.encode(codeSample))).toBe('text/plain');
  });

  it('matches extensions case-insensitively', () => {
    expect(detectMimeType('App.PY', enc.encode('print("hi")'))).toBe('text/plain');
  });

  it('extracts source verbatim for the model to read', async () => {
    const source = 'SELECT item, qty FROM inventory WHERE qty < reorder_point;\n';
    const sections = await extractDocument(enc.encode(source), detectMimeType('reorder.sql', enc.encode(source)));
    expect(sections).toEqual([{ text: source, sourceLocation: 'document' }]);
  });

  it('rejects a binary masquerading as a .py file (NUL bytes)', () => {
    const mz = Uint8Array.from([0x4d, 0x5a, 0x90, 0x00, ...enc.encode('evil'), 0x00, 0x01, 0x02]);
    expectThrowCode(() => detectMimeType('payload.py', mz), 'BINARY_TEXT_FILE');
  });

  it('rejects a binary masquerading as a .js file (high control-char ratio)', () => {
    const binary = new Uint8Array(200).map((_, i) => (i % 3 === 0 ? 0x01 : 0x41));
    expectThrowCode(() => detectMimeType('payload.js', binary), 'BINARY_TEXT_FILE');
  });

  it('rejects invalid UTF-8 claiming to be a .ts file', () => {
    expectThrowCode(() => detectMimeType('payload.ts', Uint8Array.from([0xff, 0xfe, 0x00, 0x41])), 'BINARY_TEXT_FILE');
  });

  it('still accepts real scripts with shebangs and unicode', () => {
    const script = '#!/usr/bin/env bash\n# déploiement — café\n echo "ok"\n';
    expect(detectMimeType('deploy.sh', enc.encode(script))).toBe('text/plain');
  });
});

/* ------------------------------------------------------------------ */
/* 4. Executables and installers stay rejected                          */
/* ------------------------------------------------------------------ */

describe('executables stay rejected', () => {
  it.each(['.exe', '.dll', '.msi', '.com', '.scr', '.sys', '.so', '.dylib'])(
    'rejects %s with UNSUPPORTED_FILE_TYPE',
    (ext) => {
      const mz = Uint8Array.from([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00]);
      expect(isCodeFile(`setup${ext}`)).toBe(false);
      expectThrowCode(() => detectMimeType(`setup${ext}`, mz), 'UNSUPPORTED_FILE_TYPE');
    }
  );
});

/* ------------------------------------------------------------------ */
/* 5. CSV genuinely works end to end                                    */
/* ------------------------------------------------------------------ */

describe('csv round-trip', () => {
  it('preserves rows through validation and extraction', async () => {
    const csv = 'order,item,qty\nINTGPT0040,00313-02,10\nINTGPT0041,00400-01,4\n';
    const bytes = enc.encode(csv);
    const mime = detectMimeType('orders.csv', bytes);
    expect(mime).toBe('text/csv');
    const sections = await extractDocument(bytes, mime);
    expect(sections).toHaveLength(1);
    expect(sections[0]!.text).toBe(csv);
    expect(sections[0]!.text).toContain('INTGPT0040');
  });
});

/* ------------------------------------------------------------------ */
/* 6. Chat routing: PPTX/code docs stay on the RAG text path            */
/* ------------------------------------------------------------------ */

describe('resolveChatDocuments routes pptx/code docs to the text path', () => {
  const auth = {
    userId: 'u1',
    tenantId: 't1',
    roleId: 'r1',
    clearance: 'INTERNAL',
  } as unknown as AuthContext;

  function docMatchesFilter(doc: any, filter: any): boolean {
    if (filter._id?.$in && !filter._id.$in.includes(doc._id)) return false;
    if (filter.status && doc.status !== filter.status) return false;
    if ('deletedAt' in filter && filter.deletedAt === null && doc.deletedAt !== null) return false;
    if (filter.classification?.$in && !filter.classification.$in.includes(doc.classification)) return false;
    if (Array.isArray(filter.$or)) {
      const ok = filter.$or.some((clause: any) => {
        if (clause.ownerId) return doc.ownerId === clause.ownerId;
        if (clause._id?.$in) return clause._id.$in.includes(doc._id);
        return false;
      });
      if (!ok) return false;
    }
    return true;
  }

  function mockDocCollections(docs: any[]) {
    getDbMock.mockResolvedValue({
      collection: (name: string) => {
        if (name === 'document_permissions') return { find: () => ({ toArray: async () => [] }) };
        if (name === 'documents') {
          return {
            find: (filter: any) => ({
              toArray: async () => docs.filter((doc) => docMatchesFilter(doc, filter)),
            }),
          };
        }
        if (name === 'department_memberships' || name === 'security_group_memberships') {
          return { find: () => ({ toArray: async () => [] }) };
        }
        throw new Error(`unexpected collection ${name}`);
      },
    });
  }

  function textDoc(overrides: Record<string, any> = {}) {
    return {
      _id: 'doc-1',
      filename: 'roadmap.pptx',
      mimeType: PPTX_MIME_TYPE,
      sizeBytes: 2048,
      objectKey: 'tenant/t1/doc-1',
      classification: 'INTERNAL',
      ownerId: 'u1',
      status: 'READY',
      deletedAt: null,
      ...overrides,
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('splits pptx and code documents to textDocumentIds (never vision)', async () => {
    mockDocCollections([
      textDoc(),
      textDoc({ _id: 'doc-2', filename: 'reorder.sql', mimeType: 'text/plain' }),
    ]);
    const { resolveChatDocuments } = await import('../src/chat/imageAttachments.js');
    const { images, textDocumentIds } = await resolveChatDocuments(auth, ['doc-1', 'doc-2'], {
      storage: { get: vi.fn() },
    });
    expect(images).toEqual([]);
    expect(textDocumentIds).toEqual(['doc-1', 'doc-2']);
  });
});

/* ------------------------------------------------------------------ */
/* 7. Acceptance: attached PPTX + question reaches the model as text    */
/* ------------------------------------------------------------------ */

describe('acceptance: PPTX attachment chat turn', () => {
  const baseAuth = { userId: 'u1', tenantId: 't1', roleId: 'r1' } as unknown as AuthContext;
  const textModel = {
    id: 'text-model-id',
    name: 'llama3.1:8b',
    contextWindow: 32768,
    version: '1.0',
  } as unknown as ApprovedModel;

  /**
   * What a real chat model says about the deck: the canned answer quotes
   * the extracted slide text. The mock stands in for llama3.1:8b (REQUIRES
   * REAL INFRASTRUCTURE); the test proves the turn's plumbing — extracted
   * slide text in, grounded answer out — rather than the model's weights.
   */
  const ANSWER_CHUNKS = [
    'Based on the attached deck: slide 1 covers "Slide one audit text", ',
    'slide 2 covers "Second slide audit". The key dates are on the later slides.',
  ];

  function scriptedGateway(seenInputs: any[]) {
    return async (input: any) => {
      seenInputs.push(input);
      return {
        model: textModel,
        telemetry: {},
        events: (async function* (): AsyncGenerator<GatewayEvent> {
          for (const content of ANSWER_CHUNKS) yield { type: 'text', content };
        })(),
      };
    };
  }

  function collectingSink() {
    const log = { texts: [] as string[], dones: [] as any[], errors: [] as any[] };
    return {
      log,
      sink: {
        text: async (delta: string) => {
          log.texts.push(delta);
          return true;
        },
        plan: async () => true,
        toolCalls: async () => true,
        failover: async () => true,
        done: async (payload: any) => {
          log.dones.push(payload);
          return true;
        },
        error: async (code: string, message: string) => {
          log.errors.push({ code, message });
        },
      },
    };
  }

  it('an attached PPTX reaches the model as extracted slide text and yields a grounded answer', async () => {
    // The upload gate accepts the PPTX: no "Document type is not supported".
    const deck = pptxBytes();
    expect(detectMimeType('roadmap.pptx', deck)).toBe(PPTX_MIME_TYPE);

    // The ingestion pipeline extracts real slide text.
    const sections = await extractDocument(deck, PPTX_MIME_TYPE);
    expect(sections.length).toBeGreaterThan(0);

    // The chat route wraps retrieved document text as Zone-3 context before
    // the user turn — reproduce that exact construction here.
    const context = sections.map((section) => `[${section.section}] ${section.text}`).join('\n');
    const messages: ChatMessage[] = [
      { role: 'user', content: wrapRetrievedContext(context) },
      { role: 'user', content: 'Summarize the key dates in this deck.' },
    ];

    const seenInputs: any[] = [];
    const { sink, log } = collectingSink();
    const result = await runAgenticLoop({
      tenantId: 't1',
      userId: 'u1',
      roleId: 'r1',
      classification: 'INTERNAL',
      auth: baseAuth,
      initialModel: textModel,
      buildSystemPrompt: (name, version) => buildSystemPrompt({ modelName: name, modelVersion: version }),
      providerTools: [],
      messages,
      signal: new AbortController().signal,
      telemetry: {},
      maxIterations: 5,
      maxResponseChars: 100_000,
      streamGateway: scriptedGateway(seenInputs),
      sink,
    } as AgenticLoopOptions);

    // The extracted slide text reached the provider input intact.
    expect(seenInputs).toHaveLength(1);
    const outgoing = seenInputs[0].messages as ChatMessage[];
    const contextMessage = outgoing.find(
      (m) => m.role === 'user' && typeof m.content === 'string' && m.content.includes('Slide one audit text')
    );
    expect(contextMessage).toBeDefined();

    // The turn completed with a grounded answer — never an upload/validation
    // error, never a vision-model detour for a text document.
    expect(log.errors).toEqual([]);
    expect(result.failed).toBe(false);
    expect(result.completed).toBe(true);
    expect(log.texts.join('')).toContain('Slide one audit text');
  });
});
