/**
 * Lärk — contratos compartilhados entre servidor e interface.
 * Todas as datas trafegam como strings ISO-8601 (UTC, ex.: "2026-10-16T13:00:00.000Z").
 * Este arquivo é a fonte da verdade: não renomeie campos sem atualizar os dois lados.
 */

// ─── Conversas e mensagens ───────────────────────────────────────────────

export type MessageRole = 'user' | 'assistant' | 'system';

/** Origem da mensagem: chat digitado, voz (Live), proativa (lembrete/cobrança) ou briefing. */
export type MessageKind = 'chat' | 'voice' | 'proactive' | 'briefing';

export interface Conversation {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  summary: string | null;
  messageCount: number;
}

export type ToolRisk = 'safe' | 'confirm' | 'dangerous';

export interface ToolCallInfo {
  id: string;
  name: string;
  /** Rótulo amigável em PT-BR (ex.: "Lendo arquivo"). */
  label: string;
  args: Record<string, unknown>;
  status: 'running' | 'awaiting_approval' | 'done' | 'error' | 'denied';
  /** Resumo curto do resultado para exibir na interface. */
  summary?: string;
  risk: ToolRisk;
}

export interface ChatMessage {
  id: string;
  conversationId: string;
  role: MessageRole;
  content: string;
  /** Resumo do raciocínio do modelo (thought summary do Gemini), quando houver. */
  thoughts?: string | null;
  toolCalls?: ToolCallInfo[];
  kind: MessageKind;
  createdAt: string;
}

// ─── Memória ─────────────────────────────────────────────────────────────

export type MemoryCategory =
  | 'fact'
  | 'preference'
  | 'person'
  | 'goal'
  | 'event'
  | 'skill'
  | 'health'
  | 'work'
  | 'project'
  | 'other';

export interface Memory {
  id: string;
  content: string;
  category: MemoryCategory;
  /** 1 (trivial) a 5 (essencial). */
  importance: number;
  source: 'auto' | 'tool' | 'manual';
  pinned: boolean;
  createdAt: string;
  updatedAt: string;
  lastAccessedAt: string | null;
  accessCount: number;
}

export interface MemorySearchHit {
  type: 'memory' | 'message';
  id: string;
  content: string;
  score: number;
  createdAt: string;
  conversationId?: string;
  category?: MemoryCategory;
}

export interface MemoryStats {
  memories: number;
  byCategory: Record<string, number>;
  messages: number;
  conversations: number;
  firstInteractionAt: string | null;
  embeddingsEnabled: boolean;
}

// ─── Compromissos (promessas) e lembretes ───────────────────────────────

export type CommitmentStatus = 'pending' | 'done' | 'missed' | 'cancelled';

export interface Commitment {
  id: string;
  description: string;
  dueAt: string | null;
  status: CommitmentStatus;
  createdAt: string;
  completedAt: string | null;
  lastCheckedAt: string | null;
  checkCount: number;
  notes: string | null;
}

export type Recurrence = 'none' | 'daily' | 'weekdays' | 'weekly' | 'monthly';
export type ReminderStatus = 'scheduled' | 'fired' | 'dismissed' | 'cancelled';

export interface Reminder {
  id: string;
  text: string;
  dueAt: string;
  recurrence: Recurrence;
  status: ReminderStatus;
  createdAt: string;
  firedAt: string | null;
}

// ─── Configurações ───────────────────────────────────────────────────────

export type ModelRole = 'chat' | 'fast' | 'tts' | 'live' | 'embedding';

export interface Settings {
  /** Como o Lärk chama o usuário (ex.: "Lucas", "senhor"). */
  userName: string;
  /** Instruções extras de personalidade escritas pelo usuário. */
  personaNotes: string;
  timezone: string;
  /** Modelos escolhidos por função. Vazio = automático (melhor disponível). */
  models: Record<ModelRole, string>;
  /** Voz pré-definida do Gemini TTS / Live (ex.: "Charon", "Orus"). */
  voiceName: string;
  /** Direção de estilo enviada ao TTS (ex.: "palestrante carismático"). */
  voiceStyle: string;
  /** Responder com voz também quando a conversa for por texto. */
  speakInChat: boolean;
  /** Mostrar o raciocínio (thought summaries) na interface. */
  showThoughts: boolean;
  /** Acesso ao computador. */
  computer: {
    enabled: boolean;
    /** 'ask': pede confirmação para ações 'confirm' e 'dangerous'.
     *  'dangerous-only': só pede para 'dangerous'.
     *  'never': executa tudo sem perguntar. */
    approvalMode: 'ask' | 'dangerous-only' | 'never';
    /** Pastas extras que o Lärk conhece como atalhos (Documentos, Downloads...). */
    favoritePaths: string[];
  };
  proactive: {
    enabled: boolean;
    /** Intervalo mínimo entre cobranças do mesmo compromisso, em horas. */
    checkInEveryHours: number;
    quietHoursStart: string; // "23:00"
    quietHoursEnd: string; // "07:00"
    morningBriefing: boolean;
  };
  /** true quando há chave do Gemini configurada (a chave nunca vai para o cliente). */
  hasApiKey: boolean;
}

/** Corpo aceito por PUT /api/settings (parcial, merge profundo). */
export type SettingsUpdate = Partial<Omit<Settings, 'hasApiKey' | 'computer' | 'proactive' | 'models'>> & {
  apiKey?: string;
  models?: Partial<Record<ModelRole, string>>;
  computer?: Partial<Settings['computer']>;
  proactive?: Partial<Settings['proactive']>;
};

export interface ModelInfo {
  id: string;
  displayName: string;
  roles: ModelRole[];
}

export interface HealthInfo {
  ok: boolean;
  version: string;
  mock: boolean;
  hasApiKey: boolean;
  /** Modelo efetivamente em uso por função (após resolução automática). */
  activeModels: Partial<Record<ModelRole, string>>;
  platform: string;
  hostname: string;
  authRequired: boolean;
}

export interface SystemVitals {
  hostname: string;
  platform: string;
  osName: string;
  uptimeSec: number;
  cpu: { model: string; cores: number; loadPct: number; tempC: number | null };
  memory: { totalBytes: number; usedBytes: number; usedPct: number };
  disks: { mount: string; totalBytes: number; usedBytes: number; usedPct: number }[];
  battery: { hasBattery: boolean; percent: number | null; charging: boolean | null };
  network: { iface: string; ip4: string | null; rxSec: number | null; txSec: number | null } | null;
  topProcesses: { pid: number; name: string; cpuPct: number; memPct: number }[];
}

// ─── Aprovações de ações no computador ───────────────────────────────────

export interface ApprovalRequest {
  id: string;
  toolName: string;
  label: string;
  risk: ToolRisk;
  /** Descrição humana do que será feito (ex.: "Apagar C:\\Users\\...\\foto.png"). */
  description: string;
  args: Record<string, unknown>;
  createdAt: string;
  expiresAt: string;
}

// ─── Eventos em tempo real ───────────────────────────────────────────────

/** Eventos do stream POST /api/chat (text/event-stream). `event:` = type, `data:` = JSON. */
export type ChatStreamEvent =
  | { type: 'meta'; conversationId: string; userMessageId: string; assistantMessageId: string; model: string }
  | { type: 'thought'; text: string }
  | { type: 'token'; text: string }
  | { type: 'tool'; call: ToolCallInfo }
  | { type: 'done'; message: ChatMessage }
  | { type: 'error'; message: string; code?: 'no_api_key' | 'quota' | 'provider' | 'internal' };

/** Eventos do stream global GET /api/events (text/event-stream). */
export type LarkEvent =
  | { type: 'hello'; serverTime: string }
  | { type: 'ping'; serverTime: string }
  | { type: 'message'; message: ChatMessage }
  | { type: 'reminder_fired'; reminder: Reminder; message: ChatMessage | null }
  | { type: 'checkin'; commitment: Commitment; message: ChatMessage }
  | { type: 'memory'; action: 'created' | 'updated' | 'deleted'; memory: Memory }
  | { type: 'commitment'; action: 'created' | 'updated' | 'deleted'; commitment: Commitment }
  | { type: 'reminder'; action: 'created' | 'updated' | 'deleted'; reminder: Reminder }
  | { type: 'approval_request'; request: ApprovalRequest }
  | { type: 'approval_resolved'; id: string; approved: boolean }
  | { type: 'conversation'; action: 'created' | 'updated' | 'deleted'; conversation: Conversation }
  | { type: 'settings'; settings: Settings };

// ─── Modo de voz (WebSocket /api/voice) ──────────────────────────────────

/**
 * Cliente → servidor:
 *  - mensagens binárias: áudio PCM16 little-endian mono 16 kHz do microfone.
 *  - mensagens de texto: JSON VoiceClientMessage.
 * Servidor → cliente:
 *  - mensagens binárias: áudio PCM16 little-endian mono 24 kHz da voz do Lärk.
 *  - mensagens de texto: JSON VoiceServerMessage.
 */
export type VoiceClientMessage =
  | { type: 'start'; conversationId?: string | null }
  | { type: 'text'; text: string }
  | { type: 'audio_end' }
  | { type: 'stop' };

export type VoiceServerMessage =
  | { type: 'ready'; conversationId: string; model: string; voice: string }
  | { type: 'user_transcript'; text: string; final: boolean }
  | { type: 'assistant_transcript'; text: string; final: boolean }
  | { type: 'interrupted' }
  | { type: 'turn_complete'; userMessage: ChatMessage | null; assistantMessage: ChatMessage | null }
  | { type: 'tool'; call: ToolCallInfo }
  | { type: 'error'; message: string; code?: 'no_api_key' | 'quota' | 'provider' | 'internal' }
  | { type: 'closed'; reason: string };
