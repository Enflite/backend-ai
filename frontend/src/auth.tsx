/**
 * auth.tsx — session state for the app shell.
 *
 * Owns the access token lifecycle: initial restore (refresh cookie or OIDC
 * fragment handoff), password login, logout, and marking a dead session.
 * Views consume it via useAuth(); routing and the login gate live in App.
 */
import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { api, consumeOidcFragment, setAccessToken } from './api';
import type { AuthUser } from './types';

interface AuthContextValue {
  /** undefined while the session is being restored. */
  user: AuthUser | null | undefined;
  authError: string;
  login: (email: string, password: string) => Promise<AuthUser>;
  logout: () => Promise<void>;
  /** Mark the session dead without a server round-trip (already 401/403). */
  invalidate: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error('useAuth must be used inside AuthProvider');
  return value;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null | undefined>(undefined);
  const [authError, setAuthError] = useState('');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // OIDC callback handoff: the backend redirected here with the access
        // token (or an error code) in the URL fragment.
        const oidc = consumeOidcFragment();
        if (oidc.error) {
          if (!cancelled) {
            setUser(null);
            setAuthError(oidcErrorMessage(oidc.error));
          }
          return;
        }
        const currentUser = oidc.accessToken
          ? await (async () => { setAccessToken(oidc.accessToken!); return api.me(); })()
          : await api.refresh();
        if (!cancelled) setUser(currentUser);
      } catch (cause) {
        if (!cancelled) {
          setUser(null);
          setAuthError(cause instanceof Error ? cause.message : 'Unable to initialize session');
        }
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const login = useCallback(async (email: string, password: string): Promise<AuthUser> => {
    const authenticated = await api.login(email, password);
    setAuthError('');
    setUser(authenticated);
    return authenticated;
  }, []);

  const logout = useCallback(async (): Promise<void> => {
    try {
      await api.logout();
    } finally {
      setUser(null);
    }
  }, []);

  const invalidate = useCallback((): void => setUser(null), []);

  return (
    <AuthContext.Provider value={{ user, authError, login, logout, invalidate }}>
      {children}
    </AuthContext.Provider>
  );
}

function oidcErrorMessage(code: string): string {
  switch (code) {
    case 'idp_denied': return 'Your identity provider denied the sign-in request.';
    case 'invalid_state': return 'The sign-in request expired or was already used. Please try again.';
    case 'email_missing': return 'Your identity provider did not share an email address, so the account could not be created.';
    case 'account_disabled': return 'This account has been disabled. Please contact your administrator.';
    default: return 'Single sign-on failed. Please try again or use your password.';
  }
}

export function Login({ onLogin, error }: { onLogin: (email: string, password: string) => Promise<AuthUser>; error: string }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [localError, setLocalError] = useState('');
  const [ssoEnabled, setSsoEnabled] = useState(false);
  useEffect(() => {
    let cancelled = false;
    api.oidcStatus().then((status) => { if (!cancelled) setSsoEnabled(status.enabled); }).catch(() => undefined);
    return () => { cancelled = true; };
  }, []);
  return <main className="h-screen grid place-items-center px-4"><form className="w-full max-w-sm p-6 rounded-xl space-y-4" style={{ background: 'var(--card)', border: '1px solid var(--border)' }} onSubmit={async (event) => {
    event.preventDefault(); setBusy(true); setLocalError('');
    try { await onLogin(email, password); } catch (cause) { setLocalError(cause instanceof Error ? cause.message : 'Sign in failed'); } finally { setBusy(false); }
  }}><div><img src="/enflite-logo.png" alt="Enflite" className="h-9 w-auto mb-3" /><h1 className="text-xl font-semibold">Enflite</h1><p className="text-sm mt-1" style={{ color: 'var(--muted-foreground)' }}>Sign in with your enterprise account</p></div>
    {(localError || error) && <p role="alert" className="text-sm" style={{ color: '#a50a24' }}>{localError || error}</p>}
    {ssoEnabled && <button type="button" onClick={() => { window.location.href = api.oidcLoginUrl(); }} className="w-full rounded-md py-2 text-sm font-medium" style={{ background: 'var(--secondary)', color: 'var(--foreground)', border: '1px solid var(--border)' }}>Sign in with SSO</button>}
    {ssoEnabled && <div className="flex items-center gap-3 text-xs" style={{ color: 'var(--muted-foreground)' }}><span className="flex-1" style={{ borderTop: '1px solid var(--border)' }} /><span>or with password</span><span className="flex-1" style={{ borderTop: '1px solid var(--border)' }} /></div>}
    <label className="block text-sm">Email<input autoComplete="username" type="email" required value={email} onChange={(event) => setEmail(event.target.value)} className="mt-1 w-full rounded-md px-3 py-2 bg-transparent" style={{ border: '1px solid var(--border)' }} /></label>
    <label className="block text-sm">Password<input autoComplete="current-password" type="password" required value={password} onChange={(event) => setPassword(event.target.value)} className="mt-1 w-full rounded-md px-3 py-2 bg-transparent" style={{ border: '1px solid var(--border)' }} /></label>
    <button disabled={busy} className="w-full rounded-md py-2 text-sm font-medium" style={{ background: 'var(--accent)', color: 'var(--accent-foreground)' }}>{busy ? 'Signing in…' : 'Sign in'}</button>
  </form></main>;
}
