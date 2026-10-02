/**
 * template.ts — deterministic template resolution for Flows (ADR-022).
 *
 * Grammar (the whole grammar; nothing else is supported):
 *
 *   Template expression:  {{ <path> }}
 *   <path>              := inputs.<dotted> | steps.<stepId>.output[.<dotted>]
 *                        (a bare `steps.<id>.output` resolves the whole output value)
 *   <dotted>            := segment ("." segment)*
 *   segment             := [A-Za-z0-9_-]+  with an optional [N] array index
 *                          (e.g. `items[0]`, `customer.addresses[1].city`)
 *
 * Examples:
 *   {{inputs.customerId}}
 *   {{inputs.tags[0]}}
 *   {{steps.fetch-order.output.total}}
 *   "Order {{steps.fetch-order.output.id}} totals {{steps.fetch-order.output.total}}"
 *
 * Strictness:
 * - Unknown paths (missing input key, unknown step id, missing output
 *   field) throw TEMPLATE_RESOLUTION_ERROR. A flow with a dangling
 *   reference fails loudly at run time instead of silently injecting
 *   the string "undefined" into a tool call.
 * - No eval(), no arbitrary expressions, no function calls, no filters.
 *   The `{{…}}` body is parsed as a path only.
 *
 * Value semantics:
 * - resolveValue: when the ENTIRE template string is one expression,
 *   the raw value is returned (a number stays a number). Otherwise the
 *   expression interpolates into a string (objects become JSON).
 * - resolveParams: deep-walks a params object/array, resolving every
 *   string value via resolveValue.
 *
 * Condition `when` (evaluateCondition): templates are resolved strictly
 * first, then the resolved text is evaluated with a tiny grammar:
 *   1. `<value> == '<literal>'` or `<value> != '<literal>'` (single or
 *      double quotes) → string comparison of the trimmed left side
 *      against the literal.
 *   2. Otherwise, when the whole `when` was a single bare template
 *      `{{…}}`, the raw value's JS truthiness decides.
 *   3. Otherwise a non-empty resolved string is truthy.
 * Anything that fails template resolution throws
 * TEMPLATE_RESOLUTION_ERROR — conditions never silently pass or fail.
 */

import { AppError } from '../errors.js';

export function templateError(message: string): AppError {
  return new AppError(400, 'TEMPLATE_RESOLUTION_ERROR', message);
}

/** Context a template resolves against during a run. */
export interface TemplateContext {
  inputs: Record<string, unknown>;
  /** Step id → that step's output value (in-memory only, never persisted). */
  stepOutputs: Map<string, unknown>;
}

const TEMPLATE_PATTERN = /\{\{\s*([^{}]+?)\s*\}\}/g;
const SEGMENT_PATTERN = /^[A-Za-z0-9_-]+(\[\d+\])?$/;

/** Split a dotted path into segments, honoring [N] index suffixes. */
function parseSegments(dotted: string): Array<{ key: string; index?: number }> {
  if (dotted.length === 0 || dotted.length > 512) {
    throw templateError(`invalid template path: empty or too long`);
  }
  const rawSegments = dotted.split('.');
  return rawSegments.map((raw) => {
    if (!SEGMENT_PATTERN.test(raw)) {
      throw templateError(`invalid template path segment: "${raw}"`);
    }
    const bracket = raw.indexOf('[');
    if (bracket < 0) return { key: raw };
    return {
      key: raw.slice(0, bracket),
      index: Number.parseInt(raw.slice(bracket + 1, raw.length - 1), 10),
    };
  });
}

function walkPath(root: unknown, segments: Array<{ key: string; index?: number }>, path: string): unknown {
  let current = root;
  for (const { key, index } of segments) {
    if (current === null || current === undefined || typeof current !== 'object') {
      throw templateError(`template path does not resolve: "${path}"`);
    }
    const record = current as Record<string, unknown>;
    if (!Object.prototype.hasOwnProperty.call(record, key)) {
      throw templateError(`template path does not resolve: "${path}"`);
    }
    current = record[key];
    if (index !== undefined) {
      if (!Array.isArray(current) || index >= current.length) {
        throw templateError(`template path does not resolve: "${path}"`);
      }
      current = current[index];
    }
  }
  return current;
}

/** Resolve one `{{…}}` body to its raw value. */
export function resolvePath(path: string, ctx: TemplateContext): unknown {
  const trimmed = path.trim();
  if (trimmed.startsWith('inputs.')) {
    const segments = parseSegments(trimmed.slice('inputs.'.length));
    if (!Object.prototype.hasOwnProperty.call(ctx.inputs, segments[0]!.key)) {
      throw templateError(`unknown input: "${trimmed}"`);
    }
    return walkPath(ctx.inputs, segments, trimmed);
  }
  const stepsPrefix = 'steps.';
  if (trimmed.startsWith(stepsPrefix)) {
    const rest = trimmed.slice(stepsPrefix.length);
    const outputToken = '.output';
    const markerIdx = rest.indexOf(outputToken);
    if (markerIdx < 0) {
      throw templateError(
        `invalid step reference "${trimmed}": expected steps.<id>.output[.<path>]`,
      );
    }
    const stepId = rest.slice(0, markerIdx);
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(stepId)) {
      throw templateError(`invalid step id in template path: "${stepId}"`);
    }
    if (!ctx.stepOutputs.has(stepId)) {
      throw templateError(`unknown step output: "${trimmed}"`);
    }
    const outputValue = ctx.stepOutputs.get(stepId);
    const after = rest.slice(markerIdx + outputToken.length);
    // A bare `steps.<id>.output` resolves the whole output value.
    if (after === '') return outputValue;
    if (!after.startsWith('.')) {
      throw templateError(`invalid step reference "${trimmed}": expected steps.<id>.output[.<path>]`);
    }
    const segments = parseSegments(after.slice(1));
    return walkPath(outputValue, segments, trimmed);
  }
  throw templateError(
    `invalid template path "${trimmed}": must start with inputs. or steps.<id>.output.`,
  );
}

function stringify(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === undefined) return '';
  return JSON.stringify(value) ?? '';
}

/**
 * Resolve a template string. A string that is exactly one expression
 * returns the raw value; anything else interpolates to a string.
 * Non-string inputs pass through untouched.
 */
export function resolveValue(template: unknown, ctx: TemplateContext): unknown {
  if (typeof template !== 'string') return template;
  const matches = [...template.matchAll(TEMPLATE_PATTERN)];
  if (matches.length === 0) return template;
  if (matches.length === 1 && matches[0]![0] === template) {
    return resolvePath(matches[0]![1]!, ctx);
  }
  return template.replace(TEMPLATE_PATTERN, (_whole, path: string) => stringify(resolvePath(path, ctx)));
}

/** Deep-resolve every string inside a params object/array. Depth-capped
 *  (50) so a maliciously nested params payload cannot overflow the stack. */
export function resolveParams(params: unknown, ctx: TemplateContext, depth = 0): unknown {
  if (depth > 50) {
    throw templateError('template params nested too deeply');
  }
  if (typeof params === 'string') return resolveValue(params, ctx);
  if (Array.isArray(params)) return params.map((item) => resolveParams(item, ctx, depth + 1));
  if (params !== null && typeof params === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(params as Record<string, unknown>)) {
      out[key] = resolveParams(value, ctx, depth + 1);
    }
    return out;
  }
  return params;
}

const COMPARISON_PATTERN = /^(.+?)\s*(==|!=)\s*('([^']*)'|"([^"]*)")$/;

/**
 * Evaluate a condition `when` after strict template resolution.
 * See the module docstring for the grammar.
 */
export function evaluateCondition(when: string, ctx: TemplateContext): boolean {
  const resolved = resolveValue(when, ctx);
  if (typeof resolved !== 'string') {
    // The whole `when` was a single bare template: raw truthiness.
    return truthy(resolved);
  }
  const comparison = COMPARISON_PATTERN.exec(resolved.trim());
  if (comparison) {
    const lhs = comparison[1]!.trim();
    const literal = comparison[4] ?? comparison[5] ?? '';
    return comparison[2] === '==' ? lhs === literal : lhs !== literal;
  }
  return resolved.length > 0;
}

function truthy(value: unknown): boolean {
  if (typeof value === 'string') return value.length > 0;
  return Boolean(value);
}

/**
 * Compact shape descriptor for a step output, for step logs and audit
 * metadata. Describes the TYPE, never the value: template values may
 * carry secrets and secrets must not persist in logs (ADR-004).
 * e.g. `object{keys:[a,b]}`, `string[42]`, `number`, `array[3]`, `null`.
 */
export function describeOutputShape(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (Array.isArray(value)) return `array[${value.length}]`;
  switch (typeof value) {
    case 'string':
      return `string[${value.length}]`;
    case 'number':
    case 'boolean':
    case 'bigint':
      return typeof value;
    case 'object': {
      const keys = Object.keys(value as Record<string, unknown>).slice(0, 20);
      return `object{keys:[${keys.join(',')}]}`;
    }
    default:
      return typeof value;
  }
}
