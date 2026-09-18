/**
 * streamGuard.ts — DLP for the SSE chat stream (Phase 5c).
 *
 * The hard part of streaming redaction is patterns split across provider
 * chunks ("4111 1111 111" + "1 1111"). The guard holds back the trailing
 * run of digits/spaces/dashes from each emission and scans tail + chunk as
 * one window:
 *
 *  - Every detectable pattern (SSN, card) is digit-shaped, so any pattern
 *    that could still grow with future input lives inside that trailing
 *    run. Text before the run is final: complete patterns in it are
 *    redacted, everything else is emitted immediately — no added latency
 *    when no PII is near the chunk end.
 *  - The held run is capped at DLP_MAX_PATTERN_LEN (longer than any
 *    detectable pattern: 19 digits + 18 separators) so a pathological
 *    digit stream can't pin memory.
 *
 * `flush()` redacts and emits the remaining tail; call it when the turn
 * ends, before the terminal `done` frame. Detections (kinds only, never
 * matched text) accumulate for the caller to audit.
 */

import { redactText, type DlpKind } from './detectors.js';
import { scanExternalDlp } from './hook.js';

/** Longer than any detectable pattern (19 digits + 18 separators = 37). */
export const DLP_MAX_PATTERN_LEN = 40;

export interface DlpWindowResult {
  /** Redacted text safe to emit to the client. */
  emit: string;
  /** Kinds redacted in this window, in order. */
  detections: DlpKind[];
}

export class DlpStreamGuard {
  private tail = '';
  private hookInFlight = false;

  constructor(private readonly useExternalHook: boolean) {}

  /**
   * Scans a provider chunk and returns the redacted text to emit now.
   * Only the trailing digit-shaped run is held back for the next call.
   */
  async process(chunk: string): Promise<DlpWindowResult> {
    if (!chunk) return { emit: '', detections: [] };
    const window = this.tail + chunk;
    const holdFrom = holdbackStart(window);
    const head = window.slice(0, holdFrom);
    this.tail = window.slice(holdFrom);
    const { text, detections } = redactText(head);
    const emit = await this.applyExternalHook(text);
    return { emit, detections };
  }

  /** Redacts and emits the held-back tail at the end of the turn. */
  async flush(): Promise<DlpWindowResult> {
    const window = this.tail;
    this.tail = '';
    if (!window) return { emit: '', detections: [] };
    const { text, detections } = redactText(window);
    const emit = await this.applyExternalHook(text);
    return { emit, detections };
  }

  /**
   * The external hook runs over built-in-redacted text as best-effort
   * defense in depth. The hook call is awaited per window — its redacted
   * output must gate emission — but it is bounded by
   * DLP_EXTERNAL_TIMEOUT_MS, so a slow sidecar adds at most that latency
   * per chunk and can never stall the stream indefinitely; failures and
   * timeouts keep the built-in text. Calls are never overlapped as
   * defense in depth against concurrent use of one guard instance.
   */
  private async applyExternalHook(text: string): Promise<string> {
    if (!this.useExternalHook || !text || this.hookInFlight) return text;
    this.hookInFlight = true;
    try {
      return (await scanExternalDlp(text)) ?? text;
    } finally {
      this.hookInFlight = false;
    }
  }
}

/**
 * Start offset of the trailing [\d -] run, capped at DLP_MAX_PATTERN_LEN.
 * Every detectable pattern is digit-shaped, so a pattern that could still
 * grow with future input is contained in this run; everything before it is
 * final and safe to emit (after redacting complete patterns).
 */
export function holdbackStart(window: string): number {
  let i = window.length;
  let count = 0;
  while (i > 0 && count < DLP_MAX_PATTERN_LEN && /[\d -]/.test(window[i - 1]!)) {
    i -= 1;
    count += 1;
  }
  return i;
}
