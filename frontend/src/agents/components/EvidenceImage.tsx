/**
 * agents/components/EvidenceImage.tsx — screenshot evidence viewer.
 *
 * Fetches the PNG bytes with auth (plain <img src> can't carry the Bearer
 * token) and renders them in an expandable viewer. Loading and error states
 * are explicit; a missing image is never rendered as a broken icon.
 */
import { useEffect, useState } from 'react';
import { fetchTaskEvidence } from '../api';
import Spinner from '../../components/ui/Spinner';

export default function EvidenceImage({
  taskId,
  evidenceId,
  label,
}: {
  taskId: string;
  evidenceId: string;
  label: string;
}) {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let objectUrl: string | null = null;
    setUrl(null);
    setError(null);
    fetchTaskEvidence(taskId, evidenceId)
      .then((blob) => {
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
      })
      .catch(() => {
        if (!cancelled) setError('Could not load this screenshot.');
      });
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [taskId, evidenceId]);

  if (error) {
    return (
      <span className="text-xs" style={{ color: 'var(--muted-foreground)' }} role="status">
        {error}
      </span>
    );
  }
  if (!url) {
    return (
      <span className="inline-flex items-center gap-2 text-xs" style={{ color: 'var(--muted-foreground)' }}>
        <Spinner size={12} /> Loading screenshot…
      </span>
    );
  }
  return (
    <>
      <button
        type="button"
        onClick={() => setExpanded(true)}
        className="block rounded-md overflow-hidden text-left"
        style={{ border: '1px solid var(--border)' }}
        aria-label={`Enlarge screenshot: ${label}`}
      >
        <img src={url} alt={label} className="max-h-40 w-auto block" loading="lazy" />
      </button>
      {expanded && (
        <div
          className="fixed inset-0 z-50 grid place-items-center p-6"
          style={{ background: 'rgba(24,24,27,0.72)' }}
          onClick={() => setExpanded(false)}
          role="dialog"
          aria-modal="true"
          aria-label={`Screenshot evidence: ${label}`}
        >
          <img
            src={url}
            alt={label}
            className="max-h-full max-w-full rounded-md"
            style={{ background: '#fff' }}
            onClick={(event) => event.stopPropagation()}
          />
          <button
            type="button"
            onClick={() => setExpanded(false)}
            className="absolute top-4 right-4 text-sm px-3 py-1.5 rounded-md"
            style={{ background: '#fff', color: 'var(--foreground)' }}
            autoFocus
          >
            Close
          </button>
        </div>
      )}
    </>
  );
}
