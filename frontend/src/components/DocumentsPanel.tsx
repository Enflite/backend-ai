import { useRef, useState } from 'react';
import { api } from '../api';
import type { AuthUser, DataClassification, DocumentRecord, RagResult } from '../types';

interface Props {
  user: AuthUser;
  documents: DocumentRecord[];
  selectedIds: string[];
  onSelectedIds: (ids: string[]) => void;
  onChanged: () => Promise<void>;
  onClose: () => void;
}

const CLASSIFICATIONS: DataClassification[] = ['PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'PROPRIETARY', 'CUI'];

export default function DocumentsPanel({ user, documents, selectedIds, onSelectedIds, onChanged, onClose }: Props) {
  const input = useRef<HTMLInputElement>(null);
  const [classification, setClassification] = useState<DataClassification>('INTERNAL');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<RagResult[]>([]);
  const canClassify = user.permissions.includes('document:classify');

  async function upload(file?: File) {
    if (!file) return;
    setBusy(true); setError('');
    try { await api.upload(file, canClassify ? classification : undefined); await onChanged(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Upload failed'); }
    finally { setBusy(false); if (input.current) input.current.value = ''; }
  }

  async function mutate(action: () => Promise<void>) {
    setBusy(true); setError('');
    try { await action(); await onChanged(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Document operation failed'); }
    finally { setBusy(false); }
  }

  async function search() {
    if (!query.trim()) return;
    setBusy(true); setError('');
    try { setResults(await api.ragSearch(query, selectedIds.length ? selectedIds : undefined)); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Search failed'); }
    finally { setBusy(false); }
  }

  return <div className="fixed inset-0 z-50 flex justify-end" style={{ background: '#0008' }} onMouseDown={onClose}>
    <section aria-label="Document knowledge" className="h-full w-full max-w-xl overflow-y-auto p-5" style={{ background: 'var(--background)', borderLeft: '1px solid var(--border)' }} onMouseDown={(event) => event.stopPropagation()}>
      <div className="flex items-center justify-between"><div><h2 className="text-lg font-semibold">Document knowledge</h2><p className="text-xs mt-1" style={{ color: 'var(--muted-foreground)' }}>Only READY, authorized documents can enter model context.</p></div><button aria-label="Close documents" onClick={onClose}>✕</button></div>
      {error && <p role="alert" className="mt-3 p-2 rounded text-sm" style={{ color: '#fca5a5', background: '#7f1d1d55' }}>{error}</p>}

      <div className="mt-5 p-3 rounded-lg space-y-3" style={{ border: '1px solid var(--border)' }}>
        <label className="block text-sm font-medium">Upload an enterprise document</label>
        <div className="flex gap-2">
          {canClassify && <select aria-label="Document classification" value={classification} onChange={(event) => setClassification(event.target.value as DataClassification)} className="rounded px-2 bg-transparent text-sm" style={{ border: '1px solid var(--border)' }}>{CLASSIFICATIONS.map((value) => <option key={value}>{value}</option>)}</select>}
          <input ref={input} type="file" accept=".pdf,.docx,.xlsx,.csv,.txt,.md,.html" disabled={busy} onChange={(event) => void upload(event.target.files?.[0])} className="min-w-0 text-sm" />
        </div>
        {!canClassify && <p className="text-xs" style={{ color: 'var(--muted-foreground)' }}>Uploads receive the server policy default classification.</p>}
      </div>

      <div className="mt-5 space-y-2">
        <h3 className="text-sm font-semibold">Authorized documents</h3>
        {!documents.length && <p className="text-sm" style={{ color: 'var(--muted-foreground)' }}>No documents are available.</p>}
        {documents.map((document) => {
          const selected = selectedIds.includes(document.id);
          return <article key={document.id} className="rounded-lg p-3" style={{ border: '1px solid var(--border)' }}>
            <div className="flex gap-3 items-start">
              <input aria-label={`Use ${document.filename} in chat`} type="checkbox" checked={selected} disabled={document.status !== 'READY'} onChange={() => onSelectedIds(selected ? selectedIds.filter((id) => id !== document.id) : [...selectedIds, document.id])} />
              <div className="min-w-0 flex-1"><p className="text-sm font-medium truncate">{document.filename}</p><p className="text-xs mt-1" style={{ color: 'var(--muted-foreground)' }}>{document.classification} · {document.status} · {(document.sizeBytes / 1024).toFixed(1)} KB</p>{document.errorCode && <p className="text-xs mt-1" style={{ color: '#fca5a5' }}>{document.errorCode}</p>}</div>
              {(document.status === 'FAILED' || document.status === 'QUARANTINED') && <button disabled={busy} className="text-xs" onClick={() => void mutate(() => api.retryDocument(document.id))}>Retry</button>}
              {user.permissions.includes('document:delete') && <button disabled={busy} className="text-xs" style={{ color: '#fca5a5' }} onClick={() => void mutate(() => api.deleteDocument(document.id))}>Delete</button>}
            </div>
          </article>;
        })}
      </div>

      <form className="mt-5" onSubmit={(event) => { event.preventDefault(); void search(); }}><label className="text-sm font-semibold">Search authorized knowledge</label><div className="flex gap-2 mt-2"><input value={query} onChange={(event) => setQuery(event.target.value)} maxLength={8000} className="flex-1 rounded px-3 py-2 bg-transparent text-sm" style={{ border: '1px solid var(--border)' }} placeholder="Search document content" /><button disabled={busy || !query.trim()} className="rounded px-3 text-sm" style={{ background: 'var(--accent)', color: 'var(--accent-foreground)' }}>Search</button></div></form>
      <div className="mt-3 space-y-2">{results.map((result) => <article key={result.chunkId} className="p-3 rounded text-sm" style={{ background: 'var(--card)', border: '1px solid var(--border)' }}><p className="line-clamp-4">{result.text}</p><p className="mt-2 text-xs" style={{ color: 'var(--muted-foreground)' }}>{result.documentName}{result.citation.page ? ` · page ${result.citation.page}` : ''}{result.citation.section ? ` · ${result.citation.section}` : ''} · score {result.score.toFixed(3)}</p></article>)}</div>
    </section>
  </div>;
}
