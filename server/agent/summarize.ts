/**
 * Resumo acumulado das conversas longas.
 *
 * O histórico enviado ao modelo tem só as últimas `HISTORY_WINDOW` mensagens. Quando a conversa
 * passa de ~50 mensagens, as mais antigas (fora da janela) são condensadas em `conversation.summary`
 * — um resumo acumulado, em PT-BR, focado em fatos, decisões e pendências — que entra no contexto.
 * O ponto até onde já foi resumido fica no KV interno (`conversation_summary_state:<id>`).
 */
import { generateText } from '../llm/gemini.js';
import { getConversation, updateConversation } from '../memory/conversations.js';
import { countMessages, listMessages } from '../memory/messages.js';
import { getSettings, readSettingValue, writeSettingValue } from '../memory/settings.js';
import { safeTimeZone } from '../memory/time.js';
import { truncateText } from '../memory/text.js';
import { nowIso } from '../lib/ids.js';
import { shortDateTime } from '../tools/utility.js';
import { HISTORY_WINDOW } from './context.js';
import type { ChatMessage } from '../../shared/types.js';

/** A partir de quantas mensagens a conversa passa a ter resumo. */
export const SUMMARY_TRIGGER_MESSAGES = 50;
/** Mínimo de mensagens novas fora da janela para refazer o resumo (evita chamadas a cada turno). */
export const SUMMARY_BATCH_MIN = 10;
/** Máximo de mensagens lidas de uma vez (conversas importadas gigantes são resumidas pelo trecho mais recente). */
const MAX_MESSAGES_PER_RUN = 1000;
const MAX_MESSAGE_CHARS = 1_200;
const MAX_TRANSCRIPT_CHARS = 60_000;
const MAX_SUMMARY_CHARS = 8_000;

interface SummaryState {
  /** Quantas mensagens (a partir da primeira) já estão cobertas pelo resumo. */
  covered: number;
  updatedAt?: string;
}

const stateKey = (conversationId: string) => `conversation_summary_state:${conversationId}`;

function readState(conversationId: string): SummaryState {
  const raw = readSettingValue<SummaryState>(stateKey(conversationId));
  const covered = Number(raw?.covered);
  return { covered: Number.isFinite(covered) && covered > 0 ? Math.floor(covered) : 0 };
}

const SYSTEM_PROMPT = `Você mantém o resumo acumulado de uma conversa longa entre um usuário e o Lärk, o assistente pessoal dele. Esse resumo substitui as mensagens antigas no contexto do Lärk, então precisa preservar tudo o que importa para continuar a conversa com naturalidade.

Atualize o RESUMO ATUAL integrando as NOVAS MENSAGENS:
- Foque em fatos, decisões, combinados, pedidos feitos, resultados de ações no computador, pendências e promessas, preferências reveladas e o contexto emocional relevante.
- Preserve nomes, números, datas (absolutas), caminhos de arquivos e termos técnicos exatos.
- Elimine cumprimentos, repetições e detalhes que não mudam nada.
- Escreva em português do Brasil, em texto corrido conciso ou tópicos curtos agrupados (ex.: "Contexto", "Decisões", "Pendências"), com no máximo ~600 palavras.
- Não invente nada. Responda apenas com o novo resumo completo, sem introdução.`;

function formatTranscript(messages: ChatMessage[], tz: string): string {
  const lines = messages
    .filter((m) => m.content.trim())
    .map((m) => {
      const who = m.role === 'user' ? 'Usuário' : m.role === 'assistant' ? 'Lärk' : 'Sistema';
      return `[${shortDateTime(m.createdAt, tz)}] ${who}: ${truncateText(m.content.replace(/\s+/g, ' '), MAX_MESSAGE_CHARS)}`;
    });
  let text = lines.join('\n');
  // Excesso: mantém o trecho mais recente (o resumo atual já cobre o começo).
  if (text.length > MAX_TRANSCRIPT_CHARS) text = `…${text.slice(text.length - MAX_TRANSCRIPT_CHARS)}`;
  return text;
}

/**
 * Atualiza o resumo da conversa quando há mensagens suficientes fora da janela do histórico.
 * @returns true se o resumo foi atualizado.
 */
export async function maybeSummarize(conversationId: string): Promise<boolean> {
  const total = countMessages(conversationId);
  if (total < SUMMARY_TRIGGER_MESSAGES) return false;
  const outside = total - HISTORY_WINDOW;
  const covered = Math.min(readState(conversationId).covered, outside);
  if (outside - covered < SUMMARY_BATCH_MIN) return false;

  const conversation = getConversation(conversationId);
  if (!conversation) return false;

  const span = Math.min(total - covered, MAX_MESSAGES_PER_RUN);
  const recent = listMessages(conversationId, { limit: span });
  const batch = recent.slice(0, Math.max(0, recent.length - HISTORY_WINDOW));
  if (batch.length === 0) return false;

  const tz = safeTimeZone(getSettings().timezone);
  const previous = conversation.summary?.trim();
  const prompt = [
    `RESUMO ATUAL:\n${previous || '(vazio — esta é a primeira vez)'}`,
    `NOVAS MENSAGENS (as mais antigas da conversa, que vão sair do histórico):\n${formatTranscript(batch, tz)}`,
  ].join('\n\n');

  const text = await generateText({
    role: 'fast',
    system: SYSTEM_PROMPT,
    prompt,
    temperature: 0.3,
    maxOutputTokens: 2048,
    timeoutMs: 60_000,
  });
  const summary = text.trim();
  if (!summary) return false;

  updateConversation(conversationId, { summary: truncateText(summary, MAX_SUMMARY_CHARS) });
  writeSettingValue(stateKey(conversationId), { covered: outside, updatedAt: nowIso() } satisfies SummaryState);
  return true;
}
