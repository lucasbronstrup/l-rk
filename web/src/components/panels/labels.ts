import type { CommitmentStatus, MemoryCategory, Recurrence, ReminderStatus, Settings } from '@shared/types';

/** Rótulos PT-BR dos valores de domínio exibidos nos painéis. */

export const MEMORY_CATEGORIES: MemoryCategory[] = [
  'fact',
  'preference',
  'person',
  'goal',
  'event',
  'skill',
  'health',
  'work',
  'project',
  'other',
];

export const CATEGORY_LABEL: Record<MemoryCategory, string> = {
  fact: 'Fato',
  preference: 'Preferência',
  person: 'Pessoa',
  goal: 'Objetivo',
  event: 'Evento',
  skill: 'Habilidade',
  health: 'Saúde',
  work: 'Trabalho',
  project: 'Projeto',
  other: 'Outro',
};

export const SOURCE_LABEL = {
  auto: 'Aprendida',
  tool: 'Registrada',
  manual: 'Manual',
} as const;

export const RECURRENCE_LABEL: Record<Recurrence, string> = {
  none: 'Uma vez',
  daily: 'Diário',
  weekdays: 'Dias úteis',
  weekly: 'Semanal',
  monthly: 'Mensal',
};

export const RECURRENCES: Recurrence[] = ['none', 'daily', 'weekdays', 'weekly', 'monthly'];

export const COMMITMENT_STATUS_LABEL: Record<CommitmentStatus, string> = {
  pending: 'Pendente',
  done: 'Cumprida',
  missed: 'Não cumprida',
  cancelled: 'Cancelada',
};

export const REMINDER_STATUS_LABEL: Record<ReminderStatus, string> = {
  scheduled: 'Agendado',
  fired: 'Disparado',
  dismissed: 'Dispensado',
  cancelled: 'Cancelado',
};

export const APPROVAL_MODES: { value: Settings['computer']['approvalMode']; title: string; description: string }[] = [
  {
    value: 'ask',
    title: 'Perguntar antes de ações que modificam',
    description:
      'O Lärk lê e pesquisa livremente, mas pede sua autorização antes de criar, mover, apagar arquivos ou executar comandos. O equilíbrio recomendado.',
  },
  {
    value: 'dangerous-only',
    title: 'Perguntar só antes de ações perigosas',
    description:
      'Edições comuns acontecem sem interrupção; você só é consultado para o que é irreversível ou sensível, como apagar arquivos ou rodar comandos no terminal.',
  },
  {
    value: 'never',
    title: 'Nunca perguntar (controle total)',
    description:
      'O Lärk age como a própria consciência do computador, sem pedir licença. Máxima fluidez — e máxima responsabilidade. Use apenas se confia plenamente no que pede.',
  },
];
