import { Errors } from '../errors.js';
import { CLASSIFICATIONS, Classification } from '../authz/permissions.js';
import { assertClassificationAllowed } from '../authz/classification.js';

/**
 * Resolve the classification for a new upload.
 *
 * - Users without `document:classify` get the safe default (PUBLIC for
 *   public-only users, INTERNAL otherwise). An *explicit* classification
 *   request without the permission is rejected instead of silently
 *   downgraded: mislabeling a document the user believed was CUI would be a
 *   fail-down.
 * - `document:classify` holders may request any valid classification at or
 *   below their own clearance; UNKNOWN is never a valid document label.
 */
export function resolveUploadClassification(
  clearance: Classification,
  requested: string | undefined,
  canClassify: boolean
): Classification {
  // An explicitly provided empty string counts as a request (e.g. an empty
  // multipart field): only an absent value falls back to the safe default.
  if (requested !== undefined && !canClassify) {
    throw Errors.forbidden(
      'CLASSIFICATION_DENIED',
      'Requesting a classification requires the document:classify permission'
    );
  }
  let classification: Classification = clearance === 'PUBLIC' ? 'PUBLIC' : 'INTERNAL';
  if (canClassify && requested !== undefined) {
    if (!CLASSIFICATIONS.includes(requested as Classification) || requested === 'UNKNOWN') {
      throw Errors.badRequest('INVALID_CLASSIFICATION', 'Invalid data classification');
    }
    classification = requested as Classification;
  }
  assertClassificationAllowed(clearance, classification);
  return classification;
}
