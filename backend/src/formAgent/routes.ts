/**
 * routes.ts — versioned REST API for the SyteLine Form AI Agent
 * (`/api/v1/form-customizations`).
 *
 * A person or system POSTs a form-customization request carrying the five
 * inputs (form XML, IDO properties CSV, SQL columns CSV, instructions,
 * attachments); the backend runs the whole Form-Project-Templates flow
 * and reports back with the review PR link. Form-project PRs are NEVER
 * auto-merged.
 *
 * Endpoints:
 * - POST   /form-customizations              create (JSON or multipart) → 202
 * - GET    /form-customizations              list (requester sees own; admins see tenant's)
 * - GET    /form-customizations/:id          full request record
 * - POST   /form-customizations/:id/cancel   cancel (ends work in flight)
 * - POST   /form-customizations/:id/mark-merged  human records the PR merge → completed
 *
 * Access: auth + `syteline:forms` permission + Admin/AI Admin role
 * (ADR-021 §3), fail-fast 403 FEATURE_DISABLED while
 * FORM_CUSTOMIZATION_API_ENABLED=false.
 */

import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { randomUUID } from 'node:crypto';
import { relative } from 'node:path';
import { z } from 'zod';
import { requireAuth } from '../auth/middleware.js';
import { requirePermission } from '../authz/middleware.js';
import type { AuthContext } from '../authz/permissions.js';
import { AppError, Errors } from '../errors.js';
import { config } from '../config.js';
import { recordAudit } from '../audit/audit.js';
import { formProjectsRoot } from '../syteline/forms/index.js';
import { FORM_CUSTOMIZATION_FLOW_NAME } from './flowEnsure.js';
import { StepInputError, cleanupInbox, stageIntake } from './steps.js';
import { cancelCustomizationRun } from './runner.js';
import { kickFormAgentRunner } from './scheduler.js';
import { FORM_AGENT_VERSION, PRODUCT_NAME } from './version.js';
import {
  createCustomizationInput,
  customizationIdParam,
  decodeAttachment,
  listCustomizationsQuery,
  productInfo,
  publicDetailView,
  publicListItem,
  assertRequestReadable,
  MAX_ATTACHMENT_BYTES,
  MAX_CSV_PART_BYTES,
  MAX_MULTIPART_FILES,
  MAX_XML_PART_BYTES,
  type CreateCustomizationInput,
  type FlowStepOutcome,
  type FormCustomizationDoc,
} from './types.js';
import {
  cancelCustomization,
  createCustomization,
  getCustomization,
  listCustomizations,
  markCustomizationMerged,
} from './store.js';

/** ADR-021 §3: the product surface is Admin / AI Admin only — never the User role. */
const FORM_AGENT_ROLES = new Set(['Admin', 'AI Admin']);

async function requireFormAgentRole(req: FastifyRequest, _reply: FastifyReply): Promise<void> {
  const auth = req.auth!;
  if (!FORM_AGENT_ROLES.has(auth.roleName)) {
    await recordAudit({
      tenantId: auth.tenantId,
      userId: auth.userId,
      requestId: req.requestId,
      ip: req.ip,
      action: 'AUTHORIZATION_FAILURE',
      success: false,
      reason: `Role not allowed for the SyteLine Form AI Agent: ${auth.roleName}`,
      metadata: { method: req.method, route: req.routeOptions.url },
    });
    throw Errors.forbidden(
      'FORBIDDEN',
      'The SyteLine Form AI Agent is available to the Admin and AI Admin roles',
    );
  }
}

async function requireFeatureEnabled(_req: FastifyRequest, _reply: FastifyReply): Promise<void> {
  if (!config.FORM_CUSTOMIZATION_API_ENABLED) {
    throw Errors.forbidden(
      'FEATURE_DISABLED',
      'The SyteLine Form AI Agent is disabled (FORM_CUSTOMIZATION_API_ENABLED=false)',
    );
  }
}

/** Admins (tenant:manage) see the tenant's requests; others see only their own. */
function isRequestAdmin(auth: AuthContext): boolean {
  return auth.permissions.includes('tenant:manage');
}

function validationError(message: string, details?: unknown): never {
  throw Errors.badRequest('VALIDATION_ERROR', message, details);
}

// ---------------------------------------------------------------------------
// Request parsing: JSON or multipart, one schema
// ---------------------------------------------------------------------------

interface MultipartFile {
  fieldname: string;
  filename: string;
  data: Buffer;
}

/**
 * Assemble a multipart request into the shared JSON input shape. File
 * parts are named `formXml`, `idoPropertiesCsv`, `sqlColumnsCsv`, and
 * repeatable `attachments` / `attachments[]`; text fields carry
 * `formName`, `title`, `requestedBy`, and `instructions` (JSON array or
 * newline-delimited). The production original arrives as a
 * `*.production.original.xml` attachment (ADR-021 §6).
 */
async function parseMultipartBody(req: FastifyRequest): Promise<CreateCustomizationInput> {
  const fields: Record<string, string> = {};
  const files: MultipartFile[] = [];
  try {
    const parts = (req as unknown as {
      parts: (options?: unknown) => AsyncIterableIterator<any>;
    }).parts({
      limits: {
        files: MAX_MULTIPART_FILES,
        fileSize: MAX_XML_PART_BYTES,
        fields: 12,
        parts: MAX_MULTIPART_FILES + 12,
      },
    });
    for await (const part of parts) {
      if (part.file) {
        if (files.length >= MAX_MULTIPART_FILES) {
          throw new StepInputError('MULTIPART_LIMIT_EXCEEDED', `At most ${MAX_MULTIPART_FILES} file parts are accepted`);
        }
        const data: Buffer = await part.toBuffer();
        files.push({ fieldname: part.fieldname, filename: part.filename ?? 'upload', data });
      } else {
        fields[part.fieldname] = String(part.value ?? '');
      }
    }
  } catch (error) {
    if (error instanceof StepInputError) throw error;
    if ((error as { code?: string }).code === 'FST_REQ_FILE_TOO_LARGE') {
      throw new AppError(413, 'PART_TOO_LARGE', 'A file part exceeded its size limit');
    }
    throw error;
  }

  const oneFile = (name: string): MultipartFile | undefined => {
    const found = files.filter((f) => f.fieldname === name);
    if (found.length > 1) {
      throw new StepInputError('VALIDATION_ERROR', `Only one "${name}" file part is accepted`, { part: name });
    }
    return found[0];
  };
  const checkExtension = (file: MultipartFile | undefined, part: string, ext: string): void => {
    if (file && !file.filename.toLowerCase().endsWith(ext)) {
      throw new StepInputError('VALIDATION_ERROR', `Part "${part}" must be a ${ext} file`, { part });
    }
  };
  const checkSize = (file: MultipartFile | undefined, part: string, max: number): void => {
    if (file && file.data.length > max) {
      throw new AppError(413, 'PART_TOO_LARGE', `Part "${part}" exceeds its size limit`, { part });
    }
  };

  const formXmlFile = oneFile('formXml');
  const idoFile = oneFile('idoPropertiesCsv');
  const sqlFile = oneFile('sqlColumnsCsv');
  checkExtension(formXmlFile, 'formXml', '.xml');
  checkExtension(idoFile, 'idoPropertiesCsv', '.csv');
  checkExtension(sqlFile, 'sqlColumnsCsv', '.csv');
  checkSize(formXmlFile, 'formXml', MAX_XML_PART_BYTES);
  checkSize(idoFile, 'idoPropertiesCsv', MAX_CSV_PART_BYTES);
  checkSize(sqlFile, 'sqlColumnsCsv', MAX_CSV_PART_BYTES);

  // instructions: JSON array or newline-delimited text.
  let instructions: unknown;
  const rawInstructions = fields.instructions ?? '';
  if (rawInstructions.trim() !== '') {
    try {
      instructions = JSON.parse(rawInstructions);
    } catch {
      instructions = rawInstructions
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
    }
  }

  const attachmentFiles = files.filter((f) => f.fieldname === 'attachments' || f.fieldname === 'attachments[]');
  for (const file of attachmentFiles) {
    if (file.data.length > MAX_ATTACHMENT_BYTES) {
      throw new AppError(413, 'PART_TOO_LARGE', `Attachment "${file.filename}" exceeds the size limit`, { part: 'attachments' });
    }
  }
  const attachments = attachmentFiles.map((f) => ({
    filename: f.filename.split('/').pop()!.split('\\').pop()!,
    contentBase64: f.data.toString('base64'),
  }));

  const assembled = {
    formName: fields.formName,
    title: fields.title === '' ? undefined : fields.title,
    requestedBy: fields.requestedBy === '' ? undefined : fields.requestedBy,
    instructions,
    formXml: formXmlFile?.data.toString('utf8'),
    idoPropertiesCsv: idoFile?.data.toString('utf8'),
    sqlColumnsCsv: sqlFile?.data.toString('utf8'),
    attachments,
  };
  // The production original arrives as a *.production.original.xml attachment (ADR-021 §6).
  const parsed = createCustomizationInput.safeParse(assembled);
  if (!parsed.success) {
    throw new StepInputError('VALIDATION_ERROR', 'The customization request is invalid', parsed.error.flatten());
  }
  return parsed.data;
}

function parseJsonBody(body: unknown): CreateCustomizationInput {
  const parsed = createCustomizationInput.safeParse(body);
  if (!parsed.success) {
    throw new StepInputError('VALIDATION_ERROR', 'The customization request is invalid', parsed.error.flatten());
  }
  return parsed.data;
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

const formAgentPreHandlers = [requireAuth, requirePermission('syteline:forms'), requireFormAgentRole, requireFeatureEnabled];

export async function formAgentRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.post('/form-customizations', {
    preHandler: formAgentPreHandlers,
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    const auth = req.auth!;
    const contentType = String(req.headers['content-type'] ?? '');
    let input: CreateCustomizationInput;
    let source: 'json' | 'multipart';
    try {
      if (contentType.includes('multipart/form-data')) {
        input = await parseMultipartBody(req);
        source = 'multipart';
      } else {
        input = parseJsonBody(req.body);
        source = 'json';
      }
    } catch (error) {
      if (error instanceof StepInputError) {
        return reply.status(error.httpStatus).send({
          error: { code: error.code, message: error.message, requestId: req.requestId, details: error.details },
        });
      }
      throw error;
    }

    // Decode attachments to bytes (validates base64 + sizes).
    let attachments: { filename: string; bytes: Buffer }[];
    try {
      attachments = input.attachments.map((a) =>
        decodeAttachment(a as { filename: string; content?: string; contentBase64?: string }),
      );
    } catch (error) {
      return reply.status(400).send({
        error: {
          code: 'VALIDATION_ERROR',
          message: error instanceof Error ? error.message : 'Attachment is invalid',
          requestId: req.requestId,
          details: { part: 'attachments' },
        },
      });
    }
    const seen = new Set<string>();
    for (const attachment of attachments) {
      if (seen.has(attachment.filename)) {
        return reply.status(400).send({
          error: {
            code: 'VALIDATION_ERROR',
            message: `Duplicate attachment filename: ${attachment.filename}`,
            requestId: req.requestId,
            details: { part: 'attachments' },
          },
        });
      }
      seen.add(attachment.filename);
    }

    // Intake runs synchronously here (direct stageIntake call, before any
    // run exists): semantic validation + inbox staging. Failures → 4xx,
    // no run created. The platform flow's `intake` step short-circuits on
    // the staged manifest when the runner executes.
    const customizationId = randomUUID();
    let inboxDir: string;
    let hasPrdOriginal: boolean;
    try {
      const staged = await stageIntake({
        formName: input.formName,
        title: input.title,
        instructions: input.instructions,
        formXml: Buffer.from(input.formXml, 'utf8'),
        idoCsv: input.idoPropertiesCsv,
        sqlCsv: input.sqlColumnsCsv,
        attachments,
        source,
        repo: `${config.FORM_CUSTOMIZATION_GITHUB_ORG}/${input.formName}`,
        customizationId,
      });
      inboxDir = staged.inboxDir;
      hasPrdOriginal = staged.hasPrdOriginal;
    } catch (error) {
      if (error instanceof StepInputError) {
        return reply.status(error.httpStatus).send({
          error: { code: error.code, message: error.message, requestId: req.requestId, details: error.details },
        });
      }
      throw error;
    }
    const intakeOutcome: FlowStepOutcome = {
      name: 'intake',
      status: 'done',
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      outputs: { 'inbox.dir': inboxDir, 'inbox.hasPrdOriginal': hasPrdOriginal },
      detail: `form=${input.formName}`,
    };
    const projectDir = `${input.formName}-${customizationId.slice(0, 8)}`;
    let doc;
    try {
      doc = await createCustomization(auth, {
      _id: customizationId,
      formName: input.formName,
      title: input.title,
      requestedBy: input.requestedBy,
      instructions: input.instructions,
      flowName: FORM_CUSTOMIZATION_FLOW_NAME,
      flowVersion: 'live',
      inboxDir: relative(formProjectsRoot(), inboxDir),
      projectDir,
      repo: `${config.FORM_CUSTOMIZATION_GITHUB_ORG}/${input.formName}`,
      hasPrdOriginal,
      inlineNormalized: source === 'json',
      attachmentNames: attachments.map((a) => a.filename),
      intakeOutcome,
    });
    } catch (error) {
      // The run record failed to persist: remove the staged inbox so no
      // orphaned bytes accumulate, then surface the failure.
      cleanupInbox(inboxDir);
      throw error;
    }
    await recordAudit({
      tenantId: auth.tenantId,
      userId: auth.userId,
      requestId: req.requestId,
      action: 'FORM_CUSTOMIZATION_REQUESTED',
      success: true,
      metadata: {
        customizationId: doc._id,
        formName: doc.formName,
        instructionCount: doc.instructions.length,
        flowVersion: doc.flowVersion,
      },
    });
    // Nudge the runner for an out-of-band sweep (no-op when disabled).
    kickFormAgentRunner();
    return reply.status(202).send({
      id: doc._id,
      status: doc.status,
      formName: doc.formName,
      createdAt: doc.createdAt.toISOString(),
      product: { name: PRODUCT_NAME, version: FORM_AGENT_VERSION },
    });
  });

  fastify.get('/form-customizations', {
    preHandler: formAgentPreHandlers,
  }, async (req, reply) => {
    const auth = req.auth!;
    const query = listCustomizationsQuery.safeParse(req.query);
    if (!query.success) validationError('Invalid list query', query.error.flatten());
    const docs = await listCustomizations(auth.tenantId, auth.userId, isRequestAdmin(auth), {
      status: query.data.status,
      limit: query.data.limit,
    });
    return reply.send({ items: docs.map(publicListItem) });
  });

  fastify.get('/form-customizations/:id', {
    preHandler: formAgentPreHandlers,
  }, async (req, reply) => {
    const auth = req.auth!;
    const params = customizationIdParam.safeParse(req.params);
    if (!params.success) validationError('Invalid request id', params.error.flatten());
    const doc: FormCustomizationDoc | null = await getCustomization(auth.tenantId, params.data.id);
    if (!doc) throw Errors.notFound('NOT_FOUND', 'Request not found');
    assertRequestReadable(doc, auth.userId, isRequestAdmin(auth));
    return reply.send(publicDetailView(doc));
  });

  const mutableAction = (
    action: 'cancel' | 'mark-merged',
    run: (tenantId: string, id: string) => Promise<FormCustomizationDoc | null>,
    auditAction: string,
  ) => async (req: FastifyRequest, reply: FastifyReply) => {
    const auth = req.auth!;
    const params = customizationIdParam.safeParse(req.params);
    if (!params.success) validationError('Invalid request id', params.error.flatten());
    const doc: FormCustomizationDoc | null = await getCustomization(auth.tenantId, params.data.id);
    if (!doc) throw Errors.notFound('NOT_FOUND', 'Request not found');
    assertRequestReadable(doc, auth.userId, isRequestAdmin(auth));
    const updated = await run(auth.tenantId, params.data.id);
    if (!updated) {
      throw Errors.conflict('REQUEST_ALREADY_TERMINAL', `Request is already ${doc.status}`);
    }
    await recordAudit({
      tenantId: auth.tenantId,
      userId: auth.userId,
      requestId: req.requestId,
      action: auditAction,
      success: true,
      metadata: { customizationId: doc._id, formName: doc.formName, action },
    });
    return reply.send({ id: updated._id, status: updated.status, product: productInfo() });
  };

  fastify.post('/form-customizations/:id/cancel', {
    preHandler: formAgentPreHandlers,
  }, async (req, reply) => {
    const auth = req.auth!;
    const params = customizationIdParam.safeParse(req.params);
    if (!params.success) validationError('Invalid request id', params.error.flatten());
    const doc: FormCustomizationDoc | null = await getCustomization(auth.tenantId, params.data.id);
    if (!doc) throw Errors.notFound('NOT_FOUND', 'Request not found');
    assertRequestReadable(doc, auth.userId, isRequestAdmin(auth));
    // Bridge the cancel onto the platform flow run (if one is in flight)
    // before marking the customization cancelled.
    await cancelCustomizationRun(doc).catch(() => undefined);
    const updated = await cancelCustomization(auth.tenantId, params.data.id);
    if (!updated) {
      throw Errors.conflict('REQUEST_ALREADY_TERMINAL', `Request is already ${doc.status}`);
    }
    await recordAudit({
      tenantId: auth.tenantId,
      userId: auth.userId,
      requestId: req.requestId,
      action: 'FORM_CUSTOMIZATION_CANCELLED',
      success: true,
      metadata: { customizationId: doc._id, formName: doc.formName, action: 'cancel' },
    });
    return reply.send({ id: updated._id, status: updated.status, product: productInfo() });
  });

  // A human records the review-PR merge: awaiting_review → completed.
  // The agent has no merge capability and never calls this.
  fastify.post('/form-customizations/:id/mark-merged', {
    preHandler: formAgentPreHandlers,
  }, mutableAction('mark-merged', markCustomizationMerged, 'FORM_CUSTOMIZATION_MERGED'));
}
