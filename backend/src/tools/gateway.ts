import { z } from 'zod';
import { AuthContext, Classification, Permission } from '../authz/permissions.js';
import { assertClassificationAllowed } from '../authz/classification.js';
import { tenantQuery } from '../db/pool.js';
import { recordAudit, sanitizeReason } from '../audit/audit.js';
import { config } from '../config.js';
import { Errors } from '../errors.js';
import { canModelProcess } from '../policy/engine.js';
import { getSyteLineAdapter } from './syteline.js';

export interface ToolDefinition<T = unknown> {
  name: string;
  description: string;
  action: string;
  destructive: boolean;
  allowedClassifications: Classification[];
  /**
   * Permission required to run this tool, checked in application code by
   * authorizeTool. Defaults to 'tool:use'. The SyteLine read tools require
   * 'syteline:read' so ERP access can be granted or revoked independently of
   * other tool use.
   */
  permission?: Permission;
  schema: z.ZodType<T>;
  execute(input: T, signal: AbortSignal): Promise<unknown>;
}

// Identifier shapes accepted by the SyteLine tools. Strict character
// classes keep model-supplied values from becoming injection vectors at
// the adapter layer; the adapter itself only ever interpolates them as
// URL query parameters.
const sytelineItemId = () => z.string().trim().min(1).max(80).regex(/^[A-Za-z0-9._/-]+$/);
const sytelineOrderId = () => z.string().trim().min(1).max(40).regex(/^[A-Za-z0-9._/-]+$/);
const sytelineCustomerId = () => z.string().trim().min(1).max(40).regex(/^[A-Za-z0-9._-]+$/);
const sytelineSiteId = () => z.string().trim().min(1).max(40).regex(/^[A-Za-z0-9_-]+$/);

const SYTELINE_CLASSIFICATIONS: Classification[] = ['PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'PROPRIETARY'];

export const toolRegistry: readonly ToolDefinition<any>[] = [
  {
    name: 'syteline.getItem',
    description: 'Retrieve an item from the configured internal SyteLine site',
    action: 'read',
    destructive: false,
    permission: 'syteline:read',
    allowedClassifications: SYTELINE_CLASSIFICATIONS,
    schema: z.object({
      item: sytelineItemId(),
      site: sytelineSiteId(),
    }).strict(),
    execute: (input, signal) => getSyteLineAdapter().getItem(input, signal),
  },
  {
    name: 'syteline.getSalesOrder',
    description:
      'Look up a SyteLine sales order by order number (returns header plus ' +
      'order lines), or list open orders for a customer by customerNumber. ' +
      'Start of a late-order investigation: the lines tell you which items ' +
      'to check with syteline.getItemAvailability.',
    action: 'read',
    destructive: false,
    permission: 'syteline:read',
    allowedClassifications: SYTELINE_CLASSIFICATIONS,
    schema: z.object({
      orderNumber: sytelineOrderId().optional(),
      customerNumber: sytelineCustomerId().optional(),
      site: sytelineSiteId().optional(),
      status: z.enum(['open', 'closed', 'all']).optional(),
    }).strict(),
    execute: (input: { orderNumber?: string; customerNumber?: string; site?: string; status?: string }, signal) => {
      if (!input.orderNumber && !input.customerNumber) {
        throw Errors.badRequest('MISSING_REQUIRED_PARAMETER', 'Provide orderNumber or customerNumber');
      }
      return getSyteLineAdapter().getSalesOrder(input, signal);
    },
  },
  {
    name: 'syteline.getItemAvailability',
    description:
      'On-hand, allocated, and available-to-promise quantities for an item ' +
      'at a site, plus recent inventory transactions (receipts, issues, ' +
      'adjustments) for forensics. Use after syteline.getSalesOrder to test ' +
      'whether each open line is covered.',
    action: 'read',
    destructive: false,
    permission: 'syteline:read',
    allowedClassifications: SYTELINE_CLASSIFICATIONS,
    schema: z.object({
      item: sytelineItemId(),
      site: sytelineSiteId(),
    }).strict(),
    execute: (input, signal) => getSyteLineAdapter().getItemAvailability(input, signal),
  },
  {
    name: 'syteline.getOpenPurchaseOrders',
    description:
      'Open purchase orders for an item, with promised dates, receipt ' +
      'status, and supplier. Use when syteline.getItemAvailability shows a ' +
      'shortage to see what supply is inbound and whether it is late.',
    action: 'read',
    destructive: false,
    permission: 'syteline:read',
    allowedClassifications: SYTELINE_CLASSIFICATIONS,
    schema: z.object({
      item: sytelineItemId(),
      site: sytelineSiteId().optional(),
    }).strict(),
    execute: (input, signal) => getSyteLineAdapter().getOpenPurchaseOrders(input, signal),
  },
  {
    name: 'syteline.getWorkOrders',
    description:
      'Look up work orders by work order number, or find work orders ' +
      'building an item. Returns status, quantities, and schedule dates. ' +
      'Use when the finished good is short but components are covered — ' +
      'the delay may be on the shop floor rather than in supply.',
    action: 'read',
    destructive: false,
    permission: 'syteline:read',
    allowedClassifications: SYTELINE_CLASSIFICATIONS,
    schema: z.object({
      workOrderNumber: sytelineOrderId().optional(),
      item: sytelineItemId().optional(),
      site: sytelineSiteId().optional(),
      status: z.string().trim().min(1).max(40).optional(),
    }).strict(),
    execute: (input: { workOrderNumber?: string; item?: string; site?: string; status?: string }, signal) => {
      if (!input.workOrderNumber && !input.item) {
        throw Errors.badRequest('MISSING_REQUIRED_PARAMETER', 'Provide workOrderNumber or item');
      }
      return getSyteLineAdapter().getWorkOrders(input, signal);
    },
  },
  {
    name: 'syteline.getBom',
    description:
      'Explode the bill of materials for a manufactured item into its ' +
      'components (quantity-per, level, lead time). Use when a manufactured ' +
      'item is short: check syteline.getItemAvailability for each component ' +
      'to find the blocking one.',
    action: 'read',
    destructive: false,
    permission: 'syteline:read',
    allowedClassifications: SYTELINE_CLASSIFICATIONS,
    schema: z.object({
      item: sytelineItemId(),
      site: sytelineSiteId().optional(),
      levels: z.number().int().min(1).max(5).default(3),
    }).strict(),
    execute: (input, signal) => getSyteLineAdapter().getBom(input, signal),
  },
  {
    name: 'syteline.getCustomer',
    description:
      'Look up a SyteLine customer record by customer number (name, ' +
      'status, credit hold). Pairs with syteline.getSalesOrder by ' +
      'customerNumber for backlog questions.',
    action: 'read',
    destructive: false,
    permission: 'syteline:read',
    allowedClassifications: SYTELINE_CLASSIFICATIONS,
    schema: z.object({
      customerNumber: sytelineCustomerId(),
    }).strict(),
    execute: (input, signal) => getSyteLineAdapter().getCustomer(input, signal),
  },
];

export function getTool(name: string): ToolDefinition<any> {
  const tool = toolRegistry.find((candidate) => candidate.name === name);
  if (!tool) throw Errors.notFound('TOOL_NOT_FOUND', 'Tool is not registered');
  return tool;
}

export function authorizeTool(
  auth: AuthContext,
  name: string,
  parameters: unknown,
  classification: Classification,
  confirmed: boolean,
): { definition: ToolDefinition<any>; input: unknown } {
  const definition = getTool(name);
  // Per-tool permission, enforced in application code — never by the model.
  // SyteLine tools require 'syteline:read' so ERP access is granted and
  // revoked independently of generic tool use.
  const requiredPermission = definition.permission ?? 'tool:use';
  if (!auth.permissions.includes(requiredPermission)) throw Errors.forbidden('TOOL_FORBIDDEN', 'Tool permission required');
  // The caller must be cleared for the classification the tool will process:
  // otherwise a PUBLIC-cleared user could run tools over CUI-labeled data by
  // simply asserting a higher classification in the request.
  assertClassificationAllowed(auth.clearance, classification);
  const policy = canModelProcess(classification, definition.allowedClassifications);
  if (!policy.allowed) throw Errors.forbidden('TOOL_CLASSIFICATION_DENIED', 'Tool cannot receive this data classification');
  if (definition.destructive && !confirmed) throw Errors.conflict('CONFIRMATION_REQUIRED', 'Destructive tool action requires explicit confirmation');
  const parsed = definition.schema.safeParse(parameters);
  if (!parsed.success) throw Errors.badRequest('INVALID_TOOL_PARAMETERS', 'Tool parameters are invalid', parsed.error.format());
  return { definition, input: parsed.data };
}

export async function executeTool(
  auth: AuthContext,
  name: string,
  parameters: unknown,
  classification: Classification,
  confirmed: boolean,
  signal: AbortSignal
): Promise<{ definition: ToolDefinition<any>; input: unknown; output: unknown }> {
  const prepared = authorizeTool(auth, name, parameters, classification, confirmed);
  return { ...prepared, output: await prepared.definition.execute(prepared.input, signal) };
}

export interface ToolCallResult {
  ok: boolean;
  executionId?: string;
  /** Model-context preview: JSON-serializable output, truncated to AI_TOOL_OUTPUT_MAX_CHARS when ok. */
  output?: string;
  /** Structured output for API consumers. When the output was truncated this
   * is a `{ truncated: true }` marker instead of partial JSON, so callers never
   * receive invalid or half-parsed data. */
  data?: unknown;
  /** True when `output` was truncated to AI_TOOL_OUTPUT_MAX_CHARS. */
  truncated?: boolean;
  errorCode?: string;
  message?: string;
}

/** Best-effort JSON serialization of tool output; never throws. */
function safeStringify(value: unknown): string {
  try {
    const rendered = JSON.stringify(value);
    return typeof rendered === 'string' ? rendered : 'null';
  } catch {
    try {
      return String(value).slice(0, 1024);
    } catch {
      return '[unserializable tool output]';
    }
  }
}

function toolErrorCode(error: unknown): string {
  return error instanceof Error && 'code' in error
    ? String((error as Error & { code: unknown }).code).slice(0, 100)
    : 'TOOL_EXECUTION_FAILED';
}

/**
 * Shared audited tool invocation used by both the direct /tools/:name/execute
 * endpoint and the chat agentic loop. Every attempt — denied, succeeded, or
 * failed — writes a tool_executions row and a TOOL_EXECUTION audit record with
 * the request correlation ID, so tool use is fully traceable.
 *
 * `rawArguments` is the JSON string produced by the model; unparseable or
 * schema-invalid arguments are reported as a structured failure (never thrown)
 * so the agentic loop can feed the error back to the model.
 */
export async function runToolCall(options: {
  auth: AuthContext;
  name: string;
  rawArguments: string;
  classification: Classification;
  confirmed?: boolean;
  requestId?: string;
  signal: AbortSignal;
}): Promise<ToolCallResult> {
  const { auth, name, classification, requestId, signal } = options;
  const confirmed = options.confirmed ?? false;

  let parameters: unknown;
  try {
    parameters = JSON.parse(options.rawArguments);
  } catch {
    // Malformed invocations are still audited: "audit every invocation" holds
    // even when the arguments never reach a tool definition.
    await tenantQuery(
      auth.tenantId,
      `INSERT INTO tool_executions (request_id, tenant_id, user_id, tool_name, action, parameters, authorization_decision, classification, status, error_code, completed_at)
       VALUES ($1,$2,$3,$4,'execute',$5,'DENIED',$6,'DENIED','INVALID_TOOL_ARGUMENTS',NOW())`,
      [requestId ?? 'none', auth.tenantId, auth.userId, name, JSON.stringify({ raw: options.rawArguments.slice(0, 4000) }), classification]
    );
    await recordAudit({ tenantId: auth.tenantId, userId: auth.userId, requestId, action: 'TOOL_EXECUTION', tool: name, classification, success: false, reason: 'Tool arguments are not valid JSON' });
    return { ok: false, errorCode: 'INVALID_TOOL_ARGUMENTS', message: 'Tool arguments are not valid JSON' };
  }

  let prepared: { definition: ToolDefinition<any>; input: unknown };
  try {
    prepared = authorizeTool(auth, name, parameters, classification, confirmed);
  } catch (error) {
    const code = toolErrorCode(error);
    await tenantQuery(
      auth.tenantId,
      `INSERT INTO tool_executions (request_id, tenant_id, user_id, tool_name, action, parameters, authorization_decision, classification, status, error_code, completed_at)
       VALUES ($1,$2,$3,$4,'execute','{}','DENIED',$5,'DENIED',$6,NOW())`,
      [requestId ?? 'none', auth.tenantId, auth.userId, name, classification, code]
    );
    await recordAudit({ tenantId: auth.tenantId, userId: auth.userId, requestId, action: 'TOOL_EXECUTION', tool: name, classification, success: false, reason: error instanceof Error ? error.message : 'Tool request denied' });
    return { ok: false, errorCode: code, message: error instanceof Error ? error.message : 'Tool request denied' };
  }

  const pending = await tenantQuery<{ id: string }>(
    auth.tenantId,
    `INSERT INTO tool_executions (request_id, tenant_id, user_id, tool_name, action, parameters, authorization_decision, classification, status)
     VALUES ($1,$2,$3,$4,'execute',$5,'ALLOWED',$6,'PENDING') RETURNING id`,
    [requestId ?? 'none', auth.tenantId, auth.userId, name, JSON.stringify(prepared.input), classification]
  );
  const executionId = pending.rows[0]!.id;
  // Per-tool timeout on top of the caller's signal: a hung tool must not hold
  // a chat turn or worker slot indefinitely, even when the client is gone.
  // The combined signal aborts cooperatively for adapters that listen, but a
  // non-cooperative adapter (one that ignores the signal) would still never
  // settle — so the guarded Promise.race rejects at the configured deadline
  // regardless of whether the adapter ever resolves or rejects.
  const toolSignal = AbortSignal.any([signal, AbortSignal.timeout(config.AI_TOOL_TIMEOUT_MS)]);
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    deadlineTimer = setTimeout(() => {
      reject(Errors.internal('Tool execution timed out', { tool: name }, 'TOOL_TIMEOUT'));
    }, config.AI_TOOL_TIMEOUT_MS);
    // Never let a hung adapter keep the process alive: the timer only exists
    // to reject the race, and the finally block clears it once the call
    // settles either way.
    deadlineTimer.unref?.();
  });
  try {
    const output = await Promise.race([
      prepared.definition.execute(prepared.input, toolSignal),
      deadline,
    ]);
    await tenantQuery(auth.tenantId, "UPDATE tool_executions SET status = 'SUCCEEDED', completed_at = NOW() WHERE id = $1", [executionId]);
    await recordAudit({ tenantId: auth.tenantId, userId: auth.userId, requestId, action: 'TOOL_EXECUTION', tool: name, classification, metadata: { executionId } });
    const rendered = safeStringify(output);
    if (rendered.length > config.AI_TOOL_OUTPUT_MAX_CHARS) {
      // Never hand API consumers truncated-then-reparsed JSON: the structured
      // result becomes an explicit marker while the model still gets a preview.
      return {
        ok: true,
        executionId,
        output: `${rendered.slice(0, config.AI_TOOL_OUTPUT_MAX_CHARS)}\n[truncated: tool output exceeded ${config.AI_TOOL_OUTPUT_MAX_CHARS} chars]`,
        data: { truncated: true, maxChars: config.AI_TOOL_OUTPUT_MAX_CHARS },
        truncated: true,
      };
    }
    let data: unknown = null;
    try {
      data = JSON.parse(rendered);
    } catch {
      data = rendered;
    }
    return { ok: true, executionId, output: rendered, data };
  } catch (error) {
    const code = toolErrorCode(error);
    // Client-safe: adapter exceptions (upstream messages, stack traces, host
    // names, leaked headers) never reach clients — a single generic message
    // is returned for every execution failure. Operator diagnostics are
    // sanitized server-side with the audit sanitizer patterns before being
    // recorded, so credential-shaped material never persists raw.
    const diagnostics = sanitizeReason(error instanceof Error ? error.message : 'Tool execution failed');
    await tenantQuery(auth.tenantId, "UPDATE tool_executions SET status = 'FAILED', error_code = $2, completed_at = NOW() WHERE id = $1", [executionId, code]);
    await recordAudit({ tenantId: auth.tenantId, userId: auth.userId, requestId, action: 'TOOL_EXECUTION', tool: name, classification, success: false, reason: diagnostics ?? 'Tool execution failed' });
    return { ok: false, errorCode: code, message: 'Tool execution failed' };
  } finally {
    if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
  }
}

/**
 * Minimal zod -> JSON Schema converter for the subset of schemas used in tool
 * definitions (objects, strings, numbers, booleans, enums, arrays, optionals,
 * defaults). Tool definitions remain zod-first for server-side validation; the
 * JSON Schema is only what gets sent to the model in `tools` payloads.
 */
export function zodToJsonSchema(schema: z.ZodTypeAny): Record<string, unknown> {
  const def = (schema as any)._def;
  const typeName = def?.typeName as string | undefined;
  switch (typeName) {
    case 'ZodString': {
      const result: Record<string, unknown> = { type: 'string' };
      const checks: Array<{ kind: string; value?: unknown }> = def.checks ?? [];
      for (const check of checks) {
        if (check.kind === 'min') result.minLength = check.value;
        if (check.kind === 'max') result.maxLength = check.value;
        if (check.kind === 'regex') result.pattern = String((check as unknown as { regex: RegExp }).regex.source);
      }
      if (def.description) result.description = def.description;
      return result;
    }
    case 'ZodNumber':
      return { type: 'number' };
    case 'ZodBoolean':
      return { type: 'boolean' };
    case 'ZodEnum':
      return { type: 'string', enum: (def.values as unknown[]).slice() };
    case 'ZodArray':
      return { type: 'array', items: zodToJsonSchema(def.type as z.ZodTypeAny) };
    case 'ZodObject': {
      const properties: Record<string, unknown> = {};
      const required: string[] = [];
      const shape = (def.shape as () => Record<string, z.ZodTypeAny>)();
      for (const [key, field] of Object.entries(shape)) {
        const fieldDef = (field as any)._def?.typeName as string | undefined;
        if (fieldDef === 'ZodOptional') {
          properties[key] = zodToJsonSchema((field as any)._def.innerType as z.ZodTypeAny);
        } else if (fieldDef === 'ZodDefault') {
          properties[key] = zodToJsonSchema((field as any)._def.innerType as z.ZodTypeAny);
        } else {
          properties[key] = zodToJsonSchema(field);
          required.push(key);
        }
      }
      return { type: 'object', properties, ...(required.length ? { required } : {}), additionalProperties: false };
    }
    case 'ZodOptional':
    case 'ZodDefault':
      return zodToJsonSchema(def.innerType as z.ZodTypeAny);
    default:
      return {};
  }
}
