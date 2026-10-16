import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';

vi.hoisted(() => {
  process.env.LARK_DB_PATH = ':memory:';
  delete process.env.LARK_MOCK;
});

type Callbacks = {
  onmessage: (msg: Record<string, unknown>) => void;
  onerror?: ((e: unknown) => void) | null;
  onclose?: ((e: { code: number; reason: string }) => void) | null;
};

interface FakeSession {
  model: string;
  config: Record<string, any>;
  callbacks: Callbacks;
  closed: boolean;
  sendRealtimeInput: ReturnType<typeof vi.fn>;
  sendToolResponse: ReturnType<typeof vi.fn>;
  sendClientContent: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
}

const h = vi.hoisted(() => {
  const state = {
    hasKey: true,
    sessions: [] as FakeSession[],
    /** Modelos que falham no setup: o Gemini fecha o socket com este motivo. */
    failures: new Map<string, { code: number; reason: string }>(),
    connect: null as unknown as ReturnType<typeof vi.fn>,
    postTurn: null as unknown as ReturnType<typeof vi.fn>,
    runTool: null as unknown as ReturnType<typeof vi.fn>,
  };
  return state;
});

vi.mock('../llm/gemini.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../llm/gemini.js')>();
  h.connect = vi.fn(async ({ model, config, callbacks }: { model: string; config: Record<string, any>; callbacks: Callbacks }) => {
    const failure = h.failures.get(model);
    if (failure) {
      // Como o SDK real: o setup nunca conclui e o socket fecha com o motivo.
      setTimeout(() => callbacks.onclose?.({ code: failure.code, reason: failure.reason }), 0);
      return new Promise(() => {});
    }
    const session: FakeSession = {
      model,
      config,
      callbacks,
      closed: false,
      sendRealtimeInput: vi.fn(),
      sendToolResponse: vi.fn(),
      sendClientContent: vi.fn(),
      close: vi.fn(() => {
        if (session.closed) return;
        session.closed = true;
        callbacks.onclose?.({ code: 1000, reason: '' });
      }),
    };
    h.sessions.push(session);
    return session;
  });
  return {
    ...actual,
    getClient: () => (h.hasKey ? { live: { connect: h.connect } } : null),
    resolveModel: async () => 'gemini-test-live',
    getModelFallbacks: () => ['gemini-test-live', 'gemini-3.5-transcribe-live', 'gemini-test-live-b'],
  };
});

vi.mock('../tools/index.js', () => {
  h.runTool = vi.fn(async (name: string, args: Record<string, unknown>, ctx: { emit: (c: unknown) => void }, callId?: string) => {
    const call = { id: callId ?? 'sem-id', name, label: 'Ecoando', args, status: 'running', risk: 'safe' };
    ctx.emit(call);
    const done = { ...call, status: 'done', summary: 'Ecoado' };
    ctx.emit(done);
    return { call: done, result: { output: { echoed: args }, summary: 'Ecoado' } };
  });
  return {
    getToolDeclarations: () => [{ name: 'echo', description: 'Ecoa os argumentos.', parametersJsonSchema: { type: 'object', properties: {} } }],
    runTool: h.runTool,
  };
});

vi.mock('../agent/context.js', () => ({
  buildSystemInstruction: async () => 'INSTRUÇÃO DE SISTEMA DE TESTE',
}));

vi.mock('../agent/post-turn.js', () => {
  h.postTurn = vi.fn();
  return { schedulePostTurn: h.postTurn };
});

import { config } from '../config.js';
import { addMessage, listMessages } from '../memory/messages.js';
import { createConversation } from '../memory/conversations.js';
import { updateSettings } from '../memory/settings.js';
import { resetModelCooldowns } from '../llm/gemini.js';
import { attachVoiceServer, buildMockVoiceReply, isAllowedVoiceRequest, liveCloseError, setVoiceAuthChecker, shutdownVoiceServer } from './live.js';
import type { ChatMessage, VoiceServerMessage } from '../../shared/types.js';

// ─── Infraestrutura do teste ─────────────────────────────────────────────

let server: http.Server;
let port = 0;
const clients: WebSocket[] = [];

interface Client {
  ws: WebSocket;
  messages: VoiceServerMessage[];
  audio: Buffer[];
  send: (msg: unknown) => void;
  waitFor: <T extends VoiceServerMessage['type']>(
    type: T,
    pred?: (m: Extract<VoiceServerMessage, { type: T }>) => boolean,
    timeoutMs?: number,
  ) => Promise<Extract<VoiceServerMessage, { type: T }>>;
}

async function until(check: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error('Tempo esgotado esperando a condição.');
    await new Promise((r) => setTimeout(r, 5));
  }
}

function connect(headers: Record<string, string> = {}): Promise<Client> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/voice`, { headers });
    clients.push(ws);
    const client: Client = {
      ws,
      messages: [],
      audio: [],
      send: (msg) => ws.send(JSON.stringify(msg)),
      waitFor: async (type, pred, timeoutMs = 2000) => {
        let found: VoiceServerMessage | undefined;
        await until(() => {
          found = client.messages.find((m) => m.type === type && (!pred || pred(m as never)));
          return Boolean(found);
        }, timeoutMs);
        return found as never;
      },
    };
    ws.on('message', (data, isBinary) => {
      if (isBinary) client.audio.push(Buffer.from(data as Buffer));
      else client.messages.push(JSON.parse(String(data)) as VoiceServerMessage);
    });
    ws.once('open', () => resolve(client));
    ws.once('error', reject);
    ws.once('unexpected-response', (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
  });
}

async function startSession(conversationId?: string): Promise<{ client: Client; session: FakeSession; ready: Extract<VoiceServerMessage, { type: 'ready' }> }> {
  const client = await connect();
  const before = h.sessions.length;
  client.send({ type: 'start', conversationId: conversationId ?? null });
  const ready = await client.waitFor('ready');
  await until(() => h.sessions.length > before);
  return { client, session: h.sessions[h.sessions.length - 1], ready };
}

const gemini = (session: FakeSession, msg: Record<string, unknown>) => session.callbacks.onmessage(msg);

beforeAll(async () => {
  server = http.createServer((_req, res) => res.end('ok'));
  attachVoiceServer(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  shutdownVoiceServer();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  config.mock = false;
  h.hasKey = true;
  h.sessions.length = 0;
  h.failures.clear();
  h.connect.mockClear();
  h.postTurn.mockClear();
  h.runTool.mockClear();
  resetModelCooldowns();
  setVoiceAuthChecker(() => true);
});

afterEach(async () => {
  for (const ws of clients.splice(0)) ws.close();
  await until(() => true);
});

// ─── Testes ──────────────────────────────────────────────────────────────

describe('sessão de voz ao vivo', () => {
  it('abre a sessão com voz, persona, ferramentas e transcrições', async () => {
    updateSettings({ voiceName: 'orus' });
    const conv = createConversation('Voz');
    addMessage({ conversationId: conv.id, role: 'user', content: 'Lembra do meu projeto de violão?', kind: 'chat' });
    addMessage({ conversationId: conv.id, role: 'assistant', content: 'Claro: três músicas até dezembro.', kind: 'chat' });

    const { session, ready } = await startSession(conv.id);
    expect(ready).toEqual({ type: 'ready', conversationId: conv.id, model: 'gemini-test-live', voice: 'Orus' });

    const cfg = session.config;
    expect(cfg.responseModalities).toEqual(['AUDIO']);
    expect(cfg.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName).toBe('Orus');
    expect(cfg.systemInstruction).toContain('INSTRUÇÃO DE SISTEMA DE TESTE');
    expect(cfg.systemInstruction).toContain('DIREÇÃO DE VOZ');
    expect(cfg.systemInstruction).toContain('CANAL ATUAL: CONVERSA POR VOZ AO VIVO');
    expect(cfg.systemInstruction).toContain('Lärk: Claro: três músicas até dezembro.');
    expect(cfg.tools[0].functionDeclarations[0].name).toBe('echo');
    expect(cfg.inputAudioTranscription).toEqual({});
    expect(cfg.outputAudioTranscription).toEqual({});
    expect(cfg.sessionResumption).toEqual({});
    expect(cfg.contextWindowCompression).toEqual({ slidingWindow: {} });
    expect(cfg.realtimeInputConfig.automaticActivityDetection).toBeDefined();
    updateSettings({ voiceName: 'Charon' });
  });

  it('repassa o microfone e devolve áudio, transcrições e o turno salvo', async () => {
    const conv = createConversation('Turno');
    const { client, session } = await startSession(conv.id);

    const mic = Buffer.alloc(640, 1);
    client.ws.send(mic);
    await until(() => session.sendRealtimeInput.mock.calls.length > 0);
    expect(session.sendRealtimeInput.mock.calls[0][0]).toEqual({ audio: { data: mic.toString('base64'), mimeType: 'audio/pcm;rate=16000' } });

    client.send({ type: 'audio_end' });
    await until(() => session.sendRealtimeInput.mock.calls.some((c) => c[0].audioStreamEnd === true));

    const voice = Buffer.alloc(960, 2);
    gemini(session, { serverContent: { inputTranscription: { text: 'Bom dia,' } } });
    gemini(session, { serverContent: { inputTranscription: { text: ' Lärk' } } });
    gemini(session, { serverContent: { modelTurn: { parts: [{ inlineData: { data: voice.toString('base64'), mimeType: 'audio/pcm;rate=24000' } }] } } });
    gemini(session, { serverContent: { outputTranscription: { text: ' Bom dia!' } } });
    gemini(session, { serverContent: { outputTranscription: { text: ' Bora?' } } });
    gemini(session, { serverContent: { generationComplete: true } });
    gemini(session, { serverContent: { turnComplete: true } });

    const done = await client.waitFor('turn_complete');
    expect(client.audio[0].equals(voice)).toBe(true);
    const userTexts = client.messages.filter((m) => m.type === 'user_transcript');
    expect(userTexts.map((m) => (m as { text: string }).text)).toEqual(['Bom dia,', 'Bom dia, Lärk', 'Bom dia, Lärk']);
    expect(userTexts.at(-1)).toMatchObject({ final: true });
    const assistantTexts = client.messages.filter((m) => m.type === 'assistant_transcript') as { text: string; final: boolean }[];
    expect(assistantTexts.map((m) => m.text)).toEqual(['Bom dia!', 'Bom dia! Bora?', 'Bom dia! Bora?']);
    expect(assistantTexts.at(-1)!.final).toBe(true);

    expect(done.userMessage).toMatchObject({ role: 'user', content: 'Bom dia, Lärk', kind: 'voice', conversationId: conv.id });
    expect(done.assistantMessage).toMatchObject({ role: 'assistant', content: 'Bom dia! Bora?', kind: 'voice' });
    const saved = listMessages(conv.id);
    expect(saved.map((m: ChatMessage) => m.content)).toEqual(['Bom dia, Lärk', 'Bom dia! Bora?']);
    expect(h.postTurn).toHaveBeenCalledWith(conv.id);
  });

  it('executa ferramentas pedidas pelo modelo e devolve a resposta', async () => {
    const conv = createConversation('Ferramentas');
    const { client, session } = await startSession(conv.id);

    gemini(session, { serverContent: { inputTranscription: { text: 'Repete isso' } } });
    gemini(session, { toolCall: { functionCalls: [{ id: 'call-1', name: 'echo', args: { frase: 'oi' } }] } });
    await until(() => session.sendToolResponse.mock.calls.length > 0);
    expect(session.sendToolResponse.mock.calls[0][0]).toEqual({
      functionResponses: [{ id: 'call-1', name: 'echo', response: { echoed: { frase: 'oi' } } }],
    });
    expect(h.runTool.mock.calls[0][2]).toMatchObject({ conversationId: conv.id, mode: 'voice' });
    const tools = client.messages.filter((m) => m.type === 'tool') as { call: { status: string } }[];
    expect(tools.map((t) => t.call.status)).toEqual(['running', 'done']);

    gemini(session, { serverContent: { outputTranscription: { text: 'Pronto: oi.' } } });
    gemini(session, { serverContent: { turnComplete: true } });
    const done = await client.waitFor('turn_complete');
    expect(done.assistantMessage?.toolCalls).toEqual([expect.objectContaining({ id: 'call-1', name: 'echo', status: 'done' })]);
  });

  it('separa o turno interrompido da nova fala do usuário', async () => {
    const conv = createConversation('Interrupção');
    const { client, session } = await startSession(conv.id);

    gemini(session, { serverContent: { inputTranscription: { text: 'Me conta uma história' } } });
    gemini(session, { serverContent: { outputTranscription: { text: 'Era uma vez um' } } });
    gemini(session, { serverContent: { interrupted: true } });
    gemini(session, { serverContent: { inputTranscription: { text: 'Espera, outra coisa' } } });
    gemini(session, { serverContent: { turnComplete: true } });

    await client.waitFor('interrupted');
    const first = await client.waitFor('turn_complete');
    expect(first.userMessage?.content).toBe('Me conta uma história');
    expect(first.assistantMessage?.content).toBe('Era uma vez um…');

    gemini(session, { serverContent: { outputTranscription: { text: 'Diga.' } } });
    gemini(session, { serverContent: { turnComplete: true } });
    const second = await client.waitFor('turn_complete', (m) => m.userMessage?.content === 'Espera, outra coisa');
    expect(second.assistantMessage?.content).toBe('Diga.');
  });

  it('envia texto digitado pelo canal de voz', async () => {
    const { client, session } = await startSession();
    client.send({ type: 'text', text: '  Qual é o plano?  ' });
    await until(() => session.sendRealtimeInput.mock.calls.some((c) => c[0].text));
    expect(session.sendRealtimeInput.mock.calls.find((c) => c[0].text)![0]).toEqual({ text: 'Qual é o plano?' });
    gemini(session, { serverContent: { outputTranscription: { text: 'Um passo de cada vez.' } } });
    gemini(session, { serverContent: { turnComplete: true } });
    const done = await client.waitFor('turn_complete');
    expect(done.userMessage?.content).toBe('Qual é o plano?');
  });

  it('troca de modelo quando o preferido não existe e ignora modelos que não conversam', async () => {
    h.failures.set('gemini-test-live', { code: 1008, reason: 'models/gemini-test-live is not found for API version v1beta, or is not supported for bidiGenerateContent' });
    const { ready } = await startSession();
    expect(ready.model).toBe('gemini-test-live-b');
    const tried = h.connect.mock.calls.map((c) => (c[0] as { model: string }).model);
    expect(tried).toEqual(['gemini-test-live', 'gemini-test-live-b']);
  });

  it('retoma a sessão com o handle após goAway, sem perder o canal', async () => {
    const { client, session } = await startSession();
    gemini(session, { sessionResumptionUpdate: { newHandle: 'handle-123', resumable: true } });
    gemini(session, { goAway: { timeLeft: '5s' } });
    await until(() => h.sessions.length === 2);
    const resumed = h.sessions[1];
    expect(resumed.model).toBe(session.model);
    expect(resumed.config.sessionResumption).toEqual({ handle: 'handle-123' });
    await until(() => session.close.mock.calls.length > 0);

    client.ws.send(Buffer.alloc(320, 3));
    await until(() => resumed.sendRealtimeInput.mock.calls.length > 0);
    expect(client.messages.some((m) => m.type === 'error' || m.type === 'closed')).toBe(false);
  });

  it('reconecta de forma transparente quando o Gemini cai', async () => {
    const { client, session } = await startSession();
    gemini(session, { sessionResumptionUpdate: { newHandle: 'h-2', resumable: true } });
    session.closed = true;
    session.callbacks.onclose?.({ code: 1011, reason: 'Internal error encountered.' });
    await until(() => h.sessions.length === 2);
    expect(h.sessions[1].config.sessionResumption).toEqual({ handle: 'h-2' });
    expect(client.messages.some((m) => m.type === 'error')).toBe(false);
  });

  it('avisa quando não há chave do Gemini', async () => {
    h.hasKey = false;
    const client = await connect();
    client.send({ type: 'start' });
    const error = await client.waitFor('error');
    expect(error.code).toBe('no_api_key');
    expect(error.message).toMatch(/Google AI Studio/);
    expect(h.connect).not.toHaveBeenCalled();
  });

  it('em modo demonstração responde a texto e explica que o áudio exige a chave', async () => {
    config.mock = true;
    const conv = createConversation('Demonstração');
    const client = await connect();
    client.send({ type: 'start', conversationId: conv.id });
    const ready = await client.waitFor('ready');
    expect(ready.model).toBe('mock');

    client.send({ type: 'text', text: 'Olá, tudo bem?' });
    const done = await client.waitFor('turn_complete');
    expect(done.userMessage?.content).toBe('Olá, tudo bem?');
    expect(done.assistantMessage?.content).toBe(buildMockVoiceReply('Olá, tudo bem?'));
    expect(client.messages.some((m) => m.type === 'assistant_transcript' && m.final)).toBe(true);
    expect(client.audio).toHaveLength(0);

    client.ws.send(Buffer.alloc(320));
    const error = await client.waitFor('error');
    expect(error.code).toBe('provider');
    expect(h.connect).not.toHaveBeenCalled();
  });
});

describe('segurança do WebSocket de voz', () => {
  it('recusa origens de outros sites', async () => {
    await expect(connect({ Origin: 'https://site-malicioso.example' })).rejects.toThrow('HTTP 403');
    const ok = await connect({ Origin: 'http://localhost:5173' });
    expect(ok.ws.readyState).toBe(WebSocket.OPEN);
  });

  it('aplica o verificador de autenticação configurado', async () => {
    setVoiceAuthChecker(() => false);
    await expect(connect()).rejects.toThrow('HTTP 401');
    setVoiceAuthChecker(async () => true);
    const ok = await connect();
    expect(ok.ws.readyState).toBe(WebSocket.OPEN);
  });

  it('valida Host e Origin contra DNS rebinding', () => {
    const req = (headers: Record<string, string>) => ({ headers }) as unknown as http.IncomingMessage;
    expect(isAllowedVoiceRequest(req({ host: '127.0.0.1:8787' }))).toBe(true);
    expect(isAllowedVoiceRequest(req({ host: '192.168.0.10:8787', origin: 'http://192.168.0.10:8787' }))).toBe(true);
    expect(isAllowedVoiceRequest(req({ host: 'localhost:8787', origin: 'http://192.168.0.10:5173' }))).toBe(true);
    expect(isAllowedVoiceRequest(req({ host: 'evil.example:8787', origin: 'http://evil.example:8787' }))).toBe(false);
    expect(isAllowedVoiceRequest(req({ host: 'localhost:8787', origin: 'null' }))).toBe(false);
    expect(isAllowedVoiceRequest(req({ host: '[::1]:8787', origin: 'http://[::1]:8787' }))).toBe(true);
  });
});

describe('liveCloseError', () => {
  it('traduz motivos de fechamento em status equivalentes', () => {
    expect(liveCloseError(1011, 'You exceeded your current quota').status).toBe(429);
    expect(liveCloseError(1008, 'models/x is not found for API version v1beta').status).toBe(404);
    expect(liveCloseError(1008, 'API key not valid. Please pass a valid API key.').status).toBe(403);
    expect(liveCloseError(1007, 'Invalid JSON payload received. Unknown name "foo"').status).toBe(400);
    expect(liveCloseError(1011, 'The service is currently unavailable.').status).toBe(503);
    expect(liveCloseError(1006, '', 'Unexpected server response: 404').status).toBe(404);
    expect(liveCloseError(1006, '').status).toBeUndefined();
  });
});
