/**
 * activity.ts — pure, DOM-free logic for the interactive AI avatar and the
 * per-conversation activity feed.
 *
 * The chat SSE stream already emits `notice` events (TOOL_PLAN, TOOL_CALLS,
 * MODEL_VISION_SWITCH, MODEL_FAILOVER). This module turns those events into:
 *  - an AssistantState driving the avatar's animation (idle/thinking/streaming/tools)
 *  - a live status line ("Thinking…", "Reading a file…", …)
 *  - per-conversation ActivityEntry records with friendly, non-technical wording
 *
 * Raw identifiers (tool names like `syteline.getItem`, model IDs, UUIDs) must
 * NEVER reach the UI — every label here is human-friendly.
 */

export type AssistantState = 'idle' | 'thinking' | 'streaming' | 'tools';

export type ActivityKind = 'tools' | 'vision' | 'failover' | 'sources' | 'attachment';

export interface ActivityEntry {
  id: string;
  kind: ActivityKind;
  /** Friendly title, e.g. "Looked up an item". Never a raw identifier. */
  title: string;
  /** Optional friendly detail, e.g. "Item 00313-02". */
  detail?: string;
  /** Epoch milliseconds, for display ordering. */
  at: number;
  /** Assistant message this entry belongs to — used to scroll to it. */
  messageId?: string;
}

/** Minimal shape of an SSE notice we care about (mirrors api.ts StreamNoticeData). */
export interface NoticeInput {
  code?: string;
  message: string;
  tools?: string[];
}

/* ------------------------------------------------------------------ */
/* Friendly tool names                                                 */
/* ------------------------------------------------------------------ */

/** Raw tool name → human-friendly label. Unknown tools fall back to a
 *  humanized form of the part after the namespace — never the raw name. */
const TOOL_FRIENDLY_NAMES: Record<string, string> = {
  'repo.readFile': 'Reading a file',
  'repo.search': 'Searching the codebase',
  'syteline.getItem': 'Looking up an item',
  'syteline.getBom': 'Reading a bill of materials',
  'syteline.getCustomer': 'Looking up a customer',
  'syteline.getSalesOrder': 'Checking a sales order',
  'syteline.getWorkOrders': 'Checking work orders',
  'syteline.getItemAvailability': 'Checking inventory',
  'syteline.getOpenPurchaseOrders': 'Checking purchase orders',
  'syteline.form_start_project': 'Starting a form project',
  'syteline.form_add_field': 'Adding a form field',
  'syteline.form_write_docs': 'Writing documentation',
  'syteline.form_build_deck': 'Building a presentation',
  'syteline.form_open_pr': 'Opening a review',
};

function humanize(raw: string): string {
  const base = raw.includes('.') ? raw.slice(raw.lastIndexOf('.') + 1) : raw;
  const words = base
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .trim()
    .toLowerCase();
  if (!words) return 'Working';
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function friendlyToolName(raw: string): string {
  return TOOL_FRIENDLY_NAMES[raw] ?? humanize(raw);
}

/** Deduplicated friendly names, preserving first-seen order. */
export function friendlyToolNames(raw: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const name of raw) {
    const friendly = friendlyToolName(name);
    if (!seen.has(friendly)) {
      seen.add(friendly);
      out.push(friendly);
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Assistant state machine                                             */
/* ------------------------------------------------------------------ */

export type StreamEventName = 'meta' | 'delta' | 'message' | 'notice' | 'done' | 'error';

/**
 * Fold one SSE event into the avatar's activity state.
 * Tool notices take precedence over streaming: the loop interleaves
 * thinking → tools → streaming, and the avatar should show "busy" while
 * any tool round is in flight.
 */
export function nextAssistantState(
  current: AssistantState,
  eventName: StreamEventName,
  code?: string,
): AssistantState {
  switch (eventName) {
    case 'notice':
      if (code === 'TOOL_PLAN' || code === 'TOOL_CALLS') return 'tools';
      return current;
    case 'delta':
    case 'message':
      return 'streaming';
    case 'done':
    case 'error':
      return 'idle';
    case 'meta':
      return current;
  }
}

/* ------------------------------------------------------------------ */
/* Live status line                                                    */
/* ------------------------------------------------------------------ */

function lowerFirst(text: string): string {
  return text.charAt(0).toLowerCase() + text.slice(1);
}

/**
 * Human status for the line under the avatar, e.g. "Thinking…".
 * `notice` is the most recent notice event of the in-flight turn (if any).
 */
export function deriveStatusText(
  state: AssistantState,
  notice?: NoticeInput | null,
  documentCount?: number,
): string {
  switch (state) {
    case 'thinking':
      if (documentCount && documentCount > 0) {
        return documentCount === 1 ? 'Reading your document…' : `Reading your ${documentCount} documents…`;
      }
      return 'Thinking…';
    case 'tools': {
      const tools = notice?.tools ?? [];
      if (tools.length === 1) return `${lowerFirst(friendlyToolName(tools[0]))}…`;
      if (tools.length > 1) return `Running ${tools.length} tools…`;
      return 'Working…';
    }
    case 'streaming':
      return 'Replying…';
    case 'idle':
      return 'Ready';
  }
}

/**
 * Friendly replacement for the transient notice shown under a streaming
 * message. TOOL_PLAN messages embed raw tool names ("I'll run
 * repo.readFile (hello.ts).") — those must never be shown.
 */
export function friendlyNoticeText(notice: NoticeInput): string {
  switch (notice.code) {
    case 'TOOL_CALLS': {
      const count = notice.tools?.length ?? 0;
      return `Running ${count} tool call${count === 1 ? '' : 's'}…`;
    }
    case 'TOOL_PLAN': {
      const names = friendlyToolNames(notice.tools ?? []);
      return names.length ? `${names.join(', ')}…` : 'Working…';
    }
    default:
      // MODEL_VISION_SWITCH / MODEL_FAILOVER messages already use display
      // names (backend contract) and are safe to show verbatim.
      return notice.message;
  }
}

/* ------------------------------------------------------------------ */
/* Activity feed entries                                               */
/* ------------------------------------------------------------------ */

function makeEntry(
  kind: ActivityKind,
  title: string,
  detail: string | undefined,
  messageId: string | undefined,
): ActivityEntry {
  return {
    id: typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.floor(Math.random() * 1e9)}`,
    kind,
    title,
    detail,
    at: Date.now(),
    messageId,
  };
}

/**
 * Convert one SSE notice into activity-feed entries. TOOL_PLAN is
 * intentionally skipped — TOOL_CALLS for the same round carries the same
 * information without the model's raw narration.
 */
export function noticeToActivityEntries(notice: NoticeInput, messageId?: string): ActivityEntry[] {
  switch (notice.code) {
    case 'TOOL_CALLS': {
      const names = friendlyToolNames(notice.tools ?? []);
      if (names.length === 0) {
        return [makeEntry('tools', 'Ran tools', undefined, messageId)];
      }
      if (names.length === 1) {
        return [makeEntry('tools', names[0], undefined, messageId)];
      }
      return [makeEntry('tools', `Ran ${names.length} tools`, names.join(', '), messageId)];
    }
    case 'MODEL_VISION_SWITCH':
      return [makeEntry('vision', 'Used the vision model', 'Your image needed a model that can see', messageId)];
    case 'MODEL_FAILOVER':
      return [makeEntry('failover', 'Continued with a backup model', undefined, messageId)];
    default:
      return [];
  }
}

/** Feed entry for a finished turn that cited sources. */
export function sourcesActivityEntry(count: number, messageId?: string): ActivityEntry | null {
  if (count <= 0) return null;
  return makeEntry(
    'sources',
    count === 1 ? 'Used 1 source' : `Used ${count} sources`,
    undefined,
    messageId,
  );
}

/** Feed entries for files attached to a user turn. */
export function attachmentActivityEntries(
  files: Array<{ name: string; type: string }>,
  messageId?: string,
): ActivityEntry[] {
  if (!files.length) return [];
  const images = files.filter((file) => file.type.startsWith('image/'));
  const entries: ActivityEntry[] = [];
  if (images.length === files.length && images.length > 0) {
    entries.push(makeEntry(
      'attachment',
      images.length === 1 ? 'Looked at your image' : `Looked at ${images.length} images`,
      images.length === 1 ? images[0].name : undefined,
      messageId,
    ));
  } else {
    const names = files.map((file) => file.name);
    entries.push(makeEntry(
      'attachment',
      files.length === 1 ? `Reviewed ${truncateName(names[0])}` : `Reviewed ${files.length} attachments`,
      files.length === 1 ? undefined : names.map(truncateName).join(', '),
      messageId,
    ));
  }
  return entries;
}

function truncateName(name: string, max = 40): string {
  return name.length > max ? `${name.slice(0, max - 1)}…` : name;
}

/** Format an entry timestamp like the reference feed ("3:57 PM"). */
export function formatEntryTime(at: number): string {
  return new Date(at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}
