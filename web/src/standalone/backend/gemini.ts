/**
 * Gemini direto do navegador (REST v1beta) com a chave que o usuário salvou neste aparelho.
 * - Chat: streamGenerateContent?alt=sse com thinking, function calling em laço e fallback de modelo.
 * - TTS: generateContent com responseModalities AUDIO (WAV pronto ou PCM L16 embrulhado em WAV).
 * Se a rede/CSP bloquear o domínio do Google (TypeError no fetch), o Gemini fica indisponível nesta página.
 */
import type { ChatMessage, ToolCallInfo } from '@shared/types';
import { EngineError, type TurnInput, type TurnOutput } from './engine-types';
import { nativeFetch } from './net';
import { buildSystemInstruction } from './persona';
import { createSSEReader } from './sse';
import { LOCAL_TOOLS, runTool } from './tools';
import { isAbort, isRecord, truncate } from './util';

const BASE = 'https://generativelanguage.googleapis.com/v1beta/models/';

export const CHAT_MODELS = ['gemini-3.8-flash', 'gemini-3.5-flash', 'gemini-3.5-flash-lite'];
export const TTS_MODELS = ['gemini-3.8-flash-tts', 'gemini-3.1-flash-tts-preview'];
const MAX_ITERATIONS = 6;

/** Domínio do Google bloqueado nesta página (rede ou política de segurança). */
export class GeminiUnreachable extends Error {
  constructor() {
    super('Gemini inacessível a partir desta página.');
    this.name = 'GeminiUnreachable';
  }
}

let unreachable = false;
export const isGeminiUnreachable = () => unreachable;
export function resetGeminiReachability(): void {
  unreachable = false;
}

interface GeminiPart {
  text?: string;
  thought?: boolean;
  thoughtSignature?: string;
  functionCall?: { name: string; args?: Record<string, unknown>; id?: string };
  functionResponse?: { name: string; response: Record<string, unknown>; id?: string };
  inlineData?: { mimeType: string; data: string };
}

interface GeminiContent {
  role: 'user' | 'model';
  parts: GeminiPart[];
}

class GeminiHttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function post(model: string, method: 'streamGenerateContent' | 'generateContent', key: string, body: unknown, signal: AbortSignal): Promise<Response> {
  const url = `${BASE}${encodeURIComponent(model)}:${method}${method === 'streamGenerateContent' ? '?alt=sse' : ''}`;
  let res: Response;
  try {
    res = await nativeFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify(body),
      signal,
    });
  } catch (e) {
    if (isAbort(e) || signal.aborted) throw e;
    if (e instanceof TypeError) {
      unreachable = true;
      throw new GeminiUnreachable();
    }
    throw e;
  }
  if (!res.ok) {
    let message = `HTTP ${res.status}`;
    try {
      const j = (await res.json()) as { error?: { message?: string } };
      if (j.error?.message) message = j.error.message;
    } catch {
      /* corpo ilegível */
    }
    throw new GeminiHttpError(res.status, message);
  }
  return res;
}

const isKeyProblem = (e: GeminiHttpError) =>
  e.status === 401 || e.status === 403 || (e.status === 400 && /api key|api_key|permission|unauthorized/i.test(e.message));
const isRetryableStatus = (s: number) => s === 429 || s === 404 || s === 500 || s === 502 || s === 503 || s === 504;

function keyError(): EngineError {
  return new EngineError(
    'provider',
    'O Google recusou a chave salva (inválida, revogada ou sem permissão). Confira em Configurações → Inteligência e cole uma chave nova do Google AI Studio.',
  );
}

function toHistory(messages: ChatMessage[]): GeminiContent[] {
  const out: GeminiContent[] = [];
  for (const m of messages.slice(-30)) {
    if (m.role === 'system' || !m.content.trim()) continue;
    out.push({ role: m.role === 'user' ? 'user' : 'model', parts: [{ text: truncate(m.content, 6000) }] });
  }
  return out;
}

/** Ordem de modelos de chat: o escolhido nas configurações (se houver) e a cadeia de reserva. */
export function chatModelOrder(preferred: string): string[] {
  const p = preferred.trim().replace(/^models\//, '');
  return p && !CHAT_MODELS.includes(p) ? [p, ...CHAT_MODELS] : p ? [p, ...CHAT_MODELS.filter((m) => m !== p)] : [...CHAT_MODELS];
}

/** Acrescenta partes transmitidas preservando thoughtSignature e unindo pedaços de texto. */
function appendPart(parts: GeminiPart[], part: GeminiPart): void {
  if (part.functionCall || part.functionResponse || part.inlineData) {
    parts.push({ ...part });
    return;
  }
  if (typeof part.text !== 'string') {
    if (part.thoughtSignature) parts.push({ ...part });
    return;
  }
  const last = parts[parts.length - 1];
  const canMerge =
    last && typeof last.text === 'string' && !last.functionCall && !last.thoughtSignature && !part.thoughtSignature && Boolean(last.thought) === Boolean(part.thought);
  if (canMerge) last.text += part.text;
  else parts.push({ ...part });
}

export async function runGeminiTurn(input: TurnInput & { key: string }): Promise<TurnOutput> {
  const { settings, signal } = input;
  const system = buildSystemInstruction(settings, { conversationId: input.conversationId, query: input.userText, toolsAvailable: true });
  const contents: GeminiContent[] = [...toHistory(input.history), { role: 'user', parts: [{ text: input.userText }] }];
  const declarations = LOCAL_TOOLS.map((t) => ({ name: t.name, description: t.description, parametersJsonSchema: t.parameters }));
  const models = chatModelOrder(settings.models.chat);
  let modelIndex = 0;
  let thinking = true;
  let content = '';
  let thoughts = '';
  const toolCalls: ToolCallInfo[] = [];
  let usedModel = models[0];

  for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
    const last = iter === MAX_ITERATIONS - 1;
    let parts: GeminiPart[] = [];

    // Tenta os modelos em ordem enquanto nada desta rodada tiver sido transmitido.
    for (;;) {
      const model = models[modelIndex];
      const body = {
        systemInstruction: { parts: [{ text: system }] },
        contents,
        tools: [{ functionDeclarations: declarations }],
        ...(last ? { toolConfig: { functionCallingConfig: { mode: 'NONE' } } } : {}),
        generationConfig: { temperature: 0.9, ...(thinking ? { thinkingConfig: { includeThoughts: true } } : {}) },
      };
      let streamed = false;
      parts = [];
      try {
        const res = await post(model, 'streamGenerateContent', input.key, body, signal);
        usedModel = model;
        const reader = createSSEReader(res);
        for await (const msg of reader) {
          let data: unknown;
          try {
            data = JSON.parse(msg.data);
          } catch {
            continue;
          }
          if (!isRecord(data)) continue;
          const err = data.error;
          if (isRecord(err)) throw new GeminiHttpError(Number(err.code) || 500, String(err.message ?? 'Erro do Gemini'));
          const cand = Array.isArray(data.candidates) ? (data.candidates[0] as Record<string, unknown> | undefined) : undefined;
          const cParts = isRecord(cand?.content) && Array.isArray(cand.content.parts) ? (cand.content.parts as GeminiPart[]) : [];
          for (const p of cParts) {
            appendPart(parts, p);
            if (typeof p.text === 'string' && p.text) {
              streamed = true;
              if (p.thought) {
                thoughts += p.text;
                input.onThought(p.text);
              } else {
                content += p.text;
                input.onToken(p.text);
              }
            }
            if (p.functionCall) streamed = true;
          }
        }
        break;
      } catch (e) {
        if (isAbort(e) || signal.aborted) throw e;
        if (e instanceof GeminiUnreachable) throw e;
        if (!(e instanceof GeminiHttpError)) {
          throw new EngineError('provider', 'A conexão com o Gemini caiu no meio da resposta. Tente novamente.', { canFallback: !content && !streamed, partial: content });
        }
        if (isKeyProblem(e)) throw keyError();
        if (streamed) throw new EngineError('provider', 'O Gemini interrompeu a resposta no meio. Tente novamente.', { partial: content });
        if (e.status === 400 && thinking && /think/i.test(e.message)) {
          thinking = false;
          continue;
        }
        if (isRetryableStatus(e.status) && modelIndex < models.length - 1) {
          modelIndex++;
          continue;
        }
        if (e.status === 429) {
          throw new EngineError('quota', 'A cota gratuita do Gemini se esgotou por agora.', { canFallback: !content, partial: content });
        }
        throw new EngineError('provider', `O Gemini recusou o pedido: ${truncate(e.message, 160)}`, { canFallback: !content, partial: content });
      }
    }

    contents.push({ role: 'model', parts: parts.length ? parts : [{ text: '' }] });
    const calls = parts.filter((p) => p.functionCall);
    if (calls.length === 0) break;

    const responses: GeminiPart[] = [];
    for (const p of calls) {
      const fc = p.functionCall!;
      const result = await runTool(fc.name, isRecord(fc.args) ? fc.args : {}, {
        conversationId: input.conversationId,
        emit: (call) => {
          const i = toolCalls.findIndex((c) => c.id === call.id);
          if (i >= 0) toolCalls[i] = call;
          else toolCalls.push(call);
          input.onTool(call);
        },
      });
      responses.push({ functionResponse: { name: fc.name, response: result.output, ...(fc.id ? { id: fc.id } : {}) } });
    }
    contents.push({ role: 'user', parts: responses });
    // Separa visualmente o texto de rodadas diferentes.
    if (content && !content.endsWith('\n')) {
      content += '\n\n';
      input.onToken('\n\n');
    }
  }

  return { content: content.trim(), thoughts: thoughts.trim(), toolCalls, model: usedModel };
}

// ─── TTS ─────────────────────────────────────────────────────────────────

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Cabeçalho WAV (PCM16 little-endian) para áudio cru. */
export function pcmToWav(pcm: Uint8Array, sampleRate = 24000, channels = 1): Blob {
  const header = new ArrayBuffer(44);
  const v = new DataView(header);
  const write = (o: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i));
  };
  const byteRate = sampleRate * channels * 2;
  write(0, 'RIFF');
  v.setUint32(4, 36 + pcm.byteLength, true);
  write(8, 'WAVE');
  write(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, channels, true);
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, byteRate, true);
  v.setUint16(32, channels * 2, true);
  v.setUint16(34, 16, true);
  write(36, 'data');
  v.setUint32(40, pcm.byteLength, true);
  return new Blob([header, pcm.slice().buffer], { type: 'audio/wav' });
}

function audioToBlob(mimeType: string, bytes: Uint8Array): Blob {
  const mime = mimeType.toLowerCase();
  const isRiff = bytes.length > 12 && String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]) === 'RIFF';
  if (mime.includes('wav') || isRiff) return new Blob([bytes.slice().buffer], { type: 'audio/wav' });
  // PCM cru (ex.: "audio/l16; rate=24000; channels=1" ou "audio/L16;codec=pcm;rate=24000").
  const rate = Number(/rate=(\d+)/i.exec(mime)?.[1]) || 24000;
  const channels = Number(/channels=(\d+)/i.exec(mime)?.[1]) || 1;
  return pcmToWav(bytes, rate, channels);
}

/** Síntese de voz pelo Gemini; null quando indisponível (o cliente usa a voz do navegador). */
export async function geminiTts(opts: { key: string; text: string; voiceName: string; style: string; preferredModel: string; signal: AbortSignal }): Promise<Blob | null> {
  const pref = opts.preferredModel.trim().replace(/^models\//, '');
  const models = pref && /tts/i.test(pref) ? [pref, ...TTS_MODELS.filter((m) => m !== pref)] : TTS_MODELS;
  const style = opts.style.trim() || 'Voz grave, calorosa e confiante, ritmo de palestrante, pausas de efeito';
  // A direção vai como "audio tag" entre colchetes: instruções em prosa acabam lidas em voz alta.
  const prompt = `[${style.replace(/[[\]]/g, '').replace(/\s+/g, ' ').slice(0, 160)}] ${opts.text}`;
  for (const model of models) {
    try {
      const res = await post(
        model,
        'generateContent',
        opts.key,
        {
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: {
            responseModalities: ['AUDIO'],
            speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: opts.voiceName || 'Charon' } } },
          },
        },
        opts.signal,
      );
      const data = (await res.json()) as { candidates?: { content?: { parts?: GeminiPart[] } }[] };
      const part = data.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data);
      if (!part?.inlineData) continue;
      return audioToBlob(part.inlineData.mimeType ?? '', base64ToBytes(part.inlineData.data));
    } catch (e) {
      if (isAbort(e) || opts.signal.aborted) throw e;
      if (e instanceof GeminiUnreachable) return null;
      if (e instanceof GeminiHttpError && isKeyProblem(e)) return null;
      // 429/503/404…: tenta o próximo modelo.
    }
  }
  return null;
}
