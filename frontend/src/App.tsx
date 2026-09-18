import { useEffect, useRef, useState } from 'react';
import Sidebar from './components/Sidebar';
import MessageBubble from './components/Message';
import ChatInput from './components/ChatInput';
import ModelSelector from './components/ModelSelector';
import EmptyState from './components/EmptyState';
import DocumentsPanel from './components/DocumentsPanel';
import { api, ApiError, consumeOidcFragment, mapCitation, setAccessToken, streamChat } from './api';
import type { AuthUser, Conversation, DataClassification, DocumentRecord, Message, Model, UploadedFile } from './types';

const CLASSIFICATION_COLOR: Record<string, string> = {
  PUBLIC: '#22c55e', INTERNAL: '#3b82f6', CONFIDENTIAL: '#f59e0b',
  PROPRIETARY: '#ef4444', CUI: '#a855f7', UNKNOWN: '#6b7280',
};
const CLASSIFICATION_ORDER: DataClassification[] = ['PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'PROPRIETARY', 'CUI', 'UNKNOWN'];
const randomId = () => crypto.randomUUID();

/** Mirror the backend's omitted-classification default: a PUBLIC-only caller
 *  defaults to PUBLIC (INTERNAL would exceed their clearance). */
function defaultClassification(clearance: DataClassification): DataClassification {
  return clearance === 'PUBLIC' ? 'PUBLIC' : 'INTERNAL';
}

/** Classification levels the picker may offer: at or below the caller's
 *  clearance, excluding UNKNOWN (never a valid choice). */
function selectableClassifications(clearance: DataClassification): DataClassification[] {
  if (clearance === 'UNKNOWN') return [];
  const rank = CLASSIFICATION_ORDER.indexOf(clearance);
  return CLASSIFICATION_ORDER.filter((level) => level !== 'UNKNOWN' && CLASSIFICATION_ORDER.indexOf(level) <= rank);
}

function toConversation(value: any): Conversation {
  return {
    id: value.id,
    title: value.title,
    createdAt: new Date(value.created_at),
    updatedAt: new Date(value.updated_at),
    messages: [],
    model: value.model_id,
    classification: value.classification,
  };
}

function toModel(value: any): Model {
  const allowed = (value.allowedClassifications ?? []) as DataClassification[];
  const max = [...allowed].sort((a, b) => CLASSIFICATION_ORDER.indexOf(b) - CLASSIFICATION_ORDER.indexOf(a))[0] ?? 'PUBLIC';
  return {
    id: value.id,
    name: value.name,
    provider: value.provider,
    description: `${value.provider} · ${value.version}`,
    classificationMax: max,
    contextLength: value.contextWindow,
    enabled: value.enabled ?? true,
  };
}

export default function App() {
  const [user, setUser] = useState<AuthUser | null | undefined>(undefined);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [models, setModels] = useState<Model[]>([]);
  const [selectedModel, setSelectedModel] = useState<Model | null>(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [showModelSelector, setShowModelSelector] = useState(false);
  const [isStreaming, setIsStreaming] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState('');
  const [documents, setDocuments] = useState<DocumentRecord[]>([]);
  const [selectedDocumentIds, setSelectedDocumentIds] = useState<string[]>([]);
  const [showDocuments, setShowDocuments] = useState(false);
  /** Classification applied to newly created conversations (picker in header). */
  const [draftClassification, setDraftClassification] = useState<DataClassification>('INTERNAL');
  const abortRef = useRef<AbortController | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const activeConversation = conversations.find((conversation) => conversation.id === activeId) ?? null;

  async function loadWorkspace() {
    const [modelResponse, conversationResponse, documentResponse] = await Promise.all([
      api.request<{ models: any[] }>('/models'),
      api.request<{ conversations: any[] }>('/conversations'),
      api.documents(),
    ]);
    const loadedModels = modelResponse.models.map(toModel);
    const loadedConversations = conversationResponse.conversations.map(toConversation);
    setModels(loadedModels);
    const enabledModels = loadedModels.filter((model) => model.enabled);
    setSelectedModel((current) => enabledModels.find((model) => model.id === current?.id) ?? enabledModels[0] ?? null);
    setConversations(loadedConversations);
    setDocuments(documentResponse);
    setActiveId((current) => current && loadedConversations.some((item) => item.id === current) ? current : loadedConversations[0]?.id ?? null);
  }

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
            setError(oidcErrorMessage(oidc.error));
          }
          return;
        }
        const currentUser = oidc.accessToken
          ? await (async () => { setAccessToken(oidc.accessToken!); return api.me(); })()
          : await api.refresh();
        if (cancelled) return;
        setUser(currentUser);
        if (!currentUser) return;
        setDraftClassification(defaultClassification(currentUser.clearance));
        try {
          await loadWorkspace();
        } catch (cause) {
          if (cancelled) return;
          // Auth-class failures mean the session is dead: fall back to
          // logged-out instead of showing an authenticated empty shell.
          if (cause instanceof ApiError && (cause.status === 401 || cause.status === 403)) {
            setUser(null);
            setConversations([]);
            setDocuments([]);
            setActiveId(null);
          }
          setError(cause instanceof Error ? cause.message : 'Unable to load workspace');
        }
      } catch (cause) {
        if (!cancelled) {
          setUser(null);
          setError(cause instanceof Error ? cause.message : 'Unable to initialize session');
        }
      }
    })();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => { messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [activeConversation?.messages, isStreaming]);

  useEffect(() => {
    if (!user || !documents.some((document) => document.status === 'PENDING' || document.status === 'PROCESSING')) return;
    const timer = window.setInterval(() => { void api.documents().then(setDocuments).catch(() => undefined); }, 2000);
    return () => window.clearInterval(timer);
  }, [user, documents]);

  async function selectConversation(id: string) {
    setActiveId(id);
    const existing = conversations.find((item) => item.id === id);
    if (existing?.messages.length) return;
    try {
      const response = await api.request<{ messages: any[] }>(`/conversations/${id}/messages`);
      const messages: Message[] = response.messages.map((message) => ({
        id: message.id,
        role: message.role,
        content: message.content,
        timestamp: new Date(message.created_at),
        citations: message.citations?.map(mapCitation),
        model: models.find((model) => model.id === message.model_id)?.name,
      }));
      setConversations((current) => current.map((item) => item.id === id ? { ...item, messages } : item));
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Unable to load conversation'); }
  }

  async function newConversation(): Promise<Conversation | null> {
    if (!selectedModel) return null;
    try {
      const response = await api.request<{ conversation: any }>('/conversations', {
        method: 'POST',
        body: JSON.stringify({ modelId: selectedModel.id, classification: draftClassification }),
      });
      const conversation = toConversation(response.conversation);
      setConversations((current) => [conversation, ...current]);
      setActiveId(conversation.id);
      return conversation;
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Unable to create conversation'); return null; }
  }

  /** Persist a mid-conversation model switch. The backend PATCH route is
   *  title-only today, so a 400/403 here is expected and non-fatal: the local
   *  selection still applies because every turn sends the model explicitly. */
  async function selectModel(model: Model) {
    setSelectedModel(model);
    setShowModelSelector(false);
    const conversation = activeConversation;
    if (!conversation || conversation.model === model.id) return;
    setConversations((current) => current.map((item) => item.id === conversation.id ? { ...item, model: model.id } : item));
    try {
      await api.request(`/conversations/${conversation.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ modelId: model.id }),
      });
    } catch (cause) {
      if (cause instanceof ApiError && (cause.status === 400 || cause.status === 403 || cause.status === 404)) return;
      setError(cause instanceof Error ? cause.message : 'Unable to update conversation model');
    }
  }

  async function deleteConversation(id: string) {
    try {
      await api.request(`/conversations/${id}`, { method: 'DELETE' });
      setConversations((current) => current.filter((item) => item.id !== id));
      if (activeId === id) setActiveId(conversations.find((item) => item.id !== id)?.id ?? null);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Unable to delete conversation'); }
  }

  async function renameConversation(id: string, title: string) {
    try {
      await api.request(`/conversations/${id}`, { method: 'PATCH', body: JSON.stringify({ title }) });
      setConversations((current) => current.map((item) => item.id === id ? { ...item, title } : item));
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Unable to rename conversation'); }
  }

  /** Stream one assistant turn for an already-placed assistant bubble. */
  async function runAssistantTurn(conversation: Conversation, content: string, files: UploadedFile[], assistantId: string) {
    if (!selectedModel) return;
    setIsStreaming(true);
    setError('');
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const canClassify = user?.permissions.includes('document:classify') ?? false;
      const uploaded = await Promise.all(files.filter((item) => item.file).map((item) => api.upload(item.file!, canClassify ? conversation.classification : undefined)));
      if (uploaded.length) setDocuments((current) => [...uploaded, ...current]);
      const uploadedReadyIds: string[] = [];
      for (const document of uploaded) {
        let current = document;
        for (let attempt = 0; attempt < 120 && (current.status === 'PENDING' || current.status === 'PROCESSING'); attempt += 1) {
          await new Promise((resolve) => window.setTimeout(resolve, 1000));
          if (controller.signal.aborted) throw new DOMException('Cancelled', 'AbortError');
          current = await api.document(document.id, controller.signal);
          setDocuments((items) => items.map((item) => item.id === current.id ? current : item));
        }
        if (current.status !== 'READY') throw new Error(`Document ${current.filename} is ${current.status}${current.errorCode ? `: ${current.errorCode}` : ''}`);
        uploadedReadyIds.push(current.id);
      }
      const documentIds = [...new Set([...selectedDocumentIds, ...uploadedReadyIds])];
      if (uploadedReadyIds.length) setSelectedDocumentIds(documentIds);
      await streamChat({
        conversationId: conversation.id,
        content,
        modelId: selectedModel.id,
        classification: conversation.classification,
        ...(documentIds.length ? { documentIds } : {}),
      }, controller.signal, (streamEvent) => {
        if (streamEvent.event === 'error') {
          const message = streamEvent.data.message || 'Model request failed';
          setConversations((current) => current.map((item) => item.id === conversation.id ? {
            ...item,
            messages: item.messages.map((msg) => msg.id === assistantId ? {
              ...msg,
              isStreaming: false,
              notice: undefined,
              error: message,
            } : msg),
          } : item));
          throw new Error(message);
        }
        if (streamEvent.event === 'meta') return;
        setConversations((current) => current.map((item) => item.id === conversation.id ? {
          ...item,
          messages: item.messages.map((msg) => msg.id === assistantId ? {
            ...msg,
            content: (streamEvent.event === 'delta' || streamEvent.event === 'message') ? msg.content + streamEvent.data.content : msg.content,
            isStreaming: streamEvent.event !== 'done',
            notice: streamEvent.event === 'notice' ? streamEvent.data.message : (streamEvent.event === 'done' ? undefined : msg.notice),
            citations: streamEvent.event === 'done' ? (streamEvent.data.citations ?? msg.citations) : msg.citations,
            usage: streamEvent.event === 'done' ? (streamEvent.data.usage ?? msg.usage) : msg.usage,
            model: streamEvent.event === 'done' && streamEvent.data.fallback ? `${msg.model} → ${streamEvent.data.fallback.name}` : msg.model,
          } : msg),
        } : item));
      });
    } catch (cause) {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : 'Chat request failed');
      setConversations((current) => current.map((item) => item.id === conversation.id ? {
        ...item,
        messages: item.messages.map((msg) => msg.id === assistantId ? { ...msg, isStreaming: false } : msg),
      } : item));
    } finally {
      setIsStreaming(false);
      abortRef.current = null;
    }
  }

  async function sendMessage(content: string, files: UploadedFile[]) {
    const sendableFiles = files.filter((item) => item.file);
    const text = content.trim();
    if (!selectedModel || (!text && sendableFiles.length === 0)) return;
    const conversation = activeConversation ?? await newConversation();
    if (!conversation) return;
    // The backend requires non-empty content, so a files-only send carries the
    // attached file names as the message text.
    const effectiveContent = text || sendableFiles.map((item) => item.name).join(', ');
    const userMessage: Message = { id: randomId(), role: 'user', content: effectiveContent, timestamp: new Date() };
    const assistantId = randomId();
    const assistantMessage: Message = { id: assistantId, role: 'assistant', content: '', timestamp: new Date(), isStreaming: true, model: selectedModel.name };
    setConversations((current) => current.map((item) => item.id === conversation.id ? {
      ...item,
      title: item.messages.length ? item.title : effectiveContent.slice(0, 80),
      messages: [...item.messages, userMessage, assistantMessage],
      updatedAt: new Date(),
    } : item));
    await runAssistantTurn(conversation, effectiveContent, sendableFiles, assistantId);
  }

  /** Re-send the last user message, replacing the trailing assistant bubble. */
  async function regenerateLastResponse() {
    const conversation = activeConversation;
    if (!conversation || isStreaming || !selectedModel) return;
    const messages = conversation.messages;
    let lastUserIndex = -1;
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      if (messages[i].role === 'user') { lastUserIndex = i; break; }
    }
    if (lastUserIndex < 0) return;
    const content = messages[lastUserIndex].content;
    const assistantId = randomId();
    const assistantMessage: Message = { id: assistantId, role: 'assistant', content: '', timestamp: new Date(), isStreaming: true, model: selectedModel.name };
    const conversationId = conversation.id;
    setConversations((current) => current.map((item) => item.id === conversationId ? {
      ...item,
      messages: [...item.messages.slice(0, lastUserIndex + 1), assistantMessage],
      updatedAt: new Date(),
    } : item));
    await runAssistantTurn(conversation, content, [], assistantId);
  }

  if (user === undefined) return <div className="h-screen grid place-items-center text-sm">Restoring secure session…</div>;
  if (!user) return <Login onLogin={async (email, password) => {
    const authenticated = await api.login(email, password);
    try {
      await loadWorkspace();
    } catch (cause) {
      // Keep the session but surface the failure so the user can retry.
      setError(cause instanceof Error ? cause.message : 'Unable to load workspace');
    }
    setUser(authenticated);
  }} error={error} />;

  return (
    <div className="flex h-screen overflow-hidden" style={{ background: 'var(--background)' }}>
      <Sidebar conversations={conversations} activeId={activeId} onSelect={selectConversation} onNew={() => void newConversation()}
        onDelete={(id) => void deleteConversation(id)} onRename={(id, title) => void renameConversation(id, title)}
        collapsed={sidebarCollapsed} onToggle={() => setSidebarCollapsed((value) => !value)} identity={{ name: user.displayName, role: user.roleName }} />
      <div className="flex flex-col flex-1 min-w-0">
        <header className="flex items-center justify-between px-4 py-2.5 flex-shrink-0" style={{ borderBottom: '1px solid var(--border)' }}>
          <div className="flex items-center gap-3">
            {activeConversation && <><h1 className="text-sm font-medium truncate max-w-xs">{activeConversation.title}</h1><ClassificationBadge level={activeConversation.classification} /></>}
          </div>
          <div className="flex items-center gap-3">
            <label className="flex items-center gap-1.5 text-xs" style={{ color: 'var(--muted-foreground)' }} title="Classification applied to newly created conversations">
              Classification
              <select
                aria-label="Classification for new conversations"
                value={draftClassification}
                onChange={(event) => setDraftClassification(event.target.value as DataClassification)}
                className="text-xs rounded-md px-1.5 py-1 bg-transparent"
                style={{ border: '1px solid var(--border)', color: 'var(--foreground)' }}
              >
                {selectableClassifications(user.clearance).map((level) => (
                  <option key={level} value={level}>{level}</option>
                ))}
              </select>
            </label>
            <button className="text-sm px-3 py-1.5 rounded-md" style={{ border: '1px solid var(--border)' }} onClick={() => setShowDocuments(true)}>Documents{selectedDocumentIds.length ? ` (${selectedDocumentIds.length})` : ''}</button><UserMenu user={user} onLogout={async () => { await api.logout(); setUser(null); setConversations([]); setDocuments([]); }} /></div>
        </header>
        {error && <div role="alert" className="px-4 py-2 text-sm flex justify-between" style={{ color: '#fca5a5', background: '#7f1d1d55' }}><span>{error}</span><button onClick={() => setError('')}>Dismiss</button></div>}
        <div className="flex-1 overflow-y-auto"><div className="max-w-3xl mx-auto px-4">
          {!activeConversation || !activeConversation.messages.length ? (
            selectedModel ? <EmptyState model={selectedModel} onPrompt={(prompt) => void sendMessage(prompt, [])} /> : <p className="text-center py-20 text-sm">No approved model is available for your account.</p>
          ) : <>{activeConversation.messages.map((message, index) => {
            const isLast = index === activeConversation.messages.length - 1;
            return <MessageBubble key={message.id} message={message}
              onCopy={(text) => { void navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 2000); }}
              onRegenerate={message.role === 'assistant' && isLast ? () => void regenerateLastResponse() : undefined} />;
          })}<div ref={messagesEndRef} className="h-6" /></>}
        </div></div>
        {selectedModel && <div className="flex-shrink-0 max-w-3xl mx-auto w-full"><ChatInput onSend={sendMessage} onStop={() => abortRef.current?.abort()} isStreaming={isStreaming} model={selectedModel} onModelClick={() => setShowModelSelector(true)} /></div>}
      </div>
      {showModelSelector && selectedModel && <ModelSelector models={models} selected={selectedModel} onSelect={(model) => void selectModel(model)} onClose={() => setShowModelSelector(false)} />}
      {showDocuments && <DocumentsPanel user={user} documents={documents} selectedIds={selectedDocumentIds} onSelectedIds={setSelectedDocumentIds} onChanged={async () => setDocuments(await api.documents())} onClose={() => setShowDocuments(false)} />}
      {copied && <div className="fixed bottom-6 left-1/2 -translate-x-1/2 px-3 py-1.5 rounded-lg text-xs z-50" style={{ background: 'var(--secondary)' }}>Copied to clipboard</div>}
    </div>
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

function Login({ onLogin, error }: { onLogin: (email: string, password: string) => Promise<void>; error: string }) {
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
  }}><div><h1 className="text-xl font-semibold">Enflite Private AI</h1><p className="text-sm mt-1" style={{ color: 'var(--muted-foreground)' }}>Sign in with your enterprise account</p></div>
    {(localError || error) && <p role="alert" className="text-sm" style={{ color: '#fca5a5' }}>{localError || error}</p>}
    {ssoEnabled && <button type="button" onClick={() => { window.location.href = api.oidcLoginUrl(); }} className="w-full rounded-md py-2 text-sm font-medium" style={{ background: 'var(--secondary)', color: 'var(--foreground)', border: '1px solid var(--border)' }}>Sign in with SSO</button>}
    {ssoEnabled && <div className="flex items-center gap-3 text-xs" style={{ color: 'var(--muted-foreground)' }}><span className="flex-1" style={{ borderTop: '1px solid var(--border)' }} /><span>or with password</span><span className="flex-1" style={{ borderTop: '1px solid var(--border)' }} /></div>}
    <label className="block text-sm">Email<input autoComplete="username" type="email" required value={email} onChange={(event) => setEmail(event.target.value)} className="mt-1 w-full rounded-md px-3 py-2 bg-transparent" style={{ border: '1px solid var(--border)' }} /></label>
    <label className="block text-sm">Password<input autoComplete="current-password" type="password" required value={password} onChange={(event) => setPassword(event.target.value)} className="mt-1 w-full rounded-md px-3 py-2 bg-transparent" style={{ border: '1px solid var(--border)' }} /></label>
    <button disabled={busy} className="w-full rounded-md py-2 text-sm font-medium" style={{ background: 'var(--accent)', color: 'var(--accent-foreground)' }}>{busy ? 'Signing in…' : 'Sign in'}</button>
  </form></main>;
}

function ClassificationBadge({ level }: { level: string }) {
  const color = CLASSIFICATION_COLOR[level] ?? '#6b7280';
  return <span className="px-2 py-0.5 rounded text-xs font-medium" style={{ background: color + '18', color, border: `1px solid ${color}40` }}>{level}</span>;
}

function UserMenu({ user, onLogout }: { user: AuthUser; onLogout: () => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const initials = user.displayName.split(/\s+/).map((part) => part[0]).join('').slice(0, 2).toUpperCase();
  return <div className="relative"><button aria-label="Account menu" onClick={() => setOpen((value) => !value)} className="w-8 h-8 rounded-full text-xs font-semibold" style={{ background: 'var(--secondary)' }}>{initials}</button>{open && <div className="absolute right-0 top-10 rounded-lg py-1 z-50 w-56" style={{ background: 'var(--card)', border: '1px solid var(--border)' }}><div className="px-3 py-2"><p className="text-sm font-medium">{user.displayName}</p><p className="text-xs truncate" style={{ color: 'var(--muted-foreground)' }}>{user.email}</p><p className="text-xs" style={{ color: 'var(--muted-foreground)' }}>{user.roleName} · {user.clearance}</p></div><button className="w-full text-left px-3 py-2 text-sm" style={{ color: '#fca5a5', borderTop: '1px solid var(--border)' }} onClick={() => void onLogout()}>Sign out</button></div>}</div>;
}
