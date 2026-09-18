/**
 * routing.ts — eval cases for Phase 6 capability routing.
 *
 * These cases pin the contract of `classifyTask` (backend/src/ai/routing/
 * classifier.ts): which user turns route to which serving capability. The
 * judge is `contains` over the classifier's serialized decision; the eval
 * CLI executes the REAL classifier for this category (see
 * `routingClassifyChatFn` below), so `npm run eval` proves the
 * implementation satisfies the corpus — the mockResponse only keeps the
 * corpus self-consistent under pure-mock runs.
 *
 * Eval assumption (documented, not hidden): routing cases run with
 * `sytelineToolsOffered: true`, i.e. the eval user holds `syteline:read`.
 * The gated-off behavior (ERP language without the permission → chat) is
 * covered by unit tests in backend/test/routing.test.ts, where the full
 * classifier input space (documentIds, tools flag) is exercisable.
 */
import type { EvalCase } from '../types.js';
import { classifyTask } from '../../ai/routing/classifier.js';
import type { ChatFn } from '../runner.js';

const SYTELINE_TOOLS = true;

function decisionJson(content: string): string {
  return JSON.stringify(classifyTask({ content, sytelineToolsOffered: SYTELINE_TOOLS }));
}

function routingCase(
  id: string,
  title: string,
  description: string,
  content: string,
  expectedCapability: 'chat' | 'syteline' | 'coding' | 'rag',
  severity: 'p0' | 'p1' | 'p2'
): EvalCase {
  const mockResponse = decisionJson(content);
  if (!mockResponse.includes(`"capability":"${expectedCapability}"`)) {
    throw new Error(
      `routing eval case ${id}: classifier produced ${mockResponse}, expected capability ${expectedCapability} — fix the case or the classifier, not the expectation`
    );
  }
  return {
    id,
    category: 'routing',
    title,
    description,
    messages: [{ role: 'user', content }],
    judge: { kind: 'contains', expectedSubstrings: [`"capability":"${expectedCapability}"`] },
    mockResponse,
    severity,
    dimensions: ['helpfulness', 'instruction-following'],
  };
}

export const ROUTING_CASES: EvalCase[] = [
  // ------------------------------------------------------------------
  // syteline — the flagship agentic ERP investigation flow
  // ------------------------------------------------------------------
  routingCase(
    'routing-syteline-001',
    'Late order investigation routes to syteline',
    'The canonical "why is this order late?" turn must reach the SyteLine-tuned model.',
    'Why is sales order 45213 late?',
    'syteline',
    'p0'
  ),
  routingCase(
    'routing-syteline-002',
    'Inventory check routes to syteline',
    'Entity (inventory/item) plus investigation verb routes to syteline.',
    'Check inventory for item WIDGET-100 in the Memphis warehouse',
    'syteline',
    'p1'
  ),
  routingCase(
    'routing-syteline-003',
    'Open purchase orders routes to syteline',
    'Purchase-order entity with a listing verb routes to syteline.',
    'Show me open purchase orders for vendor Acme',
    'syteline',
    'p1'
  ),
  routingCase(
    'routing-syteline-004',
    'Explicit SyteLine mention routes to syteline',
    'Naming the product is unambiguous regardless of verbs.',
    'In SyteLine, where do I see backorders?',
    'syteline',
    'p1'
  ),

  // ------------------------------------------------------------------
  // coding
  // ------------------------------------------------------------------
  routingCase(
    'routing-coding-005',
    'Fenced code block routes to coding',
    'A pasted code block is a strong coding signal even with ERP-adjacent words.',
    '```python\ndef total(lines):\n    return sum(l.qty for l in lines)\n```\nWhy does this throw TypeError on empty lines?',
    'coding',
    'p0'
  ),
  routingCase(
    'routing-coding-006',
    'Stack trace routes to coding',
    'Traceback text routes to coding.',
    'Traceback (most recent call last):\n  File "sync.py", line 42, in <module>\nValueError: invalid literal for int()',
    'coding',
    'p1'
  ),
  routingCase(
    'routing-coding-007',
    'Debugging vocabulary routes to coding',
    'Programming-task verbs route to coding.',
    'How do I debug a null pointer in my Java service?',
    'coding',
    'p1'
  ),
  routingCase(
    'routing-coding-008',
    'Refactor request routes to coding',
    'Refactor + SQL vocabulary routes to coding.',
    'Refactor this SQL query to use a CTE instead of the nested subquery',
    'coding',
    'p2'
  ),

  // ------------------------------------------------------------------
  // chat — the default; must not be stolen by near-miss vocabulary
  // ------------------------------------------------------------------
  routingCase(
    'routing-chat-009',
    'General knowledge stays on chat',
    'No code or ERP signals: the general model serves it.',
    'Explain photosynthesis in simple terms',
    'chat',
    'p1'
  ),
  routingCase(
    'routing-chat-010',
    'Everyday "order" is not an ERP order',
    '"I ordered pizza" has no ERP entity and no investigation verb.',
    'I ordered pizza for the team lunch — what toppings do people like?',
    'chat',
    'p1'
  ),
  routingCase(
    'routing-chat-011',
    'Creative writing stays on chat',
    'No task signals at all: default capability.',
    'Write a haiku about running at dawn',
    'chat',
    'p2'
  ),
  routingCase(
    'routing-chat-012',
    'Vague follow-up stays on chat',
    'Pronoun-only follow-ups carry no task signal; the pinned conversation model serves them.',
    'What about the second one?',
    'chat',
    'p2'
  ),
];

/**
 * Eval ChatFn for the routing category: executes the real deterministic
 * classifier instead of returning a scripted response. Non-routing cases
 * delegate to the wrapped chatFn. `sytelineToolsOffered` is fixed true per
 * the documented eval assumption above.
 */
export function routingClassifyChatFn(inner: ChatFn): ChatFn {
  const byUserMessage = new Map<string, EvalCase>();
  for (const c of ROUTING_CASES) {
    const lastUser = [...c.messages].reverse().find((m) => m.role === 'user');
    if (lastUser) byUserMessage.set(lastUser.content, c);
  }
  return async (messages, tools) => {
    const lastUser = [...messages].reverse().find((m) => m.role === 'user');
    const c = lastUser ? byUserMessage.get(lastUser.content) : undefined;
    if (c && lastUser) {
      return { content: decisionJson(lastUser.content) };
    }
    return inner(messages, tools);
  };
}
