import { query } from '../db/pool.js';
import { Classification } from '../authz/permissions.js';
import { verifyPassword } from './password.js';

export interface IdentityRecord {
  id: string;
  email: string;
  password_hash: string;
  display_name: string;
  is_active: boolean;
  clearance: Classification;
}

export interface IdentityProvider {
  authenticate(credentials: { email: string; password: string }): Promise<IdentityRecord | null>;
}

export class PasswordIdentityProvider implements IdentityProvider {
  async authenticate(credentials: { email: string; password: string }): Promise<IdentityRecord | null> {
    const user = (
      await query<IdentityRecord>(
        'SELECT id, email, password_hash, display_name, is_active, clearance FROM users WHERE lower(email) = $1',
        [credentials.email.toLowerCase()]
      )
    ).rows[0];
    if (!user?.is_active || !(await verifyPassword(credentials.password, user.password_hash))) return null;
    return user;
  }
}

// Deployment can replace this provider with an enterprise broker adapter while
// preserving the session, tenant, authorization, and audit boundaries.
export const identityProvider: IdentityProvider = new PasswordIdentityProvider();
