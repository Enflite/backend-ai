import { Errors } from '../errors.js';
import { canAccessClassification, Classification } from './permissions.js';

/**
 * Enforce that a caller may *assert* a classification (on a new conversation,
 * chat turn, upload, or reclassification). Reading data at or below clearance
 * is handled separately by the retrieval filters; this guards the write side
 * so a low-clearance user cannot self-label content as CUI or create
 * conversations outside their clearance.
 */
export function assertClassificationAllowed(
  clearance: Classification,
  classification: Classification
): void {
  if (!canAccessClassification(clearance, classification)) {
    throw Errors.forbidden(
      'CLASSIFICATION_DENIED',
      'Classification exceeds your clearance'
    );
  }
}
