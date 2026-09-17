import type { Conversation, Model } from '../types';

export const MODELS: Model[] = [
  {
    id: 'llama-3.3-70b',
    name: 'Llama 3.3 70B',
    provider: 'local',
    description: 'High-capability local model for general use',
    classificationMax: 'CUI',
    contextLength: 128000,
    enabled: true,
  },
  {
    id: 'mistral-7b',
    name: 'Mistral 7B',
    provider: 'local',
    description: 'Fast local model for routine queries',
    classificationMax: 'CUI',
    contextLength: 32000,
    enabled: true,
  },
  {
    id: 'codellama-13b',
    name: 'CodeLlama 13B',
    provider: 'local',
    description: 'Optimized for code generation and review',
    classificationMax: 'PROPRIETARY',
    contextLength: 16000,
    enabled: true,
  },
];

export const MOCK_CONVERSATIONS: Conversation[] = [
  {
    id: 'conv-1',
    title: 'Procurement Policy Review',
    createdAt: new Date('2026-09-17T09:15:00'),
    updatedAt: new Date('2026-09-17T09:42:00'),
    model: 'llama-3.3-70b',
    classification: 'CONFIDENTIAL',
    messages: [
      {
        id: 'msg-1',
        role: 'user',
        content: 'Summarize the key approval thresholds from the procurement policy.',
        timestamp: new Date('2026-09-17T09:15:00'),
      },
      {
        id: 'msg-2',
        role: 'assistant',
        content: `Based on the procurement policy documents, here are the key approval thresholds:

**Standard Purchase Orders**
- Up to $5,000: Department manager approval
- $5,001–$25,000: Director-level approval required
- $25,001–$100,000: VP approval + Finance review
- Over $100,000: Executive committee + Board notification

**Expedited Orders**
According to Section 4.2, expedited orders require one approval level above the standard threshold. All expedited requests must include written justification within 48 hours of the purchase.

**Sole-Source Justification**
Sole-source purchases above $10,000 require a written justification memo and legal review before commitment.`,
        timestamp: new Date('2026-09-17T09:15:30'),
        citations: [
          { id: 1, title: 'Procurement Policy 2026.pdf', section: 'Section 3.1 — Approval Matrix', page: 8 },
          { id: 2, title: 'Procurement Policy 2026.pdf', section: 'Section 4.2 — Expedited Orders', page: 14 },
          { id: 3, title: 'Sole Source Procedure.docx', section: 'Section 2 — Justification Requirements' },
        ],
      },
    ],
  },
  {
    id: 'conv-2',
    title: 'CMMC Control Gap Analysis',
    createdAt: new Date('2026-09-16T14:00:00'),
    updatedAt: new Date('2026-09-16T15:30:00'),
    model: 'llama-3.3-70b',
    classification: 'PROPRIETARY',
    messages: [],
  },
  {
    id: 'conv-3',
    title: 'Q3 Financial Summary',
    createdAt: new Date('2026-09-15T11:20:00'),
    updatedAt: new Date('2026-09-15T11:45:00'),
    model: 'mistral-7b',
    classification: 'CONFIDENTIAL',
    messages: [],
  },
  {
    id: 'conv-4',
    title: 'API Integration Design',
    createdAt: new Date('2026-09-14T08:00:00'),
    updatedAt: new Date('2026-09-14T09:10:00'),
    model: 'codellama-13b',
    classification: 'INTERNAL',
    messages: [],
  },
  {
    id: 'conv-5',
    title: 'HR Onboarding FAQ',
    createdAt: new Date('2026-09-12T16:30:00'),
    updatedAt: new Date('2026-09-12T16:55:00'),
    model: 'mistral-7b',
    classification: 'INTERNAL',
    messages: [],
  },
];
