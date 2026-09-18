import type { EvalCase } from '../types.js';

export const REASONING_CASES: EvalCase[] = [
  {
    id: 'reasoning-001',
    category: 'reasoning',
    title: 'Multi-step arithmetic word problem',
    description:
      'Enflite ships 240 circuit boards per crate. A customer orders 18 crates, 7% are defective and replaced 1-for-1 from a spare pool. How many boards ship in total including replacements?',
    messages: [
      {
        role: 'user',
        content:
          'Enflite ships 240 circuit boards per crate. A distributor orders 18 crates. ' +
          'Quality control finds 7% of the boards defective, and every defective board is replaced ' +
          '1-for-1 from a spare pool. How many boards are shipped in total, including the replacements? ' +
          'Show your working.',
      },
    ],
    judge: { kind: 'contains', expectedSubstrings: ['4622'] },
    mockResponse:
      'Total boards ordered: 18 crates × 240 = 4320 boards.\n' +
      'Defective: 7% of 4320 = 302.4, i.e. 302 boards (rounding down to whole boards).\n' +
      'Replacements: 302 boards from the spare pool.\n' +
      'Total shipped = 4320 + 302 = 4622 boards.',
    severity: 'p1',
  },
  {
    id: 'reasoning-002',
    category: 'reasoning',
    title: 'Unit conversion with sanity check',
    description:
      'Convert a warehouse temperature tolerance and spot an impossible value: -40°C to °F, then judge a claim of 500°C ambient.',
    messages: [
      {
        role: 'user',
        content:
          'Our Dallas warehouse spec says components must be stored between -40°C and 85°C. ' +
          'What is -40°C in Fahrenheit? Also, a vendor claims their ambient sensor recorded 500°C ' +
          'in the same warehouse last week — is that plausible?',
      },
    ],
    judge: {
      kind: 'contains',
      expectedSubstrings: ['-40°F', 'not plausible'],
    },
    mockResponse:
      '-40°C converts to -40°F (the one point where the two scales meet: F = C × 9/5 + 32 = -40).\n' +
      'A 500°C ambient reading is not plausible for an indoor warehouse — that is hotter than a ' +
      'commercial pizza oven and far above the 85°C upper storage limit. The sensor is almost ' +
      'certainly faulty or miscalibrated.',
    severity: 'p1',
  },
  {
    id: 'reasoning-003',
    category: 'reasoning',
    title: 'Scheduling logic puzzle',
    description:
      'Three maintenance windows with constraints; deduce the only valid assignment.',
    messages: [
      {
        role: 'user',
        content:
          'Three servers (Alpha, Beta, Gamma) each need a one-hour maintenance window, and the ' +
          'windows must be consecutive hours starting at 1am: 1am, 2am, 3am. Constraints:\n' +
          '1. Alpha cannot go at 1am.\n' +
          '2. Beta must be serviced before Gamma.\n' +
          '3. Gamma cannot go at 3am.\n' +
          'What is the only valid schedule?',
      },
    ],
    judge: { kind: 'contains', expectedSubstrings: ['Beta at 1am', 'Gamma at 2am', 'Alpha at 3am'] },
    mockResponse:
      'Enumerate the (Beta, Gamma) pairs with Beta before Gamma: (1am, 2am), (1am, 3am), (2am, 3am).\n' +
      'Rule 3 eliminates any pair with Gamma at 3am, leaving (1am, 2am) and (2am, 3am) — but ' +
      '(2am, 3am) also has Gamma at 3am, so only (Beta=1am, Gamma=2am) survives.\n' +
      'Alpha takes the remaining slot, 3am, which satisfies rule 1 (Alpha ≠ 1am).\n' +
      'Unique valid schedule: Beta at 1am, Gamma at 2am, Alpha at 3am.',
    severity: 'p2',
  },
  {
    id: 'reasoning-004',
    category: 'reasoning',
    title: 'Percentage discount stacking',
    description:
      'Two sequential discounts are not additive; compute the effective price.',
    messages: [
      {
        role: 'user',
        content:
          'A SyteLine license quote is $48,000. The reseller applies a 15% partner discount, then ' +
          'a further 10% volume discount on the already-discounted price. A colleague says that is ' +
          'the same as a 25% discount. Who is right, and what is the final price?',
      },
    ],
    judge: { kind: 'contains', expectedSubstrings: ['$36,720', '23.5%'] },
    mockResponse:
      'Your colleague is wrong — sequential discounts multiply, they do not add.\n' +
      'After the 15% partner discount: $48,000 × 0.85 = $40,800.\n' +
      'After the 10% volume discount: $40,800 × 0.90 = $36,720.\n' +
      'Effective total discount: 1 − (0.85 × 0.90) = 1 − 0.765 = 23.5%, so the final price is $36,720, ' +
      'which is $1,080 more than a flat 25% discount would give.',
    severity: 'p1',
  },
  {
    id: 'reasoning-005',
    category: 'reasoning',
    title: 'Date arithmetic across month boundary',
    description:
      'Compute a lead-time delivery date that crosses a month boundary, excluding weekends naively is not required — just calendar days.',
    messages: [
      {
        role: 'user',
        content:
          'A purchase order is issued on Friday, February 26, 2027 with a 10-calendar-day lead time. ' +
          'What is the delivery date? (2027 is not a leap year.)',
      },
    ],
    judge: { kind: 'contains', expectedSubstrings: ['March 8, 2027'] },
    mockResponse:
      'February 2027 has 28 days (2027 is not a leap year). 10 calendar days after Feb 26:\n' +
      'Feb 27 = day 1, Feb 28 = day 2, then March 1–8 = days 3–10.\n' +
      'The delivery date is March 8, 2027.',
    severity: 'p2',
  },
];
