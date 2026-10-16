/**
 * Resolução de caminhos "humanos" e proteção de pastas críticas.
 *
 * `resolveUserPath` entende "~", variáveis de ambiente (%USERPROFILE%, $HOME), URLs file:// e atalhos
 * em português ou inglês ("Área de Trabalho/projeto", "Documentos", "Downloads"...), usando as pastas
 * reais do sistema (OneDrive no Windows, XDG no Linux). Caminhos relativos partem da pasta pessoal.
 *
 * Leitura é livre. Operações destrutivas (apagar, mover, sobrescrever) são bloqueadas apenas na raiz
 * do sistema, em pastas críticas do SO, nas chaves SSH/GPG e no banco de memória do próprio Lärk.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { config } from '../config.js';
import { getSettings } from '../memory/settings.js';

const platform = process.platform;
const isWin = platform === 'win32';
const caseInsensitive = isWin || platform === 'darwin';

// ─── Texto ──────────────────────────────────────────────────────────────

/** Minúsculas sem acentos (para comparar nomes de pastas/arquivos com tolerância). */
export function foldText(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

// ─── Pastas conhecidas ──────────────────────────────────────────────────

export type KnownFolderKey = 'home' | 'desktop' | 'documents' | 'downloads' | 'pictures' | 'music' | 'videos';

export interface KnownFolder {
  key: KnownFolderKey | 'favorite';
  /** Nome em PT-BR para exibir ao usuário. */
  label: string;
  path: string;
  exists: boolean;
  /** Apelidos aceitos em resolveUserPath (normalizados com foldText). */
  aliases: string[];
}

const FOLDER_LABELS: Record<KnownFolderKey, string> = {
  home: 'Pasta pessoal',
  desktop: 'Área de Trabalho',
  documents: 'Documentos',
  downloads: 'Downloads',
  pictures: 'Imagens',
  music: 'Músicas',
  videos: 'Vídeos',
};

const FOLDER_ALIASES: Record<KnownFolderKey, string[]> = {
  home: ['~', 'home', 'pasta pessoal', 'minha pasta', 'pasta do usuario', 'perfil'],
  desktop: ['desktop', 'area de trabalho', 'mesa'],
  documents: ['documents', 'documentos', 'meus documentos', 'my documents', 'docs'],
  downloads: ['downloads', 'download', 'transferencias', 'baixados', 'baixadas'],
  pictures: ['pictures', 'imagens', 'minhas imagens', 'fotos', 'photos', 'my pictures'],
  music: ['music', 'musicas', 'musica', 'minhas musicas', 'my music'],
  videos: ['videos', 'meus videos', 'movies', 'filmes', 'my videos'],
};

const DEFAULT_SUBFOLDER: Record<Exclude<KnownFolderKey, 'home'>, string> = {
  desktop: 'Desktop',
  documents: 'Documents',
  downloads: 'Downloads',
  pictures: 'Pictures',
  music: 'Music',
  videos: platform === 'darwin' ? 'Movies' : 'Videos',
};

/** Pastas reais descobertas no sistema (registro do Windows / XDG). */
let detected: Partial<Record<KnownFolderKey, string>> | null = null;
let windowsDetection: Promise<void> | null = null;

function homeDir(): string {
  return os.homedir();
}

function existsDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** Linux: lê ~/.config/user-dirs.dirs (nomes localizados, ex.: "Área de Trabalho"). */
function detectXdgFolders(): Partial<Record<KnownFolderKey, string>> {
  const result: Partial<Record<KnownFolderKey, string>> = {};
  const configHome = process.env.XDG_CONFIG_HOME || path.join(homeDir(), '.config');
  let content = '';
  try {
    content = fs.readFileSync(path.join(configHome, 'user-dirs.dirs'), 'utf8');
  } catch {
    return result;
  }
  const map: Record<string, KnownFolderKey> = {
    DESKTOP: 'desktop',
    DOCUMENTS: 'documents',
    DOWNLOAD: 'downloads',
    PICTURES: 'pictures',
    MUSIC: 'music',
    VIDEOS: 'videos',
  };
  for (const line of content.split(/\r?\n/)) {
    const m = line.match(/^\s*XDG_([A-Z]+)_DIR\s*=\s*"(.*)"\s*$/);
    if (!m || !map[m[1]]) continue;
    const value = m[2].replace(/^\$HOME/, homeDir()).replace(/\\"/g, '"');
    if (path.isAbsolute(value) && path.resolve(value) !== path.resolve(homeDir())) result[map[m[1]]] = path.resolve(value);
  }
  return result;
}

/** Windows: heurística imediata (OneDrive) enquanto a consulta ao registro não termina. */
function windowsHeuristicFolder(key: Exclude<KnownFolderKey, 'home'>): string {
  const home = homeDir();
  const oneDriveRoots = [process.env.OneDriveConsumer, process.env.OneDriveCommercial, process.env.OneDrive].filter(
    (v): v is string => Boolean(v),
  );
  const localized: Partial<Record<KnownFolderKey, string[]>> = {
    desktop: ['Desktop', 'Área de Trabalho'],
    documents: ['Documents', 'Documentos'],
    pictures: ['Pictures', 'Imagens'],
  };
  if (key !== 'downloads' && key !== 'music' && key !== 'videos') {
    for (const root of oneDriveRoots) {
      for (const name of localized[key] ?? []) {
        const candidate = path.join(root, name);
        if (existsDir(candidate)) return candidate;
      }
    }
  }
  return path.join(home, DEFAULT_SUBFOLDER[key]);
}

/** Windows: lê as pastas reais em "Shell Folders" (já expandidas) via PowerShell, em segundo plano. */
function startWindowsDetection(): void {
  if (!isWin || windowsDetection) return;
  const script = [
    '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
    "$k = Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Shell Folders' -ErrorAction SilentlyContinue",
    '$o = [ordered]@{',
    "  desktop = $k.'Desktop'; documents = $k.'Personal'; pictures = $k.'My Pictures';",
    "  music = $k.'My Music'; videos = $k.'My Video'; downloads = $k.'{374DE290-123F-4565-9164-39C4925E467B}'",
    '}',
    '$o | ConvertTo-Json -Compress',
  ].join('\n');
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  windowsDetection = new Promise<void>((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
      { timeout: 10_000, windowsHide: true, encoding: 'utf8' },
      (error, stdout) => {
        if (!error) {
          try {
            const parsed = JSON.parse(stdout.trim()) as Record<string, unknown>;
            const result: Partial<Record<KnownFolderKey, string>> = {};
            for (const [key, value] of Object.entries(parsed)) {
              if (typeof value === 'string' && value.trim() && path.isAbsolute(value)) {
                result[key as KnownFolderKey] = path.resolve(value.trim());
              }
            }
            detected = { ...(detected ?? {}), ...result };
          } catch {
            // Saída inesperada: mantém a heurística.
          }
        }
        resolve();
      },
    );
  });
}

function detectedFolders(): Partial<Record<KnownFolderKey, string>> {
  if (detected === null) {
    detected = platform === 'linux' ? detectXdgFolders() : {};
    startWindowsDetection();
  }
  return detected;
}

/** Aguarda a detecção das pastas reais do Windows (no-op nas outras plataformas). */
export async function ensureKnownFoldersDetected(): Promise<void> {
  detectedFolders();
  if (windowsDetection) await windowsDetection;
}

function folderPath(key: KnownFolderKey): string {
  if (key === 'home') return homeDir();
  const real = detectedFolders()[key];
  if (real) return real;
  return isWin ? windowsHeuristicFolder(key) : path.join(homeDir(), DEFAULT_SUBFOLDER[key]);
}

function favoritePaths(): string[] {
  try {
    return getSettings().computer.favoritePaths ?? [];
  } catch {
    return [];
  }
}

/** Pastas conhecidas (pessoal, Área de Trabalho, Documentos, Downloads, Imagens, Músicas, Vídeos e favoritas). */
export function knownFolders(): KnownFolder[] {
  const keys: KnownFolderKey[] = ['home', 'desktop', 'documents', 'downloads', 'pictures', 'music', 'videos'];
  const folders: KnownFolder[] = keys.map((key) => {
    const p = folderPath(key);
    const aliases = new Set(FOLDER_ALIASES[key]);
    if (key !== 'home') aliases.add(foldText(path.basename(p)));
    return { key, label: FOLDER_LABELS[key], path: p, exists: existsDir(p), aliases: [...aliases] };
  });
  const taken = new Set(folders.flatMap((f) => f.aliases));
  for (const fav of favoritePaths()) {
    const resolved = resolveBasic(fav);
    const alias = foldText(path.basename(resolved));
    folders.push({
      key: 'favorite',
      label: path.basename(resolved) || resolved,
      path: resolved,
      exists: existsDir(resolved),
      aliases: alias && !taken.has(alias) ? [alias] : [],
    });
    if (alias) taken.add(alias);
  }
  return folders;
}

// ─── Resolução ──────────────────────────────────────────────────────────

function envLookup(name: string): string | undefined {
  const upper = name.toUpperCase();
  if (upper === 'HOME' || upper === 'USERPROFILE') return process.env[name] || homeDir();
  if (process.env[name] !== undefined) return process.env[name];
  const key = Object.keys(process.env).find((k) => k.toUpperCase() === upper);
  return key ? process.env[key] : undefined;
}

/** Expande %VAR%, ${VAR} e $VAR (variáveis inexistentes ficam como estão). */
export function expandEnvVars(input: string): string {
  return input
    .replace(/%([A-Za-z_][A-Za-z0-9_()]*)%/g, (m, name: string) => envLookup(name) ?? m)
    .replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (m, a?: string, b?: string) => envLookup(a ?? b ?? '') ?? m);
}

function cleanInput(input: string): string {
  let p = String(input ?? '').trim();
  p = p.replace(/^["'“”‘’`]+|["'“”‘’`]+$/g, '').trim();
  if (/^file:\/\//i.test(p)) {
    try {
      p = fileURLToPath(p);
    } catch {
      // Mantém como veio.
    }
  }
  return p;
}

/** Resolução sem apelidos (usada para favoritos, evitando recursão). */
function resolveBasic(input: string): string {
  let p = expandEnvVars(cleanInput(input));
  if (p === '~') return homeDir();
  if (/^~[\\/]/.test(p)) p = path.join(homeDir(), p.slice(2));
  if (isWin && /^[a-zA-Z]:$/.test(p)) return `${p.toUpperCase()}\\`;
  return path.isAbsolute(p) ? path.resolve(p) : path.resolve(homeDir(), p);
}

/**
 * Converte o caminho dito pelo usuário/modelo em caminho absoluto do sistema.
 * Exemplos: "~/notas.txt", "%USERPROFILE%\\Desktop", "Área de Trabalho/projeto", "documentos",
 * "C:" → "C:\\". Caminhos relativos partem da pasta pessoal.
 * @throws Error para caminho vazio.
 */
export function resolveUserPath(input: string): string {
  const cleaned = cleanInput(input);
  if (!cleaned) throw new Error('Informe um caminho.');
  const expanded = expandEnvVars(cleaned);
  if (expanded === '~') return homeDir();
  if (/^~[\\/]/.test(expanded)) return path.resolve(homeDir(), expanded.slice(2));
  if (isWin && /^[a-zA-Z]:$/.test(expanded)) return `${expanded.toUpperCase()}\\`;
  if (path.isAbsolute(expanded)) return path.resolve(expanded);

  const segments = expanded.split(/[\\/]+/).filter(Boolean);
  const first = foldText(segments[0] ?? '');
  if (first && first !== '.' && first !== '..') {
    for (const folder of knownFolders()) {
      if (folder.aliases.includes(first)) return path.resolve(folder.path, ...segments.slice(1));
    }
  }
  return path.resolve(homeDir(), expanded);
}

// ─── Proteção ────────────────────────────────────────────────────────────

/** Erro de política de segurança (a ação nem chega a ser tentada). */
export class ProtectedPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProtectedPathError';
  }
}

function norm(p: string): string {
  const resolved = path.resolve(p);
  const trimmed = resolved.length > path.parse(resolved).root.length ? resolved.replace(/[\\/]+$/, '') : resolved;
  return caseInsensitive ? trimmed.toLowerCase() : trimmed;
}

function isInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

interface ProtectionRules {
  /** A pasta e tudo dentro dela (nem criar, nem alterar, nem apagar). */
  subtree: string[];
  /** Apenas a própria pasta (não pode ser apagada/movida, mas o conteúdo pode). */
  exact: string[];
}

let rulesCache: ProtectionRules | null = null;

function databaseFiles(): string[] {
  return ['', '-wal', '-shm', '-journal'].map((suffix) => `${config.dbPath}${suffix}`);
}

function protectionRules(): ProtectionRules {
  if (rulesCache) return rulesCache;
  const home = homeDir();
  const subtree: string[] = [path.join(home, '.ssh'), path.join(home, '.gnupg')];
  const exact: string[] = [home];
  if (!config.dbPath.endsWith(':memory:')) {
    // O banco da memória permanente (e seus arquivos auxiliares do SQLite) nunca é tocado pelas ferramentas.
    subtree.push(...databaseFiles());
    const dataDir = path.dirname(config.dbPath);
    if (path.parse(dataDir).root !== dataDir) exact.push(dataDir);
  }

  if (isWin) {
    const drive = (process.env.SystemDrive || 'C:').replace(/[\\/]+$/, '');
    const systemRoot = process.env.SystemRoot || process.env.windir || `${drive}\\Windows`;
    subtree.push(
      systemRoot,
      `${drive}\\Program Files`,
      `${drive}\\Program Files (x86)`,
      `${drive}\\ProgramData\\Microsoft`,
      `${drive}\\Boot`,
      `${drive}\\Recovery`,
      `${drive}\\System Volume Information`,
      `${drive}\\$Recycle.Bin`,
      `${drive}\\EFI`,
    );
    exact.push(
      `${drive}\\Users`,
      `${drive}\\Users\\Public`,
      `${drive}\\ProgramData`,
      path.join(home, 'AppData'),
      path.join(home, 'AppData', 'Roaming'),
      path.join(home, 'AppData', 'Local'),
      path.join(home, 'AppData', 'LocalLow'),
    );
    if (process.env.OneDrive) exact.push(process.env.OneDrive);
  } else {
    subtree.push('/bin', '/sbin', '/usr', '/etc', '/boot', '/dev', '/proc', '/sys', '/lib', '/lib32', '/lib64', '/libx32', '/run', '/snap', '/var/lib', '/var/log');
    exact.push('/home', '/root', '/opt', '/var', '/srv', '/mnt', '/media', '/tmp');
    if (platform === 'darwin') {
      subtree.push('/System', '/Library', '/private', '/cores');
      exact.push('/Users', '/Applications', '/Volumes', path.join(home, 'Library'));
    }
    exact.push(path.join(home, '.config'), path.join(home, '.local'));
  }
  rulesCache = { subtree: subtree.map(norm), exact: exact.map(norm) };
  return rulesCache;
}

/**
 * Motivo pelo qual a operação é proibida, ou null se permitida.
 * - 'delete': apagar, mover a origem ou sobrescrever o destino.
 * - 'modify': criar/escrever dentro de uma pasta.
 */
export function protectionReason(target: string, op: 'delete' | 'modify'): string | null {
  const p = norm(target);
  const rules = protectionRules();
  for (const root of rules.subtree) {
    if (isInside(p, root)) {
      if (databaseFiles().some((f) => norm(f) === root)) return 'é o banco da memória permanente do Lärk';
      if (/[\\/]\.ssh$|[\\/]\.gnupg$/.test(root)) return 'contém chaves de segurança (SSH/GPG)';
      return 'é uma área crítica do sistema operacional';
    }
  }
  if (op === 'delete') {
    if (path.parse(p).root.toLowerCase() === p.toLowerCase() || /^[\\/]{2}[^\\/]+[\\/][^\\/]+$/.test(p)) {
      return 'é a raiz de uma unidade';
    }
    if (rules.exact.includes(p)) return 'é uma pasta essencial do sistema ou do seu perfil';
    for (const folder of knownFolders()) {
      if (folder.key !== 'favorite' && norm(folder.path) === p) return `é a pasta ${folder.label} inteira`;
    }
  }
  return null;
}

const OP_VERBS: Record<'delete' | 'modify', string> = { delete: 'apagar ou mover', modify: 'alterar' };

/** Lança ProtectedPathError se a operação não for permitida neste caminho. */
export function assertNotProtected(target: string, op: 'delete' | 'modify', verb = OP_VERBS[op]): void {
  const reason = protectionReason(target, op);
  if (reason) {
    throw new ProtectedPathError(`Por segurança, não vou ${verb} "${target}": ${reason}. Se for mesmo necessário, faça isso manualmente.`);
  }
}

// No Windows, descobre já na inicialização as pastas reais (OneDrive etc.), em segundo plano.
if (isWin) detectedFolders();

/** Limpa caches (testes / mudança de configuração). */
export function resetPathCaches(): void {
  rulesCache = null;
  if (!isWin) detected = null;
}
