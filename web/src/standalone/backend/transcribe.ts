/**
 * POST /api/transcribe — transcrição de reserva pelo Gemini (quando o reconhecimento de fala
 * do navegador não existe ou não alcança o serviço dele, como no Brave/Opera ou em redes restritas).
 * Recebe o áudio cru no corpo (wav/webm/ogg…) e devolve { text }.
 */
import { getApiKey } from './db';
import { isGeminiUnreachable } from './gemini';
import { isInsideClaudeAi, bytesToBase64, PAGES_URL } from './live';
import { nativeFetch } from './net';
import { HttpError, isAbort } from './util';

export const TRANSCRIBE_MODELS = ['gemini-3.5-flash-lite', 'gemini-3.5-flash'];
const PROMPT = 'Transcreva exatamente o que foi dito, em português do Brasil. Responda só com a transcrição.';
const MAX_BYTES = 12 * 1024 * 1024;
const BASE = 'https://generativelanguage.googleapis.com/v1beta/models/';

function audioMime(blob: Blob, header: string | null): string {
  const raw = (blob.type || header || '').split(';')[0].trim().toLowerCase();
  if (raw.startsWith('audio/')) return raw;
  if (raw === 'video/webm') return 'audio/webm';
  return 'audio/wav';
}

/** Limpa respostas do tipo "Transcrição: ..." ou entre aspas; silêncio vira texto vazio. */
function tidy(text: string): string {
  let t = text.replace(/\s+/g, ' ').trim();
  t = t.replace(/^(transcri[çc][ãa]o|texto)\s*:\s*/i, '');
  if (/^["“].*["”]$/.test(t)) t = t.slice(1, -1).trim();
  if (/^\(?\[?\s*(sil[êe]ncio|inaud[íi]vel|nenhuma fala|sem fala|no speech)[^)\]]*\]?\)?\.?$/i.test(t)) return '';
  return t;
}

export async function transcribeRoute(blob: Blob | null, contentType: string | null, signal?: AbortSignal): Promise<{ text: string }> {
  if (!blob || blob.size < 64) throw new HttpError(400, 'Envie o áudio a transcrever no corpo da requisição.');
  if (blob.size > MAX_BYTES) throw new HttpError(413, 'Áudio longo demais para transcrever de uma vez.');
  if (isInsideClaudeAi()) {
    throw new HttpError(
      503,
      `Dentro do claude.ai o Google é bloqueado, então não consigo transcrever sua voz aqui. Abra o Lärk em ${PAGES_URL} para falar comigo.`,
      'provider',
    );
  }
  const key = getApiKey();
  if (!key) {
    throw new HttpError(
      400,
      'Para eu entender sua voz neste navegador, cole sua chave gratuita do Google AI Studio em Configurações → Inteligência.',
      'no_api_key',
    );
  }
  if (isGeminiUnreachable()) {
    throw new HttpError(503, 'Esta página não alcança os servidores do Google (rede ou bloqueador). Confira a internet e desative bloqueadores para este site.', 'provider');
  }

  const data = bytesToBase64(new Uint8Array(await blob.arrayBuffer()));
  const body = {
    contents: [{ role: 'user', parts: [{ inlineData: { mimeType: audioMime(blob, contentType), data } }, { text: PROMPT }] }],
    generationConfig: { temperature: 0, maxOutputTokens: 1024 },
  };
  const ctl = new AbortController();
  const onAbort = () => ctl.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  let lastStatus = 0;
  let lastMessage = '';
  try {
    for (const model of TRANSCRIBE_MODELS) {
      {
        let res: Response;
        try {
          res = await nativeFetch(`${BASE}${model}:generateContent`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
            body: JSON.stringify(body),
            signal: ctl.signal,
          });
        } catch (e) {
          if (isAbort(e)) throw e;
          throw new HttpError(503, 'Não consegui falar com os servidores do Google para transcrever. Confira a internet.', 'provider');
        }
        if (res.ok) {
          const j = (await res.json()) as { candidates?: { content?: { parts?: { text?: string; thought?: boolean }[] } }[] };
          const text = (j.candidates?.[0]?.content?.parts ?? [])
            .filter((p) => typeof p.text === 'string' && !p.thought)
            .map((p) => p.text)
            .join('');
          return { text: tidy(text) };
        }
        lastStatus = res.status;
        try {
          lastMessage = ((await res.json()) as { error?: { message?: string } }).error?.message ?? '';
        } catch {
          lastMessage = '';
        }
        if (res.status === 401 || res.status === 403 || (res.status === 400 && /api key|api_key/i.test(lastMessage))) {
          throw new HttpError(
            400,
            'O Google recusou a chave salva. Cole uma chave nova do Google AI Studio em Configurações → Inteligência.',
            'no_api_key',
          );
        }
        // 429/404/5xx…: tenta o próximo modelo.
      }
    }
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }
  if (lastStatus === 429) throw new HttpError(429, 'A cota gratuita de transcrição do Gemini se esgotou por agora. Tente em alguns minutos ou digite.', 'quota');
  throw new HttpError(502, `O Gemini não conseguiu transcrever o áudio${lastMessage ? `: ${lastMessage.slice(0, 140)}` : ''}.`, 'provider');
}
