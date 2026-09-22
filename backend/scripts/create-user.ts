import { parseArgs } from 'node:util';
import { randomUUID } from 'node:crypto';
import { hashPassword } from '../src/auth/password.js';
import { getDb, closeDb } from '../src/db/mongo.js';
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

  const db = await getDb();
  try {
    // 1. Org (upsert by name)
    interface OrgDoc { _id: string; name: string; createdAt: Date }
    interface TenantDoc { _id: string; organizationId: string; name: string; createdAt: Date }
    let orgDoc = await db.collection<OrgDoc>('organizations').findOne({ name: orgName });
    let orgId: string;
    if (orgDoc) {
      orgId = orgDoc._id;
    } else {
      orgId = randomUUID();
      await db.collection<OrgDoc>('organizations').insertOne({
        _id: orgId,
        name: orgName,
        createdAt: new Date(),
      });
    }

    // 2. Tenant (upsert by organizationId + name)
    let tenantDoc = await db.collection<TenantDoc>('tenants').findOne({
      organizationId: orgId,
      name: tenantName,
    });
    let tenantId: string;
    if (tenantDoc) {
      tenantId = tenantDoc._id;
    } else {
      tenantId = randomUUID();
      await db.collection<TenantDoc>('tenants').insertOne({
        _id: tenantId,
        organizationId: orgId,
        name: tenantName,
        createdAt: new Date(),
      });
    }

    // 3. Role (must exist)
    const roleDoc = await db.collection('roles').findOne({ name: roleName });
    if (!roleDoc) {
      throw new Error(`Role '${roleName}' does not exist in database.`);
    }
    const roleId = String(roleDoc._id);

    // 4. User (upsert by email)
    const passwordHash = await hashPassword(password);
    const displayName = email.split('@')[0] ?? 'User';
    const now = new Date();

    const userResult = await db.collection('users').findOneAndUpdate(
      { email },
      {
        $set: {
          passwordHash,
          displayName,
          clearance: userClearance,
          isActive: true,
          updatedAt: now,
        },
        $setOnInsert: {
          _id: randomUUID(),
          email,
          createdAt: now,
        },
      },
      { upsert: true, returnDocument: 'after' }
    );
    const user = userResult!;
    const userId = String(user._id);

    // 5. Membership (upsert by userId + tenantId)
    await db.collection('memberships').updateOne(
      { userId, tenantId },
      {
        $set: { roleId, updatedAt: now },
        $setOnInsert: {
          _id: randomUUID(),
          userId,
          tenantId,
          createdAt: now,
        },
      },
      { upsert: true }
    );

    // 6. Provision this role's approved models for the tenant.
    // Find ACTIVE/APPROVED models and grant access to the role.
    const models = await db.collection('models').find({
      status: { $in: ['ACTIVE', 'APPROVED'] },
      enabled: true,
    }).project({ _id: 1 }).toArray();

    for (const model of models) {
      const modelId = String(model._id);
      await db.collection('model_access').updateOne(
        { tenantId, modelId, roleId },
        {
          $setOnInsert: {
            _id: randomUUID(),
            tenantId,
            modelId,
            roleId,
            createdAt: now,
          },
        },
        { upsert: true }
      );
    }

    console.log('--- User created/updated successfully ---');
    console.log(`Email:      ${email}`);
    console.log(`Role:       ${roleName}`);
    console.log(`Clearance:  ${userClearance}`);
    console.log(`Tenant:     ${tenantName} (${tenantId})`);
    console.log(`Org:        ${orgName} (${orgId})`);
  } finally {
    await closeDb();
  }
}

main().catch((err) => {
  console.error('Failed to create user:', err);
  process.exit(1);
});
