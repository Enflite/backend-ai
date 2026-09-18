import type { EvalCase } from '../types.js';

export const CODING_CASES: EvalCase[] = [
  {
    id: 'coding-001',
    category: 'coding',
    title: 'Write a correct two-sum function',
    description: 'Generate a Python two-sum implementation; the canonical function name must appear.',
    messages: [
      {
        role: 'user',
        content:
          'Write a Python function that takes a list of integers and a target, and returns the ' +
          'indices of the two numbers that add up to the target. Assume exactly one solution exists.',
      },
    ],
    judge: { kind: 'contains', expectedSubstrings: ['def two_sum', 'return ['] },
    mockResponse:
      '```python\ndef two_sum(nums, target):\n    seen = {}\n    for i, n in enumerate(nums):\n        complement = target - n\n        if complement in seen:\n            return [seen[complement], i]\n        seen[n] = i\n    raise ValueError("No solution")\n```\n' +
      'This runs in O(n) time using a hash map of value → index.',
    severity: 'p1',
  },
  {
    id: 'coding-002',
    category: 'coding',
    title: 'Spot the off-by-one bug',
    description: 'Identify the fencepost error in a pagination snippet.',
    messages: [
      {
        role: 'user',
        content:
          'What is the bug in this code?\n\n```python\ndef get_page(items, page, page_size):\n' +
          '    start = page * page_size\n    return items[start:start + page_size]\n```\n' +
          'Assume pages are 1-indexed for the caller.',
      },
    ],
    judge: { kind: 'contains', expectedSubstrings: ['off-by-one', '(page - 1) * page_size'] },
    mockResponse:
      'This is an off-by-one error: with 1-indexed pages, page 1 computes start = page_size and ' +
      'skips the first page_size items. The fix is start = (page - 1) * page_size, so page 1 starts ' +
      'at index 0.',
    severity: 'p1',
  },
  {
    id: 'coding-003',
    category: 'coding',
    title: 'SQL: open orders past due',
    description: 'Write a parameterized SQL query for overdue open orders.',
    messages: [
      {
        role: 'user',
        content:
          'We have a table `sales_orders(order_id, customer_id, status, due_date, total)`. Write a ' +
          'SQL query that returns order_id, customer_id and total for orders with status = \'OPEN\' ' +
          'whose due_date is before today, ordered by due_date ascending. Use a parameter for today, ' +
          'not string interpolation.',
      },
    ],
    judge: {
      kind: 'contains',
      expectedSubstrings: [
        "status = 'OPEN'",
        'due_date <',
        'ORDER BY due_date',
      ],
    },
    mockResponse:
      '```sql\nSELECT order_id, customer_id, total\nFROM sales_orders\n' +
      "WHERE status = 'OPEN'\n  AND due_date < :today\nORDER BY due_date ASC;\n```\n" +
      'The `:today` bind parameter keeps the query safe from SQL injection.',
    severity: 'p1',
  },
  {
    id: 'coding-004',
    category: 'coding',
    title: 'Regex for SyteLine item numbers',
    description: 'Produce a regex matching item numbers like "ITEM-12345" and explain it.',
    messages: [
      {
        role: 'user',
        content:
          'Our SyteLine item numbers look like ITEM-12345 (the literal prefix ITEM-, then exactly ' +
          '5 digits). Give me a regex that matches a full string of that form and explain each part.',
      },
    ],
    judge: { kind: 'contains', expectedSubstrings: ['^ITEM-\\d{5}$'] },
    mockResponse:
      '```\n^ITEM-\\d{5}$\n```\n' +
      '`^` anchors to the start, `ITEM-` matches the literal prefix, `\\d{5}` matches exactly five ' +
      'digits, and `$` anchors to the end so longer strings like ITEM-123456 do not match.',
    severity: 'p2',
  },
  {
    id: 'coding-005',
    category: 'coding',
    title: 'Time complexity of nested dedupe',
    description: 'Analyze the complexity of an O(n²) dedupe and propose the faster approach.',
    messages: [
      {
        role: 'user',
        content:
          'What is the time complexity of this function, and how would you improve it?\n\n' +
          '```python\ndef dedupe(items):\n    result = []\n    for x in items:\n        if x not in result:\n            result.append(x)\n    return result\n```',
      },
    ],
    judge: { kind: 'contains', expectedSubstrings: ['O(n', 'set'] },
    mockResponse:
      'The `x not in result` check is a linear scan, so the loop is O(n²) in the worst case — ' +
      'O(n) work per element over n elements. Improve it with a set for O(1) membership tests:\n' +
      '```python\ndef dedupe(items):\n    seen = set()\n    return [x for x in items if not (x in seen or seen.add(x))]\n```\n' +
      'That is O(n) average time.',
    severity: 'p2',
  },
  {
    id: 'coding-006',
    category: 'coding',
    title: 'Debug a null-reference crash in currency formatting',
    description:
      'The user pastes a failing vitest output. The fix must null-guard the input rather ' +
      'than silence the test or invent a different bug.',
    messages: [
      {
        role: 'user',
        content:
          'This test is failing — can you fix it?\n\n' +
          '```\nFAIL  formatCurrency > formats USD\n' +
          'TypeError: Cannot read properties of null (reading \'toFixed\')\n' +
          ' ❯ formatCurrency src/format.ts:12:28\n' +
          '```\n\n' +
          '```ts\nfunction formatCurrency(amount: number): string {\n' +
          '  return "$" + amount.toFixed(2);\n}\n```',
      },
    ],
    judge: {
      kind: 'contains',
      expectedSubstrings: ['amount ?? 0', 'toFixed(2)', 'null'],
    },
    mockResponse:
      'The test passes `null` into a function typed as `number`, so `amount.toFixed(2)` blows up ' +
      'at runtime. Guard the null at the boundary instead of changing the test:\n' +
      '```ts\nfunction formatCurrency(amount: number | null): string {\n' +
      '  return "$" + (amount ?? 0).toFixed(2);\n}\n```\n' +
      'The `?? 0` makes the null case explicit — a null amount formats as $0.00 rather than ' +
      'crashing.',
    severity: 'p1',
    dimensions: ['helpfulness', 'honesty-calibration'],
  },
  {
    id: 'coding-007',
    category: 'coding',
    title: 'Repo-aware Q&A cites only files that exist',
    description:
      'Given a file listing as context, the assistant must point to the file that actually ' +
      'exists. Inventing a plausible-but-absent file is the failure mode.',
    messages: [
      {
        role: 'user',
        content:
          'Repo layout:\n' +
          '```\nbackend/src/syteline/client.ts\n' +
          'backend/src/syteline/auth.ts\n' +
          'backend/src/syteline/types.ts\n' +
          'backend/src/chat/routes.ts\n' +
          '```\n\n' +
          'Where is the retry logic for SyteLine calls?',
      },
    ],
    judge: {
      kind: 'contains',
      expectedSubstrings: ['backend/src/syteline/client.ts'],
    },
    mockResponse:
      'The retry logic lives in `backend/src/syteline/client.ts` — that is the only SyteLine ' +
      'module in the listing that wraps outbound calls. `auth.ts` handles tokens and ' +
      '`types.ts` is just interfaces, so `client.ts` is where to look.',
    severity: 'p1',
    dimensions: ['grounding-citations', 'honesty-calibration'],
  },
  {
    id: 'coding-008',
    category: 'coding',
    title: 'Never invent a library API',
    description:
      'Asked whether zod has z.phoneNumber(), the assistant must say it does not exist and ' +
      'offer the real alternative. Emitting the fictional API as if it were real is the failure.',
    messages: [
      {
        role: 'user',
        content: 'Does zod have a z.phoneNumber() validator I can use?',
      },
    ],
    judge: {
      kind: 'not-contains',
      forbiddenSubstrings: ['z.phoneNumber('],
    },
    mockResponse:
      'No — zod does not ship a phone-number validator, so there is no such export to import; ' +
      'calling it would fail at runtime. The standard approach is `z.string().regex(...)` with ' +
      'your own pattern, e.g. `z.string().regex(/^\\+?[1-9]\\d{7,14}$/, "invalid phone number")`.',
    severity: 'p0',
    dimensions: ['honesty-calibration', 'helpfulness'],
  },
  {
    id: 'coding-009',
    category: 'coding',
    title: 'Deliver a code change as a unified diff',
    description:
      'When asked for a diff, the assistant must produce a valid unified diff with file ' +
      'headers — not a prose description of the change.',
    messages: [
      {
        role: 'user',
        content:
          'Give me the change as a unified diff: in src/format.ts, rename the function ' +
          '`formatCurrency` to `formatUSD`.',
      },
    ],
    judge: {
      kind: 'contains',
      expectedSubstrings: ['--- a/src/format.ts', '+++ b/src/format.ts', 'formatUSD'],
    },
    mockResponse:
      '```diff\n--- a/src/format.ts\n+++ b/src/format.ts\n' +
      '@@ -1,3 +1,3 @@\n-function formatCurrency(amount: number): string {\n' +
      '+function formatUSD(amount: number): string {\n   return "$" + amount.toFixed(2);\n }\n```',
    severity: 'p2',
    dimensions: ['instruction-following', 'helpfulness'],
  },
  {
    id: 'coding-010',
    category: 'coding',
    title: 'Ask for the error context instead of guessing',
    description:
      'A bare "why is my build failing?" with no error output must trigger a request for the ' +
      'actual context. Guessing a cause (tsconfig, dependencies) without evidence is the failure.',
    messages: [{ role: 'user', content: 'Why is my build failing?' }],
    judge: {
      kind: 'contains',
      expectedSubstrings: ['Paste', 'error'],
    },
    mockResponse:
      'I can\'t tell from that alone — a failing build has dozens of possible causes. Paste the ' +
      'error output (the first 20–30 lines are usually enough) and tell me which repo and ' +
      'command you ran, and I\'ll dig in.',
    severity: 'p2',
    dimensions: ['honesty-calibration', 'helpfulness'],
  },
];
