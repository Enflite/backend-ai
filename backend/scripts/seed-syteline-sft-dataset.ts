import { parseArgs } from 'node:util';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { getDb, closeDb } from '../src/db/mongo.js';
import { CLASSIFICATIONS, Classification } from '../src/authz/permissions.js';
import { parseSeedJsonl, seedDataset, SEED_DATASET_NAME } from '../src/learning/seed.js';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_SEED_FILE = resolve(SCRIPT_DIR, 'seed-data', 'syteline-expert-seed-v1.jsonl');

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      'tenant-id': { type: 'string' },
      tenant: { type: 'string' },
      org: { type: 'string', default: 'Default Org' },
      file: { type: 'string' },
      name: { type: 'string' },
      classification: { type: 'string', default: 'INTERNAL' },
      'created-by': { type: 'string', default: 'seed-script' },
    },
  });

  // CLI args win; env vars are the non-interactive fallback (never put
  // secrets on a command line — tenant ids are not secret, but the
  // convention keeps automation consistent with create-user.ts).
  const tenantIdArg = values['tenant-id'] ?? process.env.SEED_TENANT_ID;
  const tenantName = values.tenant ?? process.env.SEED_TENANT ?? 'Default Tenant';
  const orgName = values.org ?? process.env.SEED_ORG ?? 'Default Org';
  const file = values.file ?? process.env.SEED_FILE ?? DEFAULT_SEED_FILE;
  const name = (values.name ?? process.env.SEED_DATASET_NAME ?? SEED_DATASET_NAME).trim();
  const classification = (values.classification ?? process.env.SEED_CLASSIFICATION ?? 'INTERNAL') as Classification;
  const createdBy = values['created-by'] ?? 'seed-script';

  if (!name || name.length > 120) {
    console.error('Error: dataset name must be 1-120 characters');
    process.exit(1);
  }
  if (!CLASSIFICATIONS.includes(classification) || classification === 'UNKNOWN') {
    console.error(`Error: Invalid classification '${classification}'. Allowed: ${CLASSIFICATIONS.filter((c) => c !== 'UNKNOWN').join(', ')}`);
    process.exit(1);
  }

  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    console.error(`Error: cannot read seed file '${file}'`);
    process.exit(1);
  }

  let messageSets;
  try {
    messageSets = parseSeedJsonl(text);
  } catch (err) {
    console.error(`Error: ${(err as Error).message}`);
    process.exit(1);
  }

  const db = await getDb();
  try {
    // Resolve the tenant. Unlike create-user.ts this script never creates
    // tenants: seeding training data into a tenant that does not exist yet
    // would be a fail-open mistake.
    interface OrgDoc { _id: string; name: string }
    interface TenantDoc { _id: string; organizationId: string; name: string }
    let tenantId: string;
    if (tenantIdArg) {
      const tenantDoc = await db.collection<TenantDoc>('tenants').findOne({ _id: tenantIdArg });
      if (!tenantDoc) {
        console.error(`Error: no tenant with id '${tenantIdArg}'`);
        process.exit(1);
      }
      tenantId = String(tenantDoc._id);
    } else {
      const orgDoc = await db.collection<OrgDoc>('organizations').findOne({ name: orgName });
      const tenantDoc = orgDoc
        ? await db.collection<TenantDoc>('tenants').findOne({ organizationId: String(orgDoc._id), name: tenantName })
        : null;
      if (!tenantDoc) {
        console.error(`Error: no tenant '${tenantName}' in org '${orgName}'. Create it first (npm run create-user).`);
        process.exit(1);
      }
      tenantId = String(tenantDoc._id);
    }

    const { doc, skipped } = await seedDataset(
      { tenantId, userId: createdBy },
      { name, classification, createdBy },
      messageSets
    );

    if (skipped) {
      console.log(`Dataset '${name}' already exists for this tenant (${doc.exampleCount} examples) — nothing to do.`);
    } else {
      console.log('--- Seed dataset inserted ---');
      console.log(`Name:           ${doc.name}`);
      console.log(`Tenant:         ${tenantId}`);
      console.log(`Examples:       ${doc.exampleCount}`);
      console.log(`Classification: ${classification}`);
      console.log(`Status:         ${doc.status} (immutable)`);
      console.log(`Provenance:     curator-authored seed (sourceFeedbackId 'seed:<name>:<n>')`);
    }
  } finally {
    await closeDb();
  }
}

main().catch((err) => {
  console.error('Failed to seed SFT dataset:', err);
  process.exit(1);
});
