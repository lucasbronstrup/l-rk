import { describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  process.env.LARK_DB_PATH = ':memory:';
});

import { nextOccurrence, nextOccurrenceAfter } from './reminders.js';
import { InvalidDateError, formatLocalDateTime, parseUserDate } from './time.js';

const SP = 'America/Sao_Paulo'; // UTC−3, sem horário de verão
const NY = 'America/New_York'; // com horário de verão

describe('nextOccurrence', () => {
  it('none não se repete', () => {
    expect(nextOccurrence('2026-10-16T12:00:00.000Z', 'none', SP)).toBeNull();
  });

  it('daily mantém o horário local e vira o mês', () => {
    // 31/01 09:00 em São Paulo → 01/02 09:00
    expect(nextOccurrence('2026-01-31T12:00:00.000Z', 'daily', SP)).toBe('2026-02-01T12:00:00.000Z');
    // virada de ano
    expect(nextOccurrence('2026-12-31T12:00:00.000Z', 'daily', SP)).toBe('2027-01-01T12:00:00.000Z');
  });

  it('daily usa a data local, não a UTC (22:30 em SP já é o dia seguinte em UTC)', () => {
    // 16/10 22:30 em SP = 17/10 01:30Z → próxima: 17/10 22:30 em SP = 18/10 01:30Z
    expect(nextOccurrence('2026-10-17T01:30:00.000Z', 'daily', SP)).toBe('2026-10-18T01:30:00.000Z');
  });

  it('weekdays pula o fim de semana', () => {
    // sexta 16/10/2026 08:00 SP → segunda 19/10
    expect(nextOccurrence('2026-10-16T11:00:00.000Z', 'weekdays', SP)).toBe('2026-10-19T11:00:00.000Z');
    // sábado → segunda
    expect(nextOccurrence('2026-10-17T11:00:00.000Z', 'weekdays', SP)).toBe('2026-10-19T11:00:00.000Z');
    // segunda → terça
    expect(nextOccurrence('2026-10-19T11:00:00.000Z', 'weekdays', SP)).toBe('2026-10-20T11:00:00.000Z');
    // sexta 30/10 → segunda 02/11 (vira o mês)
    expect(nextOccurrence('2026-10-30T11:00:00.000Z', 'weekdays', SP)).toBe('2026-11-02T11:00:00.000Z');
  });

  it('weekly soma 7 dias', () => {
    expect(nextOccurrence('2026-10-28T15:00:00.000Z', 'weekly', SP)).toBe('2026-11-04T15:00:00.000Z');
  });

  it('monthly mantém o dia e ajusta para o último dia de meses curtos', () => {
    expect(nextOccurrence('2026-01-15T12:00:00.000Z', 'monthly', SP)).toBe('2026-02-15T12:00:00.000Z');
    expect(nextOccurrence('2026-01-31T12:00:00.000Z', 'monthly', SP)).toBe('2026-02-28T12:00:00.000Z');
    expect(nextOccurrence('2028-01-31T12:00:00.000Z', 'monthly', SP)).toBe('2028-02-29T12:00:00.000Z'); // bissexto
    expect(nextOccurrence('2026-12-10T12:00:00.000Z', 'monthly', SP)).toBe('2027-01-10T12:00:00.000Z');
  });

  it('preserva o horário de parede atravessando o horário de verão', () => {
    // 07/03/2026 09:00 EST (14:00Z) → 08/03/2026 09:00 EDT (13:00Z)
    expect(nextOccurrence('2026-03-07T14:00:00.000Z', 'daily', NY)).toBe('2026-03-08T13:00:00.000Z');
    // 31/10/2026 09:00 EDT (13:00Z) → 01/11/2026 09:00 EST (14:00Z)
    expect(nextOccurrence('2026-10-31T13:00:00.000Z', 'daily', NY)).toBe('2026-11-01T14:00:00.000Z');
  });

  it('cai no fuso padrão quando o fuso é inválido e trata data inválida', () => {
    expect(nextOccurrence('2026-10-16T12:00:00.000Z', 'daily', 'Fuso/Inexistente')).not.toBeNull();
    expect(nextOccurrence('não é data', 'daily', SP)).toBeNull();
  });

  it('nextOccurrenceAfter pula ocorrências perdidas', () => {
    const after = new Date('2026-10-20T12:00:00.000Z');
    expect(nextOccurrenceAfter('2026-10-16T11:00:00.000Z', 'daily', SP, after)).toBe('2026-10-21T11:00:00.000Z');
    expect(nextOccurrenceAfter('2026-10-16T11:00:00.000Z', 'none', SP, after)).toBeNull();
  });
});

describe('parseUserDate', () => {
  it('normaliza ISO com offset para UTC', () => {
    expect(parseUserDate('2026-10-17T09:00:00-03:00')).toBe('2026-10-17T12:00:00.000Z');
    expect(parseUserDate('2026-10-17T09:00:00+0530')).toBe('2026-10-17T03:30:00.000Z');
    expect(parseUserDate('2026-10-17T09:00Z')).toBe('2026-10-17T09:00:00.000Z');
    expect(parseUserDate('2026-10-17T09:00:00.250Z')).toBe('2026-10-17T09:00:00.250Z');
  });

  it('interpreta horário sem offset no fuso do usuário', () => {
    expect(parseUserDate('2026-10-17T09:00:00', { timeZone: SP })).toBe('2026-10-17T12:00:00.000Z');
    expect(parseUserDate('2026-07-01 09:00', { timeZone: NY })).toBe('2026-07-01T13:00:00.000Z');
  });

  it('só a data usa o horário padrão informado', () => {
    expect(parseUserDate('2026-10-17', { timeZone: SP, dateOnlyTime: '23:59' })).toBe('2026-10-18T02:59:00.000Z');
  });

  it('recusa datas inválidas com mensagem clara', () => {
    expect(() => parseUserDate('amanhã às 9')).toThrow(InvalidDateError);
    expect(() => parseUserDate('2026-02-30T10:00:00Z')).toThrow(/não existe/);
    expect(() => parseUserDate('2026-10-17T25:00:00Z')).toThrow(/Horário inválido/);
  });

  it('formata em português no fuso do usuário', () => {
    expect(formatLocalDateTime('2026-10-16T12:00:00.000Z', SP)).toMatch(/sexta-feira, 16 de outubro de 2026.*09:00/);
  });
});
