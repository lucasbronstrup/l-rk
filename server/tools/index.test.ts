import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  process.env.LARK_DB_PATH = ':memory:';
});

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { bus } from '../lib/bus.js';
import { updateSettings } from '../memory/settings.js';
import type { LarkEvent, ToolCallInfo } from '../../shared/types.js';
import { cancelAllApprovals, resolveApproval } from './approvals.js';
import { effectiveRisk, getAllTools, getTool, getToolDeclarations, needsApproval, runTool } from './index.js';
import { disposeMathEngine } from './utility.js';
import type { ToolContext } from './types.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-runtool-'));
let emitted: ToolCallInfo[] = [];
let events: LarkEvent[] = [];
let unsubscribe: () => void = () => {};
let autoAnswer: boolean | null = null;

const ctx = (signal?: AbortSignal): ToolContext => ({
  conversationId: 'conv-1',
  mode: 'text',
  emit: (call) => emitted.push(call),
  signal,
});

beforeEach(() => {
  emitted = [];
  events = [];
  autoAnswer = null;
  unsubscribe = bus.subscribe((e) => {
    events.push(e);
    // Simula o usuário respondendo na interface.
    if (e.type === 'approval_request' && autoAnswer !== null) {
      const answer = autoAnswer;
      setTimeout(() => resolveApproval(e.request.id, answer), 5);
    }
  });
  updateSettings({ computer: { enabled: true, approvalMode: 'ask' } });
});

afterEach(() => {
  unsubscribe();
  cancelAllApprovals();
});

afterAll(async () => {
  fs.rmSync(tmp, { recursive: true, force: true });
  await disposeMathEngine();
});

describe('registro de ferramentas', () => {
  it('inclui memória, computador, web e utilitários sem nomes repetidos', () => {
    const names = getAllTools().map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    for (const n of ['remember', 'recall', 'create_reminder', 'list_directory', 'run_command', 'web_search', 'fetch_url', 'calculate', 'take_screenshot', 'get_os_context']) {
      expect(names).toContain(n);
    }
  });

  it('gera declarações no formato do Gemini', () => {
    const decls = getToolDeclarations('text');
    const read = decls.find((d) => d.name === 'read_file')!;
    expect(read.description).toMatch(/Lê o conteúdo/);
    expect(read.parametersJsonSchema).toMatchObject({ type: 'object', required: ['path'] });
    const voice = getToolDeclarations('voice').find((d) => d.name === 'delete_path')!;
    expect(voice.description).toMatch(/aprovar na tela/);
  });

  it('esconde as ferramentas do computador quando o acesso está desligado', async () => {
    updateSettings({ computer: { enabled: false } });
    const names = getAllTools().map((t) => t.name);
    expect(names).not.toContain('list_directory');
    expect(names).not.toContain('run_command');
    expect(names).toContain('remember');
    expect(names).toContain('web_search');
    const { call, result } = await runTool('list_directory', { path: tmp }, ctx());
    expect(call.status).toBe('error');
    expect(result.output.error).toMatch(/acesso ao computador está desativado/);
  });

  it('decide aprovação conforme o modo', () => {
    expect(needsApproval('safe', 'ask')).toBe(false);
    expect(needsApproval('confirm', 'ask')).toBe(true);
    expect(needsApproval('dangerous', 'ask')).toBe(true);
    expect(needsApproval('confirm', 'dangerous-only')).toBe(false);
    expect(needsApproval('dangerous', 'dangerous-only')).toBe(true);
    expect(needsApproval('dangerous', 'never')).toBe(false);
  });

  it('calcula o risco efetivo pelos argumentos', () => {
    const write = getTool('write_file')!;
    const existing = path.join(tmp, 'existe.txt');
    fs.writeFileSync(existing, 'x');
    expect(effectiveRisk(write, { path: existing, content: 'y', mode: 'overwrite' })).toBe('dangerous');
    expect(effectiveRisk(write, { path: existing, content: 'y', mode: 'append' })).toBe('confirm');
  });
});

describe('runTool', () => {
  it('executa ferramentas seguras sem pedir aprovação', async () => {
    const { call, result } = await runTool('calculate', { expression: '2+2' }, ctx(), 'id-123');
    expect(call).toMatchObject({ id: 'id-123', name: 'calculate', label: 'Calculando', status: 'done', risk: 'safe' });
    expect(result.output.value).toBe(4);
    expect(emitted.map((c) => c.status)).toEqual(['running', 'done']);
    expect(events.some((e) => e.type === 'approval_request')).toBe(false);
  });

  it('pede aprovação no modo "ask" e executa quando aprovado', async () => {
    autoAnswer = true;
    const dir = path.join(tmp, 'aprovada');
    const { call, result } = await runTool('create_directory', { path: dir }, ctx());
    expect(call.status).toBe('done');
    expect(result.output.created).toBe(true);
    expect(fs.existsSync(dir)).toBe(true);
    expect(emitted.map((c) => c.status)).toEqual(['awaiting_approval', 'running', 'done']);
    const request = events.find((e) => e.type === 'approval_request');
    expect(request && request.type === 'approval_request' && request.request.description).toBe(`Criar a pasta ${dir}`);
  });

  it('não executa quando o usuário nega', async () => {
    autoAnswer = false;
    const dir = path.join(tmp, 'negada');
    const { call, result } = await runTool('create_directory', { path: dir }, ctx());
    expect(call.status).toBe('denied');
    expect(result.output).toEqual({ error: 'Usuário negou a ação.' });
    expect(fs.existsSync(dir)).toBe(false);
  });

  it('no modo "dangerous-only" só pergunta para ações perigosas', async () => {
    updateSettings({ computer: { approvalMode: 'dangerous-only' } });
    const dir = path.join(tmp, 'sem-pergunta');
    const created = await runTool('create_directory', { path: dir }, ctx());
    expect(created.call.status).toBe('done');
    expect(events.some((e) => e.type === 'approval_request')).toBe(false);

    autoAnswer = false;
    const deleted = await runTool('delete_path', { path: dir }, ctx());
    expect(deleted.call.status).toBe('denied');
    expect(fs.existsSync(dir)).toBe(true);
  });

  it('no modo "never" executa tudo sem perguntar', async () => {
    updateSettings({ computer: { approvalMode: 'never' } });
    const { call, result } = await runTool('run_command', { command: process.platform === 'win32' ? 'Write-Output ok' : 'echo ok' }, ctx());
    expect(call.status).toBe('done');
    expect(result.output.stdout).toBe('ok');
    expect(events.some((e) => e.type === 'approval_request')).toBe(false);
  });

  it('cancela a espera de aprovação quando a conversa é interrompida', async () => {
    const controller = new AbortController();
    const pending = runTool('create_directory', { path: path.join(tmp, 'cancelada') }, ctx(controller.signal));
    await new Promise((r) => setTimeout(r, 20));
    controller.abort();
    const { call, result } = await pending;
    expect(call.status).toBe('denied');
    expect(String(result.output.error)).toMatch(/interrompida/);
  });

  it('transforma exceções da ferramenta em erro para o modelo', async () => {
    const { call, result } = await runTool('read_file', { path: path.join(tmp, 'nao-existe.txt') }, ctx());
    expect(call.status).toBe('error');
    expect(String(result.output.error)).toMatch(/Não encontrei/);
    expect(call.summary).toMatch(/^Falhou:/);
  });

  it('valida argumentos e informa ferramenta inexistente', async () => {
    const bad = await runTool('calculate', {}, ctx());
    expect(bad.call.status).toBe('error');
    expect(String(bad.result.output.error)).toMatch(/Argumentos inválidos/);
    const unknown = await runTool('ferramenta_fantasma', {}, ctx());
    expect(unknown.result.output.error).toMatch(/não existe/);
  });

  it('encurta argumentos longos na interface sem alterar a execução', async () => {
    updateSettings({ computer: { approvalMode: 'never' } });
    const content = 'x'.repeat(5000);
    const file = path.join(tmp, 'longo.txt');
    const { call } = await runTool('write_file', { path: file, content }, ctx());
    expect(call.status).toBe('done');
    expect(String(call.args.content).length).toBeLessThan(2100);
    expect(fs.readFileSync(file, 'utf8')).toHaveLength(5000);
  });

  it('não executa nada com sinal já abortado', async () => {
    const controller = new AbortController();
    controller.abort();
    const { call } = await runTool('calculate', { expression: '1+1' }, ctx(controller.signal));
    expect(call.status).toBe('error');
  });
});
