import { describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  process.env.LARK_DB_PATH = ':memory:';
});

import os from 'node:os';
import { catastrophicCommandReason, cleanPowerShellStderr, execProgram, shellTools } from './shell.js';
import type { ToolContext } from './types.js';

const ctx: ToolContext = { conversationId: 'teste', mode: 'text', emit: () => undefined };
const tool = (name: string) => shellTools.find((t) => t.name === name)!;
const posix = process.platform !== 'win32';

describe('run_command', () => {
  it.runIf(posix)('captura stdout, stderr, código de saída e duração', async () => {
    const r = await tool('run_command').execute({ command: 'echo "olá mundo"; echo falhou >&2; exit 3', cwd: os.tmpdir() }, ctx);
    expect(r.output.stdout).toBe('olá mundo');
    expect(r.output.stderr).toBe('falhou');
    expect(r.output.exitCode).toBe(3);
    expect(r.summary).toMatch(/código 3/);
  });

  it.runIf(posix)('encerra a árvore de processos no tempo limite', async () => {
    const started = Date.now();
    const r = await tool('run_command').execute({ command: 'sleep 30 & sleep 30; echo nunca', timeout_sec: 1 }, ctx);
    expect(r.output.timedOut).toBe(true);
    expect(r.output.stdout).toBe('');
    expect(Date.now() - started).toBeLessThan(10_000);
  }, 15_000);

  it.runIf(posix)('para quando a conversa é cancelada', async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 200);
    await expect(tool('run_command').execute({ command: 'sleep 20' }, { ...ctx, signal: controller.signal })).rejects.toThrow(/cancelado/i);
  }, 10_000);

  it.runIf(posix)('limita saídas enormes mantendo início e fim', async () => {
    const r = await tool('run_command').execute({ command: 'seq 1 200000' }, ctx);
    const out = String(r.output.stdout);
    expect(out.length).toBeLessThan(21_000);
    expect(out.startsWith('1\n2\n3')).toBe(true);
    expect(out.trimEnd().endsWith('200000')).toBe(true);
    expect(r.output.stdoutTruncated).toBe(true);
  });

  it('recusa pasta de trabalho inexistente', async () => {
    await expect(tool('run_command').execute({ command: 'echo oi', cwd: '/caminho/que/nao/existe/123' }, ctx)).rejects.toThrow(/não existe/);
  });

  it.each([
    'rm -rf /',
    'sudo rm -rf --no-preserve-root /',
    'rm -rf ~',
    'rm -fr $HOME/',
    'mkfs.ext4 /dev/sda1',
    'dd if=/dev/zero of=/dev/sda bs=1M',
    ':(){ :|:& };:',
    'format C: /q',
    'Remove-Item -Recurse -Force C:\\',
    'rd /s /q C:\\',
    'Format-Volume -DriveLetter D',
  ])('bloqueia comando catastrófico: %s', async (command) => {
    expect(catastrophicCommandReason(command)).not.toBeNull();
    await expect(tool('run_command').execute({ command }, ctx)).rejects.toThrow(/Recusei/);
  });

  it.each(['rm -rf ./build', 'rm -rf ~/projetos/lixo', 'git status', 'Remove-Item .\\temp -Recurse', 'del arquivo.txt'])(
    'permite comando comum: %s',
    (command) => {
      expect(catastrophicCommandReason(command)).toBeNull();
    },
  );

  it('descreve a ação para o pedido de aprovação', () => {
    expect(tool('run_command').describe?.({ command: 'git pull', cwd: 'Documentos/app' })).toBe('Executar no terminal (em Documentos/app):\ngit pull');
    expect(tool('run_command').risk).toBe('dangerous');
  });
});

describe('cleanPowerShellStderr', () => {
  it('extrai as mensagens de erro do CLIXML do PowerShell 5.1', () => {
    const raw =
      '#< CLIXML\r\n<Objs Version="1.1.0.1" xmlns="http://schemas.microsoft.com/powershell/2004/04"><Obj S="progress" RefId="0">' +
      '<MS><PR N="Record"><AV>Preparing modules for first use.</AV></PR></MS></Obj>' +
      '<S S="Error">Get-Item : Não foi possível encontrar o caminho &apos;C:\\x&apos;._x000D__x000A_</S></Objs>';
    expect(cleanPowerShellStderr(raw)).toBe("Get-Item : Não foi possível encontrar o caminho 'C:\\x'.");
    expect(cleanPowerShellStderr('erro simples')).toBe('erro simples');
  });
});

describe('execProgram', () => {
  it('informa programa inexistente', async () => {
    await expect(execProgram('programa-que-nao-existe-lark', [])).rejects.toThrow(/programa não encontrado/);
  });
});

describe('get_os_context', () => {
  it('descreve o sistema, o shell e as pastas conhecidas', async () => {
    const r = await tool('get_os_context').execute({}, ctx);
    expect(r.output.homeDir).toBe(os.homedir());
    expect(String(r.output.shell)).toBeTruthy();
    expect((r.output.knownFolders as { name: string }[]).map((f) => f.name)).toContain('Área de Trabalho');
  });
});
