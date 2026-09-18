/**
 * live.ts — the LIVE chat adapter for eval runs.
 *
 * REQUIRES REAL INFRASTRUCTURE. Drives the real AI gateway (gatewayStream)
 * and accumulates the stream into a single { content, toolCalls } result.
 * Config-gated by EVAL_LIVE_PROVIDER: when unset, live mode is REFUSED with
 * a clear error — live results are never faked.
 *
 * Kept in its own module so the mock/CI path (runner.ts) never imports the
 * gateway or the database config.
 */
import { gatewayStream } from '../ai/gateway/gateway.js';
import type { Classification } from '../authz/permissions.js';
import type { ChatFn, RunnerMessage } from './runner.js';
import type { EvalToolDef } from './types.js';

export interface GatewayAuth {
  tenantId: string;
  userId: string;
  roleId: string;
}

export function gatewayChatFn(modelId: string, auth: GatewayAuth): ChatFn {
  const provider = process.env.EVAL_LIVE_PROVIDER;
  if (!provider) {
    throw new Error(
      'Live eval refused: EVAL_LIVE_PROVIDER is not set. ' +
        'Set it to the provider name (e.g. "vllm") to run against the real AI gateway, ' +
        'or omit --live to run the scripted mock suite.'
    );
  }
  void provider;
  return async (messages: RunnerMessage[], tools?: EvalToolDef[]): Promise<{ content: string; toolCalls?: Array<{ name: string; args: unknown }> }> => {
    const result = await gatewayStream({
      tenantId: auth.tenantId,
      userId: auth.userId,
      roleId: auth.roleId,
      modelId,
      classification: 'INTERNAL' as Classification,
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
      tools: tools?.map((t) => ({
        type: 'function' as const,
        function: {
          name: t.name,
          description: t.description,
          parameters: (t.parameters ?? {}) as Record<string, unknown>,
        },
      })),
    });
    let content = '';
    const toolCalls: Array<{ name: string; args: unknown }> = [];
    for await (const event of result.events) {
      if (event.type === 'text') content += event.content;
      else if (event.type === 'tool_call') {
        let args: unknown = {};
        try {
          args = JSON.parse(event.arguments);
        } catch {
          args = { _raw: event.arguments };
        }
        toolCalls.push({ name: event.name, args });
      }
    }
    return { content, toolCalls: toolCalls.length > 0 ? toolCalls : undefined };
  };
}
