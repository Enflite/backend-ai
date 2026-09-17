import { hash, verify, Algorithm } from '@node-rs/argon2';

const ARGON2_OPTIONS = {
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
  outputLen: 32,
  algorithm: Algorithm.Argon2id,
};

export async function hashPassword(password: string): Promise<string> {
  return hash(password, ARGON2_OPTIONS);
}

export async function verifyPassword(passwordOrHash: string, hashOrPassword: string): Promise<boolean> {
  try {
    const isFirstHash = passwordOrHash.startsWith('$argon2');
    const hashStr = isFirstHash ? passwordOrHash : hashOrPassword;
    const pwdStr = isFirstHash ? hashOrPassword : passwordOrHash;
    return await verify(hashStr, pwdStr, ARGON2_OPTIONS);
  } catch {
    return false;
  }
}
