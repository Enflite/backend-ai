/**
 * routes.ts — REST API for SyteLine task-agent runs (`/api/v1/syteline-tasks`).
 *
 * Task CRUD stays on the `syteline.task.*` tools; this module serves what
 * tools cannot: binary evidence. Per-step screenshot evidence is captured
 * server-side (tenant-scoped) and referenced by id in the step log; the
 * model only ever sees ids. This endpoint lets the frontend render the
 * actual pixels behind the evidence chips.
 *
 * - GET /syteline-tasks/:id/evidence/:evidenceId — stream the PNG bytes.
 *
 * Access: auth + `syteline:ui` permission, fail-fast 403 FEATURE_DISABLED
 * while SYTELINE_UI_ENABLED=false (same posture as every other
 * syteline.ui surface). Visibility follows the task rules: the requester
 * or an admin (tenant:manage). Anything else is 404 — never 403 — so
 * task existence never leaks to unauthorized callers. Evidence bytes are
 * never logged; the access audit carries identifiers only.
 *
 * Browser screenshots here REQUIRE REAL SYTELINE; the route logic is
 * VALIDATED IN CI.
 */

import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { requireAuth } from '../../auth/middleware.js';
import { requirePermission } from '../../authz/middleware.js';
import type { AuthContext } from '../../authz/permissions.js';
import { Errors } from '../../errors.js';
import { config } from '../../config.js';
import { recordAudit } from '../../audit/audit.js';
import { resolveChatDefault } from '../../ai/gateway/capabilityRouter.js';
import { gatewayStream } from '../../ai/gateway/gateway.js';
import { readScreenshotEvidence } from '../../tools/sytelineUi.js';
import { assertTaskVisible, createTask, getTask } from './taskStore.js';
import { kickTaskRunner } from './taskScheduler.js';
import { taskIdParam } from './taskTypes.js';

/** Evidence ids are randomUUIDs at store time — strict shape, no traversal. */
const evidenceIdParam = z
  .string()
  .regex(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    'evidenceId must be a UUID',
  );

const evidenceParams = z
  .object({ id: taskIdParam, evidenceId: evidenceIdParam })
  .strict();

/** Admins (tenant:manage) see the tenant's tasks; others see only their own. */
function isTaskAdmin(auth: AuthContext): boolean {
  return auth.permissions.includes('tenant:manage');
}

function validationError(message: string, details?: unknown): never {
  throw Errors.badRequest('VALIDATION_ERROR', message, details);
}

async function requireUiEnabled(_req: FastifyRequest, _reply: FastifyReply): Promise<void> {
  if (!config.SYTELINE_UI_ENABLED) {
    throw Errors.forbidden(
      'FEATURE_DISABLED',
      'SyteLine UI automation is disabled (SYTELINE_UI_ENABLED=false)',
    );
  }
}

// ---------------------------------------------------------------------------
// POST /syteline-tasks/generate — natural-language goal -> AI-generated tasks
// ---------------------------------------------------------------------------

const generateTasksInput = z
  .object({
    goal: z.string().min(1).max(2000),
    count: z.number().int().min(1).max(10).default(10),
  })
  .strict();

/** One AI-proposed board task. Mirrors createTaskInput's title/goal limits. */
const generatedTaskItem = z
  .object({
    title: z.string().min(1).max(120),
    goal: z.string().min(1).max(2000),
  })
  .strict();

const generatedTaskList = z.array(generatedTaskItem).min(1).max(10);

export type GeneratedTaskItem = z.infer<typeof generatedTaskItem>;

/** Returns the model's raw task-list text for a goal. */
export type TaskGenerateFn = (
  goal: string,
  count: number,
  auth: AuthContext,
  signal: AbortSignal,
) => Promise<string>;

let generateFnOverride: TaskGenerateFn | null = null;

/** Test-only seam: substitute task-list generation (mirrors overrideTaskPlanFn). */
export function overrideTaskGenerateFn(fn: TaskGenerateFn | null): void {
  generateFnOverride = fn;
}

const TASK_GENERATOR_SYSTEM_PROMPT = [
  'You are a SyteLine ERP operations planner. Break the user\'s goal into a JSON',
  'array of concrete, executable tasks for an AI agent that drives the SyteLine',
  'web client (reads screens, fills fields, clicks buttons) and verifies its work.',
  '',
  'Rules:',
  '- Output ONLY a JSON array. No prose, no markdown fences, no commentary.',
  '- Each item: {"title": "<=80 chars, imperative, specific>", "goal": "1-3 sentences: what to accomplish, which SyteLine area or form if known, and what verified success looks like."}',
  '- Order tasks so earlier/independent work comes first.',
  '- Each task must be completable by the agent on its own; put anything needing',
  '  a human decision into the task goal text.',
  '- Never invent SyteLine form names, field names, or procedures you are not',
  '  sure about — describe the intent instead.',
].join('\n');

/**
 * Default generation: non-streaming call through the authorized AI gateway.
 * Fail-closed: no servable model -> 502; unparseable output -> 502 with no
 * tasks created. Never creates tasks from output that fails schema validation.
 */
async function defaultGenerateFn(
  goal: string,
  count: number,
  auth: AuthContext,
  signal: AbortSignal,
): Promise<string> {
  const model = await resolveChatDefault(auth.tenantId, auth.userId, auth.roleId);
  if (!model) {
    throw Errors.badGateway('NO_GENERATE_MODEL', 'No servable model available for task generation');
  }
  const result = await gatewayStream({
    tenantId: auth.tenantId,
    userId: auth.userId,
    roleId: auth.roleId,
    requestId: `syteline-task-generate-${randomUUID()}`,
    modelId: model.id,
    classification: auth.clearance,
    messages: [
      {
        role: 'user',
        content: `Goal: ${goal}\n\nBreak this into at most ${count} tasks as a JSON array.`,
      },
    ],
    systemPrompt: TASK_GENERATOR_SYSTEM_PROMPT,
    signal,
  });
  let text = '';
  for await (const event of result.events) {
    if (event.type === 'text') text += event.content;
  }
  return text;
}

/** Tolerantly extract the first [...] JSON array from model text. */
export function extractTaskListJson(text: string): unknown {
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start < 0 || end <= start) {
    throw Errors.badGateway('GENERATE_SCHEMA_MISMATCH', 'Task generator did not return a JSON array');
  }
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    throw Errors.badGateway('GENERATE_SCHEMA_MISMATCH', 'Task generator returned malformed JSON');
  }
}

/** Run generation and return the schema-validated task list. Never partial. */
export async function generateTaskList(
  goal: string,
  count: number,
  auth: AuthContext,
  signal: AbortSignal,
): Promise<GeneratedTaskItem[]> {
  const raw = generateFnOverride
    ? await generateFnOverride(goal, count, auth, signal)
    : await defaultGenerateFn(goal, count, auth, signal);
  const parsed = generatedTaskList.safeParse(extractTaskListJson(raw));
  if (!parsed.success) {
    throw Errors.badGateway(
      'GENERATE_SCHEMA_MISMATCH',
      'Task generator output failed schema validation — no tasks created',
    );
  }
  return parsed.data.slice(0, count);
}

export async function sytelineTaskRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get('/syteline-tasks/:id/evidence/:evidenceId', {
    preHandler: [requireAuth, requirePermission('syteline:ui'), requireUiEnabled],
  }, async (req: FastifyRequest, reply: FastifyReply) => {
    const auth = req.auth!;
    const parsed = evidenceParams.safeParse(req.params);
    if (!parsed.success) {
      validationError('Invalid task or evidence id', parsed.error.issues);
    }
    const { id: taskId, evidenceId } = parsed.data;

    // Tenant-scoped fetch first; missing or foreign tasks are 404.
    const task = await getTask(auth.tenantId, taskId);
    if (!task) {
      throw Errors.notFound('TASK_NOT_FOUND', 'Task not found');
    }
    // Requester or admin — anything else is 404, never 403 (no existence leak).
    assertTaskVisible(task, auth.userId, isTaskAdmin(auth));

    // Defense in depth: the evidence must actually belong to this task, so
    // a UUID can never be used to probe another task's (or tenant's) files.
    const onTask = task.steps.some((step) => step.evidenceIds.includes(evidenceId));
    if (!onTask) {
      throw Errors.notFound('EVIDENCE_NOT_FOUND', 'Evidence not found');
    }

    const bytes = await readScreenshotEvidence(auth.tenantId, evidenceId);
    if (!bytes) {
      throw Errors.notFound('EVIDENCE_NOT_FOUND', 'Evidence not found');
    }

    await recordAudit({
      tenantId: auth.tenantId,
      userId: auth.userId,
      requestId: req.requestId,
      ip: req.ip,
      action: 'SYTELINE_TASK_EVIDENCE_READ',
      success: true,
      // Identifiers only — never evidence bytes.
      metadata: { taskId, evidenceId, bytes: bytes.length },
    });

    reply.header('content-type', 'image/png');
    reply.header('content-length', bytes.length);
    reply.header('cache-control', 'private, max-age=3600');
    return reply.send(bytes);
  });

  fastify.post('/syteline-tasks/generate', {
    preHandler: [requireAuth, requirePermission('syteline:ui'), requireUiEnabled],
    config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
  }, async (req: FastifyRequest, reply: FastifyReply) => {
    const auth = req.auth!;
    const parsed = generateTasksInput.safeParse(req.body);
    if (!parsed.success) {
      validationError('Invalid generate request', parsed.error.issues);
    }
    const { goal, count } = parsed.data;

    // Abort model generation if the client disconnects.
    const controller = new AbortController();
    (req.raw as unknown as NodeJS.EventEmitter).on('close', () => controller.abort());

    // Fail-closed: schema/model failures throw 502 before any task exists.
    const items = await generateTaskList(goal, count, auth, controller.signal);

    const created: Array<{ id: string; title: string }> = [];
    for (const item of items) {
      const task = await createTask(
        auth,
        { title: item.title, goal: item.goal },
        auth.clearance,
      );
      await recordAudit({
        tenantId: auth.tenantId,
        userId: auth.userId,
        requestId: req.requestId,
        action: 'SYTELINE_TASK_CREATED',
        success: true,
        metadata: {
          taskId: task._id,
          title: task.title,
          autoApproveWrites: task.autoApproveWrites,
          generated: true,
        },
      });
      created.push({ id: task._id, title: task.title });
    }
    await recordAudit({
      tenantId: auth.tenantId,
      userId: auth.userId,
      requestId: req.requestId,
      action: 'SYTELINE_TASK_GENERATED',
      success: true,
      // Identifiers and counts only — the goal text may carry operational detail.
      metadata: { requested: count, created: created.length, taskIds: created.map((t) => t.id) },
    });
    // Nudge the runner for an out-of-band sweep (no-op when disabled).
    kickTaskRunner();
    return reply.send({ tasks: created });
  });
}
