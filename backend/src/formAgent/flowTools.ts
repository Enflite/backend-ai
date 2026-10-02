/**
 * flowTools.ts — the `formagent.*` tool definitions.
 *
 * These are the platform-registry (tools/gateway.ts) face of the SyteLine
 * Form AI Agent's pipeline steps. Each tool wraps one pure step function
 * from steps.ts with explicit arguments (no shared values bag), so the
 * pipeline can run as a versioned flow on the Flows platform
 * (flows/syteline-form-customization.flow.json) while the step logic
 * stays exactly the same.
 *
 * Two side-channels keep the product behavior identical to the bespoke
 * runner:
 * - Blocked steps: the tool records (blockedCode, blockedDetail) on the
 *   customization doc via `notePendingBlocked`, then throws the code as
 *   an Errors.badRequest. The platform runner's onStepOutcome reads the
 *   side-channel back, so the API's blocked codes/details are byte-for-
 *   byte what the bespoke runner produced.
 * - Progressive step log: each tool appends its own `done` outcome to the
 *   doc's step log (+ FORM_CUSTOMIZATION_STEP audit), idempotently — the
 *   route already logged `intake`, so the intake tool's note is a no-op
 *   when the manifest short-circuit fires.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { getDb } from '../db/mongo.js';
import { recordAudit } from '../audit/audit.js';
import { Errors } from '../errors.js';
import type { ToolDefinition } from '../tools/gateway.js';
import type { Classification } from '../authz/permissions.js';
import {
  applyChangesTrn,
  backupOriginals,
  buildPlanContext,
  compareTrnPrd,
  inboxDirFor,
  openReviewPr,
  stageIntake,
  validateStagedInputs,
  verifyBuild,
  type CustomizationPlan,
  type PureStepResult,
} from './steps.js';
import { notePendingBlocked } from './store.js';
import type { FormCustomizationDoc } from './types.js';

const FORM_AGENT_CLASSIFICATIONS: Classification[] = ['PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'PROPRIETARY'];

type BlockedResult = Extract<PureStepResult, { status: 'blocked' }>;

/**
 * Record a blocked outcome on the customization doc, then throw the
 * enumerated code so the platform runner's onStepOutcome can map the
 * failed tool call back to the exact blocked code/detail the bespoke
 * runner produced.
 */
async function throwBlocked(
  tenantId: string,
  customizationId: string,
  result: BlockedResult,
): Promise<never> {
  await notePendingBlocked(tenantId, customizationId, result.blockedCode, result.blockedDetail).catch(
    () => undefined,
  );
  throw Errors.badRequest(result.blockedCode, result.blockedDetail);
}

/**
 * Progressively append a `done` step outcome to the customization's step
 * log (+ FORM_CUSTOMIZATION_STEP audit). Idempotent per step name: the
 * route already logged `intake`, and the runner's final sync covers any
 * step whose tool never ran.
 */
async function noteStepDone(
  tenantId: string,
  customizationId: string,
  stepName: string,
  detail: string | undefined,
): Promise<void> {
  try {
    const db = await getDb();
    const col = db.collection<FormCustomizationDoc>('form_customizations');
    const doc = await col.findOne(
      { _id: customizationId, tenantId },
      { projection: { steps: 1, requesterUserId: 1 } },
    );
    if (!doc) return;
    if ((doc.steps ?? []).some((s) => s.name === stepName)) return;
    const now = new Date();
    await col.updateOne(
      { _id: customizationId, tenantId },
      {
        $push: {
          steps: { name: stepName, status: 'done', startedAt: now, completedAt: now, detail },
        },
        $set: { updatedAt: now },
      },
    );
    await recordAudit({
      tenantId,
      userId: doc.requesterUserId,
      requestId: `form-customization-${customizationId}`,
      action: 'FORM_CUSTOMIZATION_STEP',
      success: true,
      metadata: { customizationId, step: stepName },
    });
  } catch {
    // best-effort: the runner's final sync covers any gap
  }
}

async function handleStepResult(
  tenantId: string,
  customizationId: string,
  stepName: string,
  result: PureStepResult,
): Promise<Record<string, unknown>> {
  if (result.status === 'blocked') {
    await throwBlocked(tenantId, customizationId, result);
    throw new Error('unreachable: throwBlocked never returns');
  }
  await noteStepDone(tenantId, customizationId, stepName, result.detail);
  return result.outputs;
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

const intakeTool: ToolDefinition = {
  name: 'formagent.intake',
  description:
    'Validate the five SyteLine form-customization inputs and stage them into the request inbox. ' +
    'Idempotent: when the inbox manifest already exists for the customization, the staged result is returned without re-writing.',
  action: 'intake',
  destructive: false,
  permission: 'syteline:forms',
  allowedClassifications: FORM_AGENT_CLASSIFICATIONS,
  // The staged inputs can be ~10MB; they must never persist in cleartext
  // in tool_executions. Redaction is shallow by convention, so the large
  // values stay top-level in the schema.
  secretParams: ['formXml', 'idoPropertiesCsv', 'sqlColumnsCsv', 'attachmentContents'],
  schema: z
    .object({
      formName: z.string().min(1).max(80),
      title: z.string().min(1).max(200),
      instructions: z.array(z.string().min(1).max(4000)).min(1).max(50),
      formXml: z.string().min(1),
      idoPropertiesCsv: z.string().min(1),
      sqlColumnsCsv: z.string().min(1),
      attachmentNames: z.array(z.string().min(1).max(255)).max(20).default([]),
      attachmentContents: z.array(z.string()).max(20).default([]),
      source: z.enum(['json', 'multipart']).default('json'),
      repo: z.string().min(1).max(200),
      customizationId: z.string().min(1).max(64),
    })
    .strict(),
  execute: async (input, ctx) => {
    const tenantId = ctx.auth.tenantId;
    const customizationId = (input as { customizationId: string }).customizationId;
    const typed = input as {
      formName: string;
      title: string;
      instructions: string[];
      formXml: string;
      idoPropertiesCsv: string;
      sqlColumnsCsv: string;
      attachmentNames: string[];
      attachmentContents: string[];
      source: 'json' | 'multipart';
      repo: string;
    };
    // Idempotent short-circuit: the route already staged this inbox
    // (synchronous intake, before any run existed). Never re-stage.
    const inboxDir = inboxDirFor(customizationId);
    const manifestPath = join(inboxDir, 'manifest.json');
    if (existsSync(manifestPath)) {
      try {
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
          formName: string;
          attachmentNames: string[];
        };
        if (manifest.formName === typed.formName) {
          const hasPrdOriginal = manifest.attachmentNames.some((n) =>
            /\.production\.original\.xml$/i.test(n),
          );
          return { inboxDir, hasPrdOriginal };
        }
      } catch {
        // fall through to a full stage
      }
    }
    if (typed.attachmentNames.length !== typed.attachmentContents.length) {
      throw Errors.badRequest(
        'VALIDATION_ERROR',
        'attachmentNames and attachmentContents must be parallel arrays.',
      );
    }
    const staged = await stageIntake({
      formName: typed.formName,
      title: typed.title,
      instructions: typed.instructions,
      formXml: Buffer.from(typed.formXml, 'utf8'),
      idoCsv: typed.idoPropertiesCsv,
      sqlCsv: typed.sqlColumnsCsv,
      attachments: typed.attachmentNames.map((filename, i) => ({
        filename,
        bytes: Buffer.from(typed.attachmentContents[i] ?? '', 'base64'),
      })),
      source: typed.source,
      repo: typed.repo,
      customizationId,
    });
    await noteStepDone(tenantId, customizationId, 'intake', `form=${typed.formName}`);
    return staged;
  },
};

const validateInputsTool: ToolDefinition = {
  name: 'formagent.validate_inputs',
  description:
    'Run the malware boundary and XML/CSV shape checks over the staged inbox. ' +
    'Returns the form name and the planner context excerpts for the agent step.',
  action: 'validate-inputs',
  destructive: false,
  permission: 'syteline:forms',
  allowedClassifications: FORM_AGENT_CLASSIFICATIONS,
  // The planner context excerpts (~20KB) exceed runToolCall's default
  // 8000-char output truncation; raise the cap so the agent step's
  // template references resolve to full data.
  outputLimit: 65536,
  schema: z
    .object({
      customizationId: z.string().min(1).max(64),
      inboxDir: z.string().min(1).max(500),
      title: z.string().min(1).max(200),
      instructions: z.array(z.string().min(1).max(4000)).min(1).max(50),
    })
    .strict(),
  execute: async (input, ctx) => {
    const typed = input as {
      customizationId: string;
      inboxDir: string;
      title: string;
      instructions: string[];
    };
    const result = await validateStagedInputs(typed.inboxDir);
    const outputs = await handleStepResult(ctx.auth.tenantId, typed.customizationId, 'validate-inputs', result);
    const planContext = buildPlanContext({
      inboxDir: typed.inboxDir,
      formName: outputs['formName'] as string,
      title: typed.title,
      instructions: typed.instructions,
    });
    return { ...outputs, planContext };
  },
};

const backupOriginalsTool: ToolDefinition = {
  name: 'formagent.backup_originals',
  description:
    'Scaffold the form project and record the TRN + production rollback originals. ' +
    'Blocks when the production original is missing.',
  action: 'backup-originals',
  destructive: false,
  permission: 'syteline:forms',
  allowedClassifications: FORM_AGENT_CLASSIFICATIONS,
  schema: z
    .object({
      customizationId: z.string().min(1).max(64),
      inboxDir: z.string().min(1).max(500),
      formName: z.string().min(1).max(80),
      title: z.string().min(1).max(200),
      repo: z.string().min(1).max(200),
    })
    .strict(),
  execute: async (input, ctx) => {
    const typed = input as {
      customizationId: string;
      inboxDir: string;
      formName: string;
      title: string;
      repo: string;
    };
    const result = await backupOriginals({
      inboxDir: typed.inboxDir,
      formName: typed.formName,
      title: typed.title,
      repo: typed.repo,
      customizationId: typed.customizationId,
    });
    return handleStepResult(ctx.auth.tenantId, typed.customizationId, 'backup-originals', result);
  },
};

const compareTrnPrdTool: ToolDefinition = {
  name: 'formagent.compare_trn_prd',
  description:
    'Compare the TRN and production originals byte-for-byte. Any drift blocks the build.',
  action: 'compare-trn-prd',
  destructive: false,
  permission: 'syteline:forms',
  allowedClassifications: FORM_AGENT_CLASSIFICATIONS,
  schema: z
    .object({
      customizationId: z.string().min(1).max(64),
      trnFile: z.string().min(1).max(500),
      prdFile: z.string().min(1).max(500),
    })
    .strict(),
  execute: async (input, ctx) => {
    const typed = input as { customizationId: string; trnFile: string; prdFile: string };
    const result = await compareTrnPrd(typed.trnFile, typed.prdFile);
    return handleStepResult(ctx.auth.tenantId, typed.customizationId, 'compare-trn-prd', result);
  },
};

const applyChangesTool: ToolDefinition = {
  name: 'formagent.apply_changes_trn',
  description:
    'Build the customized <Form>.xml from the TRN original using the agent-produced plan. ' +
    'Re-validates the plan against the UET contract before building.',
  action: 'apply-changes-trn',
  destructive: false,
  permission: 'syteline:forms',
  allowedClassifications: FORM_AGENT_CLASSIFICATIONS,
  schema: z
    .object({
      customizationId: z.string().min(1).max(64),
      plan: z.unknown(),
      trnFile: z.string().min(1).max(500),
      projectDir: z.string().min(1).max(500),
      formName: z.string().min(1).max(80),
    })
    .strict(),
  execute: async (input, ctx) => {
    const typed = input as {
      customizationId: string;
      plan: CustomizationPlan;
      trnFile: string;
      projectDir: string;
      formName: string;
    };
    const result = await applyChangesTrn({
      plan: typed.plan,
      trnFile: typed.trnFile,
      projectDir: typed.projectDir,
      formName: typed.formName,
    });
    return handleStepResult(ctx.auth.tenantId, typed.customizationId, 'apply-changes-trn', result);
  },
};

const verifyTool: ToolDefinition = {
  name: 'formagent.verify',
  description:
    'Run the deterministic rebuild check, render the project docs, and build the implementation-plan deck.',
  action: 'verify',
  destructive: false,
  permission: 'syteline:forms',
  allowedClassifications: FORM_AGENT_CLASSIFICATIONS,
  schema: z
    .object({
      customizationId: z.string().min(1).max(64),
      plan: z.unknown(),
      projectDir: z.string().min(1).max(500),
      formName: z.string().min(1).max(80),
      sha256Prefix: z.string().min(1).max(64),
      formXmlFile: z.string().min(1).max(500),
      trnFile: z.string().min(1).max(500),
      title: z.string().min(1).max(200),
      instructions: z.array(z.string().min(1).max(4000)).min(1).max(50),
      requestedBy: z.string().max(200).optional(),
      repo: z.string().min(1).max(200),
    })
    .strict(),
  execute: async (input, ctx) => {
    const typed = input as {
      customizationId: string;
      plan: CustomizationPlan;
      projectDir: string;
      formName: string;
      sha256Prefix: string;
      formXmlFile: string;
      trnFile: string;
      title: string;
      instructions: string[];
      requestedBy?: string;
      repo: string;
    };
    const result = await verifyBuild({
      plan: typed.plan,
      projectDir: typed.projectDir,
      formName: typed.formName,
      sha256Prefix: typed.sha256Prefix,
      formXmlFile: typed.formXmlFile,
      trnFile: typed.trnFile,
      title: typed.title,
      instructions: typed.instructions,
      requestedBy: typed.requestedBy,
      repo: typed.repo,
    });
    return handleStepResult(ctx.auth.tenantId, typed.customizationId, 'verify', result);
  },
};

const openPrTool: ToolDefinition = {
  name: 'formagent.open_pr',
  description:
    'Push the project branch and OPEN the review PR. Never merges — a person reviews and merges.',
  action: 'open-pr',
  destructive: false,
  permission: 'syteline:forms',
  allowedClassifications: FORM_AGENT_CLASSIFICATIONS,
  schema: z
    .object({
      customizationId: z.string().min(1).max(64),
      plan: z.unknown(),
      projectDir: z.string().min(1).max(500),
      formName: z.string().min(1).max(80),
      title: z.string().min(1).max(200),
      repo: z.string().min(1).max(200),
    })
    .strict(),
  execute: async (input, ctx) => {
    const typed = input as {
      customizationId: string;
      plan: CustomizationPlan;
      projectDir: string;
      formName: string;
      title: string;
      repo: string;
    };
    const result = await openReviewPr({
      plan: typed.plan,
      projectDir: typed.projectDir,
      formName: typed.formName,
      title: typed.title,
      repo: typed.repo,
      customizationId: typed.customizationId,
    });
    return handleStepResult(ctx.auth.tenantId, typed.customizationId, 'open-pr', result);
  },
};

/** The seven `formagent.*` tools, registered in tools/gateway.ts. */
export const formAiToolDefinitions: readonly ToolDefinition[] = [
  intakeTool,
  validateInputsTool,
  backupOriginalsTool,
  compareTrnPrdTool,
  applyChangesTool,
  verifyTool,
  openPrTool,
];

/** Map a platform step id to its formagent tool name. */
export function formAgentToolForStep(stepId: string): string | undefined {
  const found = formAiToolDefinitions.find((d) => d.action === stepId);
  return found?.name;
}
