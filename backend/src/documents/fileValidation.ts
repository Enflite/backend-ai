import path from 'node:path';
import { Errors } from '../errors.js';

/** MIME type for PowerPoint presentations (ZIP-based OOXML). */
export const PPTX_MIME_TYPE =
  'application/vnd.openxmlformats-officedocument.presentationml.presentation';

/**
 * Extension → allowed MIME types. Images (png/jpg/webp/gif) are accepted as
 * vision inputs: they bypass text extraction and chunking entirely and are
 * served to vision-capable models at chat time. Source-code and config files
 * (see CODE_EXTENSIONS / CODE_FILENAMES) are accepted as plain text: they are
 * inert data for the model to read — there is no execution path, and none
 * must ever be added. The byte-level gates — magic-byte validation here and
 * the malware scan in the ingestion pipeline — apply to every type exactly
 * the same.
 */
const ALLOWED: Record<string, readonly string[]> = {
  '.pdf': ['application/pdf'],
  '.docx': ['application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  '.xlsx': ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
  '.pptx': [PPTX_MIME_TYPE],
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

/** ZIP-based Office formats, validated by PK magic bytes here; the OOXML
 * content type (word/spreadsheet/presentation) is verified at extraction. */
const OFFICE_ZIP_EXTENSIONS = new Set(['.docx', '.xlsx', '.pptx']);

/**
 * Source-code / config extensions treated as plain text. Scripts (.sh, .ps1,
 * .bat, …) are allowed only as inert text for the model to read — never
 * executed. True binaries (.exe, .dll, .msi, .com, .scr, .sys, .so, .dylib)
 * are absent from this list and stay rejected with UNSUPPORTED_FILE_TYPE.
 */
const CODE_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.py', '.java', '.cs', '.cpp', '.c', '.h', '.hpp',
  '.go', '.rs', '.rb', '.php', '.swift', '.kt', '.scala',
  '.sql', '.json', '.jsonl', '.yaml', '.yml', '.toml', '.xml',
  '.css', '.scss', '.log', '.sh', '.bash', '.ps1', '.bat', '.cmd',
  '.pl', '.lua', '.dart', '.r', '.vue', '.svelte',
]);

/** Extensionless / dotfile names treated as plain text. */
const CODE_FILENAMES = new Set(['dockerfile', 'makefile', 'gitignore', '.env']);

/** True for files accepted as inert source/config text. */
export function isCodeFile(filename: string): boolean {
  const base = path.basename(filename).toLowerCase();
  if (CODE_FILENAMES.has(base)) return true;
  return CODE_EXTENSIONS.has(path.extname(base));
}

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

/**
 * Content sniff for text-based uploads (.txt/.md/.csv/.html and code files).
 * Source files have no magic bytes, so a binary renamed to .py must still be
 * rejected: require valid UTF-8 and reject NUL bytes or a high ratio of
 * control characters (tab/LF/CR excepted). Sampled so multi-megabyte logs
 * stay cheap; size limits are enforced separately.
 */
function assertTextContent(bytes: Uint8Array): void {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw Errors.badRequest('BINARY_TEXT_FILE', 'Text document is not valid UTF-8 text');
  }
  const sample = text.slice(0, 8192);
  let suspicious = 0;
  for (let index = 0; index < sample.length; index += 1) {
    const code = sample.charCodeAt(index);
    if (code === 0x7f || (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d)) suspicious += 1;
  }
  if (sample.length > 0 && suspicious / sample.length > 0.05) {
    throw Errors.badRequest('BINARY_TEXT_FILE', 'Text document contains binary data');
  }
}

export function detectMimeType(filename: string, bytes: Uint8Array): string {
  // Code / config files are extension-routed to inert plain text first.
  if (isCodeFile(filename)) {
    assertTextContent(bytes);
    return 'text/plain';
  }
  const extension = path.extname(filename).toLowerCase();
  if (!ALLOWED[extension]) throw Errors.badRequest('UNSUPPORTED_FILE_TYPE', 'Document type is not supported');
  if (extension === '.pdf') {
    if (new TextDecoder().decode(bytes.slice(0, 5)) !== '%PDF-') throw Errors.badRequest('FILE_SIGNATURE_MISMATCH', 'PDF signature is invalid');
    return 'application/pdf';
  }
  if (OFFICE_ZIP_EXTENSIONS.has(extension)) {
    if (bytes[0] !== 0x50 || bytes[1] !== 0x4b) throw Errors.badRequest('FILE_SIGNATURE_MISMATCH', 'Office document signature is invalid');
    return ALLOWED[extension][0]!;
  }
  if (Object.hasOwn(IMAGE_SIGNATURES, extension)) {
    const signatures = IMAGE_SIGNATURES[extension]!;
    const valid = signatures.every((signature) => signatureMatches(bytes, signature));
    if (!valid) throw Errors.badRequest('FILE_SIGNATURE_MISMATCH', 'Image file signature is invalid');
    return ALLOWED[extension][0]!;
  }
  assertTextContent(bytes);
  return ALLOWED[extension][0]!;
}
