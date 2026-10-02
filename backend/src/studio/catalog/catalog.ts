/**
 * catalog.ts — the Studio's typed action catalog (the "Postman half" of the
 * Automation Studio).
 *
 * A static registry in code. Every entry is either bound to a REAL
 * operation on the connection's upstream (method + path, parameterized by
 * connectionId at execution) or listed honestly as supported:false with the
 * reason the upstream lacks it. There are no fake operations: a catalog
 * entry the upstream cannot perform is visible in the catalog with
 * `supported: false` and an honest reason — never as a working action.
 *
 * Destructive entries are flagged with `destructive: true`. Flagging only:
 * enforcement comes in a later slice.
 */

import { z } from 'zod';
import type {
  CatalogActionDefinition,
  CatalogActionView,
  CapabilityProbeStatus,
} from '../types.js';
import { probeStatusFor } from '../connections/probe.js';

// Param primitives mirror backend/src/tools/gateway.ts so the catalog and
// the agentic tools validate the same identifiers the same way.
const sytelineItemId = () => z.string().trim().min(1).max(80).regex(/^[A-Za-z0-9._/-]+$/);
const sytelineOrderId = () => z.string().trim().min(1).max(40).regex(/^[A-Za-z0-9._/-]+$/);
const sytelineCustomerId = () => z.string().trim().min(1).max(40).regex(/^[A-Za-z0-9._-]+$/);
const sytelineSiteId = () => z.string().trim().min(1).max(40).regex(/^[A-Za-z0-9_-]+$/);

const siteOptional = () => sytelineSiteId().optional();

export const ACTION_CATALOG: CatalogActionDefinition[] = [
  {
    id: 'syteline.getItem',
    title: 'Get item',
    description: 'Fetch an item master record (description, type, site) from SyteLine.',
    substrate: 'api',
    paramsSchema: z.object({ item: sytelineItemId(), site: sytelineSiteId() }),
    destructive: false,
    requiredPermission: 'studio:run',
    operation: { method: 'GET', path: '/api/items' },
    knownReal: true,
  },
  {
    id: 'syteline.getSalesOrder',
    title: 'Get sales order',
    description:
      'Fetch a sales order with its lines, or the open orders for a customer. One of orderNumber or customerNumber is required.',
    substrate: 'api',
    paramsSchema: z
      .object({
        orderNumber: sytelineOrderId().optional(),
        customerNumber: sytelineCustomerId().optional(),
        site: siteOptional(),
        status: z.string().trim().min(1).max(40).optional(),
      })
      .refine((v) => v.orderNumber !== undefined || v.customerNumber !== undefined, {
        message: 'Either orderNumber or customerNumber is required',
      }),
    destructive: false,
    requiredPermission: 'studio:run',
    operation: { method: 'GET', path: '/api/sales-orders' },
    knownReal: true,
  },
  {
    id: 'syteline.getItemAvailability',
    title: 'Get item availability',
    description: 'On-hand, allocated, and available-to-promise for an item at a site, with recent transactions.',
    substrate: 'api',
    paramsSchema: z.object({ item: sytelineItemId(), site: sytelineSiteId() }),
    destructive: false,
    requiredPermission: 'studio:run',
    operation: { method: 'GET', path: '/api/items/availability' },
    knownReal: true,
  },
  {
    id: 'syteline.getOpenPurchaseOrders',
    title: 'Get open purchase orders',
    description: 'Open purchase orders for an item (optionally filtered to a site).',
    substrate: 'api',
    paramsSchema: z.object({ item: sytelineItemId(), site: siteOptional() }),
    destructive: false,
    requiredPermission: 'studio:run',
    operation: { method: 'GET', path: '/api/purchase-orders' },
    knownReal: true,
  },
  {
    id: 'syteline.getWorkOrders',
    title: 'Get work orders',
    description: 'Work orders filtered by work order number, item, site, or status.',
    substrate: 'api',
    paramsSchema: z.object({
      workOrderNumber: sytelineOrderId().optional(),
      item: sytelineItemId().optional(),
      site: siteOptional(),
      status: z.string().trim().min(1).max(40).optional(),
    }),
    destructive: false,
    requiredPermission: 'studio:run',
    operation: { method: 'GET', path: '/api/work-orders' },
    knownReal: true,
  },
  {
    id: 'syteline.getBom',
    title: 'Get bill of materials',
    description: 'Multi-level BOM explosion for an item.',
    substrate: 'api',
    paramsSchema: z.object({
      item: sytelineItemId(),
      site: siteOptional(),
      levels: z.number().int().min(1).max(10).optional(),
    }),
    destructive: false,
    requiredPermission: 'studio:run',
    operation: { method: 'GET', path: '/api/boms' },
    knownReal: true,
  },
  {
    id: 'syteline.getCustomer',
    title: 'Get customer',
    description: 'Customer master record (name, status, credit hold).',
    substrate: 'api',
    paramsSchema: z.object({ customerNumber: sytelineCustomerId() }),
    destructive: false,
    requiredPermission: 'studio:run',
    operation: { method: 'GET', path: '/api/customers' },
    knownReal: true,
  },

  // --- Write operations: NOT available on the current upstream. Listed
  // honestly as supported:false; they become real only when a capability
  // probe confirms the endpoint exists. ---
  {
    id: 'syteline.record.create',
    title: 'Create record',
    description: 'Create a SyteLine record (e.g. an item, order, or customer).',
    substrate: 'api',
    paramsSchema: z.object({
      collection: z.string().trim().min(1).max(80),
      fields: z.record(z.string(), z.unknown()),
    }),
    destructive: true,
    requiredPermission: 'studio:run',
    operation: { method: 'POST', path: '/api/records' },
    knownReal: false,
    unsupportedReason:
      'The upstream API exposes no write endpoints (capability probe: OPTIONS /api/records is not served). Write operations are pending upstream support.',
  },
  {
    id: 'syteline.record.update',
    title: 'Update record',
    description: 'Update fields on an existing SyteLine record.',
    substrate: 'api',
    paramsSchema: z.object({
      collection: z.string().trim().min(1).max(80),
      key: z.record(z.string(), z.unknown()),
      fields: z.record(z.string(), z.unknown()),
    }),
    destructive: true,
    requiredPermission: 'studio:run',
    operation: { method: 'PUT', path: '/api/records' },
    knownReal: false,
    unsupportedReason:
      'The upstream API exposes no write endpoints (capability probe: OPTIONS /api/records is not served). Write operations are pending upstream support.',
  },
  {
    id: 'syteline.record.delete',
    title: 'Delete record',
    description: 'Delete a SyteLine record.',
    substrate: 'api',
    paramsSchema: z.object({
      collection: z.string().trim().min(1).max(80),
      key: z.record(z.string(), z.unknown()),
    }),
    destructive: true,
    requiredPermission: 'studio:run',
    operation: { method: 'DELETE', path: '/api/records' },
    knownReal: false,
    unsupportedReason:
      'The upstream API exposes no write endpoints (capability probe: OPTIONS /api/records is not served). Write operations are pending upstream support.',
  },
  {
    id: 'syteline.ido.invoke',
    title: 'Invoke IDO method',
    description: 'Invoke a SyteLine IDO method directly (e.g. for operations the REST API does not cover).',
    substrate: 'api',
    paramsSchema: z.object({
      idoName: z.string().trim().min(1).max(80),
      method: z.string().trim().min(1).max(80),
      parameters: z.record(z.string(), z.unknown()).optional(),
    }),
    destructive: true,
    requiredPermission: 'studio:run',
    operation: { method: 'POST', path: '/api/ido/invoke' },
    knownReal: false,
    unsupportedReason:
      'The upstream API exposes no IDO invocation endpoint (capability probe: OPTIONS /api/ido/invoke is not served). IDO invocation is pending upstream support.',
  },
];

export function getCatalogAction(id: string): CatalogActionDefinition | undefined {
  return ACTION_CATALOG.find((a) => a.id === id);
}

/**
 * Evaluate a catalog entry against a connection's last probe results.
 * knownReal entries are supported only when their operation probed `ok`;
 * non-real entries always report supported:false with the honest reason.
 */
export function evaluateAvailability(
  entry: CatalogActionDefinition,
  operations: CapabilityProbeStatus[] | undefined
): { supported: boolean; supportReason: string } {
  if (!entry.knownReal) {
    return {
      supported: false,
      supportReason: entry.unsupportedReason ?? 'This operation is not available on the current upstream.',
    };
  }
  const status = probeStatusFor(operations, entry.id);
  if (status === 'ok') {
    return { supported: true, supportReason: 'Confirmed by the connection capability probe.' };
  }
  if (status === 'unsupported') {
    return { supported: false, supportReason: 'The connection probe found no such endpoint on this upstream.' };
  }
  if (status === 'error') {
    return { supported: false, supportReason: 'The connection probe hit this endpoint but errored; test the connection to re-probe.' };
  }
  return {
    supported: false,
    supportReason: 'Not probed yet: test the connection to confirm this operation is available before running it.',
  };
}

function zodToJsonSchema(schema: z.ZodTypeAny): unknown {
  // Vitest-compatible JSON Schema export without pulling a new dependency:
  // zod ships its own JSON Schema converter only via @zod/openapi, so the
  // catalog publishes a structural summary instead of a full draft schema.
  const describe = (s: z.ZodTypeAny): unknown => {
    const base: Record<string, unknown> = { type: 'object', properties: {} };
    const inner = s instanceof z.ZodObject ? s : s instanceof z.ZodEffects ? (s as z.ZodEffects<z.ZodTypeAny>)._def.schema : undefined;
    if (inner instanceof z.ZodObject) {
      const props: Record<string, unknown> = {};
      const required: string[] = [];
      for (const [key, field] of Object.entries(inner.shape)) {
        const f = field as z.ZodTypeAny;
        const isOptional = f instanceof z.ZodOptional || f instanceof z.ZodDefault;
        props[key] = { optional: isOptional, description: f.description };
        if (!isOptional) required.push(key);
      }
      base.properties = props;
      base.required = required;
    }
    return base;
  };
  return describe(schema);
}

export function toCatalogView(
  entry: CatalogActionDefinition,
  operations: CapabilityProbeStatus[] | undefined
): CatalogActionView {
  const { supported, supportReason } = evaluateAvailability(entry, operations);
  return {
    id: entry.id,
    title: entry.title,
    description: entry.description,
    substrate: entry.substrate,
    destructive: entry.destructive,
    requiredPermission: entry.requiredPermission,
    supported,
    supportReason,
    ...(entry.operation ? { operation: { method: entry.operation.method, path: entry.operation.path } } : {}),
    paramsJsonSchema: zodToJsonSchema(entry.paramsSchema),
  };
}

/** The full catalog, evaluated against a connection's probe results. */
export function listCatalog(operations?: CapabilityProbeStatus[]): CatalogActionView[] {
  return ACTION_CATALOG.map((entry) => toCatalogView(entry, operations));
}
