import { describe, expect, it } from 'vitest';
import { sanitizeReason } from '../src/audit/audit.js';

describe('audit reason sanitization', () => {
  it('redacts credential-shaped fragments', () => {
    expect(sanitizeReason('login failed: password=supersecret123')).toBe('login failed: password=[REDACTED]');
    expect(sanitizeReason('saw header Bearer abc.def.ghi')).toBe('saw header Bearer=[REDACTED]');
    expect(sanitizeReason('api_key: xyz789')).toBe('api_key=[REDACTED]');
  });

  it('strips URL userinfo', () => {
    expect(sanitizeReason('fetch https://admin:s3cret@internal:8080/x failed')).toBe(
      'fetch https://[REDACTED]@internal:8080/x failed'
    );
  });

  it('bounds reason length', () => {
    expect(sanitizeReason('x'.repeat(600))).toHaveLength(500);
  });

  it('passes through null and benign text', () => {
    expect(sanitizeReason(null)).toBeNull();
    expect(sanitizeReason(undefined)).toBeNull();
    expect(sanitizeReason('DOCUMENT_INGESTION_FAILED')).toBe('DOCUMENT_INGESTION_FAILED');
  });
});
