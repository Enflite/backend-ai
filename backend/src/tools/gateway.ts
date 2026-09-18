import { z } from 'zod';
import { AuthContext, Classification } from '../authz/permissions.js';
import { config } from '../config.js';
import { Errors } from '../errors.js';
import { canModelProcess } from '../policy/engine.js';

export interface ToolDefinition<T = unknown> {
  name: string;
  description: string;
  action: string;
  destructive: boolean;
  allowedClassifications: Classification[];
  schema: z.ZodType<T>;
  execute(input: T, signal: AbortSignal): Promise<unknown>;
}

export interface SyteLineAdapter {
  getItem(input: { item: string; site: string }, signal: AbortSignal): Promise<unknown>;
}

export class HttpSyteLineAdapter implements SyteLineAdapter {
  async getItem(input: { item: string; site: string }, signal: AbortSignal): Promise<unknown> {
    if (!config.SYTELINE_BASE_URL || !config.SYTELINE_API_TOKEN) {
      throw Errors.internal('SyteLine adapter is not configured', undefined, 'SYTELINE_NOT_CONFIGURED');
    }
    const url = new URL('/api/items', config.SYTELINE_BASE_URL);
    url.searchParams.set('item', input.item);
    url.searchParams.set('site', input.site);
    const response = await fetch(url, {
      headers: { authorization: `Bearer ${config.SYTELINE_API_TOKEN}`, accept: 'application/json' },
      signal,
    });
    if (!response.ok) throw Errors.internal('SyteLine request failed', { status: response.status }, 'SYTELINE_UPSTREAM_ERROR');
    return response.json();
  }
}

const syteLine = new HttpSyteLineAdapter();

export const toolRegistry: readonly ToolDefinition<any>[] = [
  {
    name: 'syteline.getItem',
    description: 'Retrieve an item from the configured internal SyteLine site',
    action: 'read',
    destructive: false,
    allowedClassifications: ['PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'PROPRIETARY'],
    schema: z.object({
      item: z.string().trim().min(1).max(80).regex(/^[A-Za-z0-9._/-]+$/),
      site: z.string().trim().min(1).max(40).regex(/^[A-Za-z0-9_-]+$/),
    }).strict(),
    execute: (input, signal) => syteLine.getItem(input, signal),
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
  if (!auth.permissions.includes('tool:use')) throw Errors.forbidden('TOOL_FORBIDDEN', 'Tool permission required');
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
