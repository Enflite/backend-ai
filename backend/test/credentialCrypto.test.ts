/**
 * credentialCrypto.test.ts — AES-256-GCM credential envelope.
 *
 * - round-trip (hex key and base64 key)
 * - wrong key fails, tampered ciphertext fails, tampered auth tag fails
 * - absent / placeholder / short keys are rejected (fail closed)
 *
 * VALIDATED IN CI. No SyteLine, no browser, no database.
 */
import { describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import {
  CredentialCryptoError,
  decryptCredential,
  encryptCredential,
  resolveCredentialStoreKey,
} from '../src/secrets/credentialCrypto.js';

const HEX_KEY = randomBytes(32).toString('hex');
const B64_KEY = randomBytes(32).toString('base64');

describe('resolveCredentialStoreKey', () => {
  it('accepts a 32-byte hex key', () => {
    const key = resolveCredentialStoreKey(HEX_KEY);
    expect(key).toHaveLength(32);
  });

  it('accepts a 32-byte base64 key', () => {
    const key = resolveCredentialStoreKey(B64_KEY);
    expect(key).toHaveLength(32);
  });

  it('rejects an absent key (fail closed)', () => {
    expect(() => resolveCredentialStoreKey('')).toThrow(CredentialCryptoError);
    expect(() => resolveCredentialStoreKey('   ')).toThrow(CredentialCryptoError);
  });

  it('rejects documented placeholder values', () => {
    expect(() => resolveCredentialStoreKey('change-me')).toThrow(CredentialCryptoError);
    expect(() => resolveCredentialStoreKey('CHANGEME')).toThrow(CredentialCryptoError);
    expect(() => resolveCredentialStoreKey('<redacted>')).toThrow(CredentialCryptoError);
  });

  it('rejects keys shorter than 32 bytes', () => {
    expect(() => resolveCredentialStoreKey(randomBytes(16).toString('hex'))).toThrow(
      CredentialCryptoError,
    );
  });
});

describe('encrypt/decrypt round-trip', () => {
  it('round-trips through the envelope (hex key)', () => {
    const key = resolveCredentialStoreKey(HEX_KEY);
    const envelope = encryptCredential(key, 's3cret-p@ss');
    expect(envelope.alg).toBe('aes-256-gcm');
    expect(envelope.iv).not.toBe('');
    const plaintext = decryptCredential(key, envelope);
    expect(plaintext.toString('utf8')).toBe('s3cret-p@ss');
    plaintext.fill(0);
  });

  it('round-trips through the envelope (base64 key)', () => {
    const key = resolveCredentialStoreKey(B64_KEY);
    const envelope = encryptCredential(key, 'another-secret');
    expect(decryptCredential(key, envelope).toString('utf8')).toBe('another-secret');
  });

  it('produces a fresh IV per encryption', () => {
    const key = resolveCredentialStoreKey(HEX_KEY);
    const a = encryptCredential(key, 'same');
    const b = encryptCredential(key, 'same');
    expect(a.iv).not.toBe(b.iv);
    expect(a.ciphertext).not.toBe(b.ciphertext);
  });

  it('fails with the wrong key', () => {
    const key = resolveCredentialStoreKey(HEX_KEY);
    const other = resolveCredentialStoreKey(B64_KEY);
    const envelope = encryptCredential(key, 's3cret');
    expect(() => decryptCredential(other, envelope)).toThrow(CredentialCryptoError);
  });

  it('fails on tampered ciphertext', () => {
    const key = resolveCredentialStoreKey(HEX_KEY);
    const envelope = encryptCredential(key, 's3cret');
    const bytes = Buffer.from(envelope.ciphertext, 'base64');
    bytes[0] = bytes[0]! ^ 0xff;
    expect(() =>
      decryptCredential(key, { ...envelope, ciphertext: bytes.toString('base64') }),
    ).toThrow(CredentialCryptoError);
  });

  it('fails on a tampered auth tag', () => {
    const key = resolveCredentialStoreKey(HEX_KEY);
    const envelope = encryptCredential(key, 's3cret');
    const tag = Buffer.from(envelope.authTag, 'base64');
    tag[0] = tag[0]! ^ 0xff;
    expect(() =>
      decryptCredential(key, { ...envelope, authTag: tag.toString('base64') }),
    ).toThrow(CredentialCryptoError);
  });

  it('fails on a wrong-algorithm envelope', () => {
    const key = resolveCredentialStoreKey(HEX_KEY);
    const envelope = encryptCredential(key, 's3cret');
    expect(() => decryptCredential(key, { ...envelope, alg: 'aes-256-cbc' } as never)).toThrow(
      CredentialCryptoError,
    );
  });
});
