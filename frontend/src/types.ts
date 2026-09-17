export type MessageRole = 'user' | 'assistant' | 'system';

export type DataClassification = 'PUBLIC' | 'INTERNAL' | 'CONFIDENTIAL' | 'PROPRIETARY' | 'CUI';

export interface Citation {
  id: number;
  title: string;
  section: string;
  page?: number;
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
  provider: 'local' | 'external';
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
}
