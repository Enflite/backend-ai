/**
 * routes.ts — admin HTTP surface for the eval framework.
 *
 * All routes require authentication + the `model:manage` permission: eval
 * runs are a platform admin activity, and live runs spend real GPU.
 */
import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../auth/middleware.js';
import { requirePermission } from '../authz/middleware.js';
import { Errors } from '../errors.js';
import { recordAudit } from '../audit/audit.js';
import { EVAL_SEED_CORPUS } from './corpus.js';
import { EVAL_CORPUS } from './cases/index.js';
import { mockChatFn, runEval } from './runner.js';
import { gatewayChatFn } from './live.js';
import {
  compareRuns,
  createRun,
  failRun,
  finishRun,
  getModelVersion,
  getRun,
  listRuns,
  saveCaseResult,
} from './store.js';
import { getPromotionGate } from './compare.js';
import type { EvalCategory, QualityDimension } from './types.js';

const EVAL_CATEGORIES: EvalCategory[] = [
  'reasoning', 'coding', 'json-output', 'tool-selection', 'tool-args',
  'rag-retrieval', 'rag-grounding', 'citation-accuracy', 'hallucination',
  'prompt-injection', 'exfiltration', 'tenant-isolation', 'classification',
  'long-context', 'multi-turn', 'syteline', 'refusal', 'failure-handling',
  'malformed-input', 'adversarial', 'sensitive-data', 'reliability',
];

const QUALITY_DIMENSIONS: QualityDimension[] = [
  'helpfulness', 'honesty-calibration', 'instruction-following',
  'grounding-citations', 'tool-competence', 'multi-turn-coherence',
  'refusal-correctness', 'tone',
];

const runBodySchema = z.object({
  modelId: z.string().uuid(),
  categories: z.array(z.enum(EVAL_CATEGORIES as [EvalCategory, ...EvalCategory[]])).optional(),
  severities: z.array(z.enum(['p0', 'p1', 'p2'])).optional(),
  dimensions: z.array(z.enum(QUALITY_DIMENSIONS as [QualityDimension, ...QualityDimension[]])).optional(),
  live: z.boolean().optional(),
  // Seed-only smoke run (14 representative cases) instead of the full corpus.
  seed: z.boolean().optional(),
});

const runIdParams = z.object({ id: z.string().uuid() });
const modelQuerySchema = z.object({ modelId: z.string().uuid() });
const compareQuerySchema = z.object({ runA: z.string().uuid(), runB: z.string().uuid() });

const manageEval = [requireAuth, requirePermission('model:manage')];

export async function evalRoutes(fastify: FastifyInstance): Promise<void> {
  /**
   * Run the eval suite. Mock (scripted) unless `live: true` AND
   * EVAL_LIVE_PROVIDER is set — the provider recorded on the run row says
   * which one actually ran, so a mock run can never be mistaken for live
   * validation.
   */
  fastify.post('/admin/eval/runs', { preHandler: manageEval }, async (req, reply) => {
    const auth = req.auth!;
    const parsed = runBodySchema.safeParse(req.body);
    if (!parsed.success) throw Errors.badRequest('INVALID_REQUEST', 'Invalid eval run request');
    const { modelId, categories, severities, dimensions, live, seed } = parsed.data;

    const version = await getModelVersion(modelId);
    if (!version) throw Errors.notFound('MODEL_NOT_FOUND', 'Model not found');

    const liveProvider = process.env.EVAL_LIVE_PROVIDER;
    if (live && !liveProvider) {
      throw Errors.badRequest(
        'EVAL_LIVE_NOT_CONFIGURED',
        'Live eval requested but EVAL_LIVE_PROVIDER is not set; omit live to run the scripted mock suite'
      );
    }
    const provider = live ? liveProvider! : 'mock';

    // Default corpus is the full 110-case suite; `seed: true` runs the
    // 16-case representative smoke set instead.
    const corpus = seed ? EVAL_SEED_CORPUS : EVAL_CORPUS;
    const chatFn = live
      ? gatewayChatFn(modelId, { tenantId: auth.tenantId, userId: auth.userId, roleId: auth.roleId })
      : mockChatFn(corpus);
    // The judge model should differ from the candidate under eval —
    // self-judging inflates scores. Only wired in live mode.
    const judgeModel = process.env.EVAL_JUDGE_MODEL;
    const judgeChat =
      live && judgeModel
        ? gatewayChatFn(judgeModel, { tenantId: auth.tenantId, userId: auth.userId, roleId: auth.roleId })
        : undefined;

    const runId = await createRun({ modelId, modelVersion: version, provider, createdBy: auth.userId });
    try {
      const { summary } = await runEval(corpus, chatFn, {
        modelId,
        modelVersion: version,
        categories,
        severities,
        dimensions,
        judgeChat,
        onCaseResult: (result) => saveCaseResult(runId, result),
      });
      await finishRun(runId, summary);
      await recordAudit({
        tenantId: auth.tenantId,
        userId: auth.userId,
        requestId: req.requestId,
        ip: req.ip,
        action: 'EVAL_RUN_COMPLETED',
        resource: 'model',
        resourceId: modelId,
        metadata: {
          runId,
          provider,
          total: summary.total,
          passed: summary.passed,
          failed: summary.failed,
          skipped: summary.skipped,
          p0Failed: summary.p0Failed,
        },
      });
      return reply.send({ runId, provider, summary });
    } catch (error) {
      await failRun(runId, error instanceof Error ? error.message : String(error));
      throw error;
    }
  });

  fastify.get('/admin/eval/runs', { preHandler: manageEval }, async (req, reply) => {
    const parsed = modelQuerySchema.safeParse(req.query);
    if (!parsed.success) throw Errors.badRequest('INVALID_REQUEST', 'modelId query parameter required');
    return reply.send({ runs: await listRuns(parsed.data.modelId) });
  });

  fastify.get('/admin/eval/runs/:id', { preHandler: manageEval }, async (req, reply) => {
    const parsed = runIdParams.safeParse(req.params);
    if (!parsed.success) throw Errors.badRequest('INVALID_REQUEST', 'Invalid run id');
    const run = await getRun(parsed.data.id);
    if (!run) throw Errors.notFound('EVAL_RUN_NOT_FOUND', 'Eval run not found');
    return reply.send(run);
  });

  fastify.get('/admin/eval/compare', { preHandler: manageEval }, async (req, reply) => {
    const parsed = compareQuerySchema.safeParse(req.query);
    if (!parsed.success) throw Errors.badRequest('INVALID_REQUEST', 'runA and runB query parameters required');
    const comparison = await compareRuns(parsed.data.runA, parsed.data.runB);
    if (!comparison) throw Errors.notFound('EVAL_RUN_NOT_FOUND', 'One or both eval runs not found');
    return reply.send({ comparison });
  });

  /**
   * Promotion gate for Phase 3 lifecycle transitions: eligible only if the
   * latest run for the model's current version is completed, has zero p0
   * failures, and shows no grounding/honesty regression vs the previous run.
   */
  fastify.get('/admin/eval/promotion-gate', { preHandler: manageEval }, async (req, reply) => {
    const parsed = modelQuerySchema.safeParse(req.query);
    if (!parsed.success) throw Errors.badRequest('INVALID_REQUEST', 'modelId query parameter required');
    return reply.send({ gate: await getPromotionGate(parsed.data.modelId) });
  });
}
