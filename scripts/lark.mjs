#!/usr/bin/env node
/**
 * Lärk — inicializador de um clique (Windows, macOS e Linux).
 *
 *   node scripts/lark.mjs              inicia o servidor e abre o Lärk como aplicativo
 *   node scripts/lark.mjs --background inicia o servidor em segundo plano (log em data/lark.log)
 *   node scripts/lark.mjs --no-open    não abre a janela (só o servidor)
 *   node scripts/lark.mjs --rebuild    recompila a interface e o servidor antes de iniciar
 *   node scripts/lark.mjs --stop       encerra um Lärk iniciado em segundo plano
 *
 * O que ele faz:
 *  1. confere o Node (≥ 20.11) e instala as dependências na primeira vez;
 *  2. compila (npm run build) se dist/ não existir ou estiver desatualizado;
 *  3. se o Lärk já estiver rodando, só abre a janela; senão inicia o servidor de produção;
 *  4. espera /api/health responder e abre a interface como aplicativo (Chrome/Edge/Brave com
 *     --app=URL, em uma janela própria); sem esses navegadores, usa o navegador padrão.
 * Sem dependências novas: só módulos do Node (e o pacote 'open', já instalado, como último recurso).
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = path.join(ROOT, 'data');
const PID_FILE = path.join(DATA_DIR, 'lark.pid');
const LOG_FILE = path.join(DATA_DIR, 'lark.log');
const SERVER_ENTRY = path.join(ROOT, 'dist', 'server', 'index.js');
const WEB_INDEX = path.join(ROOT, 'dist', 'web', 'index.html');
const isWin = process.platform === 'win32';
const isMac = process.platform === 'darwin';

const args = new Set(process.argv.slice(2));
const flags = {
  background: args.has('--background') || args.has('-b'),
  noOpen: args.has('--no-open'),
  rebuild: args.has('--rebuild'),
  stop: args.has('--stop'),
  help: args.has('--help') || args.has('-h'),
};

// ─── Saída no console ────────────────────────────────────────────────────

const color = process.stdout.isTTY && !process.env.NO_COLOR;
const red = (s) => (color ? `\x1b[38;5;196m${s}\x1b[0m` : s);
const gray = (s) => (color ? `\x1b[90m${s}\x1b[0m` : s);
const say = (s) => console.log(`${red('◆')} ${s}`);
const warn = (s) => console.warn(`${red('!')} ${s}`);

function fail(message) {
  console.error(`\n${red('✖')} ${message}\n`);
  process.exit(1);
}

// ─── .env (só o que o inicializador precisa: PORT, HOST e LARK_DB_PATH) ──

function readEnvFile() {
  const env = {};
  const file = path.join(ROOT, '.env');
  if (!fs.existsSync(file)) return env;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (!m) continue;
    let value = m[2];
    if (/^(['"]).*\1$/.test(value)) value = value.slice(1, -1);
    else value = value.replace(/\s+#.*$/, '');
    env[m[1]] = value;
  }
  return env;
}

const fileEnv = readEnvFile();
const envValue = (key, fallback) => process.env[key] || fileEnv[key] || fallback;
const PORT = Number(envValue('PORT', '8787')) || 8787;
const HOST = envValue('HOST', '127.0.0.1');
const LOCAL_HOST = ['0.0.0.0', '::', ''].includes(HOST) ? '127.0.0.1' : HOST.includes(':') ? `[${HOST}]` : HOST;
const BASE_URL = `http://${LOCAL_HOST === '127.0.0.1' ? 'localhost' : LOCAL_HOST}:${PORT}`;
const HEALTH_URL = `http://${LOCAL_HOST}:${PORT}/api/health`;

// ─── Utilidades ──────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function npm(argsList, opts = {}) {
  const result = spawnSync(isWin ? 'npm.cmd' : 'npm', argsList, { cwd: ROOT, stdio: 'inherit', shell: isWin, ...opts });
  if (result.error) fail(`Não consegui executar o npm (${result.error.message}). O Node.js foi instalado com o npm?`);
  return result.status === 0;
}

/** Arquivo mais recente (mtime) dentro das pastas indicadas, ignorando node_modules. */
function newestMtime(dirs) {
  let newest = 0;
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(tsx?|css|html|svg|json|webmanifest|js|mjs)$/.test(entry.name)) {
        try {
          newest = Math.max(newest, fs.statSync(full).mtimeMs);
        } catch {
          // arquivo sumiu no meio da varredura
        }
      }
    }
  };
  for (const d of dirs) walk(path.join(ROOT, d));
  return newest;
}

function mtime(file) {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return 0;
  }
}

async function health(timeoutMs = 1500) {
  try {
    const res = await fetch(HEALTH_URL, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    const body = await res.json();
    return body && body.ok ? body : null;
  } catch {
    return null;
  }
}

async function waitForHealth(timeoutMs, child) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (child && child.exitCode !== null) return null;
    const h = await health();
    if (h) return h;
    await sleep(400);
  }
  return null;
}

function readPid() {
  try {
    const pid = Number(fs.readFileSync(PID_FILE, 'utf8').trim());
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// ─── Navegador em modo aplicativo ────────────────────────────────────────

function findOnPath(names) {
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  const exts = isWin ? ['.exe', ''] : [''];
  for (const name of names) {
    for (const dir of dirs) {
      for (const ext of exts) {
        const full = path.join(dir, name + ext);
        try {
          if (fs.statSync(full).isFile()) return full;
        } catch {
          // segue procurando
        }
      }
    }
  }
  return null;
}

/** Chrome, Edge, Brave ou Chromium instalados (nessa ordem de preferência). */
function findAppBrowser() {
  const candidates = [];
  if (isWin) {
    const roots = [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA].filter(Boolean);
    const rel = [
      ['Google', 'Chrome', 'Application', 'chrome.exe'],
      ['Microsoft', 'Edge', 'Application', 'msedge.exe'],
      ['BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'],
      ['Chromium', 'Application', 'chrome.exe'],
    ];
    for (const r of rel) for (const root of roots) candidates.push(path.join(root, ...r));
  } else if (isMac) {
    const apps = [
      'Google Chrome.app/Contents/MacOS/Google Chrome',
      'Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      'Brave Browser.app/Contents/MacOS/Brave Browser',
      'Chromium.app/Contents/MacOS/Chromium',
    ];
    for (const app of apps) candidates.push(path.join('/Applications', app), path.join(os.homedir(), 'Applications', app));
  } else {
    const found = findOnPath([
      'google-chrome',
      'google-chrome-stable',
      'microsoft-edge',
      'microsoft-edge-stable',
      'brave-browser',
      'chromium',
      'chromium-browser',
    ]);
    if (found) candidates.push(found);
  }
  return candidates.find((c) => {
    try {
      return fs.statSync(c).isFile();
    } catch {
      return false;
    }
  }) ?? null;
}

/**
 * Abre o Lärk numa janela própria (sem barra de endereço). Devolve o processo do navegador quando
 * ele ficou "preso" à janela (perfil dedicado), ou null.
 */
async function openApp(url) {
  const browser = findAppBrowser();
  if (browser) {
    const profile = path.join(DATA_DIR, 'app-window');
    fs.mkdirSync(profile, { recursive: true });
    const child = spawn(
      browser,
      [
        `--app=${url}`,
        `--user-data-dir=${profile}`,
        '--window-size=1360,880',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-features=Translate',
        '--autoplay-policy=no-user-gesture-required',
      ],
      { stdio: 'ignore', detached: flags.background },
    );
    child.on('error', (e) => warn(`Não consegui abrir ${path.basename(browser)}: ${e.message}`));
    if (flags.background) child.unref();
    say(`Janela do Lärk aberta ${gray(`(${path.basename(browser)} em modo aplicativo)`)}`);
    return child;
  }
  try {
    const { default: open } = await import(pathToFileURL(path.join(ROOT, 'node_modules', 'open', 'index.js')).href);
    await open(url);
    say(`Lärk aberto no navegador padrão ${gray('(para a experiência de aplicativo e voz, use Chrome ou Edge)')}`);
  } catch {
    say(`Abra no navegador: ${red(url)}`);
  }
  return null;
}

// ─── Comandos ────────────────────────────────────────────────────────────

function printHelp() {
  console.log(`
${red('LÄRK')} — inicializador

  node scripts/lark.mjs              inicia e abre o Lärk
  node scripts/lark.mjs --background inicia em segundo plano (log em data/lark.log)
  node scripts/lark.mjs --no-open    só o servidor, sem abrir a janela
  node scripts/lark.mjs --rebuild    recompila antes de iniciar
  node scripts/lark.mjs --stop       encerra o Lärk em segundo plano
`);
}

function stopBackground() {
  const pid = readPid();
  if (!pid || !isAlive(pid)) {
    say('Nenhum Lärk em segundo plano foi encontrado.');
    try {
      fs.rmSync(PID_FILE, { force: true });
    } catch {
      // nada a limpar
    }
    return;
  }
  try {
    process.kill(pid, 'SIGTERM');
    fs.rmSync(PID_FILE, { force: true });
    say('Lärk encerrado. Até logo.');
  } catch (e) {
    fail(`Não consegui encerrar o processo ${pid}: ${e.message}`);
  }
}

function checkNode() {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 20 || (major === 20 && minor < 11)) {
    fail(`O Lärk precisa do Node.js 20.11 ou mais novo (você tem ${process.versions.node}). Baixe em https://nodejs.org`);
  }
}

function ensureInstalled() {
  if (fs.existsSync(path.join(ROOT, 'node_modules', 'hono'))) return;
  say('Primeira execução: instalando as dependências (isso leva alguns minutos)…');
  if (!npm(['install'])) fail('A instalação das dependências falhou. Veja as mensagens acima.');
}

function ensureBuilt() {
  const built = fs.existsSync(SERVER_ENTRY) && fs.existsSync(WEB_INDEX);
  const builtAt = Math.min(mtime(SERVER_ENTRY), mtime(WEB_INDEX));
  const stale = built && newestMtime(['server', 'web', 'shared']) > builtAt;
  if (built && !stale && !flags.rebuild) return;
  say(built ? 'Código atualizado: recompilando o Lärk…' : 'Compilando o Lärk pela primeira vez…');
  if (!npm(['run', 'build'])) {
    if (built) warn('A recompilação falhou; vou usar a versão compilada anterior.');
    else fail('A compilação falhou. Veja as mensagens acima.');
  }
}

function startServer() {
  const env = { ...process.env, NODE_ENV: 'production' };
  if (flags.background) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const out = fs.openSync(LOG_FILE, 'a');
    const child = spawn(process.execPath, [SERVER_ENTRY], {
      cwd: ROOT,
      env: { ...env, NO_COLOR: '1' },
      stdio: ['ignore', out, out],
      detached: true,
      windowsHide: true,
    });
    child.unref();
    fs.writeFileSync(PID_FILE, String(child.pid));
    return child;
  }
  return spawn(process.execPath, [SERVER_ENTRY], { cwd: ROOT, env, stdio: 'inherit' });
}

async function main() {
  if (flags.help) return printHelp();
  if (flags.stop) return stopBackground();

  checkNode();
  process.chdir(ROOT);

  const running = await health();
  if (running) {
    say(`O Lärk já está no ar em ${red(BASE_URL)}`);
    if (!flags.noOpen) await openApp(BASE_URL);
    return;
  }

  ensureInstalled();
  ensureBuilt();

  say('Despertando o Lärk…');
  const server = startServer();
  const ready = await waitForHealth(60_000, flags.background ? null : server);
  if (!ready) {
    if (!flags.background) server.kill();
    fail(
      flags.background
        ? `O servidor não respondeu a tempo. Veja o log em ${LOG_FILE}`
        : 'O servidor não respondeu a tempo. Veja as mensagens acima.',
    );
  }

  if (flags.background) {
    say(`Lärk em segundo plano em ${red(BASE_URL)} ${gray('(para encerrar: node scripts/lark.mjs --stop)')}`);
    if (!flags.noOpen) await openApp(BASE_URL);
    return;
  }

  const stopServer = () => {
    if (server.exitCode === null) server.kill('SIGTERM');
  };
  process.on('SIGINT', stopServer);
  process.on('SIGTERM', stopServer);
  server.on('exit', (code) => process.exit(code ?? 0));

  if (!flags.noOpen) {
    const windowProcess = await openApp(BASE_URL);
    if (windowProcess) {
      const openedAt = Date.now();
      windowProcess.on('exit', () => {
        // Se o navegador só repassou a janela para uma instância já aberta, ele sai na hora:
        // nesse caso o servidor continua até o Ctrl+C. Se a janela do Lärk foi fechada, encerra tudo.
        if (Date.now() - openedAt < 5000) return;
        say('Janela fechada — encerrando o Lärk.');
        stopServer();
      });
    }
  }
}

main().catch((e) => fail(e?.stack || String(e)));
