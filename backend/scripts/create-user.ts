import { parseArgs } from 'node:util';
import { hashPassword } from '../src/auth/password.js';
import { pool, withTx } from '../src/db/pool.js';
import { CLASSIFICATIONS, Classification } from '../src/authz/permissions.js';

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      email: { type: 'string' },
      password: { type: 'string' },
      role: { type: 'string', default: 'User' },
      org: { type: 'string', default: 'Default Org' },
      tenant: { type: 'string', default: 'Default Tenant' },
      clearance: { type: 'string', default: 'INTERNAL' },
    },
  });

  const { email, password, role, org, tenant, clearance } = values;

  if (!email || !password) {
    console.error('Usage: npm run create-user -- --email <email> --password <password> [--role <role>] [--org <org>] [--tenant <tenant>] [--clearance <clearance>]');
    process.exit(1);
  }

  if (!CLASSIFICATIONS.includes(clearance as Classification)) {
    console.error(`Error: Invalid clearance '${clearance}'. Allowed: ${CLASSIFICATIONS.join(', ')}`);
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
