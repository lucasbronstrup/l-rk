/**
 * Terminal do computador: execução de comandos (PowerShell no Windows; shell do usuário no macOS/Linux)
 * com captura de saída limitada, timeout e encerramento da árvore de processos, além do contexto do
 * sistema operacional para o modelo escrever comandos corretos.
 */
import { spawn, execFile, execFileSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { ensureKnownFoldersDetected, knownFolders, resolveUserPath } from './paths.js';
import { getOsDescription } from './system.js';
import {
  argText,
  clipMiddle,
  optionalInt,
  parseArgs,
  requiredText,
  throwIfAborted,
  userTimeZone,
  type ToolSpec,
} from './utility.js';

const isWin = process.platform === 'win32';

// ─── Execução de processos ───────────────────────────────────────────────

const HEAD_BYTES = 96 * 1024;
const TAIL_BYTES = 64 * 1024;
// eslint-disable-next-line no-control-regex
const ANSI_PATTERN = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07|\x1b[@-Z\\-_]/g;

/** Guarda o começo e o fim da saída de um processo sem estourar memória. */
class OutputCollector {
  private head: Buffer[] = [];
  private headBytes = 0;
  private tail: Buffer[] = [];
  private tailBytes = 0;
  total = 0;

  push(chunk: Buffer): void {
    this.total += chunk.length;
    if (this.headBytes < HEAD_BYTES) {
      const room = HEAD_BYTES - this.headBytes;
      const part = chunk.length <= room ? chunk : chunk.subarray(0, room);
      this.head.push(part);
      this.headBytes += part.length;
      if (part.length === chunk.length) return;
      chunk = chunk.subarray(room);
    }
    this.tail.push(chunk);
    this.tailBytes += chunk.length;
    while (this.tail.length > 1 && this.tailBytes - this.tail[0].length >= TAIL_BYTES) {
      this.tailBytes -= this.tail.shift()!.length;
    }
  }

  /** Texto decodificado (sem códigos ANSI), cortado em `maxChars` mantendo início e fim. */
  read(maxChars: number): { text: string; truncated: boolean } {
    const omittedBytes = this.total - this.headBytes - this.tailBytes;
    let text = Buffer.concat(this.head).toString('utf8');
    if (this.tail.length > 0) {
      if (omittedBytes > 0) text += `\n[… ${omittedBytes.toLocaleString('pt-BR')} bytes omitidos …]\n`;
      text += Buffer.concat(this.tail).toString('utf8');
    }
    text = text.replace(ANSI_PATTERN, '').replace(/\r\n/g, '\n').replace(/[^\n]*\r(?!\n)/g, '');
    const clipped = clipMiddle(text.trimEnd(), maxChars);
    return { text: clipped.text, truncated: clipped.truncated || omittedBytes > 0 };
  }
}

const runningChildren = new Set<ChildProcess>();
let exitHookInstalled = false;

function installExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  // Ao encerrar o servidor, não deixa comandos órfãos rodando.
  process.once('exit', () => {
    for (const child of runningChildren) killProcessTreeSync(child);
  });
}

function killProcessTreeSync(child: ChildProcess): void {
  if (!child.pid || child.exitCode !== null) return;
  try {
    if (isWin) {
      execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', timeout: 3000 });
    } else {
      process.kill(-child.pid, 'SIGKILL');
    }
  } catch {
    try {
      child.kill('SIGKILL');
    } catch {
      // Já terminou.
    }
  }
}

/** Encerra o processo e todos os seus filhos (taskkill /T no Windows; grupo de processos no Unix). */
export function killProcessTree(child: ChildProcess): void {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  if (isWin) {
    execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }, (error) => {
      if (error) {
        try {
          child.kill();
        } catch {
          // Já terminou.
        }
      }
    });
    return;
  }
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch {
    try {
      child.kill('SIGTERM');
    } catch {
      return;
    }
  }
  const timer = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) {
      try {
        process.kill(-child.pid!, 'SIGKILL');
      } catch {
        try {
          child.kill('SIGKILL');
        } catch {
          // Já terminou.
        }
      }
    }
  }, 1500);
  timer.unref();
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  aborted: boolean;
  durationMs: number;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
}

export interface ExecOptions {
  cwd?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Limite de caracteres por saída (padrão 20 000). */
  maxChars?: number;
  env?: NodeJS.ProcessEnv;
  /** Texto enviado à entrada padrão (por padrão a entrada fica fechada, evitando travar em prompts). */
  input?: string;
}

/** Executa um programa (sem shell intermediário) capturando saída, com timeout e cancelamento. */
export function execProgram(file: string, args: string[], opts: ExecOptions = {}): Promise<ExecResult> {
  installExitHook();
  const started = Date.now();
  const maxChars = opts.maxChars ?? 20_000;
  return new Promise<ExecResult>((resolve, reject) => {
    if (opts.signal?.aborted) return reject(new Error('A ação foi cancelada.'));
    let child: ChildProcess;
    try {
      child = spawn(file, args, {
        cwd: opts.cwd,
        env: {
          ...process.env,
          // Evita paginadores e prompts interativos que travariam a execução.
          PAGER: 'cat',
          GIT_PAGER: 'cat',
          GIT_TERMINAL_PROMPT: '0',
          ...opts.env,
        },
        stdio: [opts.input !== undefined ? 'pipe' : 'ignore', 'pipe', 'pipe'],
        windowsHide: true,
        detached: !isWin,
      });
    } catch (error) {
      return reject(error);
    }
    runningChildren.add(child);
    const out = new OutputCollector();
    const err = new OutputCollector();
    child.stdout?.on('data', (c: Buffer) => out.push(c));
    child.stderr?.on('data', (c: Buffer) => err.push(c));
    if (opts.input !== undefined && child.stdin) {
      child.stdin.on('error', () => undefined);
      child.stdin.end(opts.input);
    }

    let timedOut = false;
    let aborted = false;
    const timer =
      opts.timeoutMs && opts.timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            killProcessTree(child);
          }, opts.timeoutMs)
        : null;
    const onAbort = () => {
      aborted = true;
      killProcessTree(child);
    };
    opts.signal?.addEventListener('abort', onAbort, { once: true });

    let settled = false;
    const finish = (exitCode: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      runningChildren.delete(child);
      const stdout = out.read(maxChars);
      const stderr = err.read(maxChars);
      resolve({
        stdout: stdout.text,
        stderr: stderr.text,
        exitCode,
        signal,
        timedOut,
        aborted,
        durationMs: Date.now() - started,
        stdoutTruncated: stdout.truncated,
        stderrTruncated: stderr.truncated,
      });
    };
    child.once('error', (error: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      runningChildren.delete(child);
      reject(
        error.code === 'ENOENT' || error.code === 'ENOTDIR'
          ? new Error(`Não consegui iniciar "${file}": programa não encontrado${opts.cwd ? ` ou pasta de trabalho inválida (${opts.cwd})` : ''}.`)
          : error,
      );
    });
    child.once('close', finish);
  });
}

/** Prefixo que força UTF-8 no PowerShell 5.1 e silencia barras de progresso. */
const POWERSHELL_PRELUDE = [
  '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
  '$OutputEncoding = [System.Text.Encoding]::UTF8',
  "$ProgressPreference = 'SilentlyContinue'",
].join('; ');

/** Limite seguro para -EncodedCommand (a linha de comando do Windows aceita ~32 mil caracteres). */
const MAX_ENCODED_COMMAND = 24_000;

/**
 * O PowerShell 5.1 com saída redirecionada às vezes escreve registros de progresso/erro em CLIXML no stderr
 * ("#< CLIXML ..."). Extrai só as mensagens de erro legíveis.
 */
export function cleanPowerShellStderr(stderr: string): string {
  if (!stderr.includes('#< CLIXML')) return stderr;
  const decode = (t: string) =>
    t
      .replace(/_x000D__x000A_/g, '\n')
      .replace(/_x([0-9A-F]{4})_/g, (_, h: string) => String.fromCharCode(Number.parseInt(h, 16)))
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&amp;/g, '&');
  const errors = [...stderr.matchAll(/<S S="Error">([\s\S]*?)<\/S>/g)].map((m) => decode(m[1]));
  const outside = stderr.replace(/#< CLIXML[\s\S]*?<\/Objs>/g, '').trim();
  return [errors.join('').trim(), outside].filter(Boolean).join('\n');
}

/**
 * Executa um script no Windows PowerShell 5.1 com UTF-8. Scripts curtos vão por -EncodedCommand
 * (sem problemas de aspas); longos, por um .ps1 temporário com BOM (que o PowerShell 5.1 lê como UTF-8).
 */
export async function runPowerShell(script: string, opts: ExecOptions = {}): Promise<ExecResult> {
  const full = `${POWERSHELL_PRELUDE}\n${script}`;
  const encoded = Buffer.from(full, 'utf16le').toString('base64');
  const base = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass'];
  let tempFile: string | null = null;
  let args: string[];
  if (encoded.length <= MAX_ENCODED_COMMAND) {
    args = [...base, '-EncodedCommand', encoded];
  } else {
    tempFile = path.join(os.tmpdir(), `lark-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.ps1`);
    await fs.promises.writeFile(tempFile, `\ufeff${full}`, 'utf8');
    args = [...base, '-File', tempFile];
  }
  try {
    const result = await execProgram('powershell.exe', args, opts);
    return { ...result, stderr: cleanPowerShellStderr(result.stderr) };
  } finally {
    if (tempFile) await fs.promises.rm(tempFile, { force: true }).catch(() => undefined);
  }
}

/** Escapa texto para uma string PowerShell entre aspas simples. */
export function psQuote(text: string): string {
  return `'${text.replace(/'/g, "''").replace(/[‘’‚‛]/g, "''")}'`;
}

/** Verifica se um executável existe no PATH. */
export async function commandExists(name: string): Promise<boolean> {
  const dirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  const exts = isWin ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';').map((e) => e.toLowerCase()) : [''];
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, isWin && !name.toLowerCase().endsWith(ext) ? `${name}${ext}` : name);
      try {
        await fs.promises.access(candidate, isWin ? fs.constants.F_OK : fs.constants.X_OK);
        return true;
      } catch {
        // continua
      }
    }
  }
  return false;
}

export interface UserShell {
  program: string;
  name: string;
  /** Executa um comando do usuário neste shell. */
  run: (command: string, opts: ExecOptions) => Promise<ExecResult>;
}

/** Shell usado por run_command nesta plataforma. */
export function userShell(): UserShell {
  if (isWin) {
    return {
      program: 'powershell.exe',
      name: 'Windows PowerShell 5.1',
      // Propaga o código de saída de programas nativos (o PowerShell sozinho devolveria 0/1).
      run: (command, opts) =>
        runPowerShell(`${command}\nif ($null -ne $LASTEXITCODE -and $LASTEXITCODE -ne 0) { exit $LASTEXITCODE }`, opts),
    };
  }
  const candidates = [process.env.SHELL, '/bin/bash', '/bin/zsh', '/bin/sh'].filter((s): s is string => Boolean(s));
  const program = candidates.find((s) => path.isAbsolute(s) && fs.existsSync(s)) ?? '/bin/sh';
  return { program, name: path.basename(program), run: (command, opts) => execProgram(program, ['-lc', command], opts) };
}

// ─── Barreira contra comandos catastróficos ─────────────────────────────

const CATASTROPHIC: { pattern: RegExp; reason: string }[] = [
  { pattern: /\brm\s+(-[a-zA-Z]*[rR][a-zA-Z]*\s+|--recursive\s+)+(-[a-zA-Z]+\s+)*(\/|\/\*|~\/?|\$HOME\/?)(\s|$|;|&)/, reason: 'apagaria o sistema ou a pasta pessoal inteira' },
  { pattern: /--no-preserve-root/, reason: 'desativa a proteção da raiz do sistema' },
  { pattern: /\bmkfs(\.\w+)?\b|\bwipefs\b/, reason: 'formataria um disco' },
  { pattern: /\bdd\b[^|;&]*\bof=\/dev\/(sd|nvme|hd|disk|mmcblk)/, reason: 'sobrescreveria um disco inteiro' },
  { pattern: /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/, reason: 'é uma bomba de processos' },
  { pattern: /\bformat(\.com)?\s+[a-z]:/i, reason: 'formataria uma unidade' },
  { pattern: /\bFormat-Volume\b|\bClear-Disk\b|\bInitialize-Disk\b|\bdiskpart\b/i, reason: 'mexeria nas partições do disco' },
  { pattern: /\bRemove-Item\b[^|;]*\s['"]?[a-z]:\\?\*?['"]?\s[^|;]*-Recurse|\bRemove-Item\b[^|;]*-Recurse[^|;]*\s['"]?[a-z]:\\?\*?['"]?(\s|$|;)/i, reason: 'apagaria uma unidade inteira' },
  { pattern: /\b(rd|rmdir)\s+\/s\s+(\/q\s+)?[a-z]:\\?(\s|$)/i, reason: 'apagaria uma unidade inteira' },
  { pattern: /\bdel\s+(\/[a-z]\s+)*[a-z]:\\\*?(\s|$)/i, reason: 'apagaria uma unidade inteira' },
  { pattern: /\b(bcdedit|vssadmin\s+delete|cipher\s+\/w)\b/i, reason: 'altera a inicialização ou destrói backups do sistema' },
];

/** Motivo para recusar um comando catastrófico (independe do modo de aprovação), ou null. */
export function catastrophicCommandReason(command: string): string | null {
  for (const { pattern, reason } of CATASTROPHIC) if (pattern.test(command)) return reason;
  return null;
}

// ─── Ferramentas ─────────────────────────────────────────────────────────

const MAX_TIMEOUT_SEC = 300;
const DEFAULT_TIMEOUT_SEC = 60;

function timeoutSecOf(args: Record<string, unknown>): number {
  const n = Number(args?.timeout_sec);
  return Number.isFinite(n) && n > 0 ? Math.min(Math.round(n), MAX_TIMEOUT_SEC) : DEFAULT_TIMEOUT_SEC;
}

const runCommand: ToolSpec = {
  name: 'run_command',
  label: 'Executando comando',
  group: 'computer',
  risk: 'dangerous',
  timeoutMs: (args) => (timeoutSecOf(args) + 15) * 1000,
  description:
    'Executa um comando no terminal do computador do usuário e devolve stdout, stderr e código de saída. ' +
    (isWin
      ? 'No Windows roda no Windows PowerShell 5.1 (use cmdlets como Get-ChildItem, Get-Process, Start-Process; `&&` não existe — use `;`). '
      : 'Roda no shell do usuário (bash/zsh) como login shell. ') +
    'Use para tarefas sem ferramenta própria: instalar programas (winget/brew/apt), git, scripts, compactar arquivos, ' +
    'consultar informações avançadas do sistema, automatizações. Comandos não podem ser interativos (sem entrada do teclado). ' +
    'Prefira as ferramentas dedicadas (list_directory, read_file, search_files...) quando existirem. ' +
    'Chame get_os_context antes se não souber o sistema operacional.',
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'Comando completo a executar (pode ter várias linhas).' },
      cwd: { type: 'string', description: 'Pasta de trabalho (padrão: pasta pessoal). Aceita atalhos como "Documentos".' },
      timeout_sec: {
        type: 'integer',
        minimum: 1,
        maximum: MAX_TIMEOUT_SEC,
        description: `Tempo máximo em segundos (padrão ${DEFAULT_TIMEOUT_SEC}, máximo ${MAX_TIMEOUT_SEC}).`,
      },
    },
    required: ['command'],
  },
  describe: (args) => {
    const cwd = argText(args, 'cwd');
    return `Executar no terminal${cwd ? ` (em ${cwd})` : ''}:\n${argText(args, 'command')}`;
  },
  async execute(args, ctx) {
    const a = parseArgs(
      'run_command',
      z.object({
        command: requiredText('o comando').max(20_000, 'comando longo demais'),
        cwd: z.string().trim().nullish(),
        timeout_sec: optionalInt(1, MAX_TIMEOUT_SEC),
      }),
      args,
    );
    const danger = catastrophicCommandReason(a.command);
    if (danger) {
      throw new Error(`Recusei este comando porque ele ${danger}. Isso não se desfaz; se for mesmo a intenção, faça manualmente.`);
    }
    throwIfAborted(ctx.signal);
    const cwd = a.cwd ? resolveUserPath(a.cwd) : os.homedir();
    let cwdStat: fs.Stats;
    try {
      cwdStat = await fs.promises.stat(cwd);
    } catch {
      throw new Error(`A pasta de trabalho não existe: ${cwd}`);
    }
    if (!cwdStat.isDirectory()) throw new Error(`A pasta de trabalho não é uma pasta: ${cwd}`);

    const shell = userShell();
    const timeoutSec = a.timeout_sec ?? DEFAULT_TIMEOUT_SEC;
    const r = await shell.run(a.command, {
      cwd,
      timeoutMs: timeoutSec * 1000,
      signal: ctx.signal,
      maxChars: 20_000,
    });
    if (r.aborted) throw new Error('Comando cancelado.');
    const seconds =
      r.durationMs < 1000 ? `${r.durationMs} ms` : `${(r.durationMs / 1000).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} s`;
    const summary = r.timedOut
      ? `Tempo esgotado após ${timeoutSec} s (processo encerrado)`
      : r.exitCode === 0
        ? `Concluído em ${seconds}`
        : `Terminou com código ${r.exitCode ?? r.signal ?? '?'} em ${seconds}`;
    return {
      output: {
        command: a.command,
        cwd,
        shell: shell.name,
        exitCode: r.exitCode,
        ...(r.signal ? { signal: r.signal } : {}),
        timedOut: r.timedOut,
        durationMs: r.durationMs,
        stdout: r.stdout,
        stderr: r.stderr,
        ...(r.stdoutTruncated ? { stdoutTruncated: true } : {}),
        ...(r.stderrTruncated ? { stderrTruncated: true } : {}),
        ...(r.timedOut ? { note: `O comando excedeu ${timeoutSec} s e foi encerrado junto com seus subprocessos.` } : {}),
      },
      summary,
    };
  },
};

const PLATFORM_NAMES: Record<string, string> = { win32: 'Windows', darwin: 'macOS', linux: 'Linux' };

const getOsContext: ToolSpec = {
  name: 'get_os_context',
  label: 'Reconhecendo o sistema',
  group: 'computer',
  risk: 'safe',
  description:
    'Descreve o computador do usuário: sistema operacional, versão, shell usado por run_command, nome de usuário, ' +
    'pasta pessoal, caminhos reais das pastas conhecidas (Área de Trabalho, Documentos, Downloads, Imagens...) e favoritas. ' +
    'Use antes de escrever comandos ou caminhos quando não tiver certeza do ambiente.',
  parameters: { type: 'object', properties: {} },
  async execute() {
    await ensureKnownFoldersDetected();
    const shell = userShell();
    let username = '';
    try {
      username = os.userInfo().username;
    } catch {
      username = process.env.USERNAME || process.env.USER || '';
    }
    const osName = await getOsDescription();
    const folders = knownFolders();
    const platformName = PLATFORM_NAMES[process.platform] ?? process.platform;
    const notes: string[] = [];
    if (isWin) {
      notes.push(
        'run_command usa o Windows PowerShell 5.1: separe comandos com ";" (não "&&"), use aspas em caminhos com espaço.',
        'Para instalar programas use "winget install --id <Id> -e --accept-source-agreements --accept-package-agreements".',
      );
    } else if (process.platform === 'darwin') {
      notes.push('Para instalar programas use Homebrew ("brew install ...") se estiver instalado.');
    } else {
      notes.push('Comandos com sudo vão falhar (não há como digitar senha); peça para o usuário executá-los.');
    }
    return {
      output: {
        platform: platformName,
        osName,
        release: os.release(),
        arch: os.arch(),
        hostname: os.hostname(),
        username,
        homeDir: os.homedir(),
        shell: `${shell.name} (${shell.program})`,
        pathSeparator: path.sep,
        tempDir: os.tmpdir(),
        timezone: userTimeZone(),
        cpus: os.cpus().length,
        totalMemoryGB: Math.round((os.totalmem() / 1024 ** 3) * 10) / 10,
        nodeVersion: process.version,
        knownFolders: folders
          .filter((f) => f.key !== 'favorite')
          .map((f) => ({ name: f.label, path: f.path, exists: f.exists })),
        favoriteFolders: folders.filter((f) => f.key === 'favorite').map((f) => ({ path: f.path, exists: f.exists })),
        notes,
      },
      summary: `${osName || platformName} · ${username}@${os.hostname()}`,
    };
  },
};

export const shellTools: ToolSpec[] = [runCommand, getOsContext];
