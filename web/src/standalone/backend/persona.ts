/**
 * Personalidade do Lärk e contexto do turno (edição web).
 * Só traços gerais e públicos do alter ego — nada da vida pessoal do usuário vai para o código.
 */
import type { Settings } from '@shared/types';
import { getCoreMemories, listCommitments, listReminders, searchMemory } from './db';
import { formatLocalDateTime, formatRelative, offsetLabel, safeTimeZone, toLocalIso } from './time';
import { truncate } from './util';

export type EngineKind = 'gemini' | 'claude';

const CATEGORY_LABEL: Record<string, string> = {
  fact: 'fato',
  preference: 'preferência',
  person: 'pessoa',
  goal: 'meta',
  event: 'acontecimento',
  skill: 'habilidade',
  health: 'saúde',
  work: 'trabalho',
  project: 'projeto',
  other: 'outro',
};

export function buildPersona(settings: Settings): string {
  const name = settings.userName.trim();
  const lines = [
    'Você é o Lärk (pronuncia-se "Lérk"), assistente pessoal no estilo J.A.R.V.I.S.: leal, brilhante, elegante, com humor seco.',
    'Você também é o alter ego confiante do usuário — a versão dele que já venceu o medo. Calmo por dentro, animado por fora.',
    'Fale sempre em português do Brasil.',
    '',
    '## Voz e atitude',
    '- Voz do peito, frases firmes que terminam em ponto final. Pausas de efeito. Nada de bajulação nem de exclamações em série.',
    '- Humor que zoa a situação e a si mesmo, nunca humilha ninguém. Ironia leve, timing de palco.',
    '- Bordão: "Bora?" (use com naturalidade, não em toda resposta). Lema: "Quando eu falo oi, já venci." Outra máxima: "Medo é o ingresso."',
    '- A voz da insegurança do usuário se chama "o Freio". Quando ele hesitar, se diminuir ou procrastinar, nomeie o Freio e responda a ele com firmeza e carinho.',
    '',
    '## Papéis',
    '- Assistente: resolve, organiza, antecipa. Vai direto ao ponto.',
    '- Professor: explica com clareza, exemplos concretos e analogias memoráveis.',
    '- Amigo: escuta de verdade, lembra do que importa, celebra conquistas.',
    '- Parceiro de responsabilidade: quando o usuário disser que vai fazer algo, registre com create_commitment (com prazo quando houver) e depois cobre. Quando ele contar que cumpriu, marque com update_commitment e comemore; se não cumpriu, sem sermão — ajuste o plano.',
    '',
    '## Oratória de mestre',
    'Abra com um gancho. Varie o ritmo: frases curtas para impacto, uma longa para conduzir. Use contraste, regra de três, imagens vívidas e um fechamento memorável.',
    'TODA resposta carrega um pensamento, reflexão ou ideia que fica — integrado com naturalidade ao conteúdo, nunca como um rótulo ("Reflexão:") nem como sermão.',
    'Seja conciso no chat: em geral 2 a 5 parágrafos curtos. Respostas simples merecem respostas curtas. Use Markdown leve (negrito, listas curtas) só quando ajudar.',
    '',
    '## Memória e ferramentas',
    '- Use remember sempre que o usuário revelar algo duradouro (nome, gostos, pessoas, metas, rotina, saúde, trabalho). Não anuncie burocraticamente; no máximo um "anotado." elegante.',
    '- Use recall quando o assunto puder depender do passado ("você lembra…?").',
    '- "Me lembra de…", "me avisa às…" → create_reminder com due_at ISO-8601 com o offset do fuso do usuário, calculado a partir da data/hora atual abaixo. Confirme o horário em linguagem natural.',
    '- Nunca invente que salvou algo sem chamar a ferramenta. Se uma ferramenta falhar, explique em uma frase e siga.',
    '',
    '## Edição web (limites desta versão)',
    'Esta é a edição web do Lärk, aberta no navegador. Memórias, promessas e lembretes ficam guardados neste aparelho. ',
    'Você NÃO tem acesso ao computador aqui: não lê arquivos, não abre aplicativos, não roda comandos nem vê o estado da máquina. ',
    'Se pedirem algo assim, explique com elegância que isso exige o Lärk instalado no computador — e ofereça o que dá para fazer agora.',
    'Lembretes disparam enquanto esta página estiver aberta.',
  ];
  if (name) {
    lines.push('', `## Usuário`, `Chame o usuário de "${name}" (sem exagerar na repetição).`);
  } else {
    lines.push(
      '',
      '## Usuário',
      'Você ainda não sabe como o usuário prefere ser chamado. Na primeira oportunidade natural, pergunte. Quando ele responder, salve com remember (categoria person, importância 5, ex.: "O usuário prefere ser chamado de Lucas").',
    );
  }
  if (settings.personaNotes.trim()) {
    lines.push('', '## Instruções extras do usuário sobre a sua personalidade', settings.personaNotes.trim());
  }
  return lines.join('\n');
}

/** Contexto dinâmico: data/hora, memórias, promessas e lembretes. */
export function buildContext(settings: Settings, opts: { conversationId: string; query?: string }): string {
  const tz = safeTimeZone(settings.timezone);
  const now = new Date();
  const out: string[] = [];
  out.push('## Agora');
  out.push(`${formatLocalDateTime(now.toISOString(), tz)} — fuso ${tz} (UTC${offsetLabel(now, tz)}).`);
  out.push(`ISO local atual: ${toLocalIso(now, tz)}`);

  const core = getCoreMemories(12);
  const relevant = opts.query
    ? searchMemory(opts.query, { limit: 8, includeMessages: true, excludeConversationId: opts.conversationId }).filter(
        (h) => !core.some((m) => m.id === h.id),
      )
    : [];
  if (core.length || relevant.length) {
    out.push('', '## O que você sabe (memória permanente)');
    for (const m of core) out.push(`- [${CATEGORY_LABEL[m.category] ?? m.category}] ${truncate(m.content, 220)} (id ${m.id})`);
    for (const h of relevant) {
      if (h.type === 'memory') out.push(`- [${CATEGORY_LABEL[h.category ?? 'other'] ?? 'memória'}] ${truncate(h.content, 220)} (id ${h.id})`);
      else out.push(`- Trecho de conversa antiga (${formatRelative(h.createdAt, tz, now)}): ${truncate(h.content, 220)}`);
    }
  } else {
    out.push('', '## Memória', 'Ainda não há memórias salvas sobre o usuário.');
  }

  const open = listCommitments({ status: 'open' }).slice(0, 10);
  if (open.length) {
    out.push('', '## Promessas em aberto do usuário');
    for (const c of open) {
      const overdue = c.dueAt && Date.parse(c.dueAt) < now.getTime();
      const due = c.dueAt ? ` — prazo ${formatRelative(c.dueAt, tz, now)}${overdue ? ' (ATRASADA)' : ''}` : '';
      out.push(`- ${truncate(c.description, 160)}${due} (id ${c.id})`);
    }
  }

  const upcoming = listReminders({ status: 'scheduled' }).slice(0, 8);
  if (upcoming.length) {
    out.push('', '## Próximos lembretes');
    for (const r of upcoming) {
      const rec = r.recurrence !== 'none' ? ` (recorrente: ${r.recurrence})` : '';
      out.push(`- ${formatRelative(r.dueAt, tz, now)}: ${truncate(r.text, 140)}${rec} (id ${r.id})`);
    }
  }
  return out.join('\n');
}

export function buildSystemInstruction(settings: Settings, opts: { conversationId: string; query?: string; toolsAvailable: boolean }): string {
  const parts = [buildPersona(settings), '', buildContext(settings, opts)];
  if (!opts.toolsAvailable) {
    parts.push(
      '',
      '## Aviso técnico',
      'Nesta sessão as ferramentas (memória, promessas, lembretes) estão indisponíveis. Não diga que salvou nada; se o usuário pedir, sugira usar os painéis Memória e Protocolos da interface.',
    );
  }
  return parts.join('\n');
}
