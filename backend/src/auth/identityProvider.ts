import { getDb } from '../db/mongo.js';
import { Classification } from '../authz/permissions.js';
import { verifyPassword } from './password.js';

export interface IdentityRecord {
  id: string;
  email: string;
  passwordHash: string;
  displayName: string;
  isActive: boolean;
  clearance: Classification;
}

export interface IdentityProvider {
  authenticate(credentials: { email: string; password: string }): Promise<IdentityRecord | null>;
}

interface UserDoc {
  _id: string;
  email: string;
  passwordHash: string;
  displayName: string;
  isActive: boolean;
  clearance: Classification;
}

export class PasswordIdentityProvider implements IdentityProvider {
  async authenticate(credentials: { email: string; password: string }): Promise<IdentityRecord | null> {
    const db = await getDb();
    const doc = await db.collection<UserDoc>('users').findOne({ email: credentials.email.toLowerCase() });
    if (!doc) return null;
    const user: IdentityRecord = {
      id: doc._id,
      email: doc.email,
      passwordHash: doc.passwordHash,
      displayName: doc.displayName,
      isActive: doc.isActive,
      clearance: doc.clearance,
    };
    if (!user.isActive || !(await verifyPassword(credentials.password, user.passwordHash))) return null;
    return user;
  }
}

// Deployment can replace this provider with an enterprise broker adapter while
// preserving the session, tenant, authorization, and audit boundaries.
export const identityProvider: IdentityProvider = new PasswordIdentityProvider();
