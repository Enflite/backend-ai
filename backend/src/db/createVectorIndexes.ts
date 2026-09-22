/**
 * createVectorIndexes.ts — provision the Atlas Vector Search indexes for the
 * MongoDB migration (ADR-014).
 *
 * The MongoDB driver CANNOT create Atlas Search / Vector Search indexes, so
 * the migration modules (003_documents_rag, 005_repos_memory) only create
 * regular indexes. This script provisions the two vector indexes through the
 * Atlas Admin API:
 *
 *   document_chunks.embedding   → idx_document_chunks_embedding_vector
 *   repo_code_chunks.embedding  → idx_repo_code_chunks_embedding_vector
 *
 * Both are 1536-dimensional cosine indexes, matching the HNSW
 * `vector_cosine_ops` indexes from SQL migrations 004 and 026.
 *
 * Usage:
 *   # 1. Create an Atlas API key (Project → Access Manager → API Keys) with
 *   #    Project Owner (or Atlas Admin) so it can manage search indexes.
 *   npx tsx src/db/createVectorIndexes.ts --db enflite-ai
 *
 *   Required env:
 *     ATLAS_PUBLIC_KEY / ATLAS_PRIVATE_KEY  — API key pair (digest auth)
 *     ATLAS_PROJECT_ID                       — Atlas project (group) id
 *     ATLAS_CLUSTER_NAME                     — e.g. cluster0
 *
 *   Optional env:
 *     MONGODB_DB_NAME                        — overrides --db
 *
 * Without the env vars the script prints the exact index definitions and the
 * equivalent curl commands (the manual step), then exits 0.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

interface VectorIndexDef {
  collectionName: string;
  indexName: string;
  numDimensions: number;
  similarity: 'cosine';
}

const VECTOR_INDEXES: VectorIndexDef[] = [
  {
    collectionName: 'document_chunks',
    indexName: 'idx_document_chunks_embedding_vector',
    numDimensions: 1536,
    similarity: 'cosine',
  },
  {
    collectionName: 'repo_code_chunks',
    indexName: 'idx_repo_code_chunks_embedding_vector',
    numDimensions: 1536,
    similarity: 'cosine',
  },
];

function atlasIndexPayload(dbName: string, def: VectorIndexDef) {
  return {
    name: def.indexName,
    database: dbName,
    collectionName: def.collectionName,
    type: 'vectorSearch',
    definition: {
      fields: [
        {
          type: 'vector',
          path: 'embedding',
          numDimensions: def.numDimensions,
          similarity: def.similarity,
        },
      ],
    },
  };
}

function parseArgs(): { dbName: string } {
  const args = process.argv.slice(2);
  const dbFlag = args[args.indexOf('--db') + 1];
  const dbName =
    process.env.MONGODB_DB_NAME ??
    dbFlag ??
    (() => {
      // Derive from the connection string path, e.g.
      // mongodb+srv://user:pass@cluster0.x.mongodb.net/enflite-ai
      const uri = process.env.MONGODB_URI ?? '';
      const m = uri.match(/\.net\/([^?]+)/);
      return m?.[1];
    })();
  if (!dbName || args.includes('--db') === false && !process.env.MONGODB_DB_NAME && !process.env.MONGODB_URI) {
    // Fall through to the usage message below.
  }
  return { dbName: dbName ?? '' };
}

async function main(): Promise<void> {
  const { dbName } = parseArgs();
  const { ATLAS_PUBLIC_KEY, ATLAS_PRIVATE_KEY, ATLAS_PROJECT_ID, ATLAS_CLUSTER_NAME } =
    process.env;

  const payloads = VECTOR_INDEXES.map((def) => atlasIndexPayload(dbName, def));

  // Always print the definitions — this doubles as the documented manual step.
  console.log('Atlas Vector Search index definitions:\n');
  for (const p of payloads) {
    console.log(JSON.stringify(p, null, 2));
    console.log();
  }

  if (!ATLAS_PUBLIC_KEY || !ATLAS_PRIVATE_KEY || !ATLAS_PROJECT_ID || !ATLAS_CLUSTER_NAME) {
    console.log(
      [
        'Atlas API credentials not fully provided — skipping automated creation.',
        '',
        'MANUAL STEP (or re-run with env set):',
        '  1. In Atlas: Database → your cluster → Search Indexes → Create Search Index',
        '     → JSON Editor → select the database/collection above and paste the',
        '     corresponding definition.',
        '  2. Or via the Admin API with curl (digest auth):',
        '',
        '     curl --digest -u "$ATLAS_PUBLIC_KEY:$ATLAS_PRIVATE_KEY" \\',
        '       -H "Content-Type: application/json" \\',
        '       -H "Accept: application/vnd.atlas.2023-01-01+json" \\',
        `       -X POST "https://cloud.mongodb.com/api/atlas/v2/groups/$ATLAS_PROJECT_ID/clusters/$ATLAS_CLUSTER_NAME/fts/indexes" \\`,
        `       -d '<index-definition-json>'`,
        '',
        '  3. Poll the index status until it reports READY before running',
        '     $vectorSearch queries against the collection.',
      ].join('\n')
    );
    return;
  }

  if (!dbName) {
    throw new Error(
      'Database name is required: pass --db <name> or set MONGODB_DB_NAME (or MONGODB_URI).'
    );
  }

  const baseUrl =
    `https://cloud.mongodb.com/api/atlas/v2/groups/${ATLAS_PROJECT_ID}` +
    `/clusters/${encodeURIComponent(ATLAS_CLUSTER_NAME)}/fts/indexes`;

  for (const payload of payloads) {
    console.log(`Creating vector search index ${payload.name} ...`);
    const { stdout } = await execFileAsync('curl', [
      '--silent',
      '--show-error',
      '--digest',
      '-u',
      `${ATLAS_PUBLIC_KEY}:${ATLAS_PRIVATE_KEY}`,
      '-H',
      'Content-Type: application/json',
      '-H',
      'Accept: application/vnd.atlas.2023-01-01+json',
      '-X',
      'POST',
      baseUrl,
      '-d',
      JSON.stringify(payload),
    ]);
    const created = JSON.parse(stdout) as { indexID?: string; status?: string };
    console.log(`  indexID=${created.indexID ?? '?'} status=${created.status ?? '?'}`);
    if (created.indexID) {
      await waitForReady(baseUrl, dbName, payload.collectionName, created.indexID);
    }
  }
  console.log('All vector search indexes are READY.');
}

/** Poll the index status endpoint until Atlas reports READY (or FAILED). */
async function waitForReady(
  baseUrl: string,
  dbName: string,
  collectionName: string,
  indexId: string
): Promise<void> {
  const { ATLAS_PUBLIC_KEY, ATLAS_PRIVATE_KEY } = process.env;
  const url = `${baseUrl}/${encodeURIComponent(dbName)}/${encodeURIComponent(
    collectionName
  )}/${encodeURIComponent(indexId)}`;
  for (let attempt = 0; attempt < 60; attempt++) {
    const { stdout } = await execFileAsync('curl', [
      '--silent',
      '--show-error',
      '--digest',
      '-u',
      `${ATLAS_PUBLIC_KEY}:${ATLAS_PRIVATE_KEY}`,
      '-H',
      'Accept: application/vnd.atlas.2023-01-01+json',
      url,
    ]);
    const status = (JSON.parse(stdout) as { status?: string }).status;
    console.log(`  status: ${status} (attempt ${attempt + 1}/60)`);
    if (status === 'READY') return;
    if (status === 'FAILED') {
      throw new Error(`Atlas vector search index ${indexId} failed to build.`);
    }
    await new Promise((r) => setTimeout(r, 10_000));
  }
  throw new Error(`Timed out waiting for Atlas vector search index ${indexId} to become READY.`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
