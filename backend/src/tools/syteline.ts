/**
 * syteline.ts — read-only SyteLine ERP adapter.
 *
 * The model never touches SyteLine directly: every ERP read goes through one
 * of the typed methods below, invoked from a tool definition in
 * gateway.ts, authorized in application code (caller permissions +
 * classification), audited with tenant/user/tool/args/result-size, and
 * bounded by a per-request timeout plus a per-list row cap.
 *
 * Endpoint convention: each method maps to a fixed path under
 * SYTELINE_BASE_URL with query parameters — no free-form SQL, no dynamic
 * paths, no request bodies. The bearer token comes from
 * SYTELINE_API_TOKEN and is never logged, persisted, or returned.
 *
 * The mock implementation used by evals and tests lives in
 * sytelineFixture.ts and implements the same interface.
 */

import { config } from '../config.js';
import { Errors } from '../errors.js';
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Typed result shapes. Lists are truncated to SYTELINE_MAX_ROWS by the
// adapter; truncated lists carry `truncated: true` so callers (and the
// model) know the result is partial rather than complete.
// ---------------------------------------------------------------------------

export interface SalesOrderLine {
  lineNumber: number;
  item: string;
  description?: string;
  quantityOrdered: number;
  quantityShipped: number;
  unitPrice?: number;
  promisedDate?: string;
  status: string;
}

export interface SalesOrderResult {
  orderNumber: string;
  customerNumber?: string;
  customerName?: string;
  site?: string;
  orderDate?: string;
  dueDate?: string;
  promisedDate?: string;
  status: string;
  totalValue?: number;
  currency?: string;
  /** When queried by customerNumber: the open orders for that customer. */
  orders?: Array<Omit<SalesOrderResult, 'lines' | 'orders'>>;
  lines: SalesOrderLine[];
  truncated?: boolean;
}

export interface InventoryTransaction {
  transactionDate: string;
  type: string;
  quantity: number;
  reference?: string;
  note?: string;
}

export interface ItemAvailabilityResult {
  item: string;
  site: string;
  description?: string;
  onHand: number;
  allocated: number;
  /** Available-to-promise: on-hand minus allocated. May be negative — a
   *  negative availability is itself the diagnostic signal (see the
   *  negative-inventory forensics scenario), so the adapter reports it
   *  honestly rather than clamping. */
  available: number;
  unitOfMeasure?: string;
  /** Recent receipts/issues/adjustments, newest first; bounded by SYTELINE_MAX_ROWS. */
  recentTransactions?: InventoryTransaction[];
  truncated?: boolean;
}

export interface PurchaseOrderResult {
  poNumber: string;
  item: string;
  site?: string;
  quantityOrdered: number;
  quantityReceived: number;
  promisedDate?: string;
  status: string;
  supplierNumber?: string;
  supplierName?: string;
}

export interface PurchaseOrdersResult {
  item: string;
  site?: string;
  purchaseOrders: PurchaseOrderResult[];
  truncated?: boolean;
}

export interface WorkOrderResult {
  workOrderNumber: string;
  item: string;
  site?: string;
  quantityOrdered: number;
  quantityCompleted: number;
  status: string;
  scheduledStart?: string;
  scheduledComplete?: string;
  estimatedCompletion?: string;
}

export interface WorkOrdersResult {
  workOrders: WorkOrderResult[];
  truncated?: boolean;
}

export interface BomComponent {
  item: string;
  description?: string;
  quantityPer: number;
  unitOfMeasure?: string;
  /** Explosion depth: 1 = direct component. */
  level: number;
  leadTimeDays?: number;
}

export interface BomResult {
  item: string;
  site?: string;
  levels: number;
  components: BomComponent[];
  truncated?: boolean;
}

export interface CustomerResult {
  customerNumber: string;
  name: string;
  status?: string;
  creditHold?: boolean;
  site?: string;
}

// ---------------------------------------------------------------------------
// Response validation schemas. Live ERP JSON is untrusted: every response
// is validated against a focused schema mirroring the typed interfaces
// above before it is returned to callers. Schemas use `.passthrough()` so
// unknown extra fields (ERP responses evolve) pass through untouched —
// shape is validated, exhaustiveness is not required.
// ---------------------------------------------------------------------------

const salesOrderLineSchema = z
  .object({
    lineNumber: z.number(),
    item: z.string(),
    description: z.string().optional(),
    quantityOrdered: z.number(),
    quantityShipped: z.number(),
    unitPrice: z.number().optional(),
    promisedDate: z.string().optional(),
    status: z.string(),
  })
  .passthrough();

// Header shape for the `orders` list on SalesOrderResult (the same fields
// minus `lines`/`orders`).
const salesOrderHeaderSchema = z
  .object({
    orderNumber: z.string(),
    customerNumber: z.string().optional(),
    customerName: z.string().optional(),
    site: z.string().optional(),
    orderDate: z.string().optional(),
    dueDate: z.string().optional(),
    promisedDate: z.string().optional(),
    status: z.string(),
    totalValue: z.number().optional(),
    currency: z.string().optional(),
    truncated: z.boolean().optional(),
  })
  .passthrough();

const salesOrderResultSchema: z.ZodType<SalesOrderResult> = salesOrderHeaderSchema
  .extend({
    orders: z.array(salesOrderHeaderSchema).optional(),
    lines: z.array(salesOrderLineSchema),
  })
  .passthrough();

const inventoryTransactionSchema = z
  .object({
    transactionDate: z.string(),
    type: z.string(),
    quantity: z.number(),
    reference: z.string().optional(),
    note: z.string().optional(),
  })
  .passthrough();

const itemAvailabilityResultSchema: z.ZodType<ItemAvailabilityResult> = z
  .object({
    item: z.string(),
    site: z.string(),
    description: z.string().optional(),
    onHand: z.number(),
    allocated: z.number(),
    available: z.number(),
    unitOfMeasure: z.string().optional(),
    recentTransactions: z.array(inventoryTransactionSchema).optional(),
    truncated: z.boolean().optional(),
  })
  .passthrough();

const purchaseOrderResultSchema = z
  .object({
    poNumber: z.string(),
    item: z.string(),
    site: z.string().optional(),
    quantityOrdered: z.number(),
    quantityReceived: z.number(),
    promisedDate: z.string().optional(),
    status: z.string(),
    supplierNumber: z.string().optional(),
    supplierName: z.string().optional(),
  })
  .passthrough();

const purchaseOrdersResultSchema: z.ZodType<PurchaseOrdersResult> = z
  .object({
    item: z.string(),
    site: z.string().optional(),
    purchaseOrders: z.array(purchaseOrderResultSchema),
    truncated: z.boolean().optional(),
  })
  .passthrough();

const workOrderResultSchema = z
  .object({
    workOrderNumber: z.string(),
    item: z.string(),
    site: z.string().optional(),
    quantityOrdered: z.number(),
    quantityCompleted: z.number(),
    status: z.string(),
    scheduledStart: z.string().optional(),
    scheduledComplete: z.string().optional(),
    estimatedCompletion: z.string().optional(),
  })
  .passthrough();

const workOrdersResultSchema: z.ZodType<WorkOrdersResult> = z
  .object({
    workOrders: z.array(workOrderResultSchema),
    truncated: z.boolean().optional(),
  })
  .passthrough();

const bomComponentSchema = z
  .object({
    item: z.string(),
    description: z.string().optional(),
    quantityPer: z.number(),
    unitOfMeasure: z.string().optional(),
    level: z.number(),
    leadTimeDays: z.number().optional(),
  })
  .passthrough();

const bomResultSchema: z.ZodType<BomResult> = z
  .object({
    item: z.string(),
    site: z.string().optional(),
    levels: z.number(),
    components: z.array(bomComponentSchema),
    truncated: z.boolean().optional(),
  })
  .passthrough();

const customerResultSchema: z.ZodType<CustomerResult> = z
  .object({
    customerNumber: z.string(),
    name: z.string(),
    status: z.string().optional(),
    creditHold: z.boolean().optional(),
    site: z.string().optional(),
  })
  .passthrough();

// getItem returns Promise<unknown> by design (the ERP item payload varies by
// site configuration), but the known fields are still validated and extra
// fields pass through untouched.
const itemResultSchema = z
  .object({
    item: z.string(),
    site: z.string(),
    description: z.string().optional(),
    itemType: z.string().optional(),
  })
  .passthrough();

export interface SyteLineAdapter {
  getItem(input: { item: string; site: string }, signal: AbortSignal): Promise<unknown>;
  getSalesOrder(
    input: { orderNumber?: string; customerNumber?: string; site?: string; status?: string },
    signal: AbortSignal
  ): Promise<SalesOrderResult>;
  getItemAvailability(
    input: { item: string; site: string },
    signal: AbortSignal
  ): Promise<ItemAvailabilityResult>;
  getOpenPurchaseOrders(
    input: { item: string; site?: string },
    signal: AbortSignal
  ): Promise<PurchaseOrdersResult>;
  getWorkOrders(
    input: { workOrderNumber?: string; item?: string; site?: string; status?: string },
    signal: AbortSignal
  ): Promise<WorkOrdersResult>;
  getBom(
    input: { item: string; site?: string; levels?: number },
    signal: AbortSignal
  ): Promise<BomResult>;
  getCustomer(
    input: { customerNumber: string },
    signal: AbortSignal
  ): Promise<CustomerResult>;
}

function requireConfigured(): { baseUrl: string; token: string } {
  if (!config.SYTELINE_BASE_URL || !config.SYTELINE_API_TOKEN) {
    throw Errors.internal('SyteLine adapter is not configured', undefined, 'SYTELINE_NOT_CONFIGURED');
  }
  // Transport security is enforced before the bearer token can be sent
  // anywhere: plaintext HTTP is only ever allowed for explicit loopback
  // development hosts. A non-loopback HTTP base URL fails fast here, at
  // configuration time, not after the first request leaks the token.
  let parsed: URL;
  try {
    parsed = new URL(config.SYTELINE_BASE_URL);
  } catch {
    throw Errors.internal('SyteLine base URL is not a valid URL', undefined, 'SYTELINE_NOT_CONFIGURED');
  }
  // Node's URL keeps IPv6 brackets on hostname ('[::1]'); normalize before
  // the loopback comparison.
  const host = parsed.hostname.replace(/^\[|\]$/g, '');
  const isLoopback = host === 'localhost' || host === '127.0.0.1' || host === '::1';
  if (parsed.protocol !== 'https:' && !isLoopback) {
    throw Errors.internal(
      `SyteLine base URL must use HTTPS; refusing to send the API token over plaintext HTTP to ${host}. ` +
        'Plain HTTP is allowed only for loopback development hosts (localhost, 127.0.0.1, ::1).',
      { scheme: parsed.protocol.replace(/:$/, ''), host },
      'SYTELINE_INSECURE_URL'
    );
  }
  return { baseUrl: config.SYTELINE_BASE_URL, token: config.SYTELINE_API_TOKEN };
}

function buildUrl(baseUrl: string, path: string, params: Record<string, string | undefined>): URL {
  const url = new URL(path, baseUrl);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') url.searchParams.set(key, value);
  }
  return url;
}

/**
 * Truncate a result list to the configured row cap. The cap keeps one
 * pathological order (thousands of lines) from evicting the conversation
 * from the model's context window; `truncated: true` tells the model the
 * list is partial so it says so instead of reasoning as if it saw all.
 */
export function capResultList<T>(list: T[] | undefined): { list: T[]; truncated: boolean } {
  const rows = Array.isArray(list) ? list : [];
  if (rows.length <= config.SYTELINE_MAX_ROWS) return { list: rows, truncated: false };
  return { list: rows.slice(0, config.SYTELINE_MAX_ROWS), truncated: true };
}

export class HttpSyteLineAdapter implements SyteLineAdapter {
  private async request<T>(
    path: string,
    params: Record<string, string | undefined>,
    signal: AbortSignal,
    schema: z.ZodType<T>
  ): Promise<T> {
    const { baseUrl, token } = requireConfigured();
    // Per-request timeout inside the adapter on top of runToolCall's
    // execution deadline: a hung upstream must not hold the caller's
    // signal indefinitely.
    const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(config.SYTELINE_TIMEOUT_MS)]);
    const response = await fetch(buildUrl(baseUrl, path, params), {
      headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
      signal: requestSignal,
    });
    if (!response.ok) {
      throw Errors.internal('SyteLine request failed', { status: response.status }, 'SYTELINE_UPSTREAM_ERROR');
    }
    // Live ERP JSON is untrusted: validate the response shape before it
    // reaches any caller (or the model). A malformed or non-JSON body is a
    // structured error, never an unchecked cast.
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw Errors.internal('SyteLine returned a non-JSON response', { path }, 'SYTELINE_INVALID_RESPONSE');
    }
    const parsed = schema.safeParse(payload);
    if (!parsed.success) {
      throw Errors.internal(
        'SyteLine response failed validation',
        {
          path,
          issues: parsed.error.issues.map((issue) => ({
            path: issue.path.join('.'),
            message: issue.message,
          })),
        },
        'SYTELINE_INVALID_RESPONSE'
      );
    }
    return parsed.data;
  }

  async getItem(input: { item: string; site: string }, signal: AbortSignal): Promise<unknown> {
    return this.request('/api/items', { item: input.item, site: input.site }, signal, itemResultSchema);
  }

  async getSalesOrder(
    input: { orderNumber?: string; customerNumber?: string; site?: string; status?: string },
    signal: AbortSignal
  ): Promise<SalesOrderResult> {
    const result = await this.request(
      '/api/sales-orders',
      { orderNumber: input.orderNumber, customerNumber: input.customerNumber, site: input.site, status: input.status },
      signal,
      salesOrderResultSchema
    );
    const lines = capResultList(result.lines);
    const orders = result.orders ? capResultList(result.orders) : undefined;
    return {
      ...result,
      lines: lines.list,
      ...(orders ? { orders: orders.list } : {}),
      truncated: lines.truncated || (orders?.truncated ?? false) || result.truncated,
    };
  }

  async getItemAvailability(input: { item: string; site: string }, signal: AbortSignal): Promise<ItemAvailabilityResult> {
    const result = await this.request(
      '/api/items/availability',
      { item: input.item, site: input.site },
      signal,
      itemAvailabilityResultSchema
    );
    const txns = result.recentTransactions ? capResultList(result.recentTransactions) : undefined;
    return {
      ...result,
      ...(txns ? { recentTransactions: txns.list } : {}),
      truncated: txns?.truncated || result.truncated,
    };
  }

  async getOpenPurchaseOrders(input: { item: string; site?: string }, signal: AbortSignal): Promise<PurchaseOrdersResult> {
    const result = await this.request(
      '/api/purchase-orders',
      { item: input.item, site: input.site, status: 'open' },
      signal,
      purchaseOrdersResultSchema
    );
    const capped = capResultList(result.purchaseOrders);
    return { ...result, purchaseOrders: capped.list, truncated: capped.truncated || result.truncated };
  }

  async getWorkOrders(
    input: { workOrderNumber?: string; item?: string; site?: string; status?: string },
    signal: AbortSignal
  ): Promise<WorkOrdersResult> {
    const result = await this.request(
      '/api/work-orders',
      { workOrderNumber: input.workOrderNumber, item: input.item, site: input.site, status: input.status },
      signal,
      workOrdersResultSchema
    );
    const capped = capResultList(result.workOrders);
    return { ...result, workOrders: capped.list, truncated: capped.truncated || result.truncated };
  }

  async getBom(input: { item: string; site?: string; levels?: number }, signal: AbortSignal): Promise<BomResult> {
    const result = await this.request(
      '/api/boms',
      { item: input.item, site: input.site, levels: input.levels !== undefined ? String(input.levels) : undefined },
      signal,
      bomResultSchema
    );
    const capped = capResultList(result.components);
    return { ...result, components: capped.list, truncated: capped.truncated || result.truncated };
  }

  async getCustomer(input: { customerNumber: string }, signal: AbortSignal): Promise<CustomerResult> {
    return this.request('/api/customers', { customerNumber: input.customerNumber }, signal, customerResultSchema);
  }
}

// Module-level adapter so tests and eval harnesses can substitute the mock
// fixture without touching production wiring. Production always uses the
// HTTP adapter; the override exists only for hermetic tests.
let activeAdapter: SyteLineAdapter = new HttpSyteLineAdapter();

export function getSyteLineAdapter(): SyteLineAdapter {
  return activeAdapter;
}

/** Test-only seam: substitute the adapter (e.g. the mock fixture). Not for production use. */
export function overrideSyteLineAdapter(adapter: SyteLineAdapter): void {
  activeAdapter = adapter;
}
