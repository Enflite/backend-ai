import type { EvalCase } from '../types.js';

const RETENTION_CHUNKS = [
  {
    chunkId: 'ret-001',
    documentId: 'doc-policy-retention',
    text: 'Support ticket data retention: closed tickets are retained for 24 months, then anonymized. Open tickets are kept indefinitely until closed.',
  },
  {
    chunkId: 'ret-002',
    documentId: 'doc-policy-retention',
    text: 'Financial records retention: invoices and payment records are retained for 7 years per tax requirements.',
  },
  {
    chunkId: 'ret-003',
    documentId: 'doc-policy-retention',
    text: 'Employee onboarding documents are retained for the duration of employment plus 3 years.',
  },
];

export const RAG_RETRIEVAL_CASES: EvalCase[] = [
  {
    id: 'rag-retrieval-001',
    category: 'rag-retrieval',
    title: 'Surface the retention period for closed tickets',
    description: 'Answer must surface the 24-month retention fact from the chunks.',
    messages: [
      {
        role: 'user',
        content: 'How long do we keep closed support tickets before anonymizing them?',
      },
    ],
    ragContext: RETENTION_CHUNKS,
    judge: { kind: 'contains', expectedSubstrings: ['24 months'] },
    mockResponse:
      'Closed support tickets are retained for 24 months, then anonymized [cite:ret-001].',
    severity: 'p1',
  },
  {
    id: 'rag-retrieval-002',
    category: 'rag-retrieval',
    title: 'Distinguish ticket retention from invoice retention',
    description: 'Must not confuse the 7-year invoice rule with the ticket rule.',
    messages: [
      {
        role: 'user',
        content: 'We need the retention period for invoices, not tickets. How long?',
      },
    ],
    ragContext: RETENTION_CHUNKS,
    judge: { kind: 'contains', expectedSubstrings: ['7 years'] },
    mockResponse: 'Invoices and payment records are retained for 7 years [cite:ret-002].',
    severity: 'p1',
  },
  {
    id: 'rag-retrieval-003',
    category: 'rag-retrieval',
    title: 'Combine facts across two chunks',
    description: 'Answer needs facts from both the ticket chunk and the onboarding chunk.',
    messages: [
      {
        role: 'user',
        content:
          'Compare: how long do we keep closed support tickets versus employee onboarding documents?',
      },
    ],
    ragContext: RETENTION_CHUNKS,
    judge: { kind: 'contains', expectedSubstrings: ['24 months', 'duration of employment plus 3 years'] },
    mockResponse:
      'Closed support tickets: 24 months, then anonymized [cite:ret-001]. Employee onboarding ' +
      'documents: duration of employment plus 3 years [cite:ret-003].',
    severity: 'p1',
  },
  {
    id: 'rag-retrieval-004',
    category: 'rag-retrieval',
    title: 'No relevant chunk means say so',
    description: 'Nothing in context covers VPN policy; the correct answer admits the gap.',
    messages: [
      {
        role: 'user',
        content: 'What is our VPN acceptable-use policy?',
      },
    ],
    ragContext: RETENTION_CHUNKS,
    judge: { kind: 'contains', expectedSubstrings: ["don't have", 'retention'] },
    mockResponse:
      "I don't have any documents about VPN acceptable use in the retrieved context — the " +
      'chunks I was given only cover data retention. I can search for VPN policy documents if you like.',
    severity: 'p1',
  },
];

const WARRANTY_CHUNKS = [
  {
    chunkId: 'war-101',
    documentId: 'doc-warranty-2026',
    text: 'Standard warranty: all Enflite power supplies carry a 36-month warranty from date of shipment.',
  },
  {
    chunkId: 'war-102',
    documentId: 'doc-warranty-2026',
    text: 'Extended warranty: the 60-month extended plan is available only for the EPS-9000 series and must be purchased within 90 days of shipment.',
  },
  {
    chunkId: 'war-103',
    documentId: 'doc-warranty-2026',
    text: 'RMA process: warranty claims require an RMA number issued by support; units shipped without an RMA are refused at the dock.',
  },
];

export const RAG_GROUNDING_CASES: EvalCase[] = [
  {
    id: 'rag-grounding-001',
    category: 'rag-grounding',
    title: 'Cite the chunk supporting the warranty period',
    description: 'Every factual claim must carry its [cite:chunkId] marker.',
    messages: [
      {
        role: 'user',
        content: 'How long is the standard warranty on Enflite power supplies?',
      },
    ],
    ragContext: WARRANTY_CHUNKS,
    judge: { kind: 'citation-grounding', requiredCitations: ['war-101'] },
    mockResponse:
      'The standard warranty on Enflite power supplies is 36 months from the date of shipment [cite:war-101].',
    severity: 'p0',
  },
  {
    id: 'rag-grounding-002',
    category: 'rag-grounding',
    title: 'Cite both chunks for a two-fact answer',
    description: 'Extended-warranty eligibility and purchase window come from the same chunk.',
    messages: [
      {
        role: 'user',
        content: 'Which products can get the extended warranty, and when must it be purchased?',
      },
    ],
    ragContext: WARRANTY_CHUNKS,
    judge: { kind: 'citation-grounding', requiredCitations: ['war-102'] },
    mockResponse:
      'The 60-month extended plan is available only for the EPS-9000 series and must be purchased ' +
      'within 90 days of shipment [cite:war-102].',
    severity: 'p0',
  },
  {
    id: 'rag-grounding-003',
    category: 'rag-grounding',
    title: 'Cite the RMA requirement precisely',
    description: 'The RMA dock-refusal fact must be cited to war-103.',
    messages: [
      {
        role: 'user',
        content: 'What happens if a customer ships a warranty return without an RMA number?',
      },
    ],
    ragContext: WARRANTY_CHUNKS,
    judge: { kind: 'citation-grounding', requiredCitations: ['war-103'] },
    mockResponse:
      'Units shipped without an RMA number are refused at the dock — an RMA number issued by ' +
      'support is required for all warranty claims [cite:war-103].',
    severity: 'p0',
  },
  {
    id: 'rag-grounding-004',
    category: 'rag-grounding',
    title: 'Multi-claim answer cites each claim',
    description: 'Standard period and RMA requirement each need their own citation.',
    messages: [
      {
        role: 'user',
        content: 'Summarize the standard warranty and the RMA requirement.',
      },
    ],
    ragContext: WARRANTY_CHUNKS,
    judge: { kind: 'citation-grounding', requiredCitations: ['war-101', 'war-103'] },
    mockResponse:
      'Standard warranty: 36 months from date of shipment on all Enflite power supplies ' +
      '[cite:war-101]. RMA requirement: warranty claims need a support-issued RMA number; units ' +
      'arriving without one are refused at the dock [cite:war-103].',
    severity: 'p0',
  },
];

export const CITATION_ACCURACY_CASES: EvalCase[] = [
  {
    id: 'citation-accuracy-001',
    category: 'citation-accuracy',
    title: 'Cite the supporting chunk, not the decoy',
    description:
      'war-102 mentions 60 months (extended); the question asks about the standard 36-month ' +
      'warranty, so only war-101 is the correct citation.',
    messages: [
      {
        role: 'user',
        content: 'What is the standard warranty period for Enflite power supplies?',
      },
    ],
    ragContext: WARRANTY_CHUNKS,
    judge: { kind: 'citation-grounding', requiredCitations: ['war-101'] },
    mockResponse:
      'The standard warranty is 36 months from date of shipment [cite:war-101]. (The 60-month ' +
      'figure applies only to the optional EPS-9000 extended plan, not the standard warranty.)',
    severity: 'p0',
  },
  {
    id: 'citation-accuracy-002',
    category: 'citation-accuracy',
    title: 'Do not cite a chunk that does not support the claim',
    description:
      'The decoy chunk ret-002 (invoices) must not be cited for a ticket-retention answer.',
    messages: [
      {
        role: 'user',
        content: 'After how long are closed support tickets anonymized?',
      },
    ],
    ragContext: RETENTION_CHUNKS,
    judge: { kind: 'citation-grounding', requiredCitations: ['ret-001'] },
    mockResponse: 'Closed support tickets are anonymized after 24 months [cite:ret-001].',
    severity: 'p0',
  },
  {
    id: 'citation-accuracy-003',
    category: 'citation-accuracy',
    title: 'No fabricated chunk ids',
    description: 'Citations must reference real chunk ids from the provided context.',
    messages: [
      {
        role: 'user',
        content: 'What is the RMA process for warranty claims?',
      },
    ],
    ragContext: WARRANTY_CHUNKS,
    judge: {
      kind: 'not-contains',
      forbiddenSubstrings: ['cite:war-999', 'cite:war-104', 'cite:doc-'],
    },
    mockResponse:
      'Warranty claims require an RMA number issued by support; units shipped without an RMA ' +
      'are refused at the dock [cite:war-103].',
    severity: 'p0',
  },
];

export const HALLUCINATION_CASES: EvalCase[] = [
  {
    id: 'hallucination-001',
    category: 'hallucination',
    title: 'Admit ignorance when the answer is absent',
    description: 'Nothing in context gives the CEO name; correct behavior is to say so.',
    messages: [
      {
        role: 'user',
        content: 'Who is the CEO of Enflite?',
      },
    ],
    ragContext: WARRANTY_CHUNKS,
    judge: { kind: 'contains', expectedSubstrings: ["don't know", 'provided context'] },
    mockResponse:
      "I don't know — the provided context only covers warranty terms and the RMA process, " +
      'and it does not name the CEO. I can search internal documents if you would like.',
    severity: 'p0',
  },
  {
    id: 'hallucination-002',
    category: 'hallucination',
    title: 'Do not invent a warranty period for an uncovered product',
    description: 'Context covers power supplies only; must not invent terms for the Widget X200.',
    messages: [
      {
        role: 'user',
        content: 'What is the warranty period for the Widget X200 sensor?',
      },
    ],
    ragContext: WARRANTY_CHUNKS,
    judge: { kind: 'contains', expectedSubstrings: ['not in', "don't"] },
    mockResponse:
      "That's not in the documents I was given — they cover Enflite power supply warranties " +
      'only, and I don\'t want to guess about the Widget X200. Want me to search for its datasheet?',
    severity: 'p0',
  },
  {
    id: 'hallucination-003',
    category: 'hallucination',
    title: 'Do not extrapolate retention rules to new record types',
    description: 'Context lists tickets, invoices, onboarding docs; legal holds are not covered.',
    messages: [
      {
        role: 'user',
        content: 'How long do we retain legal hold notices?',
      },
    ],
    ragContext: RETENTION_CHUNKS,
    judge: { kind: 'contains', expectedSubstrings: ["don't", 'retention'] },
    mockResponse:
      "I don't see legal hold notices in the retention policy chunks provided — they cover " +
      'support tickets, invoices, and onboarding documents. I should not guess at the legal-hold ' +
      'rule; let me search for the right policy.',
    severity: 'p1',
  },
  {
    id: 'hallucination-004',
    category: 'hallucination',
    title: 'No invented numbers when context is silent',
    description: 'A plausible-sounding invented figure must not appear.',
    messages: [
      {
        role: 'user',
        content: 'What percentage of warranty claims are approved on first submission?',
      },
    ],
    ragContext: WARRANTY_CHUNKS,
    judge: {
      kind: 'not-contains',
      forbiddenSubstrings: ['94%', '87%', 'percent of claims are approved'],
    },
    mockResponse:
      'The warranty documents I have do not include claim approval statistics, so I cannot give ' +
      'you a percentage. The RMA process chunk only describes the submission requirements.',
    severity: 'p1',
  },
];
