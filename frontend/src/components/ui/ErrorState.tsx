/** Friendly failure panel with an optional retry action. */
export default function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="rounded-lg p-6 text-center" style={{ background: 'var(--card)', border: '1px solid var(--border)' }}>
      <p className="text-sm font-medium" style={{ color: '#a50a24' }}>Something went wrong</p>
      <p className="text-sm mt-1" style={{ color: 'var(--muted-foreground)' }}>{message}</p>
      {onRetry && (
        <button
          onClick={onRetry}
          className="mt-3 text-sm px-3 py-1.5 rounded-md"
          style={{ border: '1px solid var(--border)', color: 'var(--foreground)' }}
        >
          Try again
        </button>
      )}
    </div>
  );
}

/** Shown when the product surface is switched off server-side. */
export function DisabledState({ product, hint }: { product: string; hint?: string }) {
  return (
    <div className="rounded-lg p-8 text-center max-w-lg mx-auto" style={{ background: 'var(--card)', border: '1px solid var(--border)' }}>
      <p className="text-sm font-semibold" style={{ color: 'var(--foreground)' }}>{product} is disabled</p>
      <p className="text-sm mt-2" style={{ color: 'var(--muted-foreground)' }}>
        {hint ?? 'An administrator needs to enable it before it can be used.'}
      </p>
    </div>
  );
}

/** Shown when the signed-in user lacks the required permission/role. */
export function NotAuthorizedState({ product }: { product: string }) {
  return (
    <div className="rounded-lg p-8 text-center max-w-lg mx-auto" style={{ background: 'var(--card)', border: '1px solid var(--border)' }}>
      <p className="text-sm font-semibold" style={{ color: 'var(--foreground)' }}>Not authorized</p>
      <p className="text-sm mt-2" style={{ color: 'var(--muted-foreground)' }}>
        Your account doesn't have access to {product}. Ask an administrator for the right role.
      </p>
    </div>
  );
}
