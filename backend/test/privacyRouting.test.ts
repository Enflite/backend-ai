/**
 * privacyRouting.test.ts — privacy-aware provider routing.
 *
 * Mocked boundary: Mongo (tenantOp), audit (recordAudit), and the model
 * registry / capability router collaborators of applyPrivacyRouting. The
 * detector itself is pure and tested directly. No network, no Anthropic.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AppError } from '../src/errors.js';
import {
  detectCustomerData,
  stripCustomerDataTools,
  applyPrivacyRouting,
  getPrivacyAutoRouting,
  setPrivacyAutoRouting,
  setPrivacyRoutingSetting,
  PRIVACY_ROUTING_NOTICE,
} from '../src/ai/gateway/privacyRouting.js';
import type { ApprovedModel } from '../src/ai/gateway/modelRegistry.js';

vi.mock('../src/db/mongo.js', () => ({
  tenantOp: vi.fn(),
}));
vi.mock('../src/audit/audit.js', () => ({
  recordAudit: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../src/ai/gateway/modelRegistry.js', () => ({
  isClaudeConfigured: vi.fn(),
  getApprovedModelForUser: vi.fn(),
  ensureTenantDefaultModel: vi.fn(),
  findServableChatModelForGroup: vi.fn(),
  findServableVisionModelForGroup: vi.fn(),
}));
vi.mock('../src/ai/gateway/capabilityRouter.js', () => ({
  resolveDefaultOpenModel: vi.fn(),
  resolveVisionModel: vi.fn(),
}));

import { tenantOp } from '../src/db/mongo.js';
import { recordAudit } from '../src/audit/audit.js';
import {
  isClaudeConfigured,
  getApprovedModelForUser,
  ensureTenantDefaultModel,
  findServableChatModelForGroup,
} from '../src/ai/gateway/modelRegistry.js';
import { resolveDefaultOpenModel, resolveVisionModel } from '../src/ai/gateway/capabilityRouter.js';

const TENANT = 'tenant-1';
const USER = 'user-1';
const ROLE = 'role-1';

function model(overrides: Partial<ApprovedModel> & { id: string }): ApprovedModel {
  return {
    name: 'Model',
    provider: 'ollama',
    modelIdentifier: 'llama3.1:8b',
    endpoint: 'http://ollama:11434',
    contextWindow: 128000,
    classification: 'INTERNAL',
    capabilities: { chat: true },
    status: 'active',
    ...overrides,
  } as ApprovedModel;
}

const ENFLITE_MODEL = model({ id: 'model-enflite', name: 'Enflite', provider: 'ollama' });
const CLAUDE_MODEL = model({ id: 'model-claude', name: 'Claude', provider: 'claude' });

const CLEAN_PROMPT = 'You are a helpful assistant.\n\nUser: what is the capital of France?';
const SYTELINE_HISTORY_PROMPT =
  'You are a helpful assistant.\n\nUser: check status of SO-77821\n' +
  'Assistant: <untrusted_tool_result name="syteline.get_order">\n{"order": "SO-77821", "customer": "Acme Corp"}\n</untrusted_tool_result>';

function baseInput(overrides: Record<string, unknown> = {}) {
  return {
    tenantId: TENANT,
    userId: USER,
    roleId: ROLE,
    requestId: 'req-1',
    preliminaryModel: ENFLITE_MODEL,
    explicitModelSelection: false,
    promptText: CLEAN_PROMPT,
    requestedCapability: 'chat',
    hasImages: false,
    ...overrides,
  };
}

/** In-memory privacy_routing_settings collection for the toggle tests. */
const settingsStore = new Map<string, Record<string, unknown>>();

beforeEach(() => {
  vi.clearAllMocks();
  settingsStore.clear();
  vi.mocked(tenantOp).mockImplementation(async (_tenantId: string, fn: (db: any, tenantId: string) => Promise<unknown>) => {
    const db = {
      collection: () => ({
        findOne: async ({ _id }: { _id: string }) =>
          settingsStore.has(_id) ? { _id, ...settingsStore.get(_id)! } : null,
        updateOne: async (filter: { _id: string }, update: { $set: Record<string, unknown> }) => {
          settingsStore.set(filter._id, { ...(settingsStore.get(filter._id) ?? {}), ...update.$set });
        },
      }),
    };
    return fn(db, _tenantId);
  });
  vi.mocked(recordAudit).mockResolvedValue(undefined);
  vi.mocked(isClaudeConfigured).mockReturnValue(false);
  vi.mocked(resolveDefaultOpenModel).mockResolvedValue(ENFLITE_MODEL);
  vi.mocked(ensureTenantDefaultModel).mockResolvedValue(ENFLITE_MODEL);
  vi.mocked(getApprovedModelForUser).mockImplementation(async (id: string) =>
    id === CLAUDE_MODEL.id ? CLAUDE_MODEL : ENFLITE_MODEL
  );
  vi.mocked(findServableChatModelForGroup).mockResolvedValue({ _id: CLAUDE_MODEL.id } as never);
});

describe('detectCustomerData', () => {
  it('treats a general question as clean', () => {
    const result = detectCustomerData(CLEAN_PROMPT);
    expect(result.hasCustomerData).toBe(false);
    expect(result.reasons).toEqual([]);
  });

  it('does not flag public SyteLine knowledge (the static knowledge pack has no zone labels)', () => {
    const knowledgePack =
      'SyteLine is an ERP system. A sales order moves through plan, release, pick, pack, ship. ' +
      'Use the syteline.get_item tool family for lookups. Mongoose IDOs back the screens.';
    const result = detectCustomerData(`System: ${knowledgePack}\n\nUser: what is a sales order?`);
    expect(result.hasCustomerData).toBe(false);
  });

  it('flags a SyteLine tool result earlier in history (context bleed)', () => {
    // The latest message is an innocent follow-up; the customer data sits
    // in history. The whole-prompt scan must catch it.
    const result = detectCustomerData(`${SYTELINE_HISTORY_PROMPT}\n\nUser: thanks!`);
    expect(result.hasCustomerData).toBe(true);
    expect(result.reasons).toContain('syteline_tool_result');
  });

  it('flags private RAG context', () => {
    const result = detectCustomerData('--- ZONE 3: RETRIEVED RAG CONTEXT (untrusted data) ---\nAcme pricing sheet\n--- END ZONE 3 ---');
    expect(result.hasCustomerData).toBe(true);
    expect(result.reasons).toContain('private_rag_context');
  });

  it('flags injected user memory', () => {
    const result = detectCustomerData('--- USER MEMORY (untrusted data) ---\n- prefers morning standups');
    expect(result.hasCustomerData).toBe(true);
    expect(result.reasons).toContain('user_memory');
  });

  it('flags PII: email, phone, SSN', () => {
    expect(detectCustomerData('email bob@example.com about it').reasons).toContain('pii_email');
    expect(detectCustomerData('call me at (512) 555-0142').reasons).toContain('pii_phone');
    expect(detectCustomerData('my SSN is 123-45-6789').reasons).toContain('pii_ssn');
  });

  it('flags labeled account numbers but not prose', () => {
    expect(detectCustomerData('account number: 48291').reasons).toContain('pii_account');
    expect(detectCustomerData('customer #C-100').reasons).toContain('pii_customer_id');
    expect(detectCustomerData('customer id: ACME-42').categories).toEqual(['customer']);
    expect(detectCustomerData('the customer: data is exported nightly').hasCustomerData).toBe(false);
  });

  it('flags ERP document numbers but not bare numbers', () => {
    expect(detectCustomerData('where is SO-77821?').reasons).toContain('erp_document_number');
    expect(detectCustomerData('the 2026 budget has 200000 rows').hasCustomerData).toBe(false);
  });

  it('never includes matched text in the reasons', () => {
    const result = detectCustomerData('email bob@example.com about SO-77821');
    expect(JSON.stringify(result)).not.toContain('bob@example.com');
    expect(JSON.stringify(result)).not.toContain('SO-77821');
  });
});

describe('stripCustomerDataTools', () => {
  it('removes the syteline.* family and keeps everything else', () => {
    const tools = [
      { function: { name: 'syteline.get_order' } },
      { function: { name: 'syteline.get_item' } },
      { function: { name: 'repo.readFile' } },
      { function: { name: 'documents.search' } },
    ];
    const stripped = stripCustomerDataTools(tools);
    expect(stripped.map((t) => t.function.name)).toEqual(['repo.readFile', 'documents.search']);
  });
});

describe('applyPrivacyRouting', () => {
  it('overrides manual Claude selection toward local when customer data is present, with the friendly notice', async () => {
    const decision = await applyPrivacyRouting(
      baseInput({ preliminaryModel: CLAUDE_MODEL, explicitModelSelection: true, promptText: SYTELINE_HISTORY_PROMPT })
    );
    expect(decision.model.provider).toBe('ollama');
    expect(decision.privacyOverridden).toBe(true);
    expect(decision.autoRoutedToCloud).toBe(false);
    expect(decision.notice).toBe(PRIVACY_ROUTING_NOTICE);
    expect(recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'PRIVACY_ROUTING_OVERRIDE', success: true })
    );
    // The audit metadata carries reasons only — never matched text.
    const auditCall = vi.mocked(recordAudit).mock.calls[0]![0] as unknown as { metadata: { reasons: string[] } };
    expect(JSON.stringify(auditCall.metadata)).not.toContain('Acme');
  });

  it('keeps an explicit Claude selection on a clean turn (override is toward local only)', async () => {
    const decision = await applyPrivacyRouting(
      baseInput({ preliminaryModel: CLAUDE_MODEL, explicitModelSelection: true })
    );
    expect(decision.model.id).toBe(CLAUDE_MODEL.id);
    expect(decision.privacyOverridden).toBe(false);
    expect(decision.notice).toBeNull();
  });

  it('never moves an explicit Enflite selection to the cloud', async () => {
    vi.mocked(isClaudeConfigured).mockReturnValue(true);
    const decision = await applyPrivacyRouting(
      baseInput({ preliminaryModel: ENFLITE_MODEL, explicitModelSelection: true })
    );
    expect(decision.model.id).toBe(ENFLITE_MODEL.id);
    expect(decision.autoRoutedToCloud).toBe(false);
  });

  it('auto-routes a clean, unpinned turn to Claude when configured and enabled', async () => {
    vi.mocked(isClaudeConfigured).mockReturnValue(true);
    const decision = await applyPrivacyRouting(baseInput());
    expect(decision.model.id).toBe(CLAUDE_MODEL.id);
    expect(decision.autoRoutedToCloud).toBe(true);
    expect(decision.notice).toBeNull();
    expect(recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'PRIVACY_ROUTING_AUTO_CLOUD' })
    );
  });

  it('stays local when Claude is not configured (no key)', async () => {
    vi.mocked(isClaudeConfigured).mockReturnValue(false);
    const decision = await applyPrivacyRouting(baseInput());
    expect(decision.model.id).toBe(ENFLITE_MODEL.id);
    expect(decision.autoRoutedToCloud).toBe(false);
  });

  it('stays local when the tenant toggle is off', async () => {
    vi.mocked(isClaudeConfigured).mockReturnValue(true);
    settingsStore.set(TENANT, { autoRouteToCloud: false });
    const decision = await applyPrivacyRouting(baseInput());
    expect(decision.model.id).toBe(ENFLITE_MODEL.id);
    expect(decision.autoRoutedToCloud).toBe(false);
  });

  it('falls back to the preliminary model when the Claude seed is revoked for the caller', async () => {
    vi.mocked(isClaudeConfigured).mockReturnValue(true);
    vi.mocked(getApprovedModelForUser).mockRejectedValue(new AppError(403, 'MODEL_NOT_APPROVED', 'denied'));
    const decision = await applyPrivacyRouting(baseInput());
    expect(decision.model.id).toBe(ENFLITE_MODEL.id);
    expect(decision.autoRoutedToCloud).toBe(false);
  });

  it('routes syteline-capability turns local even when the text alone looks clean (predictive rule)', async () => {
    vi.mocked(isClaudeConfigured).mockReturnValue(true);
    const decision = await applyPrivacyRouting(
      baseInput({
        preliminaryModel: CLAUDE_MODEL,
        explicitModelSelection: true,
        promptText: 'User: how do I check on-hand stock?',
        requestedCapability: 'syteline',
      })
    );
    expect(decision.model.provider).toBe('ollama');
    expect(decision.privacyOverridden).toBe(true);
    expect(decision.detection.reasons).toContain('syteline_capability_predicted');
  });

  it('uses the local vision model for a customer-data image turn instead of Claude', async () => {
    const visionModel = model({ id: 'model-vision', name: 'Enflite Vision', provider: 'ollama' });
    vi.mocked(resolveVisionModel).mockResolvedValue(visionModel);
    const decision = await applyPrivacyRouting(
      baseInput({
        preliminaryModel: CLAUDE_MODEL,
        explicitModelSelection: true,
        promptText: SYTELINE_HISTORY_PROMPT,
        hasImages: true,
      })
    );
    expect(decision.model.id).toBe('model-vision');
    expect(decision.privacyOverridden).toBe(true);
    expect(resolveVisionModel).toHaveBeenCalled();
  });
});

describe('privacy auto-routing toggle', () => {
  it('defaults ON', async () => {
    const setting = await getPrivacyAutoRouting(TENANT);
    expect(setting.autoRouteToCloud).toBe(true);
  });

  it('round-trips an explicit OFF and audits the change', async () => {
    const setting = await setPrivacyAutoRouting(TENANT, false, USER, 'req-9', '127.0.0.1');
    expect(setting.autoRouteToCloud).toBe(false);
    expect(setting.updatedBy).toBe(USER);
    expect(await getPrivacyAutoRouting(TENANT)).toMatchObject({ autoRouteToCloud: false });
    expect(recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'PRIVACY_AUTO_ROUTING_SET', metadata: { autoRouteToCloud: false } })
    );
  });
});

describe('sensitive categories: finance and proprietary', () => {
  const FINANCE_RAG_PROMPT =
    '--- ZONE 3: RETRIEVED RAG CONTEXT (untrusted data) ---\n' +
    '<untrusted_document citation="1" document_id="d1" chunk_id="c1">\nQ3 revenue was $1.2M with an 18% margin.\n</untrusted_document>\n' +
    '--- END ZONE 3 ---\n\nUser: summarize the Q3 numbers';

  const PROPRIETARY_RAG_PROMPT =
    '--- ZONE 3: RETRIEVED RAG CONTEXT (untrusted data) ---\n' +
    '<untrusted_document citation="1" document_id="d9" chunk_id="c9">\nEnflite heat-treat procedure ENF-HT-004: soak at 1525F for 90 minutes.\n</untrusted_document>\n' +
    '--- END ZONE 3 ---\n\nUser: what is our heat-treat procedure?';

  it('flags a finance doc chunk in history with the finance category', () => {
    const result = detectCustomerData(FINANCE_RAG_PROMPT);
    expect(result.hasCustomerData).toBe(true);
    expect(result.reasons).toContain('private_rag_context');
    expect(result.reasons).toContain('finance_keyword');
    expect(result.categories).toContain('finance');
    expect(result.categories).toContain('proprietary');
  });

  it('routes a finance-chunk turn local over an explicit Claude pick', async () => {
    vi.mocked(isClaudeConfigured).mockReturnValue(true);
    const decision = await applyPrivacyRouting(
      baseInput({
        preliminaryModel: CLAUDE_MODEL,
        explicitModelSelection: true,
        promptText: FINANCE_RAG_PROMPT,
      })
    );
    expect(decision.model.provider).toBe('ollama');
    expect(decision.privacyOverridden).toBe(true);
    expect(decision.notice).toBe('Kept this on Enflite — it touches financial data.');
    expect(decision.enforcedCategories).toContain('finance');
  });

  it('routes a proprietary process-doc turn local', async () => {
    const detection = detectCustomerData(PROPRIETARY_RAG_PROMPT);
    expect(detection.reasons).toEqual(['private_rag_context']);
    expect(detection.categories).toEqual(['proprietary']);
    const decision = await applyPrivacyRouting(
      baseInput({
        preliminaryModel: CLAUDE_MODEL,
        explicitModelSelection: true,
        promptText: PROPRIETARY_RAG_PROMPT,
      })
    );
    expect(decision.model.provider).toBe('ollama');
    expect(decision.privacyOverridden).toBe(true);
  });

  it('flags finance keywords in prose with the finance category', () => {
    for (const text of [
      'what was our revenue last quarter?',
      'show me the P&L statement',
      'when does payroll run?',
      'post this to the GL',
      'EBITDA is up year over year',
    ]) {
      const result = detectCustomerData(`User: ${text}`);
      expect(result.reasons).toContain('finance_keyword');
      expect(result.categories).toEqual(['finance']);
    }
  });

  it('flags tax IDs (EIN) as finance and labeled accounts as finance', () => {
    const ein = detectCustomerData('our EIN is 12-3456789');
    expect(ein.reasons).toContain('pii_tax_id');
    expect(ein.categories).toEqual(['finance']);
    const acct = detectCustomerData('account number: 48291');
    expect(acct.reasons).toContain('pii_account');
    expect(acct.categories).toEqual(['finance']);
  });

  it('honors RAG chunk sensitivity metadata for finer categories', () => {
    const prompt =
      '--- ZONE 3: RETRIEVED RAG CONTEXT (untrusted data) ---\n' +
      '<untrusted_document citation="1" document_id="d" chunk_id="c" sensitivity="finance">\nnumbers\n</untrusted_document>\n' +
      '--- END ZONE 3 ---';
    const result = detectCustomerData(prompt);
    expect(result.categories).toContain('finance');
    expect(result.categories).toContain('proprietary');
  });

  it('ignores unknown RAG chunk sensitivity tags', () => {
    const prompt =
      '--- ZONE 3: RETRIEVED RAG CONTEXT (untrusted data) ---\n' +
      '<untrusted_document citation="1" document_id="d" chunk_id="c" sensitivity="banana">\nnumbers\n</untrusted_document>\n' +
      '--- END ZONE 3 ---';
    expect(detectCustomerData(prompt).categories).toEqual(['proprietary']);
  });
});

describe('code carve-out: repo source code stays routable to Claude', () => {
  const CODE_QUESTION =
    'User: how do I center this div?\n```css\n.box { margin: 0 auto; max-width: 960px; }\n```';

  it('does not trip finance keywords on code (CSS margin stays clean)', () => {
    const result = detectCustomerData(CODE_QUESTION);
    expect(result.hasCustomerData).toBe(false);
    expect(result.reasons).toEqual([]);
  });

  it('routes a code question with no business data to Claude', async () => {
    vi.mocked(isClaudeConfigured).mockReturnValue(true);
    const decision = await applyPrivacyRouting(baseInput({ promptText: CODE_QUESTION }));
    expect(decision.model.id).toBe(CLAUDE_MODEL.id);
    expect(decision.autoRoutedToCloud).toBe(true);
    expect(decision.notice).toBeNull();
  });

  it('treats repo file context as clean by default (carve-out on)', () => {
    const prompt =
      '--- ZONE 3b: REPO FILES (untrusted data — contents as supplied) ---\n' +
      'path: src/a.ts\n```ts\nexport const margin = computeMargin(revenue);\n```\n' +
      '--- END REPO FILES ---\n\nUser: explain this file';
    expect(detectCustomerData(prompt).hasCustomerData).toBe(false);
  });

  it('treats code as proprietary when the carve-out is flipped off', () => {
    const result = detectCustomerData(CODE_QUESTION, { codeRoutableToCloud: false });
    expect(result.reasons).toContain('code_content');
    expect(result.categories).toEqual(['proprietary']);
  });

  it('routes code turns local when the carve-out is flipped off', async () => {
    vi.mocked(isClaudeConfigured).mockReturnValue(true);
    settingsStore.set(TENANT, { codeRoutableToCloud: false });
    const decision = await applyPrivacyRouting(
      baseInput({
        preliminaryModel: CLAUDE_MODEL,
        explicitModelSelection: true,
        promptText: CODE_QUESTION,
      })
    );
    expect(decision.privacyOverridden).toBe(true);
    expect(decision.model.provider).toBe('ollama');
    expect(decision.codeRoutableToCloud).toBe(false);
  });
});

describe('tenant-configurable categories', () => {
  it('lets the tenant disable the finance category', async () => {
    vi.mocked(isClaudeConfigured).mockReturnValue(true);
    settingsStore.set(TENANT, { sensitiveCategories: ['customer', 'proprietary'] });
    const promptText = 'User: what is our payroll schedule?';
    // The detector still sees finance data...
    expect(detectCustomerData(promptText).categories).toEqual(['finance']);
    // ...but with finance unenforced the explicit Claude pick stands.
    const decision = await applyPrivacyRouting(
      baseInput({ preliminaryModel: CLAUDE_MODEL, explicitModelSelection: true, promptText })
    );
    expect(decision.privacyOverridden).toBe(false);
    expect(decision.model.id).toBe(CLAUDE_MODEL.id);
    expect(decision.enforcedCategories).toEqual([]);
  });

  it('round-trips sensitiveCategories and codeRoutableToCloud', async () => {
    const setting = await setPrivacyRoutingSetting(
      TENANT,
      { sensitiveCategories: ['customer'], codeRoutableToCloud: false },
      USER,
      'req-10',
      '127.0.0.1'
    );
    expect(setting.sensitiveCategories).toEqual(['customer']);
    expect(setting.codeRoutableToCloud).toBe(false);
    expect(setting.updatedBy).toBe(USER);
    expect(await getPrivacyAutoRouting(TENANT)).toMatchObject({
      sensitiveCategories: ['customer'],
      codeRoutableToCloud: false,
    });
    expect(recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'PRIVACY_AUTO_ROUTING_SET',
        metadata: { sensitiveCategories: ['customer'], codeRoutableToCloud: false },
      })
    );
  });

  it('sanitizes unknown categories on read', async () => {
    settingsStore.set(TENANT, { sensitiveCategories: ['customer', 'banana'] });
    expect((await getPrivacyAutoRouting(TENANT)).sensitiveCategories).toEqual(['customer']);
  });
});

describe('stripCustomerDataTools (category-aware gate)', () => {
  const tools = [
    { function: { name: 'syteline.get_order' } },
    { function: { name: 'repo.readFile' } },
  ];

  it('strips repo.* only when the code carve-out is flipped off', () => {
    const names = (list: Array<{ function: { name: string } }>) => list.map((t) => t.function.name);
    expect(
      names(stripCustomerDataTools(tools, ['customer', 'finance', 'proprietary'], false))
    ).toEqual([]);
    expect(
      names(stripCustomerDataTools(tools, ['customer', 'finance', 'proprietary'], true))
    ).toEqual(['repo.readFile']);
  });

  it('keeps syteline.* when neither customer nor finance is enforced', () => {
    const stripped = stripCustomerDataTools(tools, ['proprietary'], true);
    expect(stripped.map((t) => t.function.name)).toEqual(['syteline.get_order', 'repo.readFile']);
  });
});

describe('privacyOverrideNotice', () => {
  it('keeps the exact customer-only wording', async () => {
    const { privacyOverrideNotice } = await import('../src/ai/gateway/privacyRouting.js');
    expect(privacyOverrideNotice(['customer'])).toBe('Kept this on Enflite — it touches customer data.');
  });

  it('names finance data accurately', async () => {
    const { privacyOverrideNotice } = await import('../src/ai/gateway/privacyRouting.js');
    expect(privacyOverrideNotice(['finance'])).toBe('Kept this on Enflite — it touches financial data.');
  });

  it('names proprietary data accurately', async () => {
    const { privacyOverrideNotice } = await import('../src/ai/gateway/privacyRouting.js');
    expect(privacyOverrideNotice(['proprietary'])).toBe(
      'Kept this on Enflite — it touches proprietary business data.'
    );
  });

  it('prefers the customer wording when customer data is among the categories', async () => {
    const { privacyOverrideNotice } = await import('../src/ai/gateway/privacyRouting.js');
    expect(privacyOverrideNotice(['customer', 'finance'])).toBe('Kept this on Enflite — it touches customer data.');
  });

  it('uses the generic sensitive wording when no category is enforced', async () => {
    const { privacyOverrideNotice } = await import('../src/ai/gateway/privacyRouting.js');
    expect(privacyOverrideNotice([])).toBe('Kept this on Enflite — it touches sensitive data.');
  });
});

describe('fail-closed privacy routing', () => {
  it('rejects a sensitive turn when no local model can serve it (never falls back to cloud)', async () => {
    vi.mocked(resolveDefaultOpenModel).mockRejectedValue(new Error('no models'));
    vi.mocked(ensureTenantDefaultModel).mockResolvedValue(null);
    vi.mocked(isClaudeConfigured).mockReturnValue(true);

    const input = {
      tenantId: 't1',
      userId: 'u1',
      roleId: 'r1',
      promptText: 'Our Q3 revenue was $4.2M with a 31% margin.',
      preliminaryModel: CLAUDE_MODEL,
      explicitModelSelection: true,
      requestId: 'req-fail-closed',
    };
    await expect(applyPrivacyRouting(input)).rejects.toMatchObject({
      code: 'PRIVACY_LOCAL_MODEL_UNAVAILABLE',
      statusCode: 503,
    });
    // The failed closed turn is audited without any matched text.
    const auditCall = vi.mocked(recordAudit).mock.calls[0]![0];
    expect(auditCall.action).toBe('PRIVACY_ROUTING_NO_LOCAL_MODEL');
    expect(auditCall.success).toBe(false);
    const metadata = (auditCall as unknown as { metadata: { reasons: string[]; categories: string[] } }).metadata;
    expect(metadata.reasons).toContain('finance_keyword');
    expect(metadata.categories).toEqual(['finance']);
  });

  it('a sensitive turn with a local model available still routes local with the finance notice', async () => {
    vi.mocked(resolveDefaultOpenModel).mockResolvedValue(ENFLITE_MODEL);
    const decision = await applyPrivacyRouting({
      tenantId: 't1',
      userId: 'u1',
      roleId: 'r1',
      promptText: 'Our Q3 revenue was $4.2M with a 31% margin.',
      preliminaryModel: CLAUDE_MODEL,
      explicitModelSelection: true,
      requestId: 'req-finance-notice',
    });
    expect(decision.privacyOverridden).toBe(true);
    expect(decision.model.id).toBe('model-enflite');
    expect(decision.notice).toBe('Kept this on Enflite — it touches financial data.');
  });
});
