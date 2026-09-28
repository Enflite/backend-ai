/**
 * Minimal, dependency-free image-dimension parsing for the four accepted
 * vision input formats. Reads only from the file's own container headers —
 * never trusts the extension — and returns null when the bytes cannot be
 * parsed safely (truncated, corrupt, or a format edge case). Callers must
 * treat null as "dimensions unknown", never as an error.
 */

export interface ImageDimensions {
  width: number;
  height: number;
}

function readU16BE(bytes: Uint8Array, offset: number): number {
  return (bytes[offset]! << 8) | bytes[offset + 1]!;
}

function readU16LE(bytes: Uint8Array, offset: number): number {
  return bytes[offset]! | (bytes[offset + 1]! << 8);
}

function readU32BE(bytes: Uint8Array, offset: number): number {
  return bytes[offset]! * 0x1000000 + ((bytes[offset + 1]! << 16) | (bytes[offset + 2]! << 8) | bytes[offset + 3]!);
}

/** PNG: width/height are big-endian u32 at bytes 16-23 (IHDR data). */
function parsePng(bytes: Uint8Array): ImageDimensions | null {
  if (bytes.length < 24) return null;
  const width = readU32BE(bytes, 16);
  const height = readU32BE(bytes, 20);
  return sane(width, height) ? { width, height } : null;
}

/** GIF: width/height are little-endian u16 at bytes 6-9 (logical screen descriptor). */
function parseGif(bytes: Uint8Array): ImageDimensions | null {
  if (bytes.length < 10) return null;
  const width = readU16LE(bytes, 6);
  const height = readU16LE(bytes, 8);
  return sane(width, height) ? { width, height } : null;
}

/**
 * JPEG: walk the segment markers after SOI until a Start-of-Frame marker
 * (SOF0/SOF1/SOF2, C0-C3 except C4/C8/CC) is found; its payload holds
 * height then width as big-endian u16. Returns null on any malformed walk.
 */
function parseJpeg(bytes: Uint8Array): ImageDimensions | null {
  let offset = 2; // past SOI
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) return null;
    const marker = bytes[offset + 1]!;
    // Standalone markers without a length field.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
      offset += 2;
      continue;
    }
    if (offset + 4 > bytes.length) return null;
    const length = readU16BE(bytes, offset + 2);
    if (length < 2) return null;
    const isStartOfFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isStartOfFrame) {
      if (offset + 9 > bytes.length) return null;
      const height = readU16BE(bytes, offset + 5);
      const width = readU16BE(bytes, offset + 7);
      return sane(width, height) ? { width, height } : null;
    }
    offset += 2 + length;
    if (offset > bytes.length) return null;
  }
  return null;
}

/** WebP: lossy (VP8 ) stores 14-bit width/height at offset 26; lossless (VP8L) packs them at offset 21. */
function parseWebp(bytes: Uint8Array): ImageDimensions | null {
  if (bytes.length < 30) return null;
  const chunk = String.fromCharCode(bytes[12]!, bytes[13]!, bytes[14]!, bytes[15]!);
  if (chunk === 'VP8 ') {
    const width = readU16LE(bytes, 26) & 0x3fff;
    const height = readU16LE(bytes, 28) & 0x3fff;
    return sane(width, height) ? { width, height } : null;
  }
  if (chunk === 'VP8L') {
    const packed = bytes[21]! | (bytes[22]! << 8) | (bytes[23]! << 16) | (bytes[24]! << 24);
    const width = (packed & 0x3fff) + 1;
    const height = ((packed >> 14) & 0x3fff) + 1;
    return sane(width, height) ? { width, height } : null;
  }
  return null;
}

/** Reject zeros and absurd values so corrupt headers can't poison metadata. */
function sane(width: number, height: number): boolean {
  return (
    Number.isInteger(width) &&
    Number.isInteger(height) &&
    width > 0 &&
    height > 0 &&
    width <= 100000 &&
    height <= 100000
  );
}

export function parseImageDimensions(mimeType: string, bytes: Uint8Array): ImageDimensions | null {
  try {
    switch (mimeType) {
      case 'image/png':
        return parsePng(bytes);
      case 'image/jpeg':
        return parseJpeg(bytes);
      case 'image/gif':
        return parseGif(bytes);
      case 'image/webp':
        return parseWebp(bytes);
      default:
        return null;
    }
  } catch {
    return null;
  }
}
