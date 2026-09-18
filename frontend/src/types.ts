export type MessageRole = 'user' | 'assistant' | 'system';

export type DataClassification = 'PUBLIC' | 'INTERNAL' | 'CONFIDENTIAL' | 'PROPRIETARY' | 'CUI' | 'UNKNOWN';

export interface Citation {
  id: number;
  title: string;
  section?: string;
  page?: number;
  documentId?: string;
  chunkId?: string;
}

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface Message {
  id: string;
  role: MessageRole;
  content: string;
  timestamp: Date;
  citations?: Citation[];
  isStreaming?: boolean;
  model?: string;
  classification?: DataClassification;
  usage?: TokenUsage;
  /** Transient status shown while streaming (tool calls, failover notices). */
  notice?: string;
  /** Set when the turn failed; the message keeps partial content for retry. */
  error?: string;
}

export interface Conversation {
  id: string;
  title: string;
  createdAt: Date;
  updatedAt: Date;
  messages: Message[];
  model: string;
  classification: DataClassification;
}

export interface Model {
  id: string;
  name: string;
  provider: string;
  description: string;
  classificationMax: DataClassification;
  contextLength: number;
  enabled: boolean;
}

export interface UploadedFile {
  id: string;
  name: string;
  size: number;
  type: string;
  status: 'uploading' | 'processing' | 'ready' | 'error';
  file?: File;
}

export interface AuthUser {
  userId: string;
  email: string;
  displayName: string;
  roleName: string;
  clearance: DataClassification;
  tenantId: string;
  permissions: string[];
}

export interface DocumentRecord {
  id: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  classification: DataClassification;
  status: 'PENDING' | 'PROCESSING' | 'READY' | 'FAILED' | 'QUARANTINED' | 'DELETED';
  errorCode?: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface RagResult {
  documentId: string;
  documentName: string;
  chunkId: string;
  text: string;
  score: number;
  citation: Omit<Citation, 'id' | 'title'> & { documentName: string };
}
