import path from 'node:path';
import { Errors } from '../errors.js';

/**
 * Extension → allowed MIME types. Images (png/jpg/webp/gif) are accepted as
 * vision inputs: they bypass text extraction and chunking entirely and are
 * served to vision-capable models at chat time. The byte-level gates —
 * magic-byte validation here and the malware scan in the ingestion pipeline —
 * apply to them exactly as they do to text documents.
 */
const ALLOWED: Record<string, readonly string[]> = {
  '.pdf': ['application/pdf'],
  '.docx': ['application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  '.xlsx': ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
  '.csv': ['text/csv', 'text/plain'],
  '.txt': ['text/plain'],
  '.md': ['text/markdown', 'text/plain'],
  '.html': ['text/html'],
  '.png': ['image/png'],
  '.jpg': ['image/jpeg'],
  '.jpeg': ['image/jpeg'],
  '.gif': ['image/gif'],
  '.webp': ['image/webp'],
};

/** Magic-byte signatures, in file-offset order, per image extension. */
const IMAGE_SIGNATURES: Record<string, Array<{ offset: number; bytes: readonly number[] }>> = {
  '.png': [{ offset: 0, bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] }],
  '.jpg': [{ offset: 0, bytes: [0xff, 0xd8, 0xff] }], // SOI + first marker (covers JFIF/Exif/progressive)
  '.jpeg': [{ offset: 0, bytes: [0xff, 0xd8, 0xff] }],
  '.gif': [{ offset: 0, bytes: [0x47, 0x49, 0x46, 0x38] }], // GIF8
  // RIFF....WEBP: the 4-byte chunk-size field (offset 4-7) is skipped.
  '.webp': [
    { offset: 0, bytes: [0x52, 0x49, 0x46, 0x46] },
    { offset: 8, bytes: [0x57, 0x45, 0x42, 0x50] },
  ],
};

/** True for MIME types served to vision-capable models as image inputs. */
export function isImageMimeType(mimeType: string): boolean {
  return mimeType.startsWith('image/');
}

/** True for extensions that detectMimeType accepts as image vision inputs. */
export function isImageExtension(filename: string): boolean {
  const extension = path.extname(filename).toLowerCase();
  return Object.hasOwn(IMAGE_SIGNATURES, extension);
}

export function sanitizeFilename(filename: string): string {
  if (filename.includes('\0') || filename.includes('/') || filename.includes('\\') || path.isAbsolute(filename)) {
    throw Errors.badRequest('INVALID_FILENAME', 'Filename is invalid');
  }
  const value = path.basename(filename).replace(/[\x00-\x1f\x7f]/g, '').trim();
  if (!value || value.length > 255) throw Errors.badRequest('INVALID_FILENAME', 'Filename is invalid');
  return value;
}

function signatureMatches(bytes: Uint8Array, signature: { offset: number; bytes: readonly number[] }): boolean {
  if (bytes.length < signature.offset + signature.bytes.length) return false;
  return signature.bytes.every((byte, index) => bytes[signature.offset + index] === byte);
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
  if (Object.hasOwn(IMAGE_SIGNATURES, extension)) {
    const signatures = IMAGE_SIGNATURES[extension]!;
    const valid = signatures.every((signature) => signatureMatches(bytes, signature));
    if (!valid) throw Errors.badRequest('FILE_SIGNATURE_MISMATCH', 'Image file signature is invalid');
    return ALLOWED[extension][0]!;
  }
  if (bytes.includes(0)) throw Errors.badRequest('BINARY_TEXT_FILE', 'Text document contains binary data');
  return ALLOWED[extension][0]!;
}
