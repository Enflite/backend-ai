import { useState, useRef, useEffect, useCallback } from 'react';
import Sidebar from './components/Sidebar';
import MessageBubble from './components/Message';
import ChatInput from './components/ChatInput';
import ModelSelector from './components/ModelSelector';
import EmptyState from './components/EmptyState';
import { MOCK_CONVERSATIONS, MODELS } from './data/mockData';
import type { Conversation, Message, Model, UploadedFile } from './types';

const CLASSIFICATION_COLOR: Record<string, string> = {
  PUBLIC: '#22c55e',
  INTERNAL: '#3b82f6',
  CONFIDENTIAL: '#f59e0b',
  PROPRIETARY: '#ef4444',
  CUI: '#a855f7',
};

// Simulated streaming response
const STREAMING_RESPONSES = [
  `Based on my analysis of your query, here is a comprehensive response:

**Key Findings**
The documentation indicates several important considerations that should be addressed systematically. The primary factors involve both technical and organizational dimensions.

**Technical Considerations**
- System architecture must support horizontal scaling
- Data classification enforcement happens at the middleware layer
- All external requests require explicit policy authorization

**Recommendations**
You should prioritize implementing the core authentication flow before expanding to additional modules. This ensures a stable security boundary from the outset.

\`\`\`typescript
interface SecurityPolicy {
  classification: DataClassification;
  tenantId: string;
  allowedRoles: string[];
  externalProviderAllowed: boolean;
}

function enforcePolicy(req: Request, policy: SecurityPolicy): boolean {
  if (req.classification > policy.classification) return false;
  if (!policy.allowedRoles.includes(req.user.role)) return false;
  return true;
}
\`\`\`

This approach ensures compliance with your stated security requirements while maintaining operational flexibility.`,

  `I'll address each part of your question in turn.

**Overview**
The approach you're describing aligns well with established patterns for secure enterprise systems. Here's what I'd recommend:

First, establish your trust boundaries clearly. Every component in the system should know exactly what it can and cannot access.

**Implementation Notes**
The Node.js middleware should handle classification enforcement before any data reaches the model layer. This prevents accidental exposure even if a downstream component is misconfigured.

Your RAG pipeline should filter documents at the database query level — not after retrieval. A SQL pattern like:

\`\`\`sql
SELECT dc.content, dc.chunk_index, d.title, d.page_count
FROM document_chunks dc
JOIN documents d ON d.id = dc.document_id
WHERE dc.tenant_id = $1
  AND d.classification <= $2
  AND user_has_document_access($3, d.id)
ORDER BY dc.embedding <=> $4
LIMIT 5;
\`\`\`

This ensures the permission check happens in the database before results are returned to the application layer.

**Next Steps**
Start with the authentication module and get sessions working end-to-end before moving to the AI gateway layer.`,
];

function generateId() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function formatHeader(conv: Conversation | null) {
  if (!conv) return null;
  return conv.classification;
}

export default function App() {
  const [conversations, setConversations] = useState<Conversation[]>(MOCK_CONVERSATIONS);
  const [activeId, setActiveId] = useState<string | null>(MOCK_CONVERSATIONS[0].id);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [selectedModel, setSelectedModel] = useState<Model>(MODELS[0]);
  const [showModelSelector, setShowModelSelector] = useState(false);
  const [isStreaming, setIsStreaming] = useState(false);
  const [streamingMsgId, setStreamingMsgId] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const streamAbortRef = useRef<boolean>(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const activeConv = conversations.find((c) => c.id === activeId) ?? null;

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [activeConv?.messages.length, isStreaming]);

  function newConversation() {
    const conv: Conversation = {
      id: generateId(),
      title: 'New Conversation',
      createdAt: new Date(),
      updatedAt: new Date(),
      messages: [],
      model: selectedModel.id,
      classification: 'INTERNAL',
    };
    setConversations((prev) => [conv, ...prev]);
    setActiveId(conv.id);
  }

  function deleteConversation(id: string) {
    setConversations((prev) => prev.filter((c) => c.id !== id));
    if (activeId === id) {
      const remaining = conversations.filter((c) => c.id !== id);
      setActiveId(remaining[0]?.id ?? null);
    }
  }

  function renameConversation(id: string, title: string) {
    setConversations((prev) =>
      prev.map((c) => (c.id === id ? { ...c, title } : c))
    );
  }

  const simulateStream = useCallback(async (convId: string, msgId: string) => {
    streamAbortRef.current = false;
    const fullText = STREAMING_RESPONSES[Math.floor(Math.random() * STREAMING_RESPONSES.length)];
    const words = fullText.split('');
    let accumulated = '';
    const chunkSize = 3;

    for (let i = 0; i < words.length; i += chunkSize) {
      if (streamAbortRef.current) break;
      accumulated += words.slice(i, i + chunkSize).join('');
      const snap = accumulated;
      setConversations((prev) =>
        prev.map((c) => {
          if (c.id !== convId) return c;
          return {
            ...c,
            messages: c.messages.map((m) =>
              m.id === msgId ? { ...m, content: snap } : m
            ),
          };
        })
      );
      await new Promise((r) => setTimeout(r, 18));
    }

    setConversations((prev) =>
      prev.map((c) => {
        if (c.id !== convId) return c;
        return {
          ...c,
          updatedAt: new Date(),
          messages: c.messages.map((m) =>
            m.id === msgId
              ? {
                  ...m,
                  content: streamAbortRef.current ? accumulated : fullText,
                  isStreaming: false,
                  model: selectedModel.name,
                  citations: Math.random() > 0.4
                    ? [
                        { id: 1, title: 'Internal Policy Manual.pdf', section: 'Section 3.4 — Data Governance', page: 22 },
                        { id: 2, title: 'Security Procedures.docx', section: 'Appendix B — Classification Guide' },
                      ]
                    : undefined,
                }
              : m
          ),
        };
      })
    );

    setIsStreaming(false);
    setStreamingMsgId(null);
  }, [selectedModel.name]);

  async function sendMessage(content: string, files: UploadedFile[]) {
    if (!activeId) {
      newConversation();
      return;
    }

    const userMsg: Message = {
      id: generateId(),
      role: 'user',
      content,
      timestamp: new Date(),
    };

    const aiMsgId = generateId();
    const aiMsg: Message = {
      id: aiMsgId,
      role: 'assistant',
      content: '',
      timestamp: new Date(),
      isStreaming: true,
      model: selectedModel.name,
    };

    const firstMsg = activeConv?.messages.length === 0;

    setConversations((prev) =>
      prev.map((c) => {
        if (c.id !== activeId) return c;
        const updated = { ...c, messages: [...c.messages, userMsg, aiMsg], updatedAt: new Date() };
        if (firstMsg) {
          updated.title = content.slice(0, 48) + (content.length > 48 ? '…' : '');
        }
        return updated;
      })
    );

    setIsStreaming(true);
    setStreamingMsgId(aiMsgId);
    simulateStream(activeId, aiMsgId);
  }

  function stopStreaming() {
    streamAbortRef.current = true;
  }

  function handleSuggestion(prompt: string) {
    if (!activeId) newConversation();
    setTimeout(() => sendMessage(prompt, []), 50);
  }

  function copyText(text: string) {
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  const classification = activeConv?.classification ?? 'INTERNAL';

  return (
    <div className="flex h-screen overflow-hidden" style={{ background: 'var(--background)' }}>
      {/* Sidebar */}
      <Sidebar
        conversations={conversations}
        activeId={activeId}
        onSelect={setActiveId}
        onNew={newConversation}
        onDelete={deleteConversation}
        onRename={renameConversation}
        collapsed={sidebarCollapsed}
        onToggle={() => setSidebarCollapsed((v) => !v)}
      />

      {/* Main area */}
      <div className="flex flex-col flex-1 min-w-0">
        {/* Top bar */}
        <header
          className="flex items-center justify-between px-4 py-2.5 flex-shrink-0"
          style={{ borderBottom: '1px solid var(--border)', background: 'var(--background)' }}
        >
          <div className="flex items-center gap-3">
            {activeConv && (
              <>
                <h1 className="text-sm font-medium truncate max-w-xs" style={{ color: 'var(--foreground)' }}>
                  {activeConv.title}
                </h1>
                <ClassificationBadge level={classification} />
              </>
            )}
          </div>
          <div className="flex items-center gap-2">
            <StatusIndicator />
            <UserMenu />
          </div>
        </header>

        {/* Messages */}
        <div className="flex-1 overflow-y-auto">
          <div className="max-w-3xl mx-auto px-4">
            {!activeConv || activeConv.messages.length === 0 ? (
              <EmptyState model={selectedModel} onPrompt={handleSuggestion} />
            ) : (
              <>
                {activeConv.messages.map((msg, i) => (
                  <MessageBubble
                    key={msg.id}
                    message={msg}
                    onCopy={copyText}
                    onRegenerate={
                      i === activeConv.messages.length - 1 && msg.role === 'assistant'
                        ? () => {
                            const prev = activeConv.messages[i - 1];
                            if (prev) sendMessage(prev.content, []);
                          }
                        : undefined
                    }
                  />
                ))}
                <div ref={messagesEndRef} className="h-6" />
              </>
            )}
          </div>
        </div>

        {/* Input */}
        <div className="flex-shrink-0 max-w-3xl mx-auto w-full">
          <ChatInput
            onSend={sendMessage}
            onStop={stopStreaming}
            isStreaming={isStreaming}
            model={selectedModel}
            onModelClick={() => setShowModelSelector(true)}
          />
        </div>
      </div>

      {/* Model selector overlay */}
      {showModelSelector && (
        <ModelSelector
          models={MODELS}
          selected={selectedModel}
          onSelect={setSelectedModel}
          onClose={() => setShowModelSelector(false)}
        />
      )}

      {/* Copy toast */}
      {copied && (
        <div
          className="fixed bottom-6 left-1/2 -translate-x-1/2 px-3 py-1.5 rounded-lg text-xs font-medium z-50"
          style={{ background: 'var(--secondary)', color: 'var(--foreground)', border: '1px solid var(--border)' }}
        >
          Copied to clipboard
        </div>
      )}
    </div>
  );
}

function ClassificationBadge({ level }: { level: string }) {
  const color = CLASSIFICATION_COLOR[level] ?? '#6b7280';
  return (
    <span
      className="px-2 py-0.5 rounded text-xs font-medium tracking-wide"
      style={{ background: color + '18', color, border: `1px solid ${color}40` }}
    >
      {level}
    </span>
  );
}

function StatusIndicator() {
  return (
    <div className="flex items-center gap-1.5 text-xs px-2 py-1 rounded-md" style={{ color: 'var(--muted-foreground)', background: 'var(--card)', border: '1px solid var(--border)' }}>
      <span className="w-1.5 h-1.5 rounded-full" style={{ background: 'var(--accent)' }} />
      Internal Network
    </div>
  );
}

function UserMenu() {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-8 h-8 rounded-full flex items-center justify-center text-xs font-semibold"
        style={{ background: 'var(--secondary)', color: 'var(--foreground)', border: '1px solid var(--border)' }}
      >
        JD
      </button>
      {open && (
        <div
          className="absolute right-0 top-10 rounded-lg py-1 z-50 w-48"
          style={{ background: 'var(--card)', border: '1px solid var(--border)', boxShadow: '0 8px 32px rgba(0,0,0,0.4)' }}
        >
          <div className="px-3 py-2" style={{ borderBottom: '1px solid var(--border)' }}>
            <p className="text-sm font-medium" style={{ color: 'var(--foreground)' }}>Jane Doe</p>
            <p className="text-xs" style={{ color: 'var(--muted-foreground)' }}>jane.doe@acmecorp.com</p>
            <p className="text-xs mt-0.5" style={{ color: 'var(--muted-foreground)' }}>Role: Power User</p>
          </div>
          {[
            { label: 'Settings', icon: '⚙️' },
            { label: 'Audit Log', icon: '📋' },
            { label: 'API Keys', icon: '🔑' },
          ].map((item) => (
            <button
              key={item.label}
              className="w-full text-left px-3 py-1.5 text-sm flex items-center gap-2 hover:bg-secondary"
              style={{ color: 'var(--foreground)' }}
              onClick={() => setOpen(false)}
            >
              <span>{item.icon}</span>
              {item.label}
            </button>
          ))}
          <div style={{ borderTop: '1px solid var(--border)' }} className="mt-1 pt-1">
            <button
              className="w-full text-left px-3 py-1.5 text-sm hover:bg-secondary"
              style={{ color: '#ef4444' }}
              onClick={() => setOpen(false)}
            >
              Sign Out
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
