#!/usr/bin/env node
/**
 * Lärk — iniciar junto com o sistema.
 *
 *   node scripts/autostart.mjs install [--no-open]   liga (no próximo login o Lärk sobe sozinho)
 *   node scripts/autostart.mjs uninstall             desliga
 *   node scripts/autostart.mjs status                mostra se está ligado
 *
 * Windows: atalho .vbs oculto na pasta Inicializar do usuário (sem janela de console).
 * macOS:   LaunchAgent em ~/Library/LaunchAgents/com.lark.assistant.plist.
 * Linux:   ~/.config/autostart/lark.desktop (GNOME, KDE, XFCE, Cinnamon…).
 * Em todos, roda `node scripts/lark.mjs --background` (com --no-open, só o servidor).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LAUNCHER = path.join(ROOT, 'scripts', 'lark.mjs');
const NODE = process.execPath;
const [command = 'status', ...rest] = process.argv.slice(2);
const noOpen = rest.includes('--no-open');

const color = process.stdout.isTTY && !process.env.NO_COLOR;
const red = (s) => (color ? `\x1b[38;5;196m${s}\x1b[0m` : s);
const gray = (s) => (color ? `\x1b[90m${s}\x1b[0m` : s);
const say = (s) => console.log(`${red('◆')} ${s}`);

function fail(message) {
  console.error(`\n${red('✖')} ${message}\n`);
  process.exit(1);
}

const launcherArgs = ['--background', ...(noOpen ? ['--no-open'] : [])];

// ─── Windows ─────────────────────────────────────────────────────────────

function windowsTarget() {
  const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  return path.join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'Lark.vbs');
}

function windowsScript() {
  const q = (s) => `""${s}""`;
  const cmd = [q(NODE), q(LAUNCHER), ...launcherArgs].join(' ');
  // Run com estilo 0 = sem janela; False = não espera terminar.
  return [
    "' Lärk — iniciado junto com o Windows (criado por scripts/autostart.mjs)",
    'Set shell = CreateObject("WScript.Shell")',
    `shell.CurrentDirectory = "${ROOT}"`,
    `shell.Run "${cmd}", 0, False`,
    '',
  ].join('\r\n');
}

// ─── macOS ───────────────────────────────────────────────────────────────

const MAC_LABEL = 'com.lark.assistant';

function macTarget() {
  return path.join(os.homedir(), 'Library', 'LaunchAgents', `${MAC_LABEL}.plist`);
}

function xml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function macPlist() {
  const programArgs = [NODE, LAUNCHER, ...launcherArgs].map((a) => `    <string>${xml(a)}</string>`).join('\n');
  const log = path.join(ROOT, 'data', 'lark-launchd.log');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${MAC_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${programArgs}
  </array>
  <key>WorkingDirectory</key>
  <string>${xml(ROOT)}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${xml(`${path.dirname(NODE)}:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin`)}</string>
  </dict>
  <key>StandardOutPath</key>
  <string>${xml(log)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(log)}</string>
</dict>
</plist>
`;
}

// ─── Linux ───────────────────────────────────────────────────────────────

function linuxTarget() {
  const configHome = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(configHome, 'autostart', 'lark.desktop');
}

function desktopQuote(s) {
  return `"${s.replace(/(["`$\\])/g, '\\$1')}"`;
}

function linuxDesktop() {
  const exec = [NODE, LAUNCHER, ...launcherArgs].map(desktopQuote).join(' ');
  return `[Desktop Entry]
Type=Application
Name=Lärk
Comment=Assistente pessoal — a consciência do seu computador
Exec=${exec}
Path=${ROOT}
Icon=${path.join(ROOT, 'web', 'public', 'icon.svg')}
Terminal=false
X-GNOME-Autostart-enabled=true
X-GNOME-Autostart-Delay=5
`;
}

// ─── Comandos ────────────────────────────────────────────────────────────

function target() {
  if (process.platform === 'win32') return { file: windowsTarget(), content: windowsScript, name: 'pasta Inicializar do Windows' };
  if (process.platform === 'darwin') return { file: macTarget(), content: macPlist, name: 'LaunchAgents do macOS' };
  return { file: linuxTarget(), content: linuxDesktop, name: 'inicialização automática da sessão' };
}

function install() {
  if (!fs.existsSync(LAUNCHER)) fail(`Não encontrei ${LAUNCHER}.`);
  const t = target();
  try {
    fs.mkdirSync(path.dirname(t.file), { recursive: true });
    fs.mkdirSync(path.join(ROOT, 'data'), { recursive: true });
    // O Windows Script Host só entende acentos em caminhos (ex.: C:\Users\João) com UTF-16 + BOM.
    if (process.platform === 'win32') fs.writeFileSync(t.file, `\ufeff${t.content()}`, { encoding: 'utf16le' });
    else fs.writeFileSync(t.file, t.content(), { encoding: 'utf8', mode: 0o644 });
  } catch (e) {
    fail(`Não consegui gravar ${t.file}: ${e.message}`);
  }
  say(`Pronto: o Lärk vai iniciar junto com o sistema ${gray(`(${t.name})`)}.`);
  say(gray(`Arquivo: ${t.file}`));
  if (noOpen) say(gray('Ele subirá só em segundo plano; abra a janela pelo atalho quando quiser.'));
  say(gray('Para desligar: node scripts/autostart.mjs uninstall'));
}

function uninstall() {
  const t = target();
  if (!fs.existsSync(t.file)) {
    say('A inicialização automática já estava desligada.');
    return;
  }
  try {
    fs.rmSync(t.file, { force: true });
  } catch (e) {
    fail(`Não consegui remover ${t.file}: ${e.message}`);
  }
  say('Inicialização automática desligada.');
}

function status() {
  const t = target();
  say(fs.existsSync(t.file) ? `Ligada ${gray(`(${t.file})`)}` : 'Desligada. Para ligar: node scripts/autostart.mjs install');
}

switch (command) {
  case 'install':
  case 'instalar':
    install();
    break;
  case 'uninstall':
  case 'remove':
  case 'desinstalar':
    uninstall();
    break;
  case 'status':
    status();
    break;
  default:
    fail(`Comando desconhecido: "${command}". Use install, uninstall ou status.`);
}
