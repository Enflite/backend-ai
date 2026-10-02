/**
 * fieldSpec.ts — the new-field spec schema shared by the `syteline.form_*`
 * tools and the SyteLine Form AI Agent's planner.
 *
 * UET-only naming: every field binds `object.<alias>Uf_ENF_<Name>`.
 */

import { z } from 'zod';

export const newFieldSchema = z
  .object({
    field: z.string().regex(/^Uf_ENF_[A-Za-z0-9]+$/),
    caption: z.string().min(1).max(60),
    kind: z.enum(['text', 'date', 'dropdown', 'notes']),
    userDefinedType: z.string().max(60).optional(),
    container: z.string().min(1).max(80),
    top: z.number().finite(),
    labelLeft: z.number().finite(),
    labelWidth: z.number().finite().positive(),
    editLeft: z.number().finite(),
    editWidth: z.number().finite().positive(),
  })
  .strict();

export type NewFieldSpecInput = z.infer<typeof newFieldSchema>;
