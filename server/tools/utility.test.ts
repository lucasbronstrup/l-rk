import { afterAll, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  process.env.LARK_DB_PATH = ':memory:';
});

import { describeNow, disposeMathEngine, evaluateMath, utilityTools } from './utility.js';
import type { ToolContext } from './types.js';

const ctx: ToolContext = { conversationId: 'teste', mode: 'text', emit: () => undefined };
const tool = (name: string) => utilityTools.find((t) => t.name === name)!;

afterAll(async () => {
  await disposeMathEngine();
});

describe('calculate', () => {
  it('faz contas exatas e formata em pt-BR', async () => {
    const r = await tool('calculate').execute({ expression: '(1500 * 1.05^2) - 1500' }, ctx);
    expect(r.output.value).toBeCloseTo(153.75, 10);
    expect(r.output.resultPtBr).toBe('153,75');
  });

  it('entende porcentagem, unidades, matrizes e derivadas', async () => {
    expect((await evaluateMath('12% * 300')).value).toBe(36);
    expect((await evaluateMath('det([1,2;3,4])')).value).toBe(-2);
    const unit = await evaluateMath('5 km/h to mi/h');
    expect(unit.type).toBe('Unit');
    expect(unit.value).toBeCloseTo(3.10686, 4);
    expect((await evaluateMath('derivative("x^2", "x")')).result).toBe('2 * x');
    expect((await evaluateMath('factorial(20)')).result).toBe('2432902008176640000');
  });

  it('aceita símbolos tipográficos comuns', async () => {
    const r = await tool('calculate').execute({ expression: '√16 × 2 − 1' }, ctx);
    expect(r.output.value).toBe(7);
  });

  it('explica erros em português', async () => {
    await expect(evaluateMath('foo + 1')).rejects.toThrow(/Símbolo desconhecido: foo/);
    await expect(evaluateMath('2 +')).rejects.toThrow(/mal formada|Unexpected|esperado/i);
  });

  it('bloqueia funções perigosas do mathjs', async () => {
    await expect(evaluateMath('import({x: 1})')).rejects.toThrow(/desativada/);
    await expect(evaluateMath('evaluate("1+1")')).rejects.toThrow(/desativada/);
    await expect(evaluateMath('createUnit("foo")')).rejects.toThrow(/desativada/);
  });

  it('interrompe cálculos que travariam e se recupera depois', async () => {
    await expect(evaluateMath('f(n) = n < 2 ? n : f(n-1) + f(n-2); f(60)', 600)).rejects.toThrow(/demorou demais/);
    expect((await evaluateMath('1 + 1')).value).toBe(2);
  }, 15_000);

  it('valida argumentos', async () => {
    await expect(tool('calculate').execute({}, ctx)).rejects.toThrow(/Argumentos inválidos/);
  });
});

describe('convert_units', () => {
  it('converte com nomes em português', async () => {
    const r = await tool('convert_units').execute({ value: 100, from: 'fahrenheit', to: 'celsius' }, ctx);
    expect(r.output.numeric).toBeCloseTo(37.7778, 3);
    const km = await tool('convert_units').execute({ value: 3, from: 'milhas', to: 'quilômetros' }, ctx);
    expect(km.output.numeric).toBeCloseTo(4.828032, 6);
  });

  it('recusa unidades incompatíveis', async () => {
    await expect(tool('convert_units').execute({ value: 1, from: 'm', to: 'kg' }, ctx)).rejects.toThrow(/compatíveis|Units/i);
  });
});

describe('get_datetime', () => {
  it('descreve o instante em PT-BR no fuso pedido', async () => {
    const now = new Date('2026-10-16T13:05:00.000Z');
    const info = describeNow('America/Sao_Paulo', now);
    expect(info.weekday).toBe('sexta-feira');
    expect(info.time).toBe('10:05');
    expect(info.date).toBe('16/10/2026');
    expect(info.utcOffset).toBe('-03:00');
    expect(info.period).toBe('manhã');
    expect(info.iso).toBe('2026-10-16T10:05:00-03:00');
  });

  it('cai para um fuso válido quando o pedido é inválido', async () => {
    const r = await tool('get_datetime').execute({ timezone: 'Lugar/Inexistente' }, ctx);
    expect(r.output.note).toMatch(/inválido/);
  });
});
