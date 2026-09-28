/**
 * smalltalk.ts — deterministic small-talk gate for chat turns.
 *
 * The failure mode this fixes was observed live: the user sent "Hello", the
 * agentic loop offered the full tool registry, and the model treated the
 * greeting as a filename — TOOL_PLAN "I'll run repo.readFile (hello.ts)".
 * The tool round found nothing, and the model fell back to "I don't have
 * enough information to answer your question." A greeting should never reach
 * a tool call.
 *
 * Contract:
 * - Pure and deterministic: no model call, no I/O. Safe to unit test
 *   exhaustively and cheap enough to run on every turn's hot path.
 * - Conservative by design. A false negative (real chit-chat routed
 *   normally) is harmless — the turn just gets the full prompt and tools.
 *   A false positive (an actionable question answered without tools) would
 *   be a real regression, so anything with detectable task intent is
 *   excluded: SyteLine ERP signals, coding intent, repo paths, and code
 *   fences all disqualify via the shared capability detector.
 * - Greetings, thanks, farewells, and pleasantry questions ("how are you?")
 *   count. Bare acknowledgments ("ok", "yes", "go ahead") deliberately do
 *   NOT count — mid-conversation they often mean "proceed with what you
 *   proposed", which may need tools, and only the model with history can
 *   tell.
 * - Attachments are handled by the caller (chat route), not here: images,
 *   document IDs, and code files always disqualify the bypass because they
 *   need the vision / RAG / coding paths respectively.
 */
import { detectCapability } from './capabilityDetect.js';

/** Small-talk turns are short by nature; anything longer routes normally. */
const MAX_SMALLTALK_WORDS = 10;
const MAX_SMALLTALK_CHARS = 80;

/**
 * Full-message small-talk patterns (anchored). The message is lowercased and
 * whitespace-collapsed before matching. Each pattern covers the bare phrase
 * plus harmless filler ("hey there", "thanks again", "see you later").
 */
const SMALLTALK_PATTERNS: RegExp[] = [
  // Greetings.
  /^(hi|hey|hello|yo|hiya|howdy|greetings)([,\s]+(there|again|everyone|folks|team|friend|mate))?[!.,?]*$/,
  /^good\s?(morning|afternoon|evening|day)([,\s]+(everyone|folks|team|all))?[!.,?]*$/,
  // Thanks.
  /^(thanks|thank\s?you|thx|ty|much\s?appreciated)([,\s]+(again|so\s?much|very\s?much|a\s?lot|for\s?(your|the)\s?help|for\s?helping))?[!.,?]*$/,
  // Farewells.
  /^(bye|goodbye|good\s?night|see\s?you(\s?(later|soon))?|take\s?care|have\s?a\s?good\s?(day|one))[!.,?]*$/,
  // Pleasantry questions — still chit-chat, not a request for information.
  /^how\s?are\s?you(\s?doing)?[?!.,]*$/,
  /^how'?s\s?it\s?going[?!.,]*$/,
  /^what'?s\s?up[?!.,]*$/,
  // Greeting + pleasantry combos.
  /^(hi|hey|hello)([,\s]+there)?[,\s]+how\s?are\s?you[?!.,]*$/,
];

/**
 * True when the message is pure chit-chat with no actionable question.
 * See the module contract above for the conservatism rationale.
 */
export function isSmallTalk(content: string): boolean {
  const text = content.trim().toLowerCase().replace(/\s+/g, ' ');
  if (text.length === 0 || text.length > MAX_SMALLTALK_CHARS) return false;
  if (text.split(' ').length > MAX_SMALLTALK_WORDS) return false;
  // Any detectable task intent disqualifies. sytelineToolsOffered=true is the
  // conservative direction: it can only make *fewer* messages count as small
  // talk, never more. "Hello, what's the status of order X?" is a real
  // question and must route normally.
  if (detectCapability(content, { sytelineToolsOffered: true }) !== 'chat') return false;
  return SMALLTALK_PATTERNS.some((pattern) => pattern.test(text));
}
