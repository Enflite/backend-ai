/**
 * credentialCrypto.ts — AES-256-GCM encryption for stored SyteLine UI credentials.
 *
 * The key comes from the CREDENTIAL_STORE_KEY environment variable (exposed as
 * config.CREDENTIAL_STORE_KEY): 32+ bytes encoded as hex or base64. Absent,
 * placeholder, or weak keys are rejected — credential features refuse to
 * operate (fail closed) rather than encrypting with a guessable key.
 *
 * Callers must zero-fill decrypted password buffers as soon as the single
 * login use completes (see sessionManager / sytelineUi). This module never
 * logs or retains plaintext.
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { config, isPlaceholderSecret } from '../config.js';

export const CREDENTIAL_ALG = 'aes-256-gcm' as const;
const IV_BYTES = 12;
const MIN_KEY_BYTES = 32;

export interface EncryptedCredential {
  iv: string;
  ciphertext: string;
  authTag: string;
  alg: typeof CREDENTIAL_ALG;
}

export class CredentialCryptoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CredentialCryptoError';
  }
}

/**
 * Resolve the encryption key from config.CREDENTIAL_STORE_KEY (or an explicit
 * override, used by tests). Accepts hex or base64 encodings; the decoded
 * key must be at least 32 bytes. Fail closed on anything else.
 */
export function resolveCredentialStoreKey(raw?: string): Buffer {
  const candidate = (raw ?? config.CREDENTIAL_STORE_KEY ?? '').trim();
  if (!candidate) {
    throw new CredentialCryptoError(
      'CREDENTIAL_STORE_KEY is not set: the SyteLine UI credential store is unavailable'
    );
  }
  if (isPlaceholderSecret(candidate)) {
    throw new CredentialCryptoError(
      'CREDENTIAL_STORE_KEY is a documented placeholder value: refusing to encrypt credentials with it'
    );
  }
  let bytes: Buffer;
  if (/^[0-9a-fA-F]+$/.test(candidate) && candidate.length % 2 === 0) {
    bytes = Buffer.from(candidate, 'hex');
  } else {
    try {
      bytes = Buffer.from(candidate, 'base64');
    } catch {
      throw new CredentialCryptoError(
        'CREDENTIAL_STORE_KEY must be hex or base64 encoded'
      );
    }
  }
  if (bytes.length < MIN_KEY_BYTES) {
    throw new CredentialCryptoError(
      `CREDENTIAL_STORE_KEY decodes to ${bytes.length} bytes: at least ${MIN_KEY_BYTES} bytes are required`
    );
  }
  return bytes.subarray(0, 32);
}

/** Encrypt a password. Returns the storable envelope; the key is never stored. */
export function encryptCredential(key: Buffer, plaintext: string | Buffer): EncryptedCredential {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(CREDENTIAL_ALG, key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(typeof plaintext === 'string' ? Buffer.from(plaintext, 'utf8') : plaintext),
    cipher.final(),
  ]);
  return {
    iv: iv.toString('base64'),
    ciphertext: ciphertext.toString('base64'),
    authTag: cipher.getAuthTag().toString('base64'),
    alg: CREDENTIAL_ALG,
  };
}

/**
 * Decrypt a stored envelope. Returns the password as a Buffer the caller
 * must zero-fill (`buf.fill(0)`) once the single login use completes.
 * Throws CredentialCryptoError on tampering, wrong key, or malformed input.
 */
export function decryptCredential(key: Buffer, envelope: EncryptedCredential): Buffer {
  if (!envelope || envelope.alg !== CREDENTIAL_ALG) {
    throw new CredentialCryptoError('Unsupported credential encryption envelope');
  }
  let iv: Buffer;
  let ciphertext: Buffer;
  let authTag: Buffer;
  try {
    iv = Buffer.from(envelope.iv, 'base64');
    ciphertext = Buffer.from(envelope.ciphertext, 'base64');
    authTag = Buffer.from(envelope.authTag, 'base64');
  } catch {
    throw new CredentialCryptoError('Malformed credential encryption envelope');
  }
  if (iv.length !== IV_BYTES || authTag.length === 0 || ciphertext.length === 0) {
    throw new CredentialCryptoError('Malformed credential encryption envelope');
  }
  try {
    const decipher = createDecipheriv(CREDENTIAL_ALG, key, iv);
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    // Tampered ciphertext, wrong key, or corrupted envelope: GCM auth fails.
    throw new CredentialCryptoError('Credential decryption failed (wrong key or tampered data)');
  }
}
