import { parseArgs } from 'node:util';
import { hashPassword } from '../src/auth/password.js';
import { pool, withTx } from '../src/db/pool.js';
import { CLASSIFICATIONS, Classification } from '../src/authz/permissions.js';

/**
 * Prompt for a password on a TTY without echoing it. Nothing is printed per
 * keystroke (not even asterisks) so shoulder-surfers and scrollback see nothing.
 */
function promptPassword(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    if (!stdin.isTTY || typeof stdin.setRawMode !== 'function') {
      reject(new Error('No TTY available for password prompt; set BACKEND_CREATE_USER_PASSWORD'));
      return;
    }
    process.stdout.write(prompt);
    stdin.setRawMode(true);
    stdin.resume();
    let password = '';
    // A data event can carry several characters at once (e.g. pasted input
    // arriving as `password\r`), so handle the chunk character by character:
    // comparing the whole chunk against a terminator would append a trailing
    // carriage return to the password.
    const onData = (chunk: Buffer): void => {
      for (const char of chunk.toString('utf8')) {
        if (char === '\n' || char === '\r' || char === '\u0004') {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.removeListener('data', onData);
          process.stdout.write('\n');
          resolve(password);
          return;
        }
        if (char === '\u0003') {
          process.stdout.write('\n');
          process.exit(1);
        }
        if (char === '\u007f' || char === '\b') {
          password = password.slice(0, -1);
        } else if (char >= ' ') {
          password += char;
        }
      }
    };
    stdin.on('data', onData);
  });
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      email: { type: 'string' },
      role: { type: 'string', default: 'User' },
      org: { type: 'string', default: 'Default Org' },
      tenant: { type: 'string', default: 'Default Tenant' },
      clearance: { type: 'string', default: 'INTERNAL' },
    },
  });

  const { email, role, org, tenant, clearance } = values;
  // The password never travels as a CLI argument: --password was removed
  // because it is visible in shell history and process listings. Prefer the
  // no-echo TTY prompt; the BACKEND_CREATE_USER_PASSWORD environment variable
  // is the non-interactive fallback for automation (export it, never inline
  // it on a command line).
  let password = process.env.BACKEND_CREATE_USER_PASSWORD;
  if (!password) {
    try {
      password = await promptPassword('Password: ');
    } catch (error) {
      console.error(`Error: ${(error as Error).message}`);
      process.exit(1);
    }
  }

  if (!email || !password) {
    console.error('Usage: npm run create-user -- --email <email> [--role <role>] [--org <org>] [--tenant <tenant>] [--clearance <clearance>]');
    console.error('Password comes from the BACKEND_CREATE_USER_PASSWORD environment variable or a no-echo TTY prompt.');
    process.exit(1);
  }

  if (password.length < 12) {
    console.error('Error: Password must be at least 12 characters');
    process.exit(1);
  }

  if (!CLASSIFICATIONS.includes(clearance as Classification) || clearance === 'UNKNOWN') {
    console.error(`Error: Invalid clearance '${clearance}'. Allowed: ${CLASSIFICATIONS.filter((c) => c !== 'UNKNOWN').join(', ')}`);
    process.exit(1);
  }

  const roleName = role ?? 'User';
  const orgName = org ?? 'Default Org';
  const tenantName = tenant ?? 'Default Tenant';
  const userClearance = clearance as Classification;

  try {
    await withTx(async (client) => {
      // 1. Org
      let orgRes = await client.query<{ id: string }>(
        'SELECT id FROM organizations WHERE name = $1',
        [orgName]
      );
      let orgId: string;
      if (orgRes.rows.length > 0 && orgRes.rows[0]) {
        orgId = orgRes.rows[0].id;
      } else {
        const inserted = await client.query<{ id: string }>(
          'INSERT INTO organizations (name) VALUES ($1) RETURNING id',
          [orgName]
        );
        orgId = inserted.rows[0]!.id;
      }

      // 2. Tenant
      let tenantRes = await client.query<{ id: string }>(
        'SELECT id FROM tenants WHERE organization_id = $1 AND name = $2',
        [orgId, tenantName]
      );
      let tenantId: string;
      if (tenantRes.rows.length > 0 && tenantRes.rows[0]) {
        tenantId = tenantRes.rows[0].id;
      } else {
        const inserted = await client.query<{ id: string }>(
          'INSERT INTO tenants (organization_id, name) VALUES ($1, $2) RETURNING id',
          [orgId, tenantName]
        );
        tenantId = inserted.rows[0]!.id;
      }

      // 3. Role
      const roleRes = await client.query<{ id: string }>(
        'SELECT id FROM roles WHERE name = $1',
        [roleName]
      );
      if (roleRes.rows.length === 0 || !roleRes.rows[0]) {
        throw new Error(`Role '${roleName}' does not exist in database.`);
      }
      const roleId = roleRes.rows[0].id;

      // 4. User
      const passwordHash = await hashPassword(password);
      const displayName = email.split('@')[0] ?? 'User';

      const userRes = await client.query<{ id: string; email: string }>(
        `INSERT INTO users (email, password_hash, display_name, clearance, is_active)
         VALUES ($1, $2, $3, $4, true)
         ON CONFLICT (email) DO UPDATE SET
           password_hash = EXCLUDED.password_hash,
           clearance = EXCLUDED.clearance,
           is_active = true
         RETURNING id, email`,
        [email, passwordHash, displayName, userClearance]
      );
      const user = userRes.rows[0]!;

      // 5. Membership
      await client.query(
        `INSERT INTO memberships (user_id, tenant_id, role_id)
         VALUES ($1, $2, $3)
         ON CONFLICT (user_id, tenant_id) DO UPDATE SET
           role_id = EXCLUDED.role_id`,
        [user.id, tenantId, roleId]
      );

      // Provision this role's approved models for newly-created tenants.
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
      await client.query(
        `INSERT INTO model_access (tenant_id, model_id, role_id)
         SELECT $1, id, $2 FROM models WHERE status = 'APPROVED' AND enabled
         ON CONFLICT DO NOTHING`,
        [tenantId, roleId]
      );

      console.log('--- User created/updated successfully ---');
      console.log(`Email:      ${user.email}`);
      console.log(`Role:       ${roleName}`);
      console.log(`Clearance:  ${userClearance}`);
      console.log(`Tenant:     ${tenantName} (${tenantId})`);
      console.log(`Org:        ${orgName} (${orgId})`);
    });
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error('Failed to create user:', err);
  process.exit(1);
});
