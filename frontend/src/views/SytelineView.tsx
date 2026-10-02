/**
 * views/SytelineView.tsx — SyteLine ops: credential management + session view.
 *
 * Drives the syteline.ui.* tools through the generic tool endpoint. Honest
 * about API limits: there is no session-listing tool, so the session panel
 * only shows sessions it started in this page lifetime and says so plainly.
 * Passwords travel only in the save call body and are cleared from component
 * state the moment the submit is dispatched.
 */
import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '../auth';
import { ApiError } from '../api';
import { defaultToolClassification } from '../api/tools';
import {
  deleteSytelineCredentials,
  endSytelineSession,
  listSytelineCredentials,
  saveSytelineCredentials,
  startSytelineSession,
  type SytelineCredential,
  type SytelineSession,
} from '../api/syteline';
import ErrorState, { DisabledState, NotAuthorizedState } from '../components/ui/ErrorState';
import Spinner from '../components/ui/Spinner';

type LoadState = 'loading' | 'ready' | 'disabled' | 'forbidden' | 'error';

export default function SytelineView() {
  const { user } = useAuth();
  const clearance = defaultToolClassification(user?.clearance ?? 'PUBLIC');

  const [loadState, setLoadState] = useState<LoadState>('loading');
  const [loadError, setLoadError] = useState('');
  const [credentials, setCredentials] = useState<SytelineCredential[]>([]);

  const refreshCredentials = useCallback(async () => {
    setLoadState('loading');
    setLoadError('');
    try {
      const list = await listSytelineCredentials(clearance);
      setCredentials(list);
      setLoadState('ready');
    } catch (cause) {
      if (cause instanceof ApiError && cause.code === 'SYTELINE_UI_DISABLED') {
        setLoadState('disabled');
      } else if (cause instanceof ApiError && cause.status === 403) {
        setLoadState('forbidden');
      } else {
        setLoadState('error');
        setLoadError(cause instanceof Error ? cause.message : 'Unable to load saved credentials');
      }
    }
  }, [clearance]);

  useEffect(() => {
    void refreshCredentials();
  }, [refreshCredentials]);

  // The nav gate requires syteline:ui; a direct URL with no permission is
  // refused here too (the nav is a convenience, not a security boundary).
  if (!user?.permissions.includes('syteline:ui')) {
    return (
      <div className="flex-1 overflow-y-auto p-6">
        <NotAuthorizedState product="SyteLine UI automation" />
      </div>
    );
  }

  if (loadState === 'loading') {
    return (
      <div className="flex-1 overflow-y-auto p-6 grid place-items-center">
        <Spinner />
      </div>
    );
  }

  if (loadState === 'disabled') {
    return (
      <div className="flex-1 overflow-y-auto p-6">
        <DisabledState
          product="SyteLine UI automation"
          hint="SYTELINE_UI_ENABLED is off on the backend. Ask an administrator to enable it and configure SYTELINE_UI_URL."
        />
      </div>
    );
  }

  if (loadState === 'forbidden') {
    return (
      <div className="flex-1 overflow-y-auto p-6">
        <NotAuthorizedState product="SyteLine UI automation" />
      </div>
    );
  }

  if (loadState === 'error') {
    return (
      <div className="flex-1 overflow-y-auto p-6">
        <ErrorState message={loadError} onRetry={() => void refreshCredentials()} />
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto p-6 space-y-6">
      <div>
        <h1 className="text-lg font-semibold" style={{ color: 'var(--foreground)' }}>SyteLine</h1>
        <p className="text-sm mt-1" style={{ color: 'var(--muted-foreground)' }}>
          Saved SyteLine web-client credentials for UI automation, plus browser session control.
        </p>
      </div>
      <CredentialsSection credentials={credentials} clearance={clearance} onChanged={refreshCredentials} />
      <SessionSection clearance={clearance} />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Credentials                                                         */
/* ------------------------------------------------------------------ */

function CredentialsSection({
  credentials,
  clearance,
  onChanged,
}: {
  credentials: SytelineCredential[];
  clearance: Parameters<typeof listSytelineCredentials>[0];
  onChanged: () => void;
}) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [label, setLabel] = useState('');
  const [acknowledged, setAcknowledged] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [revokeTarget, setRevokeTarget] = useState<string | null>(null);
  const [revoking, setRevoking] = useState(false);
  const [revokeError, setRevokeError] = useState('');

  async function handleSave(event: React.FormEvent) {
    event.preventDefault();
    if (!acknowledged || saving) return;
    const submittedPassword = password;
    // Never keep the secret in component state beyond the submit.
    setPassword('');
    setAcknowledged(false);
    setSaving(true);
    setSaveError('');
    try {
      await saveSytelineCredentials(
        clearance,
        { username: username.trim(), password: submittedPassword, label: label.trim() || undefined },
        true,
      );
      setUsername('');
      setLabel('');
      onChanged();
    } catch (cause) {
      setSaveError(cause instanceof Error ? cause.message : 'Unable to save credentials');
    } finally {
      setSaving(false);
    }
  }

  async function handleRevoke() {
    if (revokeTarget === null || revoking) return;
    setRevoking(true);
    setRevokeError('');
    try {
      // The backend has a single per-user credential set (no credential id);
      // revoking applies to the user's saved credentials.
      await deleteSytelineCredentials(clearance, true);
      setRevokeTarget(null);
      onChanged();
    } catch (cause) {
      setRevokeError(cause instanceof Error ? cause.message : 'Unable to revoke credentials');
    } finally {
      setRevoking(false);
    }
  }

  const inputClass = 'mt-1 w-full rounded-md px-3 py-2 bg-transparent text-sm';
  const inputStyle = { border: '1px solid var(--border)' } as const;

  return (
    <section
      aria-labelledby="syteline-credentials-heading"
      className="rounded-lg p-5 space-y-5"
      style={{ background: 'var(--card)', border: '1px solid var(--border)' }}
    >
      <div>
        <h2 id="syteline-credentials-heading" className="text-sm font-semibold" style={{ color: 'var(--foreground)' }}>
          Saved credentials
        </h2>
        <p className="text-xs mt-1" style={{ color: 'var(--muted-foreground)' }}>
          Username and label metadata only — secret material is never returned by the API and never displayed here.
        </p>
      </div>

      {credentials.length === 0 ? (
        <p className="text-sm" style={{ color: 'var(--muted-foreground)' }}>
          No saved SyteLine credentials. Save a set below to enable UI automation.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs" style={{ color: 'var(--muted-foreground)' }}>
                <th className="py-2 pr-4 font-medium">Username</th>
                <th className="py-2 pr-4 font-medium">Label</th>
                <th className="py-2 pr-4 font-medium">Saved</th>
                <th className="py-2 pr-4 font-medium">Last used</th>
                <th className="py-2 font-medium text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {credentials.map((credential) => (
                <tr key={credential.username} style={{ borderTop: '1px solid var(--border)' }}>
                  <td className="py-2 pr-4" style={{ color: 'var(--foreground)' }}>{credential.username}</td>
                  <td className="py-2 pr-4" style={{ color: 'var(--muted-foreground)' }}>{credential.label ?? '—'}</td>
                  <td className="py-2 pr-4" style={{ color: 'var(--muted-foreground)' }}>
                    {formatDateTime(credential.updatedAt)}
                  </td>
                  <td className="py-2 pr-4" style={{ color: 'var(--muted-foreground)' }}>
                    {credential.lastUsedAt ? formatDateTime(credential.lastUsedAt) : '—'}
                  </td>
                  <td className="py-2 text-right">
                    {revokeTarget === credential.username ? (
                      <span className="inline-flex items-center gap-2">
                        <span className="text-xs" style={{ color: 'var(--muted-foreground)' }}>Revoke these credentials?</span>
                        <button
                          type="button"
                          disabled={revoking}
                          onClick={handleRevoke}
                          className="text-xs px-2.5 py-1.5 rounded-md font-medium"
                          style={{ background: 'var(--danger)', color: '#fff' }}
                        >
                          {revoking ? 'Revoking…' : 'Confirm revoke'}
                        </button>
                        <button
                          type="button"
                          disabled={revoking}
                          onClick={() => { setRevokeTarget(null); setRevokeError(''); }}
                          className="text-xs px-2.5 py-1.5 rounded-md"
                          style={{ border: '1px solid var(--border)', color: 'var(--foreground)' }}
                        >
                          Cancel
                        </button>
                      </span>
                    ) : (
                      <button
                        type="button"
                        onClick={() => { setRevokeTarget(credential.username); setRevokeError(''); }}
                        className="text-xs px-2.5 py-1.5 rounded-md"
                        style={{ border: '1px solid var(--border)', color: 'var(--foreground)' }}
                      >
                        Revoke
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {revokeError && (
            <p role="alert" className="text-xs mt-2" style={{ color: 'var(--danger)' }}>{revokeError}</p>
          )}
        </div>
      )}

      <form onSubmit={handleSave} className="space-y-3 pt-1" style={{ borderTop: '1px solid var(--border)' }}>
        <h3 className="text-sm font-medium pt-3" style={{ color: 'var(--foreground)' }}>
          {credentials.length > 0 ? 'Rotate credentials' : 'Save credentials'}
        </h3>
        <div className="grid gap-3 sm:grid-cols-3">
          <label className="block text-sm" style={{ color: 'var(--foreground)' }}>
            Username
            <input
              type="text"
              required
              autoComplete="username"
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              className={inputClass}
              style={inputStyle}
            />
          </label>
          <label className="block text-sm" style={{ color: 'var(--foreground)' }}>
            Password
            <input
              type="password"
              required
              autoComplete="new-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              className={inputClass}
              style={inputStyle}
            />
          </label>
          <label className="block text-sm" style={{ color: 'var(--foreground)' }}>
            Label <span style={{ color: 'var(--muted-foreground)' }}>(optional)</span>
            <input
              type="text"
              autoComplete="off"
              value={label}
              onChange={(event) => setLabel(event.target.value)}
              placeholder="e.g. personal login"
              className={inputClass}
              style={inputStyle}
            />
          </label>
        </div>
        <label className="flex items-start gap-2 text-sm cursor-pointer" style={{ color: 'var(--foreground)' }}>
          <input
            type="checkbox"
            checked={acknowledged}
            onChange={(event) => setAcknowledged(event.target.checked)}
            className="mt-1"
          />
          <span>
            I understand this is destructive: saving replaces my currently saved SyteLine credentials.
          </span>
        </label>
        {saveError && (
          <p role="alert" className="text-xs" style={{ color: 'var(--danger)' }}>{saveError}</p>
        )}
        <button
          type="submit"
          disabled={!acknowledged || saving}
          className="text-sm px-4 py-2 rounded-md font-medium disabled:opacity-50"
          style={{ background: 'var(--accent)', color: 'var(--accent-foreground)' }}
        >
          {saving ? 'Saving…' : credentials.length > 0 ? 'Rotate credentials' : 'Save credentials'}
        </button>
      </form>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Session                                                             */
/* ------------------------------------------------------------------ */

function SessionSection({
  clearance,
}: {
  clearance: Parameters<typeof listSytelineCredentials>[0];
}) {
  const [session, setSession] = useState<SytelineSession | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function handleStart() {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const started = await startSytelineSession(clearance);
      setSession(started);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to start a session');
    } finally {
      setBusy(false);
    }
  }

  async function handleEnd() {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await endSytelineSession(clearance);
      setSession(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to end the session');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section
      aria-labelledby="syteline-session-heading"
      className="rounded-lg p-5 space-y-4"
      style={{ background: 'var(--card)', border: '1px solid var(--border)' }}
    >
      <div>
        <h2 id="syteline-session-heading" className="text-sm font-semibold" style={{ color: 'var(--foreground)' }}>
          Browser session
        </h2>
        <p className="text-xs mt-1" style={{ color: 'var(--muted-foreground)' }}>
          Start a logged-in browser session to the SyteLine web client. Active sessions aren't
          listable via the current API — only sessions started from this page are shown, and
          starting reuses your existing session when one is already open.
        </p>
      </div>

      {session ? (
        <div className="rounded-md p-4 space-y-1 text-sm" style={{ background: 'var(--secondary)', border: '1px solid var(--border)' }}>
          <p style={{ color: 'var(--foreground)' }}>
            <span className="font-medium">Active session</span>
          </p>
          <p className="text-xs break-all" style={{ color: 'var(--muted-foreground)' }}>
            ID: {session.sessionId}
          </p>
          <p className="text-xs" style={{ color: 'var(--muted-foreground)' }}>
            Started {formatDateTime(session.startedAt)} · {session.url}
          </p>
          <div className="pt-2">
            <button
              type="button"
              disabled={busy}
              onClick={handleEnd}
              className="text-sm px-4 py-2 rounded-md font-medium disabled:opacity-50"
              style={{ border: '1px solid var(--border)', color: 'var(--foreground)' }}
            >
              {busy ? 'Ending…' : 'End session'}
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          disabled={busy}
          onClick={handleStart}
          className="text-sm px-4 py-2 rounded-md font-medium disabled:opacity-50"
          style={{ background: 'var(--accent)', color: 'var(--accent-foreground)' }}
        >
          {busy ? 'Starting…' : 'Start session'}
        </button>
      )}

      {error && (
        <p role="alert" className="text-xs" style={{ color: 'var(--danger)' }}>{error}</p>
      )}
    </section>
  );
}

function formatDateTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
}
