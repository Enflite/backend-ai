/**
 * hook.ts — optional external DLP sidecar (Phase 5c).
 *
 * Contract: POST { "text": string } → { "text": string } where the returned
 * text is the sidecar's redacted version. The platform runs fully without
 * the hook: the built-in detectors in detectors.ts are the enforced
 * boundary, and the hook is best-effort defense in depth.
 *
 * Failure semantics are fail-open to the built-in detectors (the text was
 * already scanned by them before the hook runs): a timeout, a non-200
 * response, or a malformed body returns null and the caller keeps the
 * built-in-redacted text.
 */

import { config } from '../config.js';

/**
 * Runs the external DLP hook over already-built-in-redacted text.
 * Returns the hook's redacted text, or null when the hook is unconfigured
 * or fails.
 */
export async function scanExternalDlp(text: string): Promise<string | null> {
  const endpoint = config.DLP_EXTERNAL_ENDPOINT;
  if (!endpoint) return null;
  try {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (config.DLP_EXTERNAL_API_KEY) headers.authorization = `Bearer ${config.DLP_EXTERNAL_API_KEY}`;
    const response = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(config.DLP_EXTERNAL_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    const result = (await response.json()) as { text?: unknown };
    return typeof result.text === 'string' ? result.text : null;
  } catch {
    return null;
  }
}
