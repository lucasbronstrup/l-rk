/**
 * Roteador da API /api/* simulada no navegador (mesma tabela de docs/ARCHITECTURE.md).
 */
import type { HealthInfo, ModelInfo } from '@shared/types';
import { activeModels, engineState, geminiKey, resolveEngine } from './brain';
import { bus } from './bus';
import { briefingRoute, chatRoute, stopChat } from './chat';
import {
  createCommitment,
  createConversation,
  createMemory,
  createReminder,
  deleteCommitment,
  deleteConversation,
  deleteMemory,
  deleteReminder,
  exportAll,
  getMemoryStats,
  getOrCreateActiveConversation,
  getSettings,
  importAll,
  listCommitments,
  listConversations,
  listMemories,
  listMessages,
  listReminders,
  searchMemory,
  updateCommitment,
  updateConversation,
  updateMemory,
  updateReminder,
  updateSettings,
  getConversation,
} from './db';
import { GEMINI_VOICES, getDeviceVitals } from './device';
import { geminiTts } from './gemini';
import { LIVE_MODELS } from './live';
import { sseResponse } from './sse';
import { transcribeRoute } from './transcribe';
import { HttpError, badRequest, emptyResponse, errorResponse, isRecord, jsonResponse, notFound } from './util';

export const VERSION = '0.1.0-web';

export interface ApiRequest {
  method: string;
  /** Caminho sem o prefixo /api (ex.: "/memories/abc"). */
  path: string;
  query: URLSearchParams;
  bodyText: string | null;
  /** Corpo binário (ex.: áudio em POST /api/transcribe), quando a requisição não enviou texto. */
  bodyBlob?: Blob | null;
  contentType?: string | null;
  signal?: AbortSignal;
}

const MODELS: ModelInfo[] = [
  { id: 'gemini-3.8-flash', displayName: 'Gemini 3.8 Flash', roles: ['chat'] },
  { id: 'gemini-3.5-flash', displayName: 'Gemini 3.5 Flash', roles: ['chat', 'fast'] },
  { id: 'gemini-3.5-flash-lite', displayName: 'Gemini 3.5 Flash-Lite', roles: ['chat', 'fast'] },
  { id: 'gemini-3.8-flash-tts', displayName: 'Gemini 3.8 Flash TTS', roles: ['tts'] },
  { id: 'gemini-3.1-flash-tts-preview', displayName: 'Gemini 3.1 Flash TTS (prévia)', roles: ['tts'] },
  { id: LIVE_MODELS[0], displayName: 'Gemini 3.8 Live', roles: ['live'] },
  { id: LIVE_MODELS[1], displayName: 'Gemini 3.1 Flash Live (prévia)', roles: ['live'] },
  { id: LIVE_MODELS[2], displayName: 'Gemini 2.5 Flash Native Audio', roles: ['live'] },
];

function parseBody(text: string | null): Record<string, unknown> {
  if (!text || !text.trim()) return {};
  try {
    const v = JSON.parse(text) as unknown;
    if (isRecord(v)) return v;
    throw badRequest('O corpo da requisição precisa ser um objeto JSON.');
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw badRequest('JSON inválido no corpo da requisição.');
  }
}

const num = (v: string | null) => {
  if (v === null || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
};

async function health(): Promise<HealthInfo> {
  if (engineState() === 'pending') await resolveEngine(2500);
  const settings = getSettings();
  const state = engineState();
  return {
    ok: true,
    version: VERSION,
    mock: false,
    // Com o Claude do claude.ai o Lärk pensa mesmo sem chave do Gemini.
    hasApiKey: settings.hasApiKey || state === 'claude',
    activeModels: activeModels(),
    platform: 'web',
    hostname: 'Navegador',
    authRequired: false,
  };
}

function eventsResponse(signal: AbortSignal | undefined): Response {
  let unsubscribe: (() => void) | null = null;
  let ping: number | undefined;
  const stop = () => {
    unsubscribe?.();
    window.clearInterval(ping);
  };
  return sseResponse(
    signal,
    (w) => {
      w.send({ type: 'hello', serverTime: new Date().toISOString() } as { type: string });
      unsubscribe = bus.subscribe((e) => w.send(e));
      ping = window.setInterval(() => w.send({ type: 'ping', serverTime: new Date().toISOString() } as { type: string }), 20_000);
    },
    stop,
  );
}

export async function route(req: ApiRequest): Promise<Response> {
  try {
    return await dispatch(req);
  } catch (e) {
    return errorResponse(e);
  }
}

async function dispatch(req: ApiRequest): Promise<Response> {
  const method = req.method.toUpperCase();
  const segs = req.path.split('/').filter(Boolean).map((s) => decodeURIComponent(s));
  const [a, b, c] = segs;
  const q = req.query;
  const is = (m: string, n: number) => method === m && segs.length === n;

  switch (a) {
    case 'health':
      if (is('GET', 1)) return jsonResponse(await health());
      break;

    case 'auth':
      if (segs.length === 2 && (b === 'status' || b === 'login' || b === 'logout')) return jsonResponse({ required: false, authenticated: true });
      break;

    case 'conversations': {
      if (is('GET', 1)) return jsonResponse(listConversations(num(q.get('limit'))));
      if (is('POST', 1)) {
        const body = parseBody(req.bodyText);
        return jsonResponse(createConversation(typeof body.title === 'string' ? body.title : undefined));
      }
      if (b === 'active' && is('GET', 2)) return jsonResponse(getOrCreateActiveConversation());
      if (b && c === 'messages' && is('GET', 3)) {
        if (!getConversation(b)) throw notFound('Conversa não encontrada.');
        return jsonResponse(listMessages(b, { limit: num(q.get('limit')), before: q.get('before') ?? undefined }));
      }
      if (b && is('PATCH', 2)) {
        const body = parseBody(req.bodyText);
        const conv = updateConversation(b, {
          title: typeof body.title === 'string' ? body.title : undefined,
          summary: typeof body.summary === 'string' || body.summary === null ? (body.summary as string | null) : undefined,
        });
        if (!conv) throw notFound('Conversa não encontrada.');
        return jsonResponse(conv);
      }
      if (b && is('DELETE', 2)) {
        if (!deleteConversation(b)) throw notFound('Conversa não encontrada.');
        return jsonResponse({ ok: true });
      }
      break;
    }

    case 'chat':
      if (is('POST', 1)) return chatRoute(parseBody(req.bodyText), req.signal);
      if (b === 'stop' && is('POST', 2)) {
        const body = parseBody(req.bodyText);
        if (typeof body.conversationId === 'string') stopChat(body.conversationId);
        return jsonResponse({ ok: true });
      }
      break;

    case 'briefing':
      if (is('POST', 1)) return jsonResponse(briefingRoute(parseBody(req.bodyText)));
      break;

    case 'memories': {
      if (is('GET', 1)) {
        return jsonResponse(
          listMemories({ q: q.get('q') ?? undefined, category: q.get('category'), limit: num(q.get('limit')), offset: num(q.get('offset')) }),
        );
      }
      if (b === 'stats' && is('GET', 2)) return jsonResponse(getMemoryStats());
      if (b === 'search' && is('GET', 2)) return jsonResponse(searchMemory(q.get('q') ?? '', { limit: num(q.get('limit')) ?? 12, includeMessages: true }));
      if (is('POST', 1)) {
        const body = parseBody(req.bodyText);
        return jsonResponse(
          createMemory({ content: String(body.content ?? ''), category: body.category, importance: body.importance, pinned: body.pinned === true, source: 'manual' }),
        );
      }
      if (b && is('PATCH', 2)) {
        const body = parseBody(req.bodyText);
        const m = updateMemory(b, body as Parameters<typeof updateMemory>[1]);
        if (!m) throw notFound('Memória não encontrada.');
        return jsonResponse(m);
      }
      if (b && is('DELETE', 2)) {
        if (!deleteMemory(b)) throw notFound('Memória não encontrada.');
        return jsonResponse({ ok: true });
      }
      break;
    }

    case 'commitments': {
      if (is('GET', 1)) return jsonResponse(listCommitments({ status: q.get('status') }));
      if (is('POST', 1)) {
        const body = parseBody(req.bodyText);
        return jsonResponse(createCommitment({ description: body.description, dueAt: body.dueAt, notes: body.notes }));
      }
      if (b && is('PATCH', 2)) {
        const body = parseBody(req.bodyText);
        const { lastCheckedAt: _l, checkCount: _c, ...patch } = body;
        void _l;
        void _c;
        const cmt = updateCommitment(b, patch);
        if (!cmt) throw notFound('Promessa não encontrada.');
        return jsonResponse(cmt);
      }
      if (b && is('DELETE', 2)) {
        if (!deleteCommitment(b)) throw notFound('Promessa não encontrada.');
        return jsonResponse({ ok: true });
      }
      break;
    }

    case 'reminders': {
      if (is('GET', 1)) return jsonResponse(listReminders({ status: q.get('status'), from: q.get('from') ?? undefined, to: q.get('to') ?? undefined }));
      if (is('POST', 1)) {
        const body = parseBody(req.bodyText);
        return jsonResponse(createReminder({ text: body.text, dueAt: body.dueAt, recurrence: body.recurrence }));
      }
      if (b && is('PATCH', 2)) {
        const body = parseBody(req.bodyText);
        const patch: Record<string, unknown> = { ...body };
        // Reagendar (adiar) reabre o lembrete.
        if (patch.dueAt !== undefined && patch.status === 'scheduled') patch.firedAt = null;
        const r = updateReminder(b, patch);
        if (!r) throw notFound('Lembrete não encontrado.');
        return jsonResponse(r);
      }
      if (b && is('DELETE', 2)) {
        if (!deleteReminder(b)) throw notFound('Lembrete não encontrado.');
        return jsonResponse({ ok: true });
      }
      break;
    }

    case 'settings':
      if (is('GET', 1)) return jsonResponse(getSettings());
      if (is('PUT', 1) || is('PATCH', 1)) return jsonResponse(updateSettings(parseBody(req.bodyText)));
      break;

    case 'models':
      if (is('GET', 1)) return jsonResponse(MODELS);
      break;

    case 'approvals':
      if (is('GET', 1)) return jsonResponse([]);
      if (b && is('POST', 2)) throw notFound('Essa autorização não existe — a edição web não executa ações no computador.');
      break;

    case 'system':
      if (b === 'vitals' && is('GET', 2)) return jsonResponse(await getDeviceVitals());
      break;

    case 'tts':
      if (is('POST', 1)) {
        const body = parseBody(req.bodyText);
        const text = typeof body.text === 'string' ? body.text.trim() : '';
        if (!text) throw badRequest('Envie o texto a falar.');
        const key = geminiKey();
        if (!key) return emptyResponse(204);
        const settings = getSettings();
        const blob = await geminiTts({
          key,
          text: text.slice(0, 4000),
          voiceName: typeof body.voiceName === 'string' && body.voiceName ? body.voiceName : settings.voiceName,
          style: typeof body.style === 'string' && body.style ? body.style : settings.voiceStyle,
          preferredModel: settings.models.tts,
          signal: req.signal ?? new AbortController().signal,
        });
        if (!blob) return emptyResponse(204);
        return new Response(blob, { status: 200, headers: { 'Content-Type': 'audio/wav', 'Cache-Control': 'no-store' } });
      }
      break;

    case 'transcribe':
      if (is('POST', 1)) return jsonResponse(await transcribeRoute(req.bodyBlob ?? null, req.contentType ?? null, req.signal));
      break;

    case 'voices':
      if (is('GET', 1)) return jsonResponse(GEMINI_VOICES);
      break;

    case 'events':
      if (is('GET', 1)) return eventsResponse(req.signal);
      break;

    case 'export':
      if (is('GET', 1)) {
        const stamp = new Date().toISOString().slice(0, 10);
        return jsonResponse(exportAll(), 200, { 'Content-Disposition': `attachment; filename="lark-backup-${stamp}.json"` });
      }
      break;

    case 'import':
      if (is('POST', 1)) return jsonResponse(importAll(parseBody(req.bodyText)));
      break;
  }
  throw new HttpError(404, `Rota desconhecida na edição web: ${method} /api${req.path}`);
}
