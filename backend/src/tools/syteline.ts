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
  private async request<T>(path: string, params: Record<string, string | undefined>, signal: AbortSignal): Promise<T> {
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
    return (await response.json()) as T;
  }

  async getItem(input: { item: string; site: string }, signal: AbortSignal): Promise<unknown> {
    return this.request('/api/items', { item: input.item, site: input.site }, signal);
  }

  async getSalesOrder(
    input: { orderNumber?: string; customerNumber?: string; site?: string; status?: string },
    signal: AbortSignal
  ): Promise<SalesOrderResult> {
    const result = await this.request<SalesOrderResult>(
      '/api/sales-orders',
      { orderNumber: input.orderNumber, customerNumber: input.customerNumber, site: input.site, status: input.status },
      signal
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
    const result = await this.request<ItemAvailabilityResult>(
      '/api/items/availability',
      { item: input.item, site: input.site },
      signal
    );
    const txns = result.recentTransactions ? capResultList(result.recentTransactions) : undefined;
    return {
      ...result,
      ...(txns ? { recentTransactions: txns.list } : {}),
      truncated: txns?.truncated || result.truncated,
    };
  }

  async getOpenPurchaseOrders(input: { item: string; site?: string }, signal: AbortSignal): Promise<PurchaseOrdersResult> {
    const result = await this.request<PurchaseOrdersResult>(
      '/api/purchase-orders',
      { item: input.item, site: input.site, status: 'open' },
      signal
    );
    const capped = capResultList(result.purchaseOrders);
    return { ...result, purchaseOrders: capped.list, truncated: capped.truncated || result.truncated };
  }

  async getWorkOrders(
    input: { workOrderNumber?: string; item?: string; site?: string; status?: string },
    signal: AbortSignal
  ): Promise<WorkOrdersResult> {
    const result = await this.request<WorkOrdersResult>(
      '/api/work-orders',
      { workOrderNumber: input.workOrderNumber, item: input.item, site: input.site, status: input.status },
      signal
    );
    const capped = capResultList(result.workOrders);
    return { ...result, workOrders: capped.list, truncated: capped.truncated || result.truncated };
  }

  async getBom(input: { item: string; site?: string; levels?: number }, signal: AbortSignal): Promise<BomResult> {
    const result = await this.request<BomResult>(
      '/api/boms',
      { item: input.item, site: input.site, levels: input.levels !== undefined ? String(input.levels) : undefined },
      signal
    );
    const capped = capResultList(result.components);
    return { ...result, components: capped.list, truncated: capped.truncated || result.truncated };
  }

  async getCustomer(input: { customerNumber: string }, signal: AbortSignal): Promise<CustomerResult> {
    return this.request<CustomerResult>('/api/customers', { customerNumber: input.customerNumber }, signal);
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
