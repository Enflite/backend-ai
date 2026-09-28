/**
 * visionChat.test.ts — image attachments through the chat pipeline.
 *
 * Acceptance criterion (owner-defined): Jake attaches a JPG screenshot of a
 * SyteLine error to a chat, the AI views the image (no "Document type is
 * not supported" anywhere in the flow), and the turn produces a real
 * diagnostic answer about the error in the screenshot — duplicate-key
 * failure, the custom SSSFSUnit.JobBuild source, likely causes, and
 * troubleshooting steps.
 *
 * Coverage here (deterministic; provider boundary mocked):
 * 1. Upload validation accepts PNG/JPEG/GIF/WebP with valid magic bytes,
 *    rejects bad signatures, and still rejects executables with
 *    UNSUPPORTED_FILE_TYPE.
 * 2. Image dimension parsing from container headers (never the extension).
 * 3. Extraction is a no-op for images (no text, no chunks downstream).
 * 4. Provider mappings: Ollama `images: [base64]`; OpenAI-compatible
 *    content-parts with `image_url` data URLs.
 * 5. Vision model resolution never falls back to the text chat default.
 * 6. Authorized image loading (tenant/owner/grant/ready/classification,
 *    count + byte caps, oversize fails closed).
 * 7. The acceptance turn: a chat turn carrying the error screenshot reaches
 *    the (mocked) vision provider with the image payload and yields a
 *    substantive diagnostic answer — not an upload/validation error.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Buffer } from 'node:buffer';

const { getDbMock, tenantOpMock } = vi.hoisted(() => {
  const getDbMock = vi.fn();
  const tenantOpMock = vi.fn(async (_tenantId: string, cb: (db: any) => Promise<any>) => cb(await getDbMock()));
  return { getDbMock, tenantOpMock };
});
const { recordAudit } = vi.hoisted(() => ({ recordAudit: vi.fn() }));
const { resolveServingModelMock } = vi.hoisted(() => ({ resolveServingModelMock: vi.fn() }));

vi.mock('../src/db/mongo.js', () => ({
  getDb: getDbMock,
  tenantOp: tenantOpMock,
}));
vi.mock('../src/audit/audit.js', () => ({ recordAudit }));
vi.mock('../src/ai/gateway/modelLifecycle.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/ai/gateway/modelLifecycle.js')>();
  return { ...original, resolveServingModel: resolveServingModelMock };
});

import { Errors } from '../src/errors.js';
import { detectMimeType, isImageExtension, isImageMimeType } from '../src/documents/fileValidation.js';
import { extractDocument } from '../src/documents/extraction.js';
import { parseImageDimensions } from '../src/documents/imageMeta.js';
import { buildSystemPrompt } from '../src/chat/systemPrompt.js';
import { estimateMessagesTokens } from '../src/ai/gateway/gateway.js';
import { OllamaProvider } from '../src/ai/providers/ollama.js';
import { OpenAICompatibleProvider } from '../src/ai/providers/openaiCompatible.js';
import type { ChatMessage, StreamChatOptions } from '../src/ai/providers/types.js';
import {
  VISION_MODEL_NAME,
  VISION_MODEL_OLLAMA_TAG,
  ensureVisionModel,
  isVisionCapableModel,
  isVisionDefaultModelDoc,
} from '../src/ai/gateway/modelRegistry.js';
import { runAgenticLoop, type AgenticLoopOptions } from '../src/chat/agenticLoop.js';
import type { GatewayEvent } from '../src/ai/gateway/gateway.js';
import type { AuthContext } from '../src/authz/permissions.js';
import type { ApprovedModel } from '../src/ai/gateway/modelRegistry.js';

/* ------------------------------------------------------------------ */
/* Fixtures: minimal but byte-valid image files                        */
/* ------------------------------------------------------------------ */

/** Minimal valid JPEG: SOI, APP0, and a SOF0 declaring 4x3. */
function jpegBytes(): Uint8Array {
  return Uint8Array.from([
    0xff, 0xd8, 0xff, 0xe0, 0x00, 0x08, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01,
    0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x03, 0x00, 0x04, 0x01, 0x01, 0x11, 0x00,
    0xff, 0xd9,
  ]);
}

/** Minimal valid PNG: signature + IHDR declaring 2x1. */
function pngBytes(): Uint8Array {
  return Uint8Array.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x00, 0x02, 0x00, 0x00, 0x00, 0x01,
    0x08, 0x02, 0x00, 0x00, 0x00,
  ]);
}

/** Minimal valid GIF89a: logical screen descriptor 7x5. */
function gifBytes(): Uint8Array {
  return Uint8Array.from([
    0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x07, 0x00, 0x05, 0x00, 0x00, 0x00, 0x00,
  ]);
}

/** Minimal valid lossy WebP (VP8 ): 14-bit width 9, height 6. */
function webpBytes(): Uint8Array {
  const bytes = new Uint8Array(30);
  bytes.set([0x52, 0x49, 0x46, 0x46, 0x12, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50], 0);
  bytes.set([0x56, 0x50, 0x38, 0x20], 12); // 'VP8 '
  bytes[26] = 9;
  bytes[28] = 6;
  return bytes;
}

function expectThrowCode(fn: () => unknown, code: string): void {
  try {
    fn();
  } catch (error) {
    expect(error).toMatchObject({ code });
    return;
  }
  throw new Error(`expected throw with code ${code}, but nothing threw`);
}

beforeEach(() => {
  vi.clearAllMocks();
  recordAudit.mockResolvedValue(undefined);
});

/* ------------------------------------------------------------------ */
/* 1. Upload validation: the exact gate the owner hit                   */
/* ------------------------------------------------------------------ */

describe('image file validation', () => {
  it('accepts a JPG error screenshot with a valid JPEG signature (no UNSUPPORTED_FILE_TYPE)', () => {
    // This is the owner's failing case: a JPG screenshot of a SyteLine error.
    expect(detectMimeType('syteline-error.jpg', jpegBytes())).toBe('image/jpeg');
    expect(detectMimeType('syteline-error.JPEG', jpegBytes())).toBe('image/jpeg');
  });

  it('accepts PNG, GIF, and WebP with valid magic bytes', () => {
    expect(detectMimeType('diagram.png', pngBytes())).toBe('image/png');
    expect(detectMimeType('anim.gif', gifBytes())).toBe('image/gif');
    expect(detectMimeType('photo.webp', webpBytes())).toBe('image/webp');
  });

  it('rejects image bytes with invalid signatures (FILE_SIGNATURE_MISMATCH)', () => {
    expectThrowCode(() => detectMimeType('evil.png', Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9])), 'FILE_SIGNATURE_MISMATCH');
    // Text bytes renamed to .jpg: not a JPEG.
    expectThrowCode(
      () => detectMimeType('notes.jpg', new TextEncoder().encode('not a jpeg at all')),
      'FILE_SIGNATURE_MISMATCH'
    );
    // Truncated WebP (RIFF present, WEBP tag missing).
    expectThrowCode(
      () => detectMimeType('cut.webp', Uint8Array.from([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0, 0, 0, 0])),
      'FILE_SIGNATURE_MISMATCH'
    );
  });

  it('still rejects executables and unknown binaries (UNSUPPORTED_FILE_TYPE)', () => {
    const mz = Uint8Array.from([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00]);
    expectThrowCode(() => detectMimeType('setup.exe', mz), 'UNSUPPORTED_FILE_TYPE');
    expectThrowCode(() => detectMimeType('payload.bin', mz), 'UNSUPPORTED_FILE_TYPE');
    expectThrowCode(() => detectMimeType('run.sh', new TextEncoder().encode('#!/bin/sh\necho hi')), 'UNSUPPORTED_FILE_TYPE');
  });

  it('classifies image MIME types and extensions', () => {
    expect(isImageMimeType('image/jpeg')).toBe(true);
    expect(isImageMimeType('image/png')).toBe(true);
    expect(isImageMimeType('application/pdf')).toBe(false);
    expect(isImageMimeType('text/plain')).toBe(false);
    expect(isImageExtension('shot.PNG')).toBe(true);
    expect(isImageExtension('doc.pdf')).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* 2. Dimension parsing from container headers                         */
/* ------------------------------------------------------------------ */

describe('image dimension parsing', () => {
  it('reads PNG dimensions from IHDR', () => {
    expect(parseImageDimensions('image/png', pngBytes())).toEqual({ width: 2, height: 1 });
  });

  it('reads JPEG dimensions by walking to SOF0', () => {
    expect(parseImageDimensions('image/jpeg', jpegBytes())).toEqual({ width: 4, height: 3 });
  });

  it('reads GIF dimensions from the logical screen descriptor', () => {
    expect(parseImageDimensions('image/gif', gifBytes())).toEqual({ width: 7, height: 5 });
  });

  it('reads lossy WebP dimensions from the VP8 frame header', () => {
    expect(parseImageDimensions('image/webp', webpBytes())).toEqual({ width: 9, height: 6 });
  });

  it('returns null (never throws) for truncated or corrupt bytes', () => {
    expect(parseImageDimensions('image/png', pngBytes().slice(0, 10))).toBeNull();
    expect(parseImageDimensions('image/jpeg', Uint8Array.from([0xff, 0xd8]))).toBeNull();
    expect(parseImageDimensions('image/gif', new Uint8Array(0))).toBeNull();
    expect(parseImageDimensions('application/pdf', pngBytes())).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* 3. Extraction is a no-op for images                                 */
/* ------------------------------------------------------------------ */

describe('image extraction', () => {
  it('returns no sections for images: nothing to chunk or embed', async () => {
    await expect(extractDocument(jpegBytes(), 'image/jpeg')).resolves.toEqual([]);
    await expect(extractDocument(pngBytes(), 'image/png')).resolves.toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* 4. Provider mappings                                                */
/* ------------------------------------------------------------------ */

const originalFetch = globalThis.fetch;

function chatOptions(overrides: Partial<StreamChatOptions> = {}): StreamChatOptions {
  return {
    endpoint: 'http://localhost:11434',
    model: VISION_MODEL_OLLAMA_TAG,
    messages: [{ role: 'user', content: 'What error is shown?' }],
    ...overrides,
  };
}

describe('provider image mappings', () => {
  beforeEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('Ollama maps image attachments to the images array (base64, no data-URL prefix)', async () => {
    const ndjson = [
      JSON.stringify({ message: { role: 'assistant', content: 'ok' }, done: true }),
    ].join('\n');
    globalThis.fetch = vi.fn().mockResolvedValue(new Response(ndjson, { status: 200 })) as never;
    const provider = new OllamaProvider({
      endpoint: 'http://localhost:11434',
      defaultTimeoutMs: 5000,
      embeddingModel: 'nomic-embed-text',
      embeddingDimensions: 2,
    });
    const messages: ChatMessage[] = [
      {
        role: 'user',
        content: 'What error is shown?',
        images: [{ data: 'QUJD', mimeType: 'image/jpeg' }],
      },
    ];
    for await (const _event of provider.streamChat(chatOptions({ messages }))) {
      // drain
    }
    const request = (globalThis.fetch as any).mock.calls[0][1];
    const body = JSON.parse(request.body);
    expect(body.messages[0]).toMatchObject({ role: 'user', content: 'What error is shown?' });
    expect(body.messages[0].images).toEqual(['QUJD']);
  });

  it('Ollama omits the images key for text-only messages', async () => {
    const ndjson = [JSON.stringify({ message: { role: 'assistant', content: 'ok' }, done: true })].join('\n');
    globalThis.fetch = vi.fn().mockResolvedValue(new Response(ndjson, { status: 200 })) as never;
    const provider = new OllamaProvider({
      endpoint: 'http://localhost:11434',
      defaultTimeoutMs: 5000,
      embeddingModel: 'nomic-embed-text',
      embeddingDimensions: 2,
    });
    for await (const _event of provider.streamChat(chatOptions())) {
      // drain
    }
    const request = (globalThis.fetch as any).mock.calls[0][1];
    expect(JSON.parse(request.body).messages[0]).not.toHaveProperty('images');
  });

  it('OpenAI-compatible maps images to content parts with image_url data URLs', async () => {
    const sse = 'data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n';
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(sse, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
    ) as never;
    const provider = new OpenAICompatibleProvider({ endpoint: 'http://vllm.test/v1', defaultTimeoutMs: 5000 });
    const messages: ChatMessage[] = [
      {
        role: 'user',
        content: 'What error is shown?',
        images: [
          { data: 'QUJD', mimeType: 'image/jpeg' },
          { data: 'RUZH', mimeType: 'image/png' },
        ],
      },
    ];
    for await (const _event of provider.streamChat(chatOptions({ endpoint: 'http://vllm.test/v1', messages }))) {
      // drain
    }
    const request = (globalThis.fetch as any).mock.calls[0][1];
    const body = JSON.parse(request.body);
    const content = body.messages[0].content;
    expect(content).toEqual([
      { type: 'text', text: 'What error is shown?' },
      { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,QUJD' } },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,RUZH' } },
    ]);
    expect(body.messages[0]).not.toHaveProperty('images');
  });
});

/* ------------------------------------------------------------------ */
/* 5. Vision model resolution: never the text default                  */
/* ------------------------------------------------------------------ */

function servableVisionDoc(overrides: Record<string, any> = {}) {
  return {
    _id: 'vision-model-id',
    name: VISION_MODEL_NAME,
    version: '1.0',
    provider: 'ollama',
    endpoint: 'http://ollama:11434',
    modelIdentifier: VISION_MODEL_OLLAMA_TAG,
    status: 'ACTIVE',
    license: 'apache-2.0',
    source: 'qwen',
    sha256: null,
    contextWindow: 32768,
    capabilities: { chat: true, streaming: true, vision: true },
    classification: 'INTERNAL',
    allowedClassifications: ['PUBLIC', 'INTERNAL'],
    deployment: {},
    requestTimeoutMs: null,
    maxTokens: null,
    temperature: null,
    fallbackModelId: null,
    lifecycleUpdatedAt: new Date(),
    approvedBy: null,
    approvedAt: null,
    lastEvalRunId: null,
    createdAt: new Date(),
    enabled: true,
    ...overrides,
  };
}

/** Minimal in-memory mongo stand-in for the models + model_access collections. */
function mockModelCollections(modelDocs: any[]) {
  const models = {
    findOne: vi.fn(async (filter: any) => {
      return (
        modelDocs.find((doc) => {
          if (filter._id && doc._id !== filter._id) return false;
          if (filter.name && doc.name !== filter.name) return false;
          if (filter.isVisionDefault === true && doc.isVisionDefault !== true) return false;
          if (filter['capabilities.vision'] === true && doc.capabilities?.vision !== true) return false;
          if (filter.status?.$in && !filter.status.$in.includes(doc.status)) return false;
          if (filter.enabled === true && doc.enabled !== true) return false;
          return true;
        }) ?? null
      );
    }),
    updateOne: vi.fn(async (filter: any, update: any) => {
      const doc = modelDocs.find((d) => d._id === filter._id);
      if (doc) Object.assign(doc, update.$set);
      return { modifiedCount: doc ? 1 : 0 };
    }),
    insertOne: vi.fn(async (doc: any) => {
      modelDocs.push({ ...doc });
      return { insertedId: doc._id };
    }),
  };
  const modelAccess = {
    findOne: vi.fn(async (): Promise<any> => null),
    find: vi.fn(() => ({ toArray: vi.fn(async (): Promise<any[]> => []) })),
  };
  const emptyCollection = {
    findOne: vi.fn(async () => null),
    find: vi.fn(() => ({ toArray: vi.fn(async () => []) })),
  };
  getDbMock.mockResolvedValue({
    collection: (name: string) => {
      if (name === 'models') return models;
      if (name === 'model_access') return modelAccess;
      return emptyCollection;
    },
  });
  return { models, modelAccess };
}

describe('vision model registry', () => {
  it('exposes the canonical vision model name and Ollama tag', () => {
    expect(VISION_MODEL_NAME).toBe('qwen/Qwen2.5-VL-7B-Instruct');
    expect(VISION_MODEL_OLLAMA_TAG).toBe('qwen2.5vl:7b');
  });

  it('recognizes vision default docs and vision-capable models', () => {
    expect(isVisionDefaultModelDoc({ name: VISION_MODEL_NAME })).toBe(true);
    expect(isVisionDefaultModelDoc({ name: 'x', isVisionDefault: true })).toBe(true);
    expect(isVisionDefaultModelDoc({ name: 'meta-llama/Meta-Llama-3.1-8B-Instruct' })).toBe(false);
    expect(isVisionCapableModel({ capabilities: { chat: true, vision: true } })).toBe(true);
    expect(isVisionCapableModel({ capabilities: { chat: true } })).toBe(false);
    expect(isVisionCapableModel({})).toBe(false);
  });

  it('ensureVisionModel seeds the platform vision model when none exists', async () => {
    const { models } = mockModelCollections([]);
    const ensured = await ensureVisionModel();
    expect(models.insertOne).toHaveBeenCalledTimes(1);
    const seed = models.insertOne.mock.calls[0]![0];
    expect(seed).toMatchObject({
      name: VISION_MODEL_NAME,
      modelIdentifier: VISION_MODEL_OLLAMA_TAG,
      provider: 'ollama',
      status: 'ACTIVE',
      isVisionDefault: true,
    });
    expect(seed.capabilities).toMatchObject({ vision: true, chat: true, streaming: true });
    expect(ensured).toMatchObject({ name: VISION_MODEL_NAME, id: seed._id });
    expect(ensured).not.toHaveProperty('isVisionDefault');
  });

  it('ensureVisionModel returns the existing servable vision model without seeding', async () => {
    const existing = servableVisionDoc({ isVisionDefault: true });
    const { models } = mockModelCollections([existing]);
    const ensured = await ensureVisionModel();
    expect(models.insertOne).not.toHaveBeenCalled();
    expect(ensured).toMatchObject({ id: existing._id, name: VISION_MODEL_NAME });
  });

  it('ensureVisionModel does not resurrect an admin-disabled vision model', async () => {
    const disabled = servableVisionDoc({ status: 'DEPRECATED', enabled: false });
    const { models } = mockModelCollections([disabled]);
    const ensured = await ensureVisionModel();
    expect(ensured).toBeNull();
    expect(models.insertOne).not.toHaveBeenCalled();
  });
});

/* ------------------------------------------------------------------ */
/* 6. Vision capability resolution                                     */
/* ------------------------------------------------------------------ */

describe('vision capability resolution', () => {
  beforeEach(() => {
    resolveServingModelMock.mockReset();
  });

  it("resolveCapabilityModel('vision') uses the admin vision default without chat fallback", async () => {
    const { resolveCapabilityModel, resolveVisionModel } = await import('../src/ai/gateway/capabilityRouter.js');
    const adminVision = { id: 'admin-vision-id', name: 'custom-vision', capabilities: { vision: true } } as unknown as ApprovedModel;
    resolveServingModelMock.mockResolvedValue(adminVision);

    const resolution = await resolveCapabilityModel({ tenantId: 't1', userId: 'u1', roleId: 'r1', capability: 'vision' });
    expect(resolveServingModelMock).toHaveBeenCalledWith('t1', 'u1', 'r1', 'vision');
    expect(resolution.requested).toBe('vision');
    expect(resolution.resolved).toBe('vision');
    expect(resolution.fallbackUsed).toBe(false);
    expect(resolution.model).toBe(adminVision);

    const direct = await resolveVisionModel({ tenantId: 't1', userId: 'u1', roleId: 'r1' });
    expect(direct).toBe(adminVision);
  });

  it('a stale admin vision default falls through to the platform vision model (never the chat default)', async () => {
    const { resolveVisionModel } = await import('../src/ai/gateway/capabilityRouter.js');
    resolveServingModelMock.mockRejectedValue(Errors.forbidden('MODEL_NOT_APPROVED', 'stale vision default'));
    mockModelCollections([]);

    const model = await resolveVisionModel({ tenantId: 't1', userId: 'u1', roleId: 'r1' });
    expect(model.name).toBe(VISION_MODEL_NAME);
    expect(model.name).not.toBe('meta-llama/Meta-Llama-3.1-8B-Instruct');
    expect(isVisionCapableModel(model)).toBe(true);
  });

  it('a non-vision-capable admin vision default is refused — images never go to a text-only model', async () => {
    const { resolveVisionModel } = await import('../src/ai/gateway/capabilityRouter.js');
    const textDefault = {
      id: 'text-id',
      name: 'meta-llama/Meta-Llama-3.1-8B-Instruct',
      capabilities: { chat: true },
    } as unknown as ApprovedModel;
    resolveServingModelMock.mockResolvedValue(textDefault);
    mockModelCollections([]);

    const model = await resolveVisionModel({ tenantId: 't1', userId: 'u1', roleId: 'r1' });
    expect(model.name).toBe(VISION_MODEL_NAME);
    expect(isVisionCapableModel(model)).toBe(true);
    expect(recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'MODEL_CAPABILITY_FALLBACK', resourceId: 'text-id' })
    );
  });

  it('skips a text-only model flagged as the vision default — the ensure path never resurrects it for image turns', async () => {
    const { resolveVisionModel } = await import('../src/ai/gateway/capabilityRouter.js');
    resolveServingModelMock.mockResolvedValue(null);
    // An admin flagged a TEXT-ONLY model as the vision default. The ensure
    // path must not return it for an image turn; it seeds the canonical
    // vision model instead.
    const textOnlyFlagged = {
      _id: 'text-only-id',
      name: 'some-text-model',
      status: 'ACTIVE',
      enabled: true,
      isVisionDefault: true,
      capabilities: { chat: true },
    };
    mockModelCollections([textOnlyFlagged]);

    const model = await resolveVisionModel({ tenantId: 't1', userId: 'u1', roleId: 'r1' });
    expect(model.id).not.toBe('text-only-id');
    expect(model.name).toBe(VISION_MODEL_NAME);
    expect(isVisionCapableModel(model)).toBe(true);
  });

  it('fails closed (NO_APPROVED_MODEL) when the vision model was admin-disabled — no silent chat fallback', async () => {
    const { resolveVisionModel } = await import('../src/ai/gateway/capabilityRouter.js');
    resolveServingModelMock.mockResolvedValue(null);
    // Admin disabled the canonical vision doc: ensure must not resurrect it.
    mockModelCollections([servableVisionDoc({ status: 'DEPRECATED', enabled: false })]);

    await expect(resolveVisionModel({ tenantId: 't1', userId: 'u1', roleId: 'r1' })).rejects.toMatchObject({
      code: 'NO_APPROVED_MODEL',
    });
  });

  it('honors an explicit revocation of the vision model for the caller', async () => {
    const { resolveVisionModel } = await import('../src/ai/gateway/capabilityRouter.js');
    resolveServingModelMock.mockResolvedValue(null);
    const visionDoc = servableVisionDoc({ isVisionDefault: true });
    const { modelAccess } = mockModelCollections([visionDoc]);
    modelAccess.findOne.mockResolvedValue({ revoked: true });

    await expect(resolveVisionModel({ tenantId: 't1', userId: 'u1', roleId: 'r1' })).rejects.toMatchObject({
      code: 'MODEL_NOT_APPROVED',
    });
  });

  it('normalizeCapability accepts vision and still rejects unknown capabilities', async () => {
    const { normalizeCapability } = await import('../src/ai/gateway/capabilityRouter.js');
    expect(normalizeCapability('vision')).toBe('vision');
    expectThrowCode(() => normalizeCapability('telepathy'), 'INVALID_CAPABILITY');
  });
});

/* ------------------------------------------------------------------ */
/* 7. Authorized image loading for chat turns                          */
/* ------------------------------------------------------------------ */

describe('resolveChatDocuments', () => {
  const auth = {
    userId: 'u1',
    tenantId: 't1',
    roleId: 'r1',
    clearance: 'INTERNAL',
  } as unknown as AuthContext;

  /** Applies the authorization predicates resolveChatDocuments actually sends. */
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

  function mockDocCollections(grants: any[], docs: any[]) {
    const findToArray = (rows: any[]) => () => ({ toArray: vi.fn(async () => rows) });
    getDbMock.mockResolvedValue({
      collection: (name: string) => {
        if (name === 'document_permissions') return { find: findToArray(grants) };
        if (name === 'documents') {
          return {
            find: vi.fn((filter: any) => ({
              toArray: vi.fn(async () => docs.filter((doc) => docMatchesFilter(doc, filter))),
            })),
          };
        }
        if (name === 'department_memberships' || name === 'security_group_memberships') {
          return { find: findToArray([]) };
        }
        throw new Error(`unexpected collection ${name}`);
      },
    });
  }

  function imageDoc(overrides: Record<string, any> = {}) {
    return {
      _id: 'img-1',
      filename: 'syteline-error.jpg',
      mimeType: 'image/jpeg',
      sizeBytes: 1024,
      objectKey: 'tenant/t1/img-1',
      classification: 'INTERNAL',
      ownerId: 'u1',
      status: 'READY',
      deletedAt: null,
      ...overrides,
    };
  }

  function textDoc(overrides: Record<string, any> = {}) {
    return {
      _id: 'doc-2',
      filename: 'notes.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 2048,
      objectKey: 'tenant/t1/doc-2',
      classification: 'INTERNAL',
      ownerId: 'u1',
      status: 'READY',
      deletedAt: null,
      ...overrides,
    };
  }

  async function resolve(docs: any[], grants: any[] = [], storageGet = vi.fn(async () => jpegBytes())) {
    mockDocCollections(grants, docs);
    const { resolveChatDocuments } = await import('../src/chat/imageAttachments.js');
    return resolveChatDocuments(auth, docs.map((d) => d._id), { storage: { get: storageGet } });
  }

  it('loads an authorized READY image as base64 and splits text docs to RAG', async () => {
    const { images, textDocumentIds } = await resolve([imageDoc(), textDoc()]);
    expect(images).toHaveLength(1);
    expect(images[0]).toMatchObject({
      documentId: 'img-1',
      filename: 'syteline-error.jpg',
      mimeType: 'image/jpeg',
    });
    expect(images[0]!.image.data).toBe(Buffer.from(jpegBytes()).toString('base64'));
    expect(textDocumentIds).toEqual(['doc-2']);
  });

  it('does not treat non-image, non-READY, deleted, over-clearance, or unauthorized IDs as vision inputs', async () => {
    // These IDs are not authorized images, so none may become vision inputs.
    // They stay on the RAG text path, which enforces its own authorization —
    // the image split must never remove IDs from RAG.
    const ids = ['processing', 'deleted', 'secret', 'foreign'];
    const { images, textDocumentIds } = await resolve([
      imageDoc({ _id: 'processing', status: 'PROCESSING' }),
      imageDoc({ _id: 'deleted', deletedAt: new Date() }),
      imageDoc({ _id: 'secret', classification: 'CONFIDENTIAL' }),
      imageDoc({ _id: 'foreign', ownerId: 'someone-else' }),
    ]);
    expect(images).toEqual([]);
    expect(textDocumentIds).toEqual(ids);
  });

  it('loads a granted image the caller does not own', async () => {
    const { images, textDocumentIds } = await resolve(
      [imageDoc({ ownerId: 'someone-else' })],
      [{ documentId: 'img-1' }]
    );
    expect(images).toHaveLength(1);
    expect(textDocumentIds).toEqual([]);
  });

  it('fails closed when more than the per-turn image cap is attached', async () => {
    const docs = Array.from({ length: 6 }, (_, i) => imageDoc({ _id: `img-${i}` }));
    // The model must never answer about images it did not receive: the turn
    // fails with a clear error instead of silently dropping images.
    await expect(resolve(docs)).rejects.toMatchObject({ code: 'TOO_MANY_IMAGES' });
  });

  it('fails closed on an oversize image', async () => {
    const big = imageDoc({ sizeBytes: 100 * 1024 * 1024 });
    await expect(resolve([big])).rejects.toMatchObject({ code: 'IMAGE_TOO_LARGE' });
  });

  it('fails closed when the turn total exceeds the byte budget', async () => {
    const { config } = await import('../src/config.js');
    const original = config.CHAT_MAX_IMAGE_TOTAL_BYTES;
    config.CHAT_MAX_IMAGE_TOTAL_BYTES = 10 * 1024 * 1024;
    try {
      // Each image is under the 8 MiB per-image cap; together they exceed
      // the 10 MiB turn budget.
      const docs = [imageDoc({ _id: 'a', sizeBytes: 7 * 1024 * 1024 }), imageDoc({ _id: 'b', sizeBytes: 7 * 1024 * 1024 })];
      await expect(resolve(docs)).rejects.toMatchObject({ code: 'IMAGES_TOO_LARGE' });
    } finally {
      config.CHAT_MAX_IMAGE_TOTAL_BYTES = original;
    }
  });

  it('returns empty splits when no document IDs are selected', async () => {
    const { resolveChatDocuments } = await import('../src/chat/imageAttachments.js');
    await expect(resolveChatDocuments(auth, undefined)).resolves.toEqual({ images: [], textDocumentIds: [] });
    await expect(resolveChatDocuments(auth, [])).resolves.toEqual({ images: [], textDocumentIds: [] });
  });
});

/* ------------------------------------------------------------------ */
/* 8. Acceptance: the owner's error-screenshot turn                    */
/* ------------------------------------------------------------------ */

describe('acceptance: SyteLine error screenshot chat turn', () => {
  const baseAuth = { userId: 'u1', tenantId: 't1', roleId: 'r1' } as unknown as AuthContext;
  const visionModel = {
    id: 'vision-model-id',
    name: VISION_MODEL_NAME,
    contextWindow: 32768,
    version: '1.0',
  } as unknown as ApprovedModel;

  /**
   * What a real vision model sees and says about Jake's screenshot: the
   * canned answer quotes the visible error, names the failing custom
   * source, and gives causes + steps. The mock stands in for qwen2.5vl:7b
   * (REQUIRES REAL INFRASTRUCTURE); the test proves the turn's plumbing —
   * image payload in, diagnostic answer out — rather than the model's
   * weights.
   */
  const DIAGNOSTIC_CHUNKS = [
    'The screenshot shows a SyteLine error dialog. The error text reads ',
    '"Duplicate key ..." and the call stack names the custom source ',
    'SSSFSUnit.JobBuild. This is a duplicate-key failure raised by the ',
    'custom JobBuild routine, not by standard SyteLine code.\n\n',
    'Likely causes:\n',
    '1. The custom routine generates a job or operation number that already exists.\n',
    '2. A retry or double-submit ran the routine twice for the same input.\n',
    '3. A customization bypassed the standard numbering exit.\n\n',
    'Troubleshooting steps:\n',
    '1. Note the exact key value in the message and find the existing record.\n',
    '2. Check the SSSFSUnit customization source for how JobBuild builds the key.\n',
    '3. Reproduce in a test environment with SQL Profiler running to catch the insert.\n',
    '4. Fix the numbering logic or add an existence check before insert.',
  ];

  function scriptedVisionGateway(seenInputs: any[]) {
    return async (input: any) => {
      seenInputs.push(input);
      return {
        model: visionModel,
        telemetry: {},
        events: (async function* (): AsyncGenerator<GatewayEvent> {
          for (const content of DIAGNOSTIC_CHUNKS) yield { type: 'text', content };
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

  it('an attached error screenshot reaches the vision provider and yields a diagnostic answer', async () => {
    // The upload gate accepts the JPG: no "Document type is not supported".
    const screenshot = jpegBytes();
    expect(detectMimeType('syteline-error.jpg', screenshot)).toBe('image/jpeg');

    const seenInputs: any[] = [];
    const { sink, log } = collectingSink();
    const messages: ChatMessage[] = [
      {
        role: 'user',
        content: 'What does this error mean and how do I fix it?',
        images: [{ data: Buffer.from(screenshot).toString('base64'), mimeType: 'image/jpeg' }],
      },
    ];

    const result = await runAgenticLoop({
      tenantId: 't1',
      userId: 'u1',
      roleId: 'r1',
      classification: 'INTERNAL',
      auth: baseAuth,
      initialModel: visionModel,
      // The real system prompt with visionMode on: the VISION INPUT section
      // is what steers the model toward a diagnostic-style answer.
      buildSystemPrompt: (name, version) =>
        buildSystemPrompt({ modelName: name, modelVersion: version, visionMode: true }),
      providerTools: [],
      messages,
      signal: new AbortController().signal,
      telemetry: {},
      maxIterations: 5,
      maxResponseChars: 100_000,
      streamGateway: scriptedVisionGateway(seenInputs),
      sink,
    } as AgenticLoopOptions);

    // The image payload reached the provider input intact.
    expect(seenInputs).toHaveLength(1);
    const outgoing = seenInputs[0].messages as ChatMessage[];
    const outgoingUser = outgoing.find((m) => m.role === 'user');
    expect(outgoingUser?.images).toHaveLength(1);
    expect(outgoingUser?.images?.[0]?.mimeType).toBe('image/jpeg');
    expect(outgoingUser?.images?.[0]?.data).toBe(Buffer.from(screenshot).toString('base64'));
    // The turn ran under the vision system prompt.
    const systemMessage = outgoing.find((m) => m.role === 'system');
    expect(systemMessage?.content).toContain('VISION INPUT');

    // The turn completed with a substantive diagnostic answer — never an
    // upload/validation error.
    expect(log.errors).toEqual([]);
    expect(result.failed).toBe(false);
    expect(result.completed).toBe(true);
    const answer = log.texts.join('');
    expect(answer.toLowerCase()).toContain('duplicate key');
    expect(answer).toContain('SSSFSUnit.JobBuild');
    expect(answer.toLowerCase()).toContain('likely causes');
    expect(answer.toLowerCase()).toContain('troubleshooting');
    expect(result.content).toContain('SSSFSUnit.JobBuild');
  });

  it('the vision system prompt is deterministic and only present in vision mode', () => {
    const withVision = buildSystemPrompt({ modelName: 'm', visionMode: true });
    const withoutVision = buildSystemPrompt({ modelName: 'm' });
    expect(withVision).toContain('VISION INPUT');
    expect(withoutVision).not.toContain('VISION INPUT');
    expect(buildSystemPrompt({ modelName: 'm', visionMode: true })).toBe(withVision);
  });

  it('image tokens are budgeted in context-window estimates', () => {
    const textOnly: ChatMessage[] = [{ role: 'user', content: 'hello' }];
    const withImage: ChatMessage[] = [
      { role: 'user', content: 'hello', images: [{ data: 'QUJD', mimeType: 'image/jpeg' }] },
    ];
    expect(estimateMessagesTokens(withImage)).toBeGreaterThan(estimateMessagesTokens(textOnly));
  });
});
