import { useEffect, useRef, useState } from 'react';
import Sidebar from './components/Sidebar';
import MessageBubble from './components/Message';
import ChatInput from './components/ChatInput';
import ModelSelector from './components/ModelSelector';
import ProviderSwitcher from './components/ProviderSwitcher';
import EmptyState from './components/EmptyState';
import DocumentsPanel from './components/DocumentsPanel';
import AssistantAvatar from './components/AssistantAvatar';
import ActivityPanel from './components/ActivityPanel';
import {
  attachmentActivityEntries,
  deriveStatusText,
  friendlyNoticeText,
  nextAssistantState,
  noticeToActivityEntries,
  sourcesActivityEntry,
} from './activity';
import type { ActivityEntry, AssistantState, NoticeInput } from './activity';
import { api, ApiError, consumeOidcFragment, mapCitation, setAccessToken, streamChat } from './api';
import { resolveEffectiveProviderGroup } from './providerGroups';
import type { AuthUser, Conversation, DataClassification, DocumentRecord, Message, Model, ProviderGroup, ProviderInfo, UploadedFile } from './types';

/** localStorage key for the last-used provider group. */
const PROVIDER_STORAGE_KEY = 'enflite-provider';

function initialProvider(): ProviderGroup {
  const stored = localStorage.getItem(PROVIDER_STORAGE_KEY);
  return stored === 'claude' || stored === 'openai' ? stored : 'enflite';
}

const CLASSIFICATION_COLOR: Record<string, string> = {
  PUBLIC: '#15803d', INTERNAL: '#2563eb', CONFIDENTIAL: '#b45309',
  PROPRIETARY: '#cf0c2c', CUI: '#7e22ce', UNKNOWN: '#6b7280',
};
const CLASSIFICATION_ORDER: DataClassification[] = ['PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'PROPRIETARY', 'CUI', 'UNKNOWN'];
const randomId = () => crypto.randomUUID();

function describeChatError(cause: unknown): string {
  // The browser reports a dead socket or an unreachable backend as a bare
  // TypeError ("Failed to fetch") — translate it into the actionable
  // message instead of showing the cryptic raw text.
  if (cause instanceof Error && cause.message === 'Failed to fetch') {
    return "Can't reach the AI service — check the backend is running and Ollama is up with all three models (README Step 3).";
  }
  return cause instanceof Error ? cause.message : 'Chat request failed';
}

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
  const capabilities = (value.capabilities ?? {}) as Record<string, unknown>;
  return {
    id: value.id,
    name: value.displayName ?? value.name,
    provider: value.provider,
    providerGroup: value.providerGroup ?? 'enflite',
    providerLabel: value.providerLabel ?? value.provider,
    isProviderDefault: value.isProviderDefault ?? false,
    chat: capabilities.chat !== false,
    vision: capabilities.vision === true,
    description: `${value.providerLabel ?? value.provider} · ${value.version}`,
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
  /** One-tap provider switching: Enflite | Claude | OpenAI (ADR-018). */
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [activeProvider, setActiveProvider] = useState<ProviderGroup>(initialProvider);
  const [isStreaming, setIsStreaming] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState('');
  const [documents, setDocuments] = useState<DocumentRecord[]>([]);
  const [selectedDocumentIds, setSelectedDocumentIds] = useState<string[]>([]);
  const [showDocuments, setShowDocuments] = useState(false);
  /** Classification applied to newly created conversations (picker in header). */
  const [draftClassification, setDraftClassification] = useState<DataClassification>('INTERNAL');
  /** Interactive avatar + activity feed (frontend-only; no backend changes). */
  const [assistantState, setAssistantState] = useState<AssistantState>('idle');
  const [lastNotice, setLastNotice] = useState<NoticeInput | null>(null);
  const [activityLog, setActivityLog] = useState<Record<string, ActivityEntry[]>>({});
  const [showActivity, setShowActivity] = useState(false);
  const [flashMessageId, setFlashMessageId] = useState<string | null>(null);
  /** Document count for the in-flight turn — feeds the "Reading your documents…" status. */
  const turnDocCountRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const activeConversation = conversations.find((conversation) => conversation.id === activeId) ?? null;

  /** Ref mirror so loadWorkspace reads the latest provider without re-fetching. */
  const activeProviderRef = useRef<ProviderGroup>(activeProvider);
  useEffect(() => { activeProviderRef.current = activeProvider; }, [activeProvider]);

  async function loadWorkspace() {
    const [modelResponse, conversationResponse, documentResponse, providerList] = await Promise.all([
      api.request<{ models: any[] }>('/models'),
      api.request<{ conversations: any[] }>('/conversations'),
      api.documents(),
      api.providers().catch(() => [] as ProviderInfo[]),
    ]);
    const loadedModels = modelResponse.models.map(toModel);
    const loadedConversations = conversationResponse.conversations.map(toConversation);
    setModels(loadedModels);
    setProviders(providerList);
    // If the remembered provider has no usable models (e.g. its key was
    // removed, or Enflite was omitted because OLLAMA_ENABLED=false), fall
    // back to the first group with servable models — Claude first — rather
    // than stranding the user on an unusable provider.
    const enabledModels = loadedModels.filter((model) => model.enabled);
    const effectiveProvider = resolveEffectiveProviderGroup(activeProviderRef.current, enabledModels);
    if (effectiveProvider !== activeProviderRef.current) {
      activeProviderRef.current = effectiveProvider;
      setActiveProvider(effectiveProvider);
    }
    const groupModels = enabledModels.filter((model) => model.providerGroup === effectiveProvider);
    const preferred = groupModels.find((model) => model.isProviderDefault) ?? groupModels[0];
    setSelectedModel((current) =>
      (current && current.providerGroup === effectiveProvider && groupModels.some((model) => model.id === current.id))
        ? current
        : preferred ?? enabledModels[0] ?? null);
    setConversations(loadedConversations);
    setDocuments(documentResponse);
    setActiveId((current) => current && loadedConversations.some((item) => item.id === current) ? current : loadedConversations[0]?.id ?? null);
  }

  /** One tap: switch provider, keep the model when it belongs to the new
   *  group, otherwise auto-select the provider's preferred model. A group
   *  with no servable models (e.g. key set but seeds blocked by the egress
   *  allowlist) is not switchable — switching would desync the switcher
   *  from the model that actually serves the turn. */
  function switchProvider(group: ProviderGroup) {
    if (group === activeProvider) return;
    const groupModels = models.filter((model) => model.enabled && model.providerGroup === group);
    if (groupModels.length === 0) return;
    activeProviderRef.current = group;
    setActiveProvider(group);
    localStorage.setItem(PROVIDER_STORAGE_KEY, group);
    setSelectedModel((current) => {
      if (current && current.providerGroup === group) return current;
      return groupModels.find((model) => model.isProviderDefault) ?? groupModels[0] ?? current;
    });
    setShowModelSelector(false);
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

  useEffect(() => { document.title = 'Enflite'; }, []);

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

  /** Append entries to the active conversation's activity feed (newest appended last). */
  function appendActivity(conversationId: string, entries: ActivityEntry[]) {
    if (!entries.length) return;
    setActivityLog((current) => ({ ...current, [conversationId]: [...(current[conversationId] ?? []), ...entries] }));
  }

  /** Jump from an activity entry to its message: scroll + temporary highlight. */
  function jumpToMessage(messageId: string) {
    setShowActivity(false);
    requestAnimationFrame(() => {
      document.getElementById(`msg-${messageId}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      setFlashMessageId(messageId);
      window.setTimeout(() => setFlashMessageId((current) => (current === messageId ? null : current)), 1700);
    });
  }

  /** Stream one assistant turn for an already-placed assistant bubble. */
  async function runAssistantTurn(conversation: Conversation, content: string, files: UploadedFile[], assistantId: string) {
    if (!selectedModel) return;
    setIsStreaming(true);
    setError('');
    setAssistantState('thinking');
    setLastNotice(null);
    turnDocCountRef.current = selectedDocumentIds.length;
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
      turnDocCountRef.current = documentIds.length;
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
          setLastNotice(null);
          throw new Error(message);
        }
        if (streamEvent.event === 'meta') return;
        // Interactive avatar + activity feed: fold the event into the avatar
        // state, record feed entries for notices, and keep the last notice
        // for the live status line.
        setAssistantState((current) => nextAssistantState(
          current,
          streamEvent.event,
          streamEvent.event === 'notice' ? streamEvent.data.code : undefined,
        ));
        if (streamEvent.event === 'notice') {
          const noticeInput: NoticeInput = {
            code: streamEvent.data.code,
            message: streamEvent.data.message,
            tools: streamEvent.data.tools,
          };
          setLastNotice(noticeInput);
          appendActivity(conversation.id, noticeToActivityEntries(noticeInput, assistantId));
        }
        if (streamEvent.event === 'done') {
          const citations = streamEvent.data.citations ?? [];
          const entry = sourcesActivityEntry(citations.length, assistantId);
          if (entry) appendActivity(conversation.id, [entry]);
          setLastNotice(null);
        }
        setConversations((current) => current.map((item) => item.id === conversation.id ? {
          ...item,
          messages: item.messages.map((msg) => msg.id === assistantId ? {
            ...msg,
            content: (streamEvent.event === 'delta' || streamEvent.event === 'message') ? msg.content + streamEvent.data.content : msg.content,
            isStreaming: streamEvent.event !== 'done',
            notice: streamEvent.event === 'notice' ? friendlyNoticeText(streamEvent.data) : (streamEvent.event === 'done' ? undefined : msg.notice),
            citations: streamEvent.event === 'done' ? (streamEvent.data.citations ?? msg.citations) : msg.citations,
            usage: streamEvent.event === 'done' ? (streamEvent.data.usage ?? msg.usage) : msg.usage,
            model: streamEvent.event === 'done' && streamEvent.data.fallback ? `${msg.model} → ${streamEvent.data.fallback.name}` : msg.model,
          } : msg),
        } : item));
      });
    } catch (cause) {
      if (!controller.signal.aborted) setError(describeChatError(cause));
      setConversations((current) => current.map((item) => item.id === conversation.id ? {
        ...item,
        messages: item.messages.map((msg) => msg.id === assistantId ? { ...msg, isStreaming: false } : msg),
      } : item));
    } finally {
      setIsStreaming(false);
      setAssistantState('idle');
      setLastNotice(null);
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
    appendActivity(conversation.id, attachmentActivityEntries(
      sendableFiles.map((item) => ({ name: item.name, type: item.type })),
      assistantId,
    ));
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
          <div className="flex items-center gap-3 min-w-0">
            {/* Interactive assistant identity: avatar with live status underneath. */}
            <div className="flex items-center gap-2 flex-shrink-0">
              <AssistantAvatar state={assistantState} onClick={() => setShowActivity(true)} />
              <div className="leading-tight hidden sm:block">
                <div className="text-sm font-semibold" style={{ color: 'var(--foreground)' }}>Enflite AI</div>
                <div
                  className="text-xs truncate max-w-[160px]"
                  style={{ color: 'var(--muted-foreground)' }}
                  role="status"
                  aria-live="polite"
                >
                  {deriveStatusText(assistantState, lastNotice, turnDocCountRef.current)}
                </div>
              </div>
            </div>
            {activeConversation && <><h1 className="text-sm font-medium truncate max-w-xs">{activeConversation.title}</h1><ClassificationBadge level={activeConversation.classification} /></>}
          </div>
          <div className="flex items-center gap-3">
            <ProviderSwitcher
              providers={providers.map((p) => {
                const hasModels = models.some((m) => m.enabled && m.providerGroup === p.key);
                return {
                  ...p,
                  enabled: p.enabled && hasModels,
                  hint: hasModels ? p.hint : 'No models available for this provider — ask your admin',
                };
              })}
              active={activeProvider}
              onSelect={switchProvider}
            />
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
        {error && <div role="alert" className="px-4 py-2 text-sm flex justify-between" style={{ color: '#a50a24', background: '#cf0c2c12' }}><span>{error}</span><button onClick={() => setError('')}>Dismiss</button></div>}
        <div className="flex-1 overflow-y-auto"><div className="max-w-3xl mx-auto px-4">
          {!activeConversation || !activeConversation.messages.length ? (
            selectedModel ? <EmptyState model={selectedModel} onPrompt={(prompt) => void sendMessage(prompt, [])} /> : <p className="text-center py-20 text-sm">Still loading the AI — if this persists, refresh and try again.</p>
          ) : <>{activeConversation.messages.map((message, index) => {
            const isLast = index === activeConversation.messages.length - 1;
            return <MessageBubble key={message.id} id={`msg-${message.id}`} flash={flashMessageId === message.id} message={message}
              onCopy={(text) => { void navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 2000); }}
              onRegenerate={message.role === 'assistant' && isLast ? () => void regenerateLastResponse() : undefined} />;
          })}<div ref={messagesEndRef} className="h-6" /></>}
        </div></div>
        {selectedModel && <div className="flex-shrink-0 max-w-3xl mx-auto w-full"><ChatInput onSend={sendMessage} onStop={() => abortRef.current?.abort()} isStreaming={isStreaming} model={selectedModel} onModelClick={() => setShowModelSelector(true)} /></div>}
      </div>
      {showModelSelector && selectedModel && (
        <ModelSelector
          models={models.filter((model) => model.providerGroup === activeProvider)}
          selected={selectedModel}
          groupLabel={providers.find((p) => p.key === activeProvider)?.label ?? 'Enflite'}
          residencyNote={providers.find((p) => p.key === activeProvider)?.residencyLabel ?? 'Stays on your network'}
          onSelect={(model) => void selectModel(model)}
          onClose={() => setShowModelSelector(false)}
        />
      )}
      {showDocuments && <DocumentsPanel user={user} documents={documents} selectedIds={selectedDocumentIds} onSelectedIds={setSelectedDocumentIds} onChanged={async () => setDocuments(await api.documents())} onClose={() => setShowDocuments(false)} />}
      {showActivity && (
        <ActivityPanel
          open={showActivity}
          onClose={() => setShowActivity(false)}
          entries={[...(activeConversation ? activityLog[activeConversation.id] ?? [] : [])].reverse()}
          onJump={jumpToMessage}
        />
      )}
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
  }}><div><img src="/enflite-logo.png" alt="Enflite" className="h-9 w-auto mb-3" /><h1 className="text-xl font-semibold">Enflite</h1><p className="text-sm mt-1" style={{ color: 'var(--muted-foreground)' }}>Sign in with your enterprise account</p></div>
    {(localError || error) && <p role="alert" className="text-sm" style={{ color: '#a50a24' }}>{localError || error}</p>}
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
  return <div className="relative"><button aria-label="Account menu" onClick={() => setOpen((value) => !value)} className="w-8 h-8 rounded-full text-xs font-semibold" style={{ background: 'var(--secondary)' }}>{initials}</button>{open && <div className="absolute right-0 top-10 rounded-lg py-1 z-50 w-56" style={{ background: 'var(--card)', border: '1px solid var(--border)' }}><div className="px-3 py-2"><p className="text-sm font-medium">{user.displayName}</p><p className="text-xs truncate" style={{ color: 'var(--muted-foreground)' }}>{user.email}</p><p className="text-xs" style={{ color: 'var(--muted-foreground)' }}>{user.roleName} · {user.clearance}</p></div><button className="w-full text-left px-3 py-2 text-sm" style={{ color: '#a50a24', borderTop: '1px solid var(--border)' }} onClick={() => void onLogout()}>Sign out</button></div>}</div>;
}
