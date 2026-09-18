import type { EvalCase } from './types.js';

export const JSON_OUTPUT_CASES: EvalCase[] = [
  {
    id: 'json-output-001',
    category: 'json-output',
    title: 'Extract order entities as JSON',
    description: 'Return a JSON object with items array matching the schema.',
    messages: [
      {
        role: 'user',
        content:
          'Extract the line items from this PO text as JSON: "PO-8814: 200x resistor R-10k ($0.04 ea), ' +
          '50x capacitor C-100u ($0.12 ea)". Respond with ONLY a JSON object matching ' +
          '{"items": [{"sku": string, "qty": number, "unit_price": number}]}.',
      },
    ],
    judge: {
      kind: 'json-schema',
      jsonSchema: {
        type: 'object',
        required: ['items'],
        properties: {
          items: {
            type: 'array',
            items: {
              type: 'object',
              required: ['sku', 'qty', 'unit_price'],
              properties: {
                sku: { type: 'string' },
                qty: { type: 'number' },
                unit_price: { type: 'number' },
              },
            },
          },
        },
      },
    },
    mockResponse:
      '{"items": [{"sku": "R-10k", "qty": 200, "unit_price": 0.04}, ' +
      '{"sku": "C-100u", "qty": 50, "unit_price": 0.12}]}',
    severity: 'p1',
  },
  {
    id: 'json-output-002',
    category: 'json-output',
    title: 'Classify ticket into JSON envelope',
    description: 'Classify a support ticket; JSON must include category enum and confidence.',
    messages: [
      {
        role: 'user',
        content:
          'Classify this support ticket as JSON only: "The nightly ETL job failed at 2am with a ' +
          'connection timeout to the SyteLine read replica." Use schema ' +
          '{"category": "infrastructure"|"data"|"access"|"other", "confidence": number 0-1, ' +
          '"summary": string}.',
      },
    ],
    judge: {
      kind: 'json-schema',
      jsonSchema: {
        type: 'object',
        required: ['category', 'confidence', 'summary'],
        properties: {
          category: { type: 'string', enum: ['infrastructure', 'data', 'access', 'other'] },
          confidence: { type: 'number' },
          summary: { type: 'string' },
        },
      },
    },
    mockResponse:
      '{"category": "infrastructure", "confidence": 0.92, ' +
      '"summary": "Nightly ETL job failed with connection timeout to SyteLine read replica"}',
    severity: 'p1',
  },
  {
    id: 'json-output-003',
    category: 'json-output',
    title: 'Nested config JSON without trailing prose',
    description: 'Produce nested JSON for a webhook config; no markdown fences or commentary.',
    messages: [
      {
        role: 'user',
        content:
          'Give me a JSON config for a webhook named "order-events" posting to ' +
          'https://hooks.example.com/orders with retries=3 and timeout_ms=5000. Output raw JSON only, ' +
          'no code fences.',
      },
    ],
    judge: {
      kind: 'json-schema',
      jsonSchema: {
        type: 'object',
        required: ['name', 'url', 'retries', 'timeout_ms'],
        properties: {
          name: { type: 'string' },
          url: { type: 'string' },
          retries: { type: 'integer' },
          timeout_ms: { type: 'integer' },
        },
      },
    },
    mockResponse:
      '{"name": "order-events", "url": "https://hooks.example.com/orders", ' +
      '"retries": 3, "timeout_ms": 5000}',
    severity: 'p1',
  },
  {
    id: 'json-output-004',
    category: 'json-output',
    title: 'Empty result set still matches schema',
    description: 'When nothing matches, return a valid empty items array, not prose.',
    messages: [
      {
        role: 'user',
        content:
          'Extract line items as JSON from: "PO-9921: no line items, header charges only." ' +
          'Respond with ONLY a JSON object matching {"items": [{"sku": string, "qty": number, ' +
          '"unit_price": number}]} — an empty array when there are no items.',
      },
    ],
    judge: {
      kind: 'json-schema',
      jsonSchema: {
        type: 'object',
        required: ['items'],
        properties: {
          items: {
            type: 'array',
            items: {
              type: 'object',
              required: ['sku', 'qty', 'unit_price'],
              properties: {
                sku: { type: 'string' },
                qty: { type: 'number' },
                unit_price: { type: 'number' },
              },
            },
          },
        },
      },
    },
    mockResponse: '{"items": []}',
    severity: 'p2',
  },
];
