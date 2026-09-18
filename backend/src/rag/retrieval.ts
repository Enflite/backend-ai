import { AuthContext, CLASSIFICATIONS, Classification, canAccessClassification } from '../authz/permissions.js';
import { tenantQuery } from '../db/pool.js';
import { internalEmbeddingProvider } from '../documents/ingestion.js';

export interface Citation {
  documentId: string;
  documentName: string;
  chunkId: string;
  page?: number;
  section?: string;
  sourceLocation?: string;
}

export interface RetrievalResult {
  context: string;
  citations: Citation[];
}

export async function retrieveAuthorizedContext(
  auth: AuthContext,
  queryText: string,
  documentIds?: string[]
): Promise<RetrievalResult> {
  const [embedding] = await internalEmbeddingProvider.embed([queryText], AbortSignal.timeout(30000));
  const allowed = CLASSIFICATIONS.filter(
    (classification) => classification !== 'UNKNOWN' && canAccessClassification(auth.clearance, classification)
  ) as Classification[];
  const rows = (
    await tenantQuery<{
      chunk_id: string; content: string; page: number | null; section: string | null;
      source_location: string | null; document_id: string; filename: string;
    }>(
      auth.tenantId,
      `SELECT dc.id AS chunk_id, dc.content, dc.page, dc.section, dc.source_location,
              d.id AS document_id, d.filename
       FROM document_chunks dc JOIN documents d ON d.id = dc.document_id AND d.tenant_id = dc.tenant_id
       WHERE dc.tenant_id = $1 AND d.status = 'COMPLETED' AND d.deleted_at IS NULL
         AND d.classification = ANY($2::text[])
         AND ($3::uuid[] IS NULL OR d.id = ANY($3::uuid[]))
         AND (
           d.owner_id = $4 OR EXISTS (
             SELECT 1 FROM document_permissions dp
             WHERE dp.document_id = d.id AND dp.tenant_id = $1 AND dp.can_read
               AND (dp.user_id = $4 OR dp.role_id = $5)
           )
         )
       ORDER BY dc.embedding <=> $6::vector
       LIMIT 8`,
      [auth.tenantId, allowed, documentIds?.length ? documentIds : null, auth.userId, auth.roleId, `[${embedding!.join(',')}]`]
    )
  ).rows;
  const citations = rows.map((row) => ({
    documentId: row.document_id,
    documentName: row.filename,
    chunkId: row.chunk_id,
    ...(row.page ? { page: row.page } : {}),
    ...(row.section ? { section: row.section } : {}),
    ...(row.source_location ? { sourceLocation: row.source_location } : {}),
  }));
  const context = rows.map((row, index) =>
    `<untrusted_document citation="${index + 1}" document_id="${row.document_id}" chunk_id="${row.chunk_id}">\n${row.content}\n</untrusted_document>`
  ).join('\n\n');
  return { context, citations };
}
