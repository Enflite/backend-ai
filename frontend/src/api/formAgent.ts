/**
 * api/formAgent.ts — SyteLine Form AI Agent REST client.
 *
 * Dedicated product endpoints (backend PR #55):
 *   POST   /api/v1/form-customizations        create (JSON or multipart) → 202
 *   GET    /api/v1/form-customizations        list (own; admins see tenant's)
 *   GET    /api/v1/form-customizations/:id    full record
 *   POST   /api/v1/form-customizations/:id/cancel
 *   POST   /api/v1/form-customizations/:id/mark-merged  (human records the PR merge)
 *
 * Payload shapes mirror the backend's public views
 * (backend/src/formAgent/types.ts). The multipart assembly + validation
 * live in ../formAgent/payload.ts.
 */
import { api } from '../api';
import type {
  CreateCustomizationAccepted,
  FormCustomizationDetail,
  FormCustomizationListItem,
  FormCustomizationStatus,
} from '../formAgent/types';

const BASE = '/form-customizations';

export async function createFormCustomization(
  body: FormData | Record<string, unknown>,
): Promise<CreateCustomizationAccepted> {
  return api.request<CreateCustomizationAccepted>(BASE, {
    method: 'POST',
    body: body instanceof FormData ? body : JSON.stringify(body),
  });
}

export async function listFormCustomizations(
  status?: FormCustomizationStatus,
  limit = 50,
): Promise<FormCustomizationListItem[]> {
  const params = new URLSearchParams();
  if (status) params.set('status', status);
  params.set('limit', String(limit));
  const body = await api.request<{ items: FormCustomizationListItem[] }>(`${BASE}?${params}`);
  return body.items;
}

export async function getFormCustomization(id: string): Promise<FormCustomizationDetail> {
  return api.request<FormCustomizationDetail>(`${BASE}/${encodeURIComponent(id)}`);
}

export async function cancelFormCustomization(id: string): Promise<{ id: string; status: string }> {
  return api.request(`${BASE}/${encodeURIComponent(id)}/cancel`, { method: 'POST' });
}

export async function markFormCustomizationMerged(id: string): Promise<{ id: string; status: string }> {
  return api.request(`${BASE}/${encodeURIComponent(id)}/mark-merged`, { method: 'POST' });
}
