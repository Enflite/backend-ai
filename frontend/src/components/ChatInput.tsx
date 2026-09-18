import { useState, useRef, useCallback } from 'react';
import type { Model, UploadedFile } from '../types';

interface ChatInputProps {
  onSend: (message: string, files: UploadedFile[]) => void;
  onStop?: () => void;
  isStreaming: boolean;
  disabled?: boolean;
  model: Model;
  onModelClick: () => void;
}

/** Client-side upload cap. Must stay in sync with the backend's
 *  MAX_UPLOAD_BYTES default (25 MiB); the server rejects larger files. */
const MAX_FILE_BYTES = 25 * 1024 * 1024;

export default function ChatInput({ onSend, onStop, isStreaming, disabled, model, onModelClick }: ChatInputProps) {
  const [text, setText] = useState('');
  const [files, setFiles] = useState<UploadedFile[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  function handleInput(e: React.ChangeEvent<HTMLTextAreaElement>) {
    setText(e.target.value);
    const ta = textareaRef.current;
    if (ta) {
      ta.style.height = 'auto';
      ta.style.height = Math.min(ta.scrollHeight, 200) + 'px';
    }
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  }

  function submit() {
    const sendable = files.filter((f) => f.file);
    if ((!text.trim() && sendable.length === 0) || isStreaming || disabled) return;
    // Mark files as uploading for the duration of the send; oversized files
    // (status 'error') were already excluded from `sendable`.
    setFiles((prev) => prev.map((f) => (f.file ? { ...f, status: 'uploading' } : f)));
    void (async () => {
      try {
        await onSend(text.trim(), sendable);
      } finally {
        setText('');
        setFiles([]);
        if (textareaRef.current) textareaRef.current.style.height = 'auto';
      }
    })();
  }

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const selected = Array.from(e.target.files || []);
    addFiles(selected);
    e.target.value = '';
  }

  function addFiles(selected: File[]) {
    const newFiles: UploadedFile[] = selected.map((f) => {
      const tooLarge = f.size > MAX_FILE_BYTES;
      return {
        id: Math.random().toString(36).slice(2),
        name: f.name,
        size: f.size,
        type: f.type,
        status: tooLarge ? 'error' : 'ready',
        error: tooLarge ? `Exceeds the ${formatSize(MAX_FILE_BYTES)} upload limit` : undefined,
        // Oversized files are excluded from the send entirely.
        file: tooLarge ? undefined : f,
      };
    });
    setFiles((prev) => [...prev, ...newFiles]);
  }

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    addFiles(Array.from(e.dataTransfer.files));
  }, []);

  function removeFile(id: string) {
    setFiles((prev) => prev.filter((f) => f.id !== id));
  }

  function formatSize(bytes: number) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1048576).toFixed(1)} MB`;
  }

  const sendableCount = files.filter((f) => f.file).length;
  const canSend = (text.trim().length > 0 || sendableCount > 0) && !isStreaming && !disabled;

  return (
    <div className="px-4 pb-4">
      <div
        className="rounded-xl overflow-hidden"
        style={{
          background: 'var(--card)',
          border: dragOver ? '1px solid var(--accent)' : '1px solid var(--border)',
          boxShadow: '0 0 0 1px transparent',
        }}
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={handleDrop}
      >
        {/* Attached files */}
        {files.length > 0 && (
          <div className="flex flex-wrap gap-2 px-3 pt-3">
            {files.map((f) => (
              <div
                key={f.id}
                className="flex items-center gap-1.5 px-2 py-1 rounded-md text-xs"
                style={{
                  background: 'var(--secondary)',
                  color: 'var(--foreground)',
                  border: f.status === 'error' ? '1px solid #ef444480' : '1px solid transparent',
                }}
                title={f.error}
              >
                <IconFile />
                <span className="max-w-[140px] truncate">{f.name}</span>
                <span style={{ color: 'var(--muted-foreground)' }}>{formatSize(f.size)}</span>
                {f.status === 'uploading' && (
                  <span className="animate-pulse" style={{ color: 'var(--accent)' }}>Uploading…</span>
                )}
                {f.status === 'error' && (
                  <span style={{ color: '#fca5a5' }}>{f.error ?? 'Upload blocked'}</span>
                )}
                {f.status !== 'uploading' && (
                  <button onClick={() => removeFile(f.id)} className="ml-1 hover:text-red-400" style={{ color: 'var(--muted-foreground)' }} aria-label={`Remove ${f.name}`}>
                    <IconX />
                  </button>
                )}
              </div>
            ))}
          </div>
        )}

        {/* Textarea */}
        <textarea
          ref={textareaRef}
          value={text}
          onChange={handleInput}
          onKeyDown={handleKeyDown}
          placeholder="Ask anything… (Shift+Enter for new line)"
          rows={1}
          disabled={disabled}
          className="w-full px-4 pt-3 pb-2 text-sm resize-none outline-none bg-transparent leading-relaxed placeholder:text-muted-foreground"
          style={{ color: 'var(--foreground)', maxHeight: 200 }}
        />

        {/* Toolbar */}
        <div className="flex items-center justify-between px-3 pb-2.5">
          <div className="flex items-center gap-1">
            <input
              ref={fileInputRef}
              type="file"
              multiple
              accept=".pdf,.docx,.xlsx,.csv,.txt,.md,.html"
              className="hidden"
              onChange={handleFileChange}
            />
            <ToolBtn onClick={() => fileInputRef.current?.click()} title="Attach files">
              <IconAttach />
            </ToolBtn>
            <button
              onClick={onModelClick}
              className="flex items-center gap-1 px-2 py-1 rounded-md text-xs hover:bg-secondary"
              style={{ color: 'var(--muted-foreground)', border: '1px solid var(--border)' }}
            >
              <span className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ background: 'var(--accent)' }} />
              {model.name}
            </button>
          </div>

          <div className="flex items-center gap-2">
            <span className="text-xs" style={{ color: text.length > 3000 ? '#ef4444' : 'var(--muted-foreground)' }}>
              {text.length > 0 && text.length}
            </span>
            {isStreaming ? (
              <button
                onClick={onStop}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium"
                style={{ background: 'var(--secondary)', color: 'var(--foreground)', border: '1px solid var(--border)' }}
              >
                <IconStop /> Stop
              </button>
            ) : (
              <button
                onClick={submit}
                disabled={!canSend}
                className="p-2 rounded-lg"
                style={{
                  background: canSend ? 'var(--accent)' : 'var(--secondary)',
                  color: canSend ? 'var(--accent-foreground)' : 'var(--muted-foreground)',
                  cursor: canSend ? 'pointer' : 'not-allowed',
                }}
              >
                <IconSend />
              </button>
            )}
          </div>
        </div>
      </div>

      <p className="text-center text-xs mt-2" style={{ color: 'var(--muted-foreground)' }}>
        Requests are routed only through server-approved models and document policies.
      </p>
    </div>
  );
}

function ToolBtn({ onClick, title, children }: { onClick: () => void; title: string; children: React.ReactNode }) {
  return (
    <button onClick={onClick} title={title} className="p-1.5 rounded-md hover:bg-secondary" style={{ color: 'var(--muted-foreground)' }}>
      {children}
    </button>
  );
}

function IconAttach() {
  return <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><path d="M14 8l-5.5 5.5a4 4 0 01-5.66-5.66L8.5 2.17a2.5 2.5 0 013.54 3.54L6.5 11.17a1 1 0 01-1.41-1.42L10 4.83" /></svg>;
}
function IconSend() {
  return <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><path d="M14 2L7 9M14 2L9.5 14 7 9 2 6.5 14 2z" /></svg>;
}
function IconStop() {
  return <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor"><rect x="3" y="3" width="10" height="10" rx="2" /></svg>;
}
function IconFile() {
  return <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><path d="M9 1H4a1 1 0 00-1 1v12a1 1 0 001 1h8a1 1 0 001-1V6L9 1z" /><path d="M9 1v5h5" /></svg>;
}
function IconX() {
  return <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M4 4l8 8M12 4l-8 8" /></svg>;
}
