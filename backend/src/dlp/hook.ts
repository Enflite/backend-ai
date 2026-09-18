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
 * built-in-redacted text. An endpoint URL that is not HTTPS (except HTTP
 * to an explicit loopback host for local development) is refused outright:
 * the hook never ships text over plaintext to a remote host.
 */

import { config } from '../config.js';

/**
 * Hosts where plaintext HTTP is acceptable: explicit loopback only, for
 * local sidecar development. Any other host must use HTTPS — the hook
 * ships outbound text to the sidecar, so a plaintext remote URL would leak
 * it on the wire.
 */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

/**
 * Test seam: true when the configured DLP endpoint URL is safe to call —
 * HTTPS anywhere, or HTTP to an explicit loopback host. Anything else
 * (plaintext remote, non-HTTP(S) scheme, unparseable URL) is refused.
 */
export function isDlpEndpointAllowed(endpoint: string): boolean {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  if (url.protocol === 'https:') return true;
  if (url.protocol !== 'http:') return false;
  // Node's URL keeps IPv6 brackets in hostname ("[::1]"); strip them.
  const host = url.hostname.replace(/^\[|\]$/g, '');
  return LOOPBACK_HOSTS.has(host);
}

let insecureEndpointWarned = false;

/** Refuses the hook when the endpoint is a plaintext non-loopback URL. */
function resolveEndpoint(): string | null {
  const endpoint = config.DLP_EXTERNAL_ENDPOINT;
  if (!endpoint) return null;
  if (!isDlpEndpointAllowed(endpoint)) {
    // Log once: scanExternalDlp runs per stream window.
    if (!insecureEndpointWarned) {
      insecureEndpointWarned = true;
      console.error(
        'DLP external hook disabled: DLP_EXTERNAL_ENDPOINT must use HTTPS ' +
          '(HTTP is allowed only for explicit loopback hosts)'
      );
    }
    return null;
  }
  return endpoint;
}

/** Test seam: reset the one-shot insecure-endpoint warning. */
export function resetDlpEndpointWarning(): void {
  insecureEndpointWarned = false;
}

/**
 * Runs the external DLP hook over already-built-in-redacted text.
 * Returns the hook's redacted text, or null when the hook is unconfigured
 * or fails.
 */
export async function scanExternalDlp(text: string): Promise<string | null> {
  const endpoint = resolveEndpoint();
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
