import type { EvalCase } from './types.js';

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
];
