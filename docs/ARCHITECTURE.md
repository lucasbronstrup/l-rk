# Lärk — Arquitetura e contratos internos

Lärk é um assistente pessoal estilo J.A.R.V.I.S. que roda **localmente no computador do usuário**
(servidor Node + interface web), usa a **API gratuita do Google AI Studio (Gemini)** como cérebro e voz,
tem **memória permanente** em SQLite e **acesso ao computador** (arquivos, terminal, sistema).

Idioma de tudo voltado ao usuário: **português do Brasil**. Código e identificadores: inglês.

## Stack (versões já instaladas — confira as APIs em `node_modules`, elas podem ser mais novas que o seu conhecimento)

| Camada | Tecnologia |
|---|---|
| Servidor | Node ≥20, TypeScript (ESM), **Hono** + `@hono/node-server`, `ws` (WebSocket da voz) |
| IA | **`@google/genai`** (SDK oficial do Gemini, v2.x): `models.generateContentStream`, function calling (`parametersJsonSchema`), `thinkingConfig.includeThoughts`, `live.connect`, TTS (`responseModalities: ['AUDIO']`), `models.embedContent`, `models.list` |
| Banco | **better-sqlite3** com FTS5 (busca textual) + embeddings em BLOB (Float32) para busca semântica |
| Computador | `fast-glob`, `systeminformation`, `screenshot-desktop`, `clipboardy`, `trash`, `open`, `mammoth`, `node:child_process` |
| Interface | React 19, Vite 8, Tailwind CSS v4 (`@tailwindcss/vite`, tokens em `web/src/styles/theme.css`), `zustand`, `motion`, `lucide-react`, `react-markdown` + `remark-gfm` |
| Fontes | `@fontsource/orbitron` (display), `@fontsource/rajdhani` (HUD), `@fontsource-variable/inter` (texto), `@fontsource/jetbrains-mono` (dados) |

Imports no servidor usam caminhos relativos com sufixo `.js` (ex.: `import { bus } from '../lib/bus.js'`),
e os tipos compartilhados vêm de `../../shared/types.js`. No front use os aliases `@/` (web/src) e `@shared/` (shared).
**Não adicione dependências** ao package.json; se algo for indispensável, registre em `docs/NOTES.md`.

## Arquivos de contrato (já escritos — não mude a API pública deles)

- `shared/types.ts` — todos os tipos de domínio, eventos SSE, protocolo da voz.
- `server/config.ts` — `config` (porta, caminho do banco, chave do .env, modo mock...).
- `server/lib/bus.ts` — `bus.publish(LarkEvent)` / `bus.subscribe(fn)`.
- `server/lib/ids.ts` — `newId()`, `nowIso()`.
- `server/tools/types.ts` — `ToolDefinition`, `ToolContext`, `ToolResult`.
- `web/src/styles/theme.css` — tokens de cor/fonte (Tailwind v4 `@theme`).
- `web/src/store/ui.ts` — `useUi` (estado do orbe, nível de voz, modais, aba mobile, conexão, voiceMode).
- `web/src/store/prefs.ts` — `usePrefs` (preferências locais: wakeWord, sfx, notifications, fallbackVoiceURI, volume).
- `web/src/lib/sfx.ts` — `playSfx(kind)`.
- `web/src/lib/cn.ts` — `cn(...)`.
- `web/src/components/ui/*` — primitivos: `HudPanel`, `HudButton`, `IconButton`, `Badge`, `Modal`, `Toggle`, `Field`.

## Módulos do servidor e suas interfaces públicas

### `server/db/` + `server/memory/` (dono: S1 — dados e memória)
```ts
// server/db/index.ts
export const db: Database;               // better-sqlite3, WAL, migrações aplicadas na importação
// server/memory/settings.ts
export function getSettings(): Settings;                 // nunca expõe a chave
export function updateSettings(patch: SettingsUpdate): Settings; // publica {type:'settings'}
export function getApiKey(): string;                     // chave salva no banco || config.geminiApiKey
// server/memory/conversations.ts
export function createConversation(title?: string): Conversation;
export function getConversation(id: string): Conversation | null;
export function listConversations(limit?: number): Conversation[];
export function updateConversation(id: string, patch: { title?: string; summary?: string | null }): Conversation | null;
export function deleteConversation(id: string): boolean;
export function getOrCreateActiveConversation(): Conversation; // a mais recente atualizada, ou nova
// server/memory/messages.ts
export function addMessage(m: Omit<ChatMessage, 'id' | 'createdAt'> & { id?: string; createdAt?: string }): ChatMessage; // indexa FTS + agenda embedding
export function updateMessage(id: string, patch: Partial<Pick<ChatMessage, 'content' | 'thoughts' | 'toolCalls'>>): ChatMessage | null;
export function listMessages(conversationId: string, opts?: { limit?: number; before?: string }): ChatMessage[]; // ordem cronológica
export function countMessages(conversationId: string): number;
// server/memory/memories.ts
export function createMemory(input: { content: string; category: MemoryCategory; importance?: number; source?: Memory['source']; pinned?: boolean }): Memory;
export function updateMemory(id: string, patch: Partial<Pick<Memory, 'content' | 'category' | 'importance' | 'pinned'>>): Memory | null;
export function deleteMemory(id: string): boolean;
export function getMemory(id: string): Memory | null;
export function listMemories(opts?: { q?: string; category?: MemoryCategory; limit?: number; offset?: number }): { items: Memory[]; total: number };
export function getMemoryStats(): MemoryStats;
// server/memory/search.ts
export async function searchMemory(query: string, opts?: { limit?: number; includeMessages?: boolean; excludeConversationId?: string }): Promise<MemorySearchHit[]>; // híbrido FTS + vetorial
export async function findSimilarMemories(text: string, limit?: number): Promise<Memory[]>;
export function getCoreMemories(limit?: number): Memory[]; // fixadas + mais importantes (sempre no contexto)
// server/memory/embeddings.ts
export async function embed(texts: string[], taskType?: 'RETRIEVAL_DOCUMENT' | 'RETRIEVAL_QUERY'): Promise<Float32Array[] | null>; // null se sem chave/mock/erro
export function startEmbeddingWorker(): void; // processa em segundo plano mensagens/memórias sem embedding
// server/memory/commitments.ts
export function createCommitment(input: { description: string; dueAt?: string | null; notes?: string | null }): Commitment;
export function updateCommitment(id: string, patch: Partial<Pick<Commitment, 'description' | 'dueAt' | 'status' | 'notes' | 'lastCheckedAt' | 'checkCount'>>): Commitment | null;
export function deleteCommitment(id: string): boolean;
export function listCommitments(opts?: { status?: CommitmentStatus | 'open' }): Commitment[];
export function getCommitment(id: string): Commitment | null;
// server/memory/reminders.ts
export function createReminder(input: { text: string; dueAt: string; recurrence?: Recurrence }): Reminder;
export function updateReminder(id: string, patch: Partial<Pick<Reminder, 'text' | 'dueAt' | 'status' | 'recurrence' | 'firedAt'>>): Reminder | null;
export function deleteReminder(id: string): boolean;
export function listReminders(opts?: { status?: ReminderStatus; from?: string; to?: string }): Reminder[];
export function getDueReminders(now: Date): Reminder[];
export function nextOccurrence(dueAt: string, recurrence: Recurrence, timezone: string): string | null;
// server/tools/memory-tools.ts
export const memoryTools: ToolDefinition[]; // remember, recall, update_memory, forget, create_commitment, update_commitment, list_commitments, create_reminder, list_reminders, cancel_reminder
```
Todas as funções de escrita publicam o evento correspondente no `bus` (`memory`, `commitment`, `reminder`, `conversation`).

### `server/tools/` (dono: S-tools — computador e web)
```ts
// server/tools/index.ts
export function getAllTools(): ToolDefinition[];               // memoryTools + ferramentas do computador/web/utilitários
export function getToolDeclarations(mode: 'text' | 'voice'): FunctionDeclaration[]; // formato @google/genai (name, description, parametersJsonSchema)
export async function runTool(name: string, args: Record<string, unknown>, ctx: ToolContext, callId?: string): Promise<{ call: ToolCallInfo; result: ToolResult }>; // aplica aprovação, timeout, captura erro
// server/tools/approvals.ts
export function requestApproval(input: Omit<ApprovalRequest, 'id' | 'createdAt' | 'expiresAt'>, timeoutMs?: number): Promise<boolean>; // publica approval_request; resolve com a decisão (timeout = negado)
export function resolveApproval(id: string, approved: boolean): boolean;
export function listPendingApprovals(): ApprovalRequest[];
// server/tools/system.ts
export async function getSystemVitals(): Promise<SystemVitals>;
```

### `server/llm/` + `server/agent/` + rota de chat (dono: S2 — cérebro)
```ts
// server/llm/gemini.ts
export function getClient(): GoogleGenAI | null;                 // null sem chave
export async function listAvailableModels(force?: boolean): Promise<ModelInfo[]>; // models.list, cache 1h
export async function resolveModel(role: ModelRole): Promise<string>; // settings.models[role] || melhor disponível pela lista de preferência
export async function getActiveModels(): Promise<Partial<Record<ModelRole, string>>>;
export async function generateText(opts: { system?: string; prompt: string | Content[]; role?: 'chat' | 'fast'; json?: boolean; temperature?: number; maxOutputTokens?: number }): Promise<string>; // com fallback de modelo em 429/503
export function classifyGeminiError(e: unknown): { code: 'no_api_key' | 'quota' | 'provider' | 'internal'; message: string };
// server/agent/persona.ts
export function buildPersona(settings: Settings, mode: 'text' | 'voice'): string; // personalidade completa (orador mestre)
// server/agent/context.ts
export async function buildSystemInstruction(opts: { conversationId: string; mode: 'text' | 'voice'; query?: string }): Promise<string>; // persona + data/hora + perfil + memórias relevantes + compromissos + lembretes + resumo
export function toGeminiHistory(messages: ChatMessage[]): Content[];
// server/agent/loop.ts
export async function runAgentTurn(opts: { conversationId: string; userText: string; kind?: MessageKind; onEvent: (e: ChatStreamEvent) => void; signal?: AbortSignal }): Promise<ChatMessage>;
// server/agent/post-turn.ts
export function schedulePostTurn(conversationId: string): void; // extração de memórias/compromissos + resumo, em segundo plano
// server/agent/mock.ts — respostas simuladas quando config.mock (ou sem chave no modo demonstração)
// server/routes/chat.ts
export const chatRoutes: Hono; // POST /chat (SSE), POST /tts-text? não — TTS é do S-voice
```

### `server/voice/` (dono: S-voice — voz)
```ts
// server/voice/tts.ts
export async function synthesizeSpeech(text: string, opts?: { voiceName?: string; style?: string }): Promise<{ wav: Buffer; model: string } | null>; // null em mock/sem chave/quota → cliente usa voz do navegador
// server/voice/live.ts
export function attachVoiceServer(server: import('node:http').Server): void; // WebSocket em /api/voice (protocolo em shared/types.ts)
// server/routes/voice.ts
export const voiceRoutes: Hono; // POST /tts {text} → audio/wav (204 quando indisponível); GET /voices → lista de vozes
```

### `server/proactive/` + rotas REST + entrada (dono: S3 — sistema)
```ts
// server/proactive/scheduler.ts
export function startScheduler(): void; // a cada 20s: lembretes vencidos, cobranças de compromissos, briefing matinal
// server/proactive/briefing.ts
export async function generateBriefing(conversationId?: string): Promise<ChatMessage>;
// server/lib/auth.ts — middleware opcional por senha (LARK_PASSWORD), cookie assinado
// server/routes/*.ts — REST (lista abaixo); server/index.ts — monta tudo, serve dist/web em produção, anexa WebSocket
```

## API HTTP (prefixo `/api`)

| Método | Rota | Resposta |
|---|---|---|
| GET | `/health` | `HealthInfo` |
| GET | `/auth/status` · POST `/auth/login {password}` · POST `/auth/logout` | `{required, authenticated}` |
| GET | `/conversations` | `Conversation[]` |
| POST | `/conversations` `{title?}` | `Conversation` |
| GET | `/conversations/active` | `Conversation` (getOrCreateActiveConversation) |
| PATCH/DELETE | `/conversations/:id` | `Conversation` / `{ok}` |
| GET | `/conversations/:id/messages?limit=&before=` | `ChatMessage[]` |
| POST | `/chat` `{conversationId?, message}` | SSE de `ChatStreamEvent` |
| POST | `/chat/stop` `{conversationId}` | `{ok}` (aborta geração) |
| POST | `/briefing` `{conversationId?, force?}` | `{message: ChatMessage}` |
| GET | `/memories?q=&category=&limit=&offset=` | `{items: Memory[], total}` |
| GET | `/memories/stats` | `MemoryStats` |
| GET | `/memories/search?q=` | `MemorySearchHit[]` |
| POST/PATCH/DELETE | `/memories`, `/memories/:id` | `Memory` / `{ok}` |
| GET/POST | `/commitments?status=` | `Commitment[]` / `Commitment` |
| PATCH/DELETE | `/commitments/:id` | `Commitment` / `{ok}` |
| GET/POST | `/reminders?status=` | `Reminder[]` / `Reminder` |
| PATCH/DELETE | `/reminders/:id` | `Reminder` / `{ok}` |
| GET/PUT | `/settings` | `Settings` |
| GET | `/models` | `ModelInfo[]` |
| GET | `/approvals` · POST `/approvals/:id` `{approved}` | `ApprovalRequest[]` / `{ok}` |
| GET | `/system/vitals` | `SystemVitals` |
| POST | `/tts` `{text}` | `audio/wav` ou 204 |
| GET | `/voices` | `{name, description}[]` |
| GET | `/events` | SSE de `LarkEvent` (com `ping` a cada 20s) |
| GET | `/export` · POST `/import` | backup JSON completo |
| WS | `/api/voice` | protocolo `VoiceClientMessage`/`VoiceServerMessage` |

Formato SSE: `event: <type>\ndata: <JSON do evento inteiro>\n\n`.

## Interface (web/src)

| Dono | Arquivos | Exporta |
|---|---|---|
| W1 (casca/HUD) | `web/index.html`, `main.tsx`, `App.tsx`, `styles/global.css`, `components/hud/*`, `web/public/*` | layout responsivo, orbe reativo, boot, barra superior, fundo |
| W2 (chat + voz) | `components/chat/*`, `store/chat.ts`, `lib/stream.ts`, `lib/audio/*`, `hooks/useVoice*.ts`, `components/voice/*` | `ChatPanel`, `VoiceModeOverlay`, `VoiceController`, `useChat` |
| W3 (dados) | `lib/api.ts`, `store/data.ts`, `components/panels/*`, `hooks/useDataBootstrap.ts` | `MemoryPanel`, `CommitmentsPanel`, `RemindersPanel`, `SystemPanel`, `SettingsModal`, `ConversationsDrawer`, `NotificationCenter`, `ApprovalDialog`, `AuthGate`, `useDataBootstrap`, `api` |

Contratos entre os donos da interface:
```ts
// W2 — web/src/store/chat.ts
export const useChat: UseBoundStore<{
  conversationId: string | null; messages: ChatMessage[]; streaming: boolean; error: string | null;
  init(): Promise<void>;                      // carrega a conversa ativa
  sendMessage(text: string): Promise<void>;
  stop(): void;
  loadConversation(id: string): Promise<void>;
  newConversation(): Promise<void>;
  receiveProactive(msg: ChatMessage): void;   // chamado pelo W3 ao receber evento message/checkin/reminder_fired; anexa e fala (se speakInChat ou voiceMode)
  appendMessages(msgs: ChatMessage[]): void;  // usado pela voz para registrar turnos
}>;
// W2 — componentes
export function ChatPanel(): JSX.Element;          // ocupa 100% da altura do contêiner
export function VoiceModeOverlay(): JSX.Element;   // UI do modo de voz (aparece quando useUi.voiceMode)
export function VoiceController(): null;           // palavra de ativação, reprodução TTS, atalhos
export function speak(text: string): Promise<void>; // em web/src/lib/audio/speak.ts — TTS Gemini → fallback navegador; atualiza orbState/voiceLevel
// W3 — web/src/lib/api.ts
export const api: { /* um método tipado por rota REST acima */ };
// W3 — web/src/store/data.ts
export const useData: UseBoundStore<{ settings: Settings | null; health: HealthInfo | null; memories; memoryStats; commitments; reminders; conversations; vitals; approvals; ... }>;
// W3 — hooks/useDataBootstrap.ts
export function useDataBootstrap(): void; // carrega dados, abre /api/events, despacha eventos (inclui useChat.getState().receiveProactive)
// W3 — componentes
export function MemoryPanel(): JSX.Element; export function CommitmentsPanel(): JSX.Element; export function RemindersPanel(): JSX.Element;
export function SystemPanel(): JSX.Element; export function SettingsModal(): JSX.Element; // abre via useUi.settingsOpen
export function ConversationsDrawer(): JSX.Element; // abre via useUi.conversationsOpen
export function NotificationCenter(): JSX.Element; export function ApprovalDialog(): JSX.Element;
export function AuthGate(props: { children: ReactNode }): JSX.Element;
```

## Fatos verificados da API do Gemini (testados em 16/10/2026 com uma chave real do plano gratuito)

Modelos que existem de fato (`models.list`) — use estes IDs nas listas de preferência:
- **Texto (chat):** `gemini-3.8-flash` (no teste devolveu **503 "high demand"** → o fallback é obrigatório), `gemini-3.7-flash`, `gemini-3.6-flash`, `gemini-3.5-flash`, `gemini-3-flash-preview`, `gemini-flash-latest`, `gemini-2.5-flash`.
- **Texto rápido (fast):** `gemini-3.5-flash-lite` (✅ respondeu em ~5 s), `gemini-3.1-flash-lite`, `gemini-flash-lite-latest`, `gemini-2.5-flash-lite`.
- **TTS:** `gemini-3.8-flash-tts` (✅ ~2,7 s; **devolve `audio/wav` já com cabeçalho RIFF** — não embrulhe de novo), `gemini-3.1-flash-tts-preview` (✅ ~1,7 s; devolve `audio/l16; rate=24000; channels=1` = PCM cru que precisa de cabeçalho WAV), `gemini-3.8-flash-lite-tts`, `gemini-2.5-flash-preview-tts`. Trate os dois formatos pelo `mimeType`.
- **Live (bidiGenerateContent):** `gemini-3.8-live`, `gemini-3.8-live-extended-thinking`, `gemini-3.1-flash-live-preview`, `gemini-2.5-flash-native-audio-latest`, `gemini-2.5-flash-native-audio-preview-12-2025`. Atenção: também têm bidiGenerateContent, mas NÃO servem para conversa: `gemini-3.5-transcribe-live` (só transcrição), `gemini-3.5-live-translate-preview`, `gemini-robotics-er-2-streaming-preview`, `lyria-realtime-exp` — exclua por nome.
- **Embeddings:** `gemini-embedding-2` (✅ 3072 dimensões; use `outputDimensionality: 768` para economizar espaço), `gemini-embedding-001`. (Não existe `gemini-embedding-002`.)
- **Transcrição:** `gemini-3.5-transcribe` (generateContent com áudio) — útil para STT de reserva.
- Modelos `*-pro*` exigem cobrança: nunca escolha automaticamente.
- O formato das chaves novas do AI Studio começa com `AQ.` (não só `AIza`). Não valide a chave por prefixo.

## Persona: o Lärk é o alter ego do usuário (Lärk Skynner)

O usuário tem um manual pessoal chamado **"Lärk Skynner — Manual do Alter Ego"**: o Lärk é a versão confiante, carismática e
sem freio do próprio usuário (nome vem de *skylark*, a cotovia que canta enquanto sobe). O assistente encarna essa
identidade além do papel de J.A.R.V.I.S.: calmo por dentro, animado por fora; voz do peito, grave, com pausas, frases que
terminam em ponto final; humor que zoa a situação e a si mesmo, nunca humilha ninguém; bordão "Bora?"; lema "Quando eu falo
oi, já venci."; "Medo é o ingresso."; chama a voz da insegurança de **"o Freio"** e responde a ela.

O conteúdo integral do manual é **pessoal e NÃO vai para o repositório (que é público)**. Ele fica em
`data/alter-ego.md` (pasta `data/` é ignorada pelo git). Regras:
- `buildPersona` deve carregar `data/alter-ego.md` (se existir; caminho relativo à pasta do banco, `path.dirname(config.dbPath)`)
  e incluí-lo no system instruction numa seção "MANUAL DO ALTER EGO DO USUÁRIO (conhecimento privado)", com cache por mtime.
- A personalidade-base no código pode citar os traços gerais acima (são públicos e genéricos), mas nunca detalhes da vida
  do usuário.
- Os recursos de coach do programa (imersão de 14 dias, missões por nível, diário de votos, ritual) serão implementados numa
  etapa seguinte — não precisam ser feitos agora.
