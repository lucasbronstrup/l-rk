/**
 * Área de trabalho: ver a tela (captura), área de transferência, abrir programas, notificações nativas,
 * bloquear a tela, volume e teclas de mídia — no Windows, macOS e Linux.
 *
 * Limites conhecidos (documentados nas mensagens de erro):
 * - macOS: captura de tela e atalhos exigem permissões de "Gravação de Tela"/"Acessibilidade" para o terminal/Node;
 *   teclas de mídia controlam Spotify ou Música (não há tecla de mídia nativa sem ferramentas externas).
 * - Linux: depende das ferramentas da sessão gráfica (xrandr+ImageMagick/grim/gnome-screenshot, pactl/wpctl/amixer,
 *   playerctl/MPRIS, notify-send, loginctl).
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import clipboard from 'clipboardy';
import { z } from 'zod';
import { foldText } from './paths.js';
import { commandExists, execProgram, psQuote, runPowerShell, type ExecResult } from './shell.js';
import { argText, clipMiddle, formatBytes, optionalBool, optionalInt, parseArgs, requiredText, type ToolSpec } from './utility.js';
import type { ToolResult } from './types.js';

const require = createRequire(import.meta.url);
const platform = process.platform;
const isWin = platform === 'win32';
const isMac = platform === 'darwin';

function lastLine(r: ExecResult): string {
  return (r.stdout.trim().split(/\r?\n/).pop() ?? '').trim();
}

function failureText(r: ExecResult): string {
  return (r.stderr || r.stdout || `código ${r.exitCode}`).trim().split(/\r?\n/).slice(-3).join(' ').slice(0, 300);
}

/** Inicia um programa gráfico desacoplado do servidor. */
function launchDetached(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    try {
      const child = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: false });
      child.once('error', (error: NodeJS.ErrnoException) =>
        reject(error.code === 'ENOENT' ? new Error(`Programa não encontrado: ${command}`) : error),
      );
      child.once('spawn', () => {
        child.unref();
        resolve();
      });
    } catch (error) {
      reject(error);
    }
  });
}

/** AppleScript com argumentos (sem interpolar texto do usuário no script). */
function osascript(lines: string[], args: string[] = [], timeoutMs = 15_000): Promise<ExecResult> {
  return execProgram('osascript', [...lines.flatMap((l) => ['-e', l]), ...args], { timeoutMs });
}

// ─── Captura de tela ─────────────────────────────────────────────────────

interface Display {
  id: string | number;
  name?: string;
  primary?: boolean;
  width?: number;
  height?: number;
}

interface ScreenshotModule {
  (options?: { format?: string; screen?: string | number }): Promise<Buffer>;
  listDisplays(): Promise<Display[]>;
}

const MAX_IMAGE_BYTES = 12 * 1024 * 1024;

function imageMime(buf: Buffer): string {
  if (buf[0] === 0x89 && buf[1] === 0x50) return 'image/png';
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg';
  return 'image/png';
}

/** Linux sem X11 (Wayland) ou sem ImageMagick: tenta outras ferramentas comuns. */
async function linuxFallbackScreenshot(): Promise<Buffer> {
  const file = path.join(os.tmpdir(), `lark-tela-${process.pid}-${Date.now()}.png`);
  const attempts: [string, string[]][] = [
    ['grim', [file]],
    ['gnome-screenshot', ['-f', file]],
    ['spectacle', ['-b', '-n', '-o', file]],
    ['scrot', ['-o', file]],
    ['import', ['-window', 'root', file]],
  ];
  try {
    for (const [cmd, args] of attempts) {
      if (!(await commandExists(cmd))) continue;
      const r = await execProgram(cmd, args, { timeoutMs: 15_000 }).catch(() => null);
      if (r && r.exitCode === 0 && fs.existsSync(file)) return await fs.promises.readFile(file);
    }
  } finally {
    await fs.promises.rm(file, { force: true }).catch(() => undefined);
  }
  throw new Error('Nenhuma ferramenta de captura disponível. Instale "grim" (Wayland) ou "imagemagick" + "xrandr" (X11).');
}

async function captureScreens(display: string | number | null): Promise<{ buffers: Buffer[]; displays: Display[] }> {
  const screenshot = require('screenshot-desktop') as ScreenshotModule;
  let displays: Display[] = [];
  let listed = false;
  try {
    displays = await screenshot.listDisplays();
    listed = true;
  } catch {
    displays = [];
  }
  // No Linux a biblioteca depende de xrandr + ImageMagick e não trata falhas internas de listDisplays
  // (rejeição não capturada): só a usamos quando a listagem funcionou e o "import" existe.
  const libraryUsable = platform !== 'linux' || (listed && (await commandExists('import')));
  const capture = async (screen?: string | number) => {
    if (!libraryUsable) return linuxFallbackScreenshot();
    try {
      return await screenshot({ format: 'jpg', ...(screen !== undefined ? { screen } : {}) });
    } catch (error) {
      if (platform === 'linux') return linuxFallbackScreenshot();
      throw error;
    }
  };
  if (display === 'all' && displays.length > 1) {
    const buffers: Buffer[] = [];
    for (const d of displays.slice(0, 4)) buffers.push(await capture(d.id));
    return { buffers, displays: displays.slice(0, 4) };
  }
  if (typeof display === 'number' && displays.length > 0) {
    const d = displays[display - 1];
    if (!d) throw new Error(`Existem ${displays.length} telas; escolha de 1 a ${displays.length}.`);
    return { buffers: [await capture(d.id)], displays: [d] };
  }
  const primary = displays.find((d) => d.primary) ?? displays[0];
  return { buffers: [await capture(primary?.id)], displays: primary ? [primary] : [] };
}

const takeScreenshot: ToolSpec = {
  name: 'take_screenshot',
  label: 'Olhando a tela',
  group: 'computer',
  risk: 'safe',
  timeoutMs: 45_000,
  description:
    'Captura a tela do computador e a anexa para você VER o que o usuário está vendo (janelas, erros, textos, imagens). ' +
    'Use quando ele disser "olha minha tela", "o que é isso aqui?", "me ajuda com esse erro" ou quando precisar ' +
    'confirmar o resultado de uma ação. Com vários monitores, display=1 é o principal ou "all" para todos.',
  parameters: {
    type: 'object',
    properties: {
      display: {
        type: 'string',
        description: 'Qual tela: "1" (principal, padrão), "2"... ou "all" para todas.',
      },
    },
  },
  async execute(args): Promise<ToolResult> {
    const raw = argText(args, 'display').toLowerCase();
    const display = raw === 'all' || raw === 'todas' ? 'all' : raw && Number.isFinite(Number(raw)) ? Math.max(1, Math.round(Number(raw))) : null;
    let result: { buffers: Buffer[]; displays: Display[] };
    try {
      result = await captureScreens(display);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        isMac
          ? `Não consegui capturar a tela (${message}). No macOS, permita "Gravação de Tela" para o Terminal/Node em Ajustes do Sistema › Privacidade e Segurança.`
          : `Não consegui capturar a tela: ${message}`,
      );
    }
    const images = result.buffers.filter((b) => b.length > 0);
    if (images.length === 0) throw new Error('A captura veio vazia.');
    const tooBig = images.find((b) => b.length > MAX_IMAGE_BYTES);
    if (tooBig) throw new Error(`A captura ficou grande demais para análise (${formatBytes(tooBig.length)}).`);
    return {
      output: {
        captured: images.length,
        displays: result.displays.map((d, i) => ({ index: i + 1, id: String(d.id), ...(d.width && d.height ? { resolution: `${d.width}x${d.height}` } : {}) })),
        size: formatBytes(images.reduce((s, b) => s + b.length, 0)),
        note: `${images.length === 1 ? 'A imagem da tela foi anexada' : 'As imagens das telas foram anexadas'} a esta resposta: analise-as para responder.`,
      },
      summary: images.length === 1 ? 'Tela capturada' : `${images.length} telas capturadas`,
      inlineData: images.map((b) => ({ mimeType: imageMime(b), data: b.toString('base64') })),
    };
  },
};

// ─── Área de transferência ───────────────────────────────────────────────

function clipboardError(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  return new Error(
    platform === 'linux'
      ? `Não consegui acessar a área de transferência (${message}). No Linux é preciso xclip/xsel (X11) ou wl-clipboard (Wayland).`
      : `Não consegui acessar a área de transferência: ${message}`,
  );
}

const clipboardRead: ToolSpec = {
  name: 'clipboard_read',
  label: 'Lendo a área de transferência',
  group: 'computer',
  risk: 'safe',
  description: 'Lê o texto que o usuário copiou (Ctrl+C). Use quando ele disser "o que eu copiei", "analisa isso que copiei".',
  parameters: { type: 'object', properties: {} },
  async execute() {
    let text: string;
    try {
      text = await clipboard.read();
    } catch (error) {
      throw clipboardError(error);
    }
    const clipped = clipMiddle(text, 30_000);
    return {
      output: { text: clipped.text, chars: text.length, ...(clipped.truncated ? { truncated: true } : {}), ...(text ? {} : { note: 'A área de transferência está vazia (ou contém algo que não é texto, como uma imagem).' }) },
      summary: text ? `${text.length.toLocaleString('pt-BR')} caracteres copiados` : 'Área de transferência vazia',
    };
  },
};

const clipboardWrite: ToolSpec = {
  name: 'clipboard_write',
  label: 'Copiando para a área de transferência',
  group: 'computer',
  risk: 'confirm',
  description: 'Coloca um texto na área de transferência para o usuário colar (Ctrl+V) onde quiser.',
  parameters: {
    type: 'object',
    properties: { text: { type: 'string', description: 'Texto a copiar.' } },
    required: ['text'],
  },
  describe: (args) => {
    const text = typeof args.text === 'string' ? args.text : '';
    return `Copiar para a área de transferência (${text.length.toLocaleString('pt-BR')} caracteres):\n${text.slice(0, 300)}${text.length > 300 ? '…' : ''}`;
  },
  async execute(args) {
    const a = parseArgs('clipboard_write', z.object({ text: z.string({ error: 'informe o texto' }).max(1_000_000) }), args);
    try {
      await clipboard.write(a.text);
    } catch (error) {
      throw clipboardError(error);
    }
    return { output: { ok: true, chars: a.text.length }, summary: 'Copiado para a área de transferência' };
  },
};

// ─── Abrir programas ─────────────────────────────────────────────────────

/** Nomes em português → nomes de apps do macOS (pacotes .app são em inglês). */
const MAC_APP_ALIASES: Record<string, string> = {
  calculadora: 'Calculator',
  calendario: 'Calendar',
  notas: 'Notes',
  lembretes: 'Reminders',
  musica: 'Music',
  fotos: 'Photos',
  mensagens: 'Messages',
  mapas: 'Maps',
  contatos: 'Contacts',
  relogio: 'Clock',
  'pre-visualizacao': 'Preview',
  'visualizador de imagens': 'Preview',
  'editor de texto': 'TextEdit',
  'ajustes do sistema': 'System Settings',
  configuracoes: 'System Settings',
  'preferencias do sistema': 'System Preferences',
  'monitor de atividade': 'Activity Monitor',
  'loja de apps': 'App Store',
  livros: 'Books',
  podcasts: 'Podcasts',
  'captura de tela': 'Screenshot',
};

async function macFindApp(query: string): Promise<string | null> {
  const dirs = ['/Applications', '/System/Applications', '/System/Applications/Utilities', '/Applications/Utilities', path.join(os.homedir(), 'Applications')];
  const q = foldText(query);
  let best: { name: string; score: number } | null = null;
  for (const dir of dirs) {
    let entries: string[] = [];
    try {
      entries = await fs.promises.readdir(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.endsWith('.app')) continue;
      const name = entry.slice(0, -4);
      const f = foldText(name);
      const score = f === q ? 100 : f.startsWith(q) ? 60 : f.includes(q) ? 40 : 0;
      if (score > (best?.score ?? 0)) best = { name: path.join(dir, entry), score };
    }
  }
  return best?.name ?? null;
}

interface DesktopEntry {
  id: string;
  file: string;
  names: string[];
  exec: string;
}

async function linuxDesktopEntries(): Promise<DesktopEntry[]> {
  const home = os.homedir();
  const dataDirs = (process.env.XDG_DATA_DIRS || '/usr/local/share:/usr/share').split(':');
  const dirs = [
    path.join(process.env.XDG_DATA_HOME || path.join(home, '.local/share'), 'applications'),
    ...dataDirs.map((d) => path.join(d, 'applications')),
    '/var/lib/flatpak/exports/share/applications',
    path.join(home, '.local/share/flatpak/exports/share/applications'),
    '/var/lib/snapd/desktop/applications',
  ];
  const seen = new Set<string>();
  const result: DesktopEntry[] = [];
  for (const dir of dirs) {
    let files: string[] = [];
    try {
      files = await fs.promises.readdir(dir);
    } catch {
      continue;
    }
    for (const f of files) {
      if (!f.endsWith('.desktop') || seen.has(f)) continue;
      seen.add(f);
      let content = '';
      try {
        content = await fs.promises.readFile(path.join(dir, f), 'utf8');
      } catch {
        continue;
      }
      const main = content.split(/^\[(?!Desktop Entry\])/m)[0];
      if (/^NoDisplay=true/m.test(main) || /^Hidden=true/m.test(main) || !/^Type=Application/m.test(main)) continue;
      const names = [...main.matchAll(/^(?:Name|GenericName|Name\[pt_BR\]|Name\[pt\]|GenericName\[pt_BR\]|Keywords\[pt_BR\]|Keywords)=(.+)$/gm)].flatMap((m) =>
        m[1].split(';').map((s) => s.trim()).filter(Boolean),
      );
      const exec = main.match(/^Exec=(.+)$/m)?.[1] ?? '';
      if (names.length && exec) result.push({ id: f.replace(/\.desktop$/, ''), file: path.join(dir, f), names, exec });
    }
  }
  return result;
}

function splitExec(exec: string): string[] {
  const parts: string[] = [];
  const re = /"((?:[^"\\]|\\.)*)"|(\S+)/g;
  for (const m of exec.matchAll(re)) {
    const token = m[1] !== undefined ? m[1].replace(/\\(.)/g, '$1') : m[2];
    if (/^%[a-zA-Z]$/.test(token)) continue;
    parts.push(token.replace(/%%/g, '%'));
  }
  return parts;
}

async function openAppWindows(name: string, args: string[]): Promise<string> {
  const argList = args.length ? `@(${args.map(psQuote).join(', ')})` : '@()';
  const script = [
    `$name = ${psQuote(name)}`,
    `$argList = ${argList}`,
    'try {',
    '  if ($argList.Count -gt 0) { Start-Process -FilePath $name -ArgumentList $argList -ErrorAction Stop }',
    '  else { Start-Process -FilePath $name -ErrorAction Stop }',
    '  Write-Output "OK|$name"; exit 0',
    '} catch { }',
    // Apps do Menu Iniciar (inclui os da Microsoft Store), com nomes localizados ("Calculadora").
    '$app = Get-StartApps | Where-Object { $_.Name -like "*$name*" } | Sort-Object { $_.Name.Length } | Select-Object -First 1',
    'if ($app) { Start-Process ("shell:AppsFolder\\" + $app.AppID); Write-Output ("OK|" + $app.Name); exit 0 }',
    'Write-Output "NOTFOUND"; exit 2',
  ].join('\n');
  const r = await runPowerShell(script, { timeoutMs: 30_000 });
  const line = lastLine(r);
  if (line.startsWith('OK|')) return line.slice(3);
  if (line === 'NOTFOUND') throw new Error(`Não encontrei um programa chamado "${name}" no Windows (nem no Menu Iniciar).`);
  throw new Error(`Não consegui abrir "${name}": ${failureText(r)}`);
}

async function openAppMac(name: string, args: string[]): Promise<string> {
  const candidates = [MAC_APP_ALIASES[foldText(name)], name].filter((c): c is string => Boolean(c));
  for (const candidate of candidates) {
    const r = await execProgram('open', ['-a', candidate, ...(args.length ? ['--args', ...args] : [])], { timeoutMs: 15_000 });
    if (r.exitCode === 0) return candidate;
  }
  const found = await macFindApp(MAC_APP_ALIASES[foldText(name)] ?? name);
  if (found) {
    const r = await execProgram('open', ['-a', found, ...(args.length ? ['--args', ...args] : [])], { timeoutMs: 15_000 });
    if (r.exitCode === 0) return path.basename(found, '.app');
  }
  throw new Error(`Não encontrei um aplicativo chamado "${name}" no Mac.`);
}

async function openAppLinux(name: string, args: string[]): Promise<string> {
  const q = foldText(name);
  const entries = await linuxDesktopEntries();
  let best: { entry: DesktopEntry; score: number } | null = null;
  for (const entry of entries) {
    for (const n of [entry.id, ...entry.names]) {
      const f = foldText(n);
      const score = f === q ? 100 : f.startsWith(q) ? 60 : f.includes(q) ? 40 : 0;
      if (score > (best?.score ?? 0)) best = { entry, score };
    }
  }
  if (best) {
    if (!args.length && (await commandExists('gtk-launch'))) {
      const r = await execProgram('gtk-launch', [best.entry.id], { timeoutMs: 15_000 }).catch(() => null);
      if (r && r.exitCode === 0) return best.entry.names[0];
    }
    const [cmd, ...rest] = splitExec(best.entry.exec);
    if (cmd) {
      await launchDetached(cmd, [...rest, ...args]);
      return best.entry.names[0];
    }
  }
  if (await commandExists(name)) {
    await launchDetached(name, args);
    return name;
  }
  throw new Error(`Não encontrei um aplicativo chamado "${name}" neste Linux.`);
}

const openApp: ToolSpec = {
  name: 'open_app',
  label: 'Abrindo programa',
  group: 'computer',
  risk: 'confirm',
  riskFor: (args) => (Array.isArray(args.args) && args.args.length > 0 ? 'dangerous' : 'confirm'),
  timeoutMs: 45_000,
  description:
    'Abre um programa instalado pelo nome, como o usuário diria: "Spotify", "Calculadora", "Word", "Chrome", ' +
    '"Bloco de Notas" (notepad), "VS Code" (code), "Explorador de Arquivos" (explorer), "Configurações". ' +
    'Procura também no Menu Iniciar/Aplicativos com nomes em português. Para abrir um arquivo ou site, use open_path.',
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Nome do programa.' },
      args: { type: 'array', items: { type: 'string' }, description: 'Argumentos de linha de comando (opcional, avançado).' },
    },
    required: ['name'],
  },
  describe: (args) => {
    const extra = Array.isArray(args.args) && args.args.length ? ` com argumentos: ${args.args.map(String).join(' ')}` : '';
    return `Abrir o programa "${argText(args, 'name')}"${extra}`;
  },
  async execute(args) {
    const a = parseArgs(
      'open_app',
      z.object({ name: requiredText('o nome do programa').max(200), args: z.array(z.string().max(2000)).max(30).nullish() }),
      args,
    );
    const extra = a.args ?? [];
    const opened = isWin ? await openAppWindows(a.name, extra) : isMac ? await openAppMac(a.name, extra) : await openAppLinux(a.name, extra);
    return { output: { ok: true, opened }, summary: `Abrindo ${opened}` };
  },
};

// ─── Notificações ────────────────────────────────────────────────────────

function xmlEscape(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

async function notifyWindows(title: string, message: string): Promise<void> {
  const toastXml = `<toast><visual><binding template="ToastGeneric"><text>${xmlEscape(title)}</text><text>${xmlEscape(message)}</text></binding></visual></toast>`;
  const script = [
    'try {',
    '  [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null',
    '  [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null',
    '  $xml = New-Object Windows.Data.Xml.Dom.XmlDocument',
    `  $xml.LoadXml(${psQuote(toastXml)})`,
    '  $toast = New-Object Windows.UI.Notifications.ToastNotification $xml',
    "  $appId = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe'",
    '  [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($appId).Show($toast)',
    '  Write-Output "OK"; exit 0',
    '} catch {',
    // Plano B: balão da bandeja do sistema (funciona em qualquer Windows).
    '  Add-Type -AssemblyName System.Windows.Forms',
    '  Add-Type -AssemblyName System.Drawing',
    '  $n = New-Object System.Windows.Forms.NotifyIcon',
    '  $n.Icon = [System.Drawing.SystemIcons]::Information',
    `  $n.BalloonTipTitle = ${psQuote(title)}`,
    `  $n.BalloonTipText = ${psQuote(message)}`,
    '  $n.Visible = $true',
    '  $n.ShowBalloonTip(8000)',
    '  Start-Sleep -Seconds 8',
    '  $n.Dispose()',
    '  Write-Output "OK"; exit 0',
    '}',
  ].join('\n');
  const r = await runPowerShell(script, { timeoutMs: 25_000 });
  if (lastLine(r) !== 'OK') throw new Error(failureText(r));
}

const notify: ToolSpec = {
  name: 'notify',
  label: 'Enviando notificação',
  group: 'computer',
  risk: 'safe',
  timeoutMs: 30_000,
  description:
    'Mostra uma notificação nativa do sistema (canto da tela), mesmo com o navegador minimizado. ' +
    'Use para avisos importantes ou quando o usuário pedir para ser avisado de algo.',
  parameters: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'Título curto.' },
      message: { type: 'string', description: 'Texto da notificação.' },
    },
    required: ['message'],
  },
  async execute(args) {
    const a = parseArgs(
      'notify',
      z.object({ title: z.string().trim().max(120).nullish(), message: requiredText('a mensagem').max(1000) }),
      args,
    );
    const title = a.title || 'Lärk';
    try {
      if (isWin) await notifyWindows(title, a.message);
      else if (isMac) {
        const r = await osascript(['on run argv', 'display notification (item 2 of argv) with title (item 1 of argv)', 'end run'], [title, a.message]);
        if (r.exitCode !== 0) throw new Error(failureText(r));
      } else {
        if (!(await commandExists('notify-send'))) throw new Error('notify-send não está instalado (pacote libnotify-bin).');
        const r = await execProgram('notify-send', ['-a', 'Lärk', title, a.message], { timeoutMs: 10_000 });
        if (r.exitCode !== 0) throw new Error(failureText(r));
      }
    } catch (error) {
      throw new Error(`Não consegui mostrar a notificação: ${error instanceof Error ? error.message : String(error)}`);
    }
    return { output: { ok: true, title, message: a.message }, summary: `Notificação: ${title}` };
  },
};

// ─── Bloquear a tela ─────────────────────────────────────────────────────

async function tryCommands(attempts: [string, string[]][]): Promise<boolean> {
  for (const [cmd, args] of attempts) {
    if (!(await commandExists(cmd))) continue;
    const r = await execProgram(cmd, args, { timeoutMs: 10_000 }).catch(() => null);
    if (r && r.exitCode === 0) return true;
  }
  return false;
}

const lockScreen: ToolSpec = {
  name: 'lock_screen',
  label: 'Bloqueando a tela',
  group: 'computer',
  risk: 'confirm',
  description: 'Bloqueia a tela do computador imediatamente (exige a senha do usuário para voltar). Use quando ele pedir para bloquear o PC.',
  parameters: { type: 'object', properties: {} },
  describe: () => 'Bloquear a tela do computador agora',
  async execute() {
    let ok = false;
    if (isWin) {
      const r = await execProgram('rundll32.exe', ['user32.dll,LockWorkStation'], { timeoutMs: 10_000 });
      ok = r.exitCode === 0;
    } else if (isMac) {
      const r = await osascript(['tell application "System Events" to keystroke "q" using {control down, command down}']).catch(() => null);
      ok = Boolean(r && r.exitCode === 0);
      if (!ok) ok = await tryCommands([['pmset', ['displaysleepnow']]]);
    } else {
      ok = await tryCommands([
        ['loginctl', ['lock-session']],
        ['xdg-screensaver', ['lock']],
        ['gnome-screensaver-command', ['-l']],
        ['dm-tool', ['lock']],
        ['dbus-send', ['--session', '--dest=org.freedesktop.ScreenSaver', '--type=method_call', '/org/freedesktop/ScreenSaver', 'org.freedesktop.ScreenSaver.Lock']],
      ]);
    }
    if (!ok) throw new Error('Não consegui bloquear a tela neste sistema.');
    return { output: { ok: true }, summary: 'Tela bloqueada' };
  },
};

// ─── Volume ──────────────────────────────────────────────────────────────

/** C# para o volume mestre via CoreAudio (IAudioEndpointVolume), sem ferramentas externas. */
const WINDOWS_AUDIO_CS = `
using System;
using System.Runtime.InteropServices;
[Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioEndpointVolume {
  int f(); int g(); int h(); int i();
  int SetMasterVolumeLevelScalar(float fLevel, Guid pguidEventContext);
  int j();
  int GetMasterVolumeLevelScalar(out float pfLevel);
  int k(); int l(); int m(); int n();
  int SetMute([MarshalAs(UnmanagedType.Bool)] bool bMute, Guid pguidEventContext);
  int GetMute(out bool pbMute);
}
[Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDevice { int Activate(ref Guid id, int clsCtx, int activationParams, out IAudioEndpointVolume aev); }
[Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDeviceEnumerator { int f(); int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice endpoint); }
[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class MMDeviceEnumeratorComObject { }
public class LarkAudio {
  static IAudioEndpointVolume Vol() {
    var enumerator = new MMDeviceEnumeratorComObject() as IMMDeviceEnumerator;
    IMMDevice dev = null;
    Marshal.ThrowExceptionForHR(enumerator.GetDefaultAudioEndpoint(0, 1, out dev));
    IAudioEndpointVolume epv = null;
    var epvid = typeof(IAudioEndpointVolume).GUID;
    Marshal.ThrowExceptionForHR(dev.Activate(ref epvid, 23, 0, out epv));
    return epv;
  }
  public static float Volume {
    get { float v = -1; Marshal.ThrowExceptionForHR(Vol().GetMasterVolumeLevelScalar(out v)); return v; }
    set { Marshal.ThrowExceptionForHR(Vol().SetMasterVolumeLevelScalar(value, Guid.Empty)); }
  }
  public static bool Mute {
    get { bool mute; Marshal.ThrowExceptionForHR(Vol().GetMute(out mute)); return mute; }
    set { Marshal.ThrowExceptionForHR(Vol().SetMute(value, Guid.Empty)); }
  }
}`;

interface VolumeState {
  level: number | null;
  muted: boolean | null;
}

async function volumeWindows(level: number | null, mute: boolean | null): Promise<VolumeState> {
  const script = [
    "Add-Type -TypeDefinition @'",
    WINDOWS_AUDIO_CS,
    "'@",
    level !== null ? `[LarkAudio]::Volume = ${(level / 100).toFixed(2)}` : '',
    mute !== null ? `[LarkAudio]::Mute = $${mute ? 'true' : 'false'}` : '',
    'Write-Output ("{0}|{1}" -f [math]::Round([LarkAudio]::Volume * 100), [LarkAudio]::Mute)',
  ].join('\n');
  const r = await runPowerShell(script, { timeoutMs: 30_000 });
  const m = lastLine(r).match(/^(\d+)\|(True|False)$/i);
  if (!m) throw new Error(`Não consegui controlar o volume: ${failureText(r)}`);
  return { level: Number(m[1]), muted: m[2].toLowerCase() === 'true' };
}

async function volumeMac(level: number | null, mute: boolean | null): Promise<VolumeState> {
  const lines: string[] = [];
  if (level !== null) lines.push(`set volume output volume ${Math.round(level)}`);
  if (mute !== null) lines.push(`set volume output muted ${mute ? 'true' : 'false'}`);
  lines.push('set s to get volume settings', 'return ((output volume of s) as text) & "|" & ((output muted of s) as text)');
  const r = await osascript(lines);
  const m = lastLine(r).match(/^(\d+|missing value)\|(true|false|missing value)$/);
  if (r.exitCode !== 0 || !m) throw new Error(`Não consegui controlar o volume: ${failureText(r)}`);
  return { level: m[1] === 'missing value' ? null : Number(m[1]), muted: m[2] === 'missing value' ? null : m[2] === 'true' };
}

async function volumeLinux(level: number | null, mute: boolean | null): Promise<VolumeState> {
  if (await commandExists('pactl')) {
    if (level !== null) await execProgram('pactl', ['set-sink-volume', '@DEFAULT_SINK@', `${Math.round(level)}%`], { timeoutMs: 10_000 });
    if (mute !== null) await execProgram('pactl', ['set-sink-mute', '@DEFAULT_SINK@', mute ? '1' : '0'], { timeoutMs: 10_000 });
    const v = await execProgram('pactl', ['get-sink-volume', '@DEFAULT_SINK@'], { timeoutMs: 10_000 });
    const m = await execProgram('pactl', ['get-sink-mute', '@DEFAULT_SINK@'], { timeoutMs: 10_000 });
    const pct = v.stdout.match(/(\d+)%/);
    if (v.exitCode === 0 && pct) return { level: Number(pct[1]), muted: /yes|sim/i.test(m.stdout) };
  }
  if (await commandExists('wpctl')) {
    if (level !== null) await execProgram('wpctl', ['set-volume', '@DEFAULT_AUDIO_SINK@', (level / 100).toFixed(2)], { timeoutMs: 10_000 });
    if (mute !== null) await execProgram('wpctl', ['set-mute', '@DEFAULT_AUDIO_SINK@', mute ? '1' : '0'], { timeoutMs: 10_000 });
    const v = await execProgram('wpctl', ['get-volume', '@DEFAULT_AUDIO_SINK@'], { timeoutMs: 10_000 });
    const m = v.stdout.match(/Volume:\s*([\d.]+)/);
    if (v.exitCode === 0 && m) return { level: Math.round(Number(m[1]) * 100), muted: /MUTED/.test(v.stdout) };
  }
  if (await commandExists('amixer')) {
    if (level !== null) await execProgram('amixer', ['-q', 'sset', 'Master', `${Math.round(level)}%`], { timeoutMs: 10_000 });
    if (mute !== null) await execProgram('amixer', ['-q', 'sset', 'Master', mute ? 'mute' : 'unmute'], { timeoutMs: 10_000 });
    const v = await execProgram('amixer', ['get', 'Master'], { timeoutMs: 10_000 });
    const m = v.stdout.match(/\[(\d+)%\](?:.*\[(on|off)\])?/);
    if (v.exitCode === 0 && m) return { level: Number(m[1]), muted: m[2] ? m[2] === 'off' : null };
  }
  throw new Error('Não encontrei um controle de áudio (pactl, wpctl ou amixer).');
}

function setVolumeState(level: number | null, mute: boolean | null): Promise<VolumeState> {
  if (isWin) return volumeWindows(level, mute);
  if (isMac) return volumeMac(level, mute);
  return volumeLinux(level, mute);
}

const setVolume: ToolSpec = {
  name: 'set_volume',
  label: 'Ajustando o volume',
  group: 'computer',
  risk: 'confirm',
  riskFor: (args) => (args.level == null && args.mute == null ? 'safe' : 'confirm'),
  timeoutMs: 45_000,
  description:
    'Ajusta o volume geral do computador (0 a 100) e/ou silencia (mute). Sem argumentos, apenas informa o volume atual.',
  parameters: {
    type: 'object',
    properties: {
      level: { type: 'integer', minimum: 0, maximum: 100, description: 'Novo volume de 0 a 100.' },
      mute: { type: 'boolean', description: 'true = silenciar; false = tirar do mudo.' },
    },
  },
  describe: (args) => {
    const parts: string[] = [];
    if (args.level != null) parts.push(`volume em ${String(args.level)}%`);
    if (args.mute != null) parts.push(args.mute === true || args.mute === 'true' ? 'silenciar' : 'tirar do mudo');
    return `Ajustar o som: ${parts.join(' e ') || 'consultar volume'}`;
  },
  async execute(args) {
    const a = parseArgs('set_volume', z.object({ level: optionalInt(0, 100), mute: optionalBool }), args);
    const state = await setVolumeState(a.level ?? null, a.mute ?? null);
    const changed = a.level !== null && a.level !== undefined ? true : a.mute !== null && a.mute !== undefined;
    return {
      output: { ok: true, level: state.level, muted: state.muted },
      summary: `${changed ? 'Volume ajustado' : 'Volume atual'}: ${state.level ?? '?'}%${state.muted ? ' (mudo)' : ''}`,
    };
  },
};

// ─── Teclas de mídia ─────────────────────────────────────────────────────

type MediaAction = 'play_pause' | 'next' | 'previous' | 'stop' | 'volume_up' | 'volume_down' | 'mute';

const WINDOWS_VK: Record<MediaAction, number> = {
  play_pause: 0xb3,
  next: 0xb0,
  previous: 0xb1,
  stop: 0xb2,
  mute: 0xad,
  volume_down: 0xae,
  volume_up: 0xaf,
};

async function mediaWindows(action: MediaAction): Promise<void> {
  const vk = WINDOWS_VK[action];
  const presses = action === 'volume_up' || action === 'volume_down' ? 5 : 1; // cada tecla = 2%
  const script = [
    "Add-Type -TypeDefinition @'",
    'using System; using System.Runtime.InteropServices;',
    'public static class LarkKeys {',
    '  [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);',
    '}',
    "'@",
    `for ($i = 0; $i -lt ${presses}; $i++) {`,
    `  [LarkKeys]::keybd_event(${vk}, 0, 1, [UIntPtr]::Zero)`,
    `  [LarkKeys]::keybd_event(${vk}, 0, 3, [UIntPtr]::Zero)`,
    '  Start-Sleep -Milliseconds 30',
    '}',
    'Write-Output "OK"',
  ].join('\n');
  const r = await runPowerShell(script, { timeoutMs: 30_000 });
  if (lastLine(r) !== 'OK') throw new Error(failureText(r));
}

const MAC_PLAYER_COMMAND: Partial<Record<MediaAction, string>> = {
  play_pause: 'playpause',
  next: 'next track',
  previous: 'previous track',
  stop: 'pause',
};

async function mediaMac(action: MediaAction): Promise<string> {
  if (action === 'volume_up' || action === 'volume_down' || action === 'mute') {
    const current = await volumeMac(null, null);
    if (action === 'mute') await volumeMac(null, !current.muted);
    else await volumeMac(Math.max(0, Math.min(100, (current.level ?? 50) + (action === 'volume_up' ? 10 : -10))), null);
    return 'sistema';
  }
  const command = MAC_PLAYER_COMMAND[action]!;
  for (const app of ['Spotify', 'Music']) {
    // Verifica antes: um "tell" para app não instalado falha já na compilação do script.
    const running = await osascript([`return application "${app}" is running`]);
    if (lastLine(running) !== 'true') continue;
    const r = await osascript([`tell application "${app}" to ${command}`]);
    if (r.exitCode === 0) return app === 'Music' ? 'Música' : app;
  }
  throw new Error('Nenhum player compatível aberto (Spotify ou Música).');
}

async function mediaLinux(action: MediaAction): Promise<string> {
  if (action === 'volume_up' || action === 'volume_down' || action === 'mute') {
    const current = await volumeLinux(null, null);
    if (action === 'mute') await volumeLinux(null, !current.muted);
    else await volumeLinux(Math.max(0, Math.min(100, (current.level ?? 50) + (action === 'volume_up' ? 10 : -10))), null);
    return 'sistema';
  }
  const playerctl: Record<string, string> = { play_pause: 'play-pause', next: 'next', previous: 'previous', stop: 'stop' };
  if (await commandExists('playerctl')) {
    const r = await execProgram('playerctl', [playerctl[action]], { timeoutMs: 10_000 });
    if (r.exitCode === 0) return 'player ativo';
  }
  if (await commandExists('dbus-send')) {
    const list = await execProgram(
      'dbus-send',
      ['--session', '--dest=org.freedesktop.DBus', '--type=method_call', '--print-reply', '/org/freedesktop/DBus', 'org.freedesktop.DBus.ListNames'],
      { timeoutMs: 10_000 },
    );
    const player = list.stdout.match(/"(org\.mpris\.MediaPlayer2\.[^"]+)"/)?.[1];
    const method: Record<string, string> = { play_pause: 'PlayPause', next: 'Next', previous: 'Previous', stop: 'Stop' };
    if (player) {
      const r = await execProgram(
        'dbus-send',
        ['--session', '--type=method_call', `--dest=${player}`, '/org/mpris/MediaPlayer2', `org.mpris.MediaPlayer2.Player.${method[action]}`],
        { timeoutMs: 10_000 },
      );
      if (r.exitCode === 0) return player.replace('org.mpris.MediaPlayer2.', '');
    }
  }
  throw new Error('Nenhum player de mídia encontrado (instale "playerctl" ou abra um player compatível com MPRIS).');
}

const MEDIA_LABELS: Record<MediaAction, string> = {
  play_pause: 'Tocar/pausar',
  next: 'Próxima faixa',
  previous: 'Faixa anterior',
  stop: 'Parar',
  volume_up: 'Aumentar volume',
  volume_down: 'Diminuir volume',
  mute: 'Silenciar/reativar som',
};

const mediaKey: ToolSpec = {
  name: 'media_key',
  label: 'Controlando a mídia',
  group: 'computer',
  risk: 'confirm',
  timeoutMs: 45_000,
  description:
    'Controla a música/vídeo tocando no computador como as teclas de mídia do teclado: tocar/pausar, próxima, anterior, ' +
    'parar, aumentar/diminuir volume e mudo. Funciona com Spotify, YouTube no navegador, players do sistema etc.',
  parameters: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['play_pause', 'next', 'previous', 'stop', 'volume_up', 'volume_down', 'mute'],
        description: 'Ação de mídia.',
      },
    },
    required: ['action'],
  },
  describe: (args) => `Mídia: ${MEDIA_LABELS[argText(args, 'action') as MediaAction] ?? argText(args, 'action')}`,
  async execute(args) {
    const a = parseArgs(
      'media_key',
      z.object({ action: z.enum(['play_pause', 'next', 'previous', 'stop', 'volume_up', 'volume_down', 'mute'], { error: 'ação inválida' }) }),
      args,
    );
    let target = 'sistema';
    if (isWin) await mediaWindows(a.action);
    else if (isMac) target = await mediaMac(a.action);
    else target = await mediaLinux(a.action);
    return { output: { ok: true, action: a.action, target }, summary: MEDIA_LABELS[a.action] };
  },
};

export const desktopTools: ToolSpec[] = [
  takeScreenshot,
  clipboardRead,
  clipboardWrite,
  openApp,
  notify,
  lockScreen,
  setVolume,
  mediaKey,
];
