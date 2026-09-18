import path from 'node:path';
import { Errors } from '../errors.js';

const ALLOWED: Record<string, readonly string[]> = {
  '.pdf': ['application/pdf'],
  '.docx': ['application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  '.xlsx': ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
  '.csv': ['text/csv', 'text/plain'],
  '.txt': ['text/plain'],
  '.md': ['text/markdown', 'text/plain'],
  '.html': ['text/html'],
};

export function sanitizeFilename(filename: string): string {
  if (filename.includes('\0') || filename.includes('/') || filename.includes('\\') || path.isAbsolute(filename)) {
    throw Errors.badRequest('INVALID_FILENAME', 'Filename is invalid');
  }
  const value = path.basename(filename).replace(/[\x00-\x1f\x7f]/g, '').trim();
  if (!value || value.length > 255) throw Errors.badRequest('INVALID_FILENAME', 'Filename is invalid');
  return value;
}

export function detectMimeType(filename: string, bytes: Uint8Array): string {
  const extension = path.extname(filename).toLowerCase();
  if (!ALLOWED[extension]) throw Errors.badRequest('UNSUPPORTED_FILE_TYPE', 'Document type is not supported');
  if (extension === '.pdf') {
    if (new TextDecoder().decode(bytes.slice(0, 5)) !== '%PDF-') throw Errors.badRequest('FILE_SIGNATURE_MISMATCH', 'PDF signature is invalid');
    return 'application/pdf';
  }
  if (extension === '.docx' || extension === '.xlsx') {
    if (bytes[0] !== 0x50 || bytes[1] !== 0x4b) throw Errors.badRequest('FILE_SIGNATURE_MISMATCH', 'Office document signature is invalid');
    return ALLOWED[extension][0]!;
  }
  if (bytes.includes(0)) throw Errors.badRequest('BINARY_TEXT_FILE', 'Text document contains binary data');
  return ALLOWED[extension][0]!;
}
