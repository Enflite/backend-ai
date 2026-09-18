import { useState } from 'react';
import type { Message, Citation } from '../types';

interface MessageProps {
  message: Message;
  onCopy: (text: string) => void;
  onRegenerate?: () => void;
}

function parseContent(content: string): Array<{ type: 'text' | 'code'; content: string; language?: string }> {
  const parts: Array<{ type: 'text' | 'code'; content: string; language?: string }> = [];
  const codeBlockRegex = /```(\w*)\n?([\s\S]*?)```/g;
  let lastIndex = 0;
  let match;

  while ((match = codeBlockRegex.exec(content)) !== null) {
    if (match.index > lastIndex) {
      parts.push({ type: 'text', content: content.slice(lastIndex, match.index) });
    }
    parts.push({ type: 'code', language: match[1] || 'plaintext', content: match[2].trimEnd() });
    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < content.length) {
    parts.push({ type: 'text', content: content.slice(lastIndex) });
  }

  return parts;
}

function renderText(text: string) {
  const lines = text.split('\n');
  const elements: React.ReactNode[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (line.startsWith('**') && line.endsWith('**') && line.length > 4) {
      elements.push(
        <p key={i} className="font-semibold mt-3 mb-1" style={{ color: 'var(--foreground)' }}>
          {line.slice(2, -2)}
        </p>
      );
    } else if (line.startsWith('- ') || line.startsWith('* ')) {
      const items: string[] = [];
      while (i < lines.length && (lines[i].startsWith('- ') || lines[i].startsWith('* '))) {
        items.push(lines[i].slice(2));
        i++;
      }
      elements.push(
        <ul key={`ul-${i}`} className="list-none space-y-1 my-2">
          {items.map((item, j) => (
            <li key={j} className="flex items-start gap-2 text-sm" style={{ color: 'var(--foreground)' }}>
              <span className="mt-1.5 w-1 h-1 rounded-full flex-shrink-0" style={{ background: 'var(--accent)' }} />
              {renderInline(item)}
            </li>
          ))}
        </ul>
      );
      continue;
    } else if (line === '') {
      elements.push(<div key={i} className="h-2" />);
    } else {
      elements.push(
        <p key={i} className="text-sm leading-relaxed" style={{ color: 'var(--foreground)' }}>
          {renderInline(line)}
        </p>
      );
    }
    i++;
  }

  return elements;
}

function renderInline(text: string): React.ReactNode {
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g);
  return parts.map((part, i) => {
    if (part.startsWith('**') && part.endsWith('**')) {
      return <strong key={i}>{part.slice(2, -2)}</strong>;
    }
    if (part.startsWith('`') && part.endsWith('`')) {
      return (
        <code key={i} className="px-1 py-0.5 rounded text-xs font-mono" style={{ background: 'var(--secondary)', color: 'var(--accent)' }}>
          {part.slice(1, -1)}
        </code>
      );
    }
    return part;
  });
}

function CodeBlock({ content, language }: { content: string; language: string }) {
  const [copied, setCopied] = useState(false);

  function copy() {
    navigator.clipboard.writeText(content);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div className="rounded-md overflow-hidden my-3" style={{ border: '1px solid var(--border)' }}>
      <div className="flex items-center justify-between px-3 py-1.5" style={{ background: 'var(--secondary)', borderBottom: '1px solid var(--border)' }}>
        <span className="text-xs font-mono" style={{ color: 'var(--muted-foreground)' }}>{language}</span>
        <button
          onClick={copy}
          className="flex items-center gap-1 text-xs px-2 py-0.5 rounded hover:bg-card"
          style={{ color: copied ? 'var(--accent)' : 'var(--muted-foreground)' }}
        >
          {copied ? <IconCheck /> : <IconCopy />}
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre className="overflow-x-auto p-4 text-xs font-mono leading-relaxed" style={{ background: 'var(--card)', color: '#a8d8b9' }}>
        <code>{content}</code>
      </pre>
    </div>
  );
}

function CitationsBlock({ citations }: { citations: Citation[] }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="mt-3 pt-3" style={{ borderTop: '1px solid var(--border)' }}>
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1.5 text-xs font-medium"
        style={{ color: 'var(--accent)' }}
      >
        <IconBookOpen />
        {citations.length} source{citations.length !== 1 ? 's' : ''}
        <IconChevron open={open} />
      </button>
      {open && (
        <div className="mt-2 space-y-1.5">
          {citations.map((c) => (
            <div key={c.id} className="flex items-start gap-2 px-2.5 py-2 rounded-md" style={{ background: 'var(--secondary)' }}>
              <span className="text-xs font-mono flex-shrink-0 mt-0.5" style={{ color: 'var(--accent)' }}>[{c.id}]</span>
              <div>
                <p className="text-xs font-medium" style={{ color: 'var(--foreground)' }}>{c.title}</p>
                <p className="text-xs" style={{ color: 'var(--muted-foreground)' }}>
                  {c.section}{c.page ? ` — Page ${c.page}` : ''}
                </p>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default function MessageBubble({ message, onCopy, onRegenerate }: MessageProps) {
  const isUser = message.role === 'user';
  const parts = parseContent(message.content);

  return (
    <div className={`flex gap-3 py-4 group ${isUser ? 'flex-row-reverse' : ''}`}>
      {/* Avatar */}
      <div
        className="w-8 h-8 rounded-full flex items-center justify-center text-xs font-semibold flex-shrink-0 self-start mt-0.5"
        style={
          isUser
            ? { background: 'var(--secondary)', color: 'var(--foreground)', border: '1px solid var(--border)' }
            : { background: 'var(--accent)', color: 'var(--accent-foreground)' }
        }
      >
        {isUser ? 'U' : 'AI'}
      </div>

      {/* Content */}
      <div className={`flex-1 min-w-0 ${isUser ? 'flex flex-col items-end' : ''}`}>
        {isUser ? (
          <div className="max-w-[80%] px-4 py-2.5 rounded-xl text-sm" style={{ background: 'var(--secondary)', color: 'var(--foreground)', border: '1px solid var(--border)' }}>
            {message.content}
          </div>
        ) : (
          <div className="max-w-full">
            {message.isStreaming && !message.content ? (
              <div className="flex items-center gap-1.5 py-2">
                <span className="w-1.5 h-1.5 rounded-full animate-pulse" style={{ background: 'var(--accent)' }} />
                <span className="w-1.5 h-1.5 rounded-full animate-pulse [animation-delay:0.2s]" style={{ background: 'var(--accent)' }} />
                <span className="w-1.5 h-1.5 rounded-full animate-pulse [animation-delay:0.4s]" style={{ background: 'var(--accent)' }} />
              </div>
            ) : (
              <>
                {parts.map((part, i) =>
                  part.type === 'code' ? (
                    <CodeBlock key={i} content={part.content} language={part.language || 'plaintext'} />
                  ) : (
                    <div key={i}>{renderText(part.content)}</div>
                  )
                )}
                {message.citations && <CitationsBlock citations={message.citations} />}
                {message.notice && (
                  <p className="text-xs mt-2 flex items-center gap-1.5" style={{ color: 'var(--muted-foreground)' }} role="status">
                    <span className="w-1.5 h-1.5 rounded-full animate-pulse" style={{ background: 'var(--accent)' }} />
                    {message.notice}
                  </p>
                )}
                {message.error && (
                  <div className="mt-2 px-3 py-2 rounded-md text-xs flex items-center justify-between gap-3" style={{ background: '#7f1d1d55', color: '#fca5a5' }} role="alert">
                    <span>{message.error}</span>
                    {onRegenerate && (
                      <button onClick={onRegenerate} className="underline underline-offset-2 flex-shrink-0">Retry</button>
                    )}
                  </div>
                )}
                {message.usage && (
                  <p className="text-xs mt-2" style={{ color: 'var(--muted-foreground)' }} title={`Prompt: ${message.usage.promptTokens}, Completion: ${message.usage.completionTokens}`}>
                    {message.usage.totalTokens.toLocaleString()} tokens
                  </p>
                )}
                {message.isStreaming && <span aria-label="Streaming" className="inline-block w-1.5 h-4 ml-1 animate-pulse" style={{ background: 'var(--accent)' }} />}
              </>
            )}
          </div>
        )}

        {/* Actions */}
        {!isUser && !message.isStreaming && (
          <div className="flex items-center gap-1 mt-2 opacity-0 group-hover:opacity-100">
            <ActionBtn onClick={() => onCopy(message.content)} title="Copy">
              <IconCopy />
            </ActionBtn>
            {onRegenerate && (
              <ActionBtn onClick={onRegenerate} title="Regenerate">
                <IconRefresh />
              </ActionBtn>
            )}
            <span className="text-xs ml-1" style={{ color: 'var(--muted-foreground)' }}>
              {message.model}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

function ActionBtn({ onClick, title, children }: { onClick: () => void; title: string; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      title={title}
      className="p-1.5 rounded-md hover:bg-secondary"
      style={{ color: 'var(--muted-foreground)' }}
    >
      {children}
    </button>
  );
}

function IconCopy() {
  return <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><rect x="5" y="5" width="9" height="9" rx="1" /><path d="M11 5V3a1 1 0 00-1-1H3a1 1 0 00-1 1v7a1 1 0 001 1h2" /></svg>;
}
function IconCheck() {
  return <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M3 8l4 4 6-7" /></svg>;
}
function IconRefresh() {
  return <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><path d="M13 2v4h-4M3 14v-4h4" /><path d="M3.5 9A5.5 5.5 0 1112.5 7" /></svg>;
}
function IconBookOpen() {
  return <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><path d="M8 3v11M8 3C7 2 5 1 2 1v11c3 0 5 1 6 2M8 3c1-1 3-2 6-2v11c-3 0-5 1-6 2" /></svg>;
}
function IconChevron({ open }: { open: boolean }) {
  return <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" style={{ transform: open ? 'rotate(180deg)' : 'none' }}><path d="M4 6l4 4 4-4" /></svg>;
}
