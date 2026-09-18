import { useEffect, useRef, useState } from 'react';
import Sidebar from './components/Sidebar';
import MessageBubble from './components/Message';
import ChatInput from './components/ChatInput';
import ModelSelector from './components/ModelSelector';
import EmptyState from './components/EmptyState';
import { api, mapCitation, streamChat } from './api';
import type { AuthUser, Conversation, DataClassification, Message, Model, UploadedFile } from './types';

const CLASSIFICATION_COLOR: Record<string, string> = {
  PUBLIC: '#22c55e', INTERNAL: '#3b82f6', CONFIDENTIAL: '#f59e0b',
  PROPRIETARY: '#ef4444', CUI: '#a855f7', UNKNOWN: '#6b7280',
};
const CLASSIFICATION_ORDER: DataClassification[] = ['PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'PROPRIETARY', 'CUI', 'UNKNOWN'];
const randomId = () => crypto.randomUUID();

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
    enabled: true,
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
  const abortRef = useRef<AbortController | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const activeConversation = conversations.find((conversation) => conversation.id === activeId) ?? null;

  async function loadWorkspace() {
    const [modelResponse, conversationResponse] = await Promise.all([
      api.request<{ models: any[] }>('/models'),
      api.request<{ conversations: any[] }>('/conversations'),
    ]);
    const loadedModels = modelResponse.models.map(toModel);
    const loadedConversations = conversationResponse.conversations.map(toConversation);
    setModels(loadedModels);
    setSelectedModel((current) => loadedModels.find((model) => model.id === current?.id) ?? loadedModels[0] ?? null);
    setConversations(loadedConversations);
    setActiveId((current) => current && loadedConversations.some((item) => item.id === current) ? current : loadedConversations[0]?.id ?? null);
  }

  useEffect(() => {
    api.refresh().then(async (currentUser) => {
      setUser(currentUser);
      if (currentUser) await loadWorkspace();
    }).catch((cause) => { setUser(null); setError(cause instanceof Error ? cause.message : 'Unable to initialize session'); });
  }, []);

  useEffect(() => { messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [activeConversation?.messages, isStreaming]);

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
        body: JSON.stringify({ modelId: selectedModel.id, classification: 'INTERNAL' }),
      });
      const conversation = toConversation(response.conversation);
      setConversations((current) => [conversation, ...current]);
      setActiveId(conversation.id);
      return conversation;
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Unable to create conversation'); return null; }
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

  async function sendMessage(content: string, files: UploadedFile[]) {
    if (!selectedModel || !content.trim()) return;
    const conversation = activeConversation ?? await newConversation();
    if (!conversation) return;
    const userMessage: Message = { id: randomId(), role: 'user', content, timestamp: new Date() };
    const assistantId = randomId();
    const assistantMessage: Message = { id: assistantId, role: 'assistant', content: '', timestamp: new Date(), isStreaming: true, model: selectedModel.name };
    setConversations((current) => current.map((item) => item.id === conversation.id ? {
      ...item,
      title: item.messages.length ? item.title : content.slice(0, 80),
      messages: [...item.messages, userMessage, assistantMessage],
      updatedAt: new Date(),
    } : item));
    setIsStreaming(true);
    setError('');
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const documentIds = await Promise.all(files.filter((item) => item.file).map((item) => api.upload(item.file!, conversation.classification)));
      await streamChat({
        conversationId: conversation.id,
        content,
        modelId: selectedModel.id,
        classification: conversation.classification,
        ...(documentIds.length ? { documentIds } : {}),
      }, controller.signal, ({ event, data }) => {
        if (event === 'error') throw new Error(data.message);
        setConversations((current) => current.map((item) => item.id === conversation.id ? {
          ...item,
          messages: item.messages.map((message) => message.id === assistantId ? {
            ...message,
            content: event === 'delta' ? message.content + data.content : message.content,
            isStreaming: event !== 'done',
            citations: event === 'done' ? data.citations?.map(mapCitation) : message.citations,
          } : message),
        } : item));
      });
    } catch (cause) {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : 'Chat request failed');
      setConversations((current) => current.map((item) => item.id === conversation.id ? {
        ...item,
        messages: item.messages.map((message) => message.id === assistantId ? { ...message, isStreaming: false } : message),
      } : item));
    } finally {
      setIsStreaming(false);
      abortRef.current = null;
    }
  }

  if (user === undefined) return <div className="h-screen grid place-items-center text-sm">Restoring secure session…</div>;
  if (!user) return <Login onLogin={async (email, password) => { const authenticated = await api.login(email, password); setUser(authenticated); await loadWorkspace(); }} error={error} />;

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
          <UserMenu user={user} onLogout={async () => { await api.logout(); setUser(null); setConversations([]); }} />
        </header>
        {error && <div role="alert" className="px-4 py-2 text-sm flex justify-between" style={{ color: '#fca5a5', background: '#7f1d1d55' }}><span>{error}</span><button onClick={() => setError('')}>Dismiss</button></div>}
        <div className="flex-1 overflow-y-auto"><div className="max-w-3xl mx-auto px-4">
          {!activeConversation || !activeConversation.messages.length ? (
            selectedModel ? <EmptyState model={selectedModel} onPrompt={(prompt) => void sendMessage(prompt, [])} /> : <p className="text-center py-20 text-sm">No approved model is available for your account.</p>
          ) : <>{activeConversation.messages.map((message) => <MessageBubble key={message.id} message={message} onCopy={(text) => { void navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 2000); }} />)}<div ref={messagesEndRef} className="h-6" /></>}
        </div></div>
        {selectedModel && <div className="flex-shrink-0 max-w-3xl mx-auto w-full"><ChatInput onSend={sendMessage} onStop={() => abortRef.current?.abort()} isStreaming={isStreaming} model={selectedModel} onModelClick={() => setShowModelSelector(true)} /></div>}
      </div>
      {showModelSelector && selectedModel && <ModelSelector models={models} selected={selectedModel} onSelect={setSelectedModel} onClose={() => setShowModelSelector(false)} />}
      {copied && <div className="fixed bottom-6 left-1/2 -translate-x-1/2 px-3 py-1.5 rounded-lg text-xs z-50" style={{ background: 'var(--secondary)' }}>Copied to clipboard</div>}
    </div>
  );
}

function Login({ onLogin, error }: { onLogin: (email: string, password: string) => Promise<void>; error: string }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [localError, setLocalError] = useState('');
  return <main className="h-screen grid place-items-center px-4"><form className="w-full max-w-sm p-6 rounded-xl space-y-4" style={{ background: 'var(--card)', border: '1px solid var(--border)' }} onSubmit={async (event) => {
    event.preventDefault(); setBusy(true); setLocalError('');
    try { await onLogin(email, password); } catch (cause) { setLocalError(cause instanceof Error ? cause.message : 'Sign in failed'); } finally { setBusy(false); }
  }}><div><h1 className="text-xl font-semibold">Enflite Private AI</h1><p className="text-sm mt-1" style={{ color: 'var(--muted-foreground)' }}>Sign in with your enterprise account</p></div>
    {(localError || error) && <p role="alert" className="text-sm" style={{ color: '#fca5a5' }}>{localError || error}</p>}
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
