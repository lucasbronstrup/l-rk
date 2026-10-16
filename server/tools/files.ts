/**
 * Arquivos do computador: listar, ler (texto, Word, planilhas, apresentações), analisar com o Gemini
 * (PDF, imagens, áudio, vídeo), buscar por nome/conteúdo, criar, mover, copiar, mandar para a Lixeira,
 * abrir com o programa padrão e listar arquivos recentes.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { createRequire } from 'node:module';
import type { Readable } from 'node:stream';
import fg from 'fast-glob';
import open, { apps } from 'open';
import trash from 'trash';
import { createPartFromUri, type Part } from '@google/genai';
import { z } from 'zod';
import { config } from '../config.js';
import { classifyGeminiError, generateWithFallback, getClient } from '../llm/gemini.js';
import { assertNotProtected, foldText, knownFolders, resolveUserPath } from './paths.js';
import {
  argText,
  formatBytes,
  optionalBool,
  optionalInt,
  parseArgs,
  plural,
  requiredText,
  shortDateTime,
  throwIfAborted,
  userTimeZone,
  type ToolSpec,
} from './utility.js';
import type { ToolRisk } from '../../shared/types.js';

const require = createRequire(import.meta.url);
const isWin = process.platform === 'win32';

// ─── Tipos de arquivo ────────────────────────────────────────────────────

const TEXT_EXTENSIONS = new Set(
  (
    'txt md markdown rst log csv tsv json jsonc json5 ndjson xml yaml yml toml ini cfg conf env properties ' +
    'html htm css scss sass less js mjs cjs jsx ts tsx vue svelte astro py pyw rb php java kt kts scala go rs c h cpp cc ' +
    'hpp cs fs vb swift m mm dart lua pl r jl sql sh bash zsh fish ps1 psm1 bat cmd vbs gradle makefile cmake dockerfile ' +
    'gitignore gitattributes editorconfig srt vtt tex bib ipynb rtf svg plist reg lock license readme'
  ).split(/\s+/),
);

/** Formatos que o Gemini entende nativamente (análise multimodal). */
const GEMINI_MIME: Record<string, string> = {
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  heic: 'image/heic',
  heif: 'image/heif',
  wav: 'audio/wav',
  mp3: 'audio/mp3',
  aiff: 'audio/aiff',
  aif: 'audio/aiff',
  aac: 'audio/aac',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  opus: 'audio/ogg',
  flac: 'audio/flac',
  m4a: 'audio/mp4',
  weba: 'audio/webm',
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  mpeg: 'video/mpeg',
  mpg: 'video/mpg',
  mov: 'video/mov',
  avi: 'video/avi',
  flv: 'video/x-flv',
  webm: 'video/webm',
  wmv: 'video/wmv',
  '3gp': 'video/3gpp',
};

const OTHER_MIME: Record<string, string> = {
  txt: 'text/plain',
  md: 'text/markdown',
  csv: 'text/csv',
  json: 'application/json',
  html: 'text/html',
  htm: 'text/html',
  xml: 'application/xml',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  zip: 'application/zip',
  exe: 'application/vnd.microsoft.portable-executable',
  gif: 'image/gif',
  bmp: 'image/bmp',
  svg: 'image/svg+xml',
  mkv: 'video/x-matroska',
};

const OFFICE_EXTENSIONS = new Set(['docx', 'xlsx', 'xlsm', 'pptx', 'odt', 'ods', 'odp']);
const EXECUTABLE_EXTENSIONS = new Set([
  'exe', 'msi', 'bat', 'cmd', 'com', 'ps1', 'vbs', 'vbe', 'js', 'jse', 'wsf', 'wsh', 'scr', 'pif', 'hta', 'cpl', 'msc',
  'jar', 'lnk', 'reg', 'sh', 'command', 'app', 'run', 'appimage', 'deb', 'rpm', 'pkg', 'dmg',
]);

function extOf(p: string): string {
  const base = path.basename(p).toLowerCase();
  const ext = path.extname(base).slice(1);
  return ext || (TEXT_EXTENSIONS.has(base) ? base : '');
}

function mimeOf(p: string): string | null {
  const ext = extOf(p);
  return GEMINI_MIME[ext] ?? OTHER_MIME[ext] ?? null;
}

function kindLabel(ext: string, isDir: boolean): string {
  if (isDir) return 'pasta';
  if (!ext) return 'arquivo';
  if (GEMINI_MIME[ext]?.startsWith('image/') || ['gif', 'bmp', 'svg', 'ico', 'tif', 'tiff'].includes(ext)) return 'imagem';
  if (GEMINI_MIME[ext]?.startsWith('audio/')) return 'áudio';
  if (GEMINI_MIME[ext]?.startsWith('video/') || ext === 'mkv') return 'vídeo';
  if (ext === 'pdf') return 'PDF';
  if (['docx', 'doc', 'odt', 'rtf'].includes(ext)) return 'documento';
  if (['xlsx', 'xlsm', 'xls', 'ods', 'csv'].includes(ext)) return 'planilha';
  if (['pptx', 'ppt', 'odp'].includes(ext)) return 'apresentação';
  if (['zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz'].includes(ext)) return 'compactado';
  if (EXECUTABLE_EXTENSIONS.has(ext)) return 'executável';
  if (TEXT_EXTENSIONS.has(ext)) return 'texto';
  return ext.toUpperCase();
}

// ─── Leitura de texto ────────────────────────────────────────────────────

/** Heurística de binário: bytes nulos ou muitos caracteres de controle no início. */
function looksBinary(buf: Buffer): boolean {
  if (buf.length >= 2 && ((buf[0] === 0xff && buf[1] === 0xfe) || (buf[0] === 0xfe && buf[1] === 0xff))) return false;
  const n = Math.min(buf.length, 8000);
  if (n === 0) return false;
  let control = 0;
  for (let i = 0; i < n; i++) {
    const b = buf[i];
    if (b === 0) return true;
    if (b < 7 || (b > 13 && b < 32 && b !== 27)) control++;
  }
  return control / n > 0.1;
}

/** Remove bytes de sequências UTF-8 cortadas nas bordas de uma janela de leitura. */
function trimUtf8Edges(buf: Buffer): Buffer {
  let start = 0;
  while (start < Math.min(buf.length, 4) && (buf[start] & 0xc0) === 0x80) start++;
  let end = buf.length;
  for (let i = buf.length - 1, k = 0; i >= start && k < 4; i--, k++) {
    const b = buf[i];
    if ((b & 0x80) === 0) break;
    if ((b & 0xc0) === 0xc0) {
      const need = b >= 0xf0 ? 4 : b >= 0xe0 ? 3 : 2;
      if (buf.length - i < need) end = i;
      break;
    }
  }
  return buf.subarray(start, end);
}

/** Decodifica texto detectando BOM, UTF-8 e, na falta dele, Windows-1252 (comum em arquivos antigos do Windows). */
function decodeText(buf: Buffer): { text: string; encoding: string } {
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return { text: buf.subarray(3).toString('utf8'), encoding: 'UTF-8 (BOM)' };
  }
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return { text: new TextDecoder('utf-16le').decode(buf.subarray(2)), encoding: 'UTF-16 LE' };
  }
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    return { text: new TextDecoder('utf-16be').decode(buf.subarray(2)), encoding: 'UTF-16 BE' };
  }
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(buf), encoding: 'UTF-8' };
  } catch {
    try {
      return { text: new TextDecoder('windows-1252').decode(buf), encoding: 'Windows-1252' };
    } catch {
      return { text: buf.toString('latin1'), encoding: 'Latin-1' };
    }
  }
}

// ─── ZIP mínimo (planilhas e apresentações do Office/LibreOffice) ───────

const ZIP_MAX_ENTRY_BYTES = 80 * 1024 * 1024;

/** Lê o diretório central de um ZIP e devolve leitores preguiçosos por nome de entrada. */
function readZip(buf: Buffer): Map<string, () => Buffer> {
  const entries = new Map<string, () => Buffer>();
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65_535); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('Arquivo corrompido ou não é um documento Office válido.');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let i = 0; i < count && p + 46 <= buf.length; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    const compressedSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    entries.set(name, () => {
      if (buf.readUInt32LE(localOffset) !== 0x04034b50) throw new Error(`Entrada ZIP inválida: ${name}`);
      const start = localOffset + 30 + buf.readUInt16LE(localOffset + 26) + buf.readUInt16LE(localOffset + 28);
      const data = buf.subarray(start, start + compressedSize);
      if (method === 0) return data;
      if (method === 8) return zlib.inflateRawSync(data, { maxOutputLength: ZIP_MAX_ENTRY_BYTES });
      throw new Error(`Compressão ZIP não suportada (${method}).`);
    });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function decodeXmlEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(Number.parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function columnIndex(letters: string): number {
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/** Converte um .xlsx em texto tabulado (uma seção por planilha). */
function xlsxToText(buf: Buffer): string {
  const zip = readZip(buf);
  const read = (name: string) => {
    const getter = zip.get(name);
    return getter ? getter().toString('utf8') : '';
  };
  const shared: string[] = [];
  for (const m of read('xl/sharedStrings.xml').matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)) {
    const withoutPhonetic = m[1].replace(/<rPh\b[\s\S]*?<\/rPh>/g, '');
    shared.push(decodeXmlEntities([...withoutPhonetic.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((t) => t[1]).join('')));
  }
  const rels = new Map<string, string>();
  for (const m of read('xl/_rels/workbook.xml.rels').matchAll(/<Relationship\b([^>]*)\/?>/g)) {
    const id = m[1].match(/\bId="([^"]+)"/)?.[1];
    const target = m[1].match(/\bTarget="([^"]+)"/)?.[1];
    if (id && target) rels.set(id, target.startsWith('/') ? target.slice(1) : `xl/${target}`);
  }
  const sheets = [...read('xl/workbook.xml').matchAll(/<sheet\b([^>]*)\/?>/g)].map((m) => ({
    name: decodeXmlEntities(m[1].match(/\bname="([^"]*)"/)?.[1] ?? 'Planilha'),
    target: rels.get(m[1].match(/\br:id="([^"]+)"/)?.[1] ?? '') ?? '',
  }));
  const parts: string[] = [];
  for (const sheet of sheets) {
    const xml = sheet.target ? read(sheet.target) : '';
    const lines: string[] = [];
    let rowCount = 0;
    for (const row of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
      if (++rowCount > 5000) {
        lines.push('[… linhas restantes omitidas …]');
        break;
      }
      const cells: string[] = [];
      let implicitCol = 0;
      for (const c of row[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const attrs = c[1];
        const ref = attrs.match(/\br="([A-Z]+)\d+"/)?.[1];
        const col = ref ? columnIndex(ref) : implicitCol;
        implicitCol = col + 1;
        if (col > 200) continue;
        const type = attrs.match(/\bt="(\w+)"/)?.[1];
        const body = c[2] ?? '';
        let value = '';
        if (type === 'inlineStr') value = [...body.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((t) => t[1]).join('');
        else {
          const v = body.match(/<v>([\s\S]*?)<\/v>/)?.[1] ?? '';
          if (type === 's') value = shared[Number(v)] ?? '';
          else if (type === 'b') value = v === '1' ? 'VERDADEIRO' : 'FALSO';
          else value = v;
        }
        while (cells.length < col) cells.push('');
        cells[col] = decodeXmlEntities(value).replace(/[\t\r\n]+/g, ' ').trim();
      }
      while (cells.length && !cells[cells.length - 1]) cells.pop();
      if (cells.length) lines.push(cells.join('\t'));
    }
    parts.push(`## Planilha: ${sheet.name}\n${lines.join('\n') || '(vazia)'}`);
  }
  return parts.join('\n\n');
}

/** Extrai o texto de cada slide de um .pptx. */
function pptxToText(buf: Buffer): string {
  const zip = readZip(buf);
  const slides = [...zip.keys()]
    .map((name) => ({ name, n: Number(name.match(/^ppt\/slides\/slide(\d+)\.xml$/)?.[1] ?? Number.NaN) }))
    .filter((s) => Number.isFinite(s.n))
    .sort((a, b) => a.n - b.n);
  return slides
    .map((s) => {
      const xml = zip.get(s.name)!().toString('utf8');
      const paragraphs = xml
        .split(/<\/a:p>/)
        .map((p) => decodeXmlEntities([...p.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)].map((t) => t[1]).join('')).trim())
        .filter(Boolean);
      return `## Slide ${s.n}\n${paragraphs.join('\n') || '(sem texto)'}`;
    })
    .join('\n\n');
}

/** Extrai o texto de documentos OpenDocument (.odt/.ods/.odp). */
function openDocumentToText(buf: Buffer): string {
  const zip = readZip(buf);
  const xml = zip.get('content.xml')?.().toString('utf8') ?? '';
  return decodeXmlEntities(
    xml
      .replace(/<text:tab\/>/g, '\t')
      .replace(/<text:line-break\/>/g, '\n')
      .replace(/<text:s(?: text:c="(\d+)")?\/>/g, (_, n?: string) => ' '.repeat(Number(n ?? 1)))
      .replace(/<\/text:(p|h)>/g, '\n')
      .replace(/<\/table:table-cell>/g, '\t')
      .replace(/<\/table:table-row>/g, '\n')
      .replace(/<[^>]+>/g, ''),
  )
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

interface MammothModule {
  extractRawText(input: { path: string } | { buffer: Buffer }): Promise<{ value: string; messages: unknown[] }>;
}

/** Extrai texto de formatos de escritório suportados. */
async function officeToText(filePath: string, ext: string): Promise<string> {
  const stat = await fs.promises.stat(filePath);
  if (stat.size > 60 * 1024 * 1024) throw new Error(`Arquivo grande demais para extrair texto (${formatBytes(stat.size)}; máx. 60 MB).`);
  if (ext === 'docx') {
    const mammoth = require('mammoth') as MammothModule;
    const result = await mammoth.extractRawText({ path: filePath });
    return result.value.replace(/\n{3,}/g, '\n\n').trim();
  }
  const buf = await fs.promises.readFile(filePath);
  if (ext === 'xlsx' || ext === 'xlsm') return xlsxToText(buf);
  if (ext === 'pptx') return pptxToText(buf);
  return openDocumentToText(buf);
}

// ─── Utilidades de sistema de arquivos ──────────────────────────────────

async function statOrNull(p: string): Promise<fs.Stats | null> {
  try {
    return await fs.promises.stat(p);
  } catch {
    return null;
  }
}

async function requireExisting(p: string): Promise<fs.Stats> {
  try {
    return await fs.promises.stat(p);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') throw new Error(`Não encontrei "${p}". Confira o caminho (use search_files para procurar pelo nome).`);
    if (code === 'EACCES' || code === 'EPERM') throw new Error(`Sem permissão para acessar "${p}".`);
    throw error;
  }
}

function friendlyFsError(error: unknown, target: string): Error {
  const code = (error as NodeJS.ErrnoException).code;
  switch (code) {
    case 'EACCES':
    case 'EPERM':
      return new Error(`Sem permissão para modificar "${target}" (arquivo protegido, aberto em outro programa ou exige administrador).`);
    case 'EBUSY':
      return new Error(`"${target}" está em uso por outro programa. Feche-o e tente de novo.`);
    case 'ENOSPC':
      return new Error('Não há espaço suficiente no disco.');
    case 'ENAMETOOLONG':
      return new Error('O caminho é longo demais para o sistema.');
    case 'EROFS':
      return new Error(`"${target}" está numa unidade somente leitura.`);
    case 'ENOENT':
      return new Error(`Não encontrei "${target}".`);
    case 'EEXIST':
      return new Error(`"${target}" já existe.`);
    default:
      return error instanceof Error ? error : new Error(String(error));
  }
}

/** Executa `fn` sobre itens com concorrência limitada. */
async function runPool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return results;
}

const WINDOWS_HIDDEN = new Set(
  [
    'desktop.ini', 'thumbs.db', 'ntuser.dat', 'ntuser.ini', 'ntuser.pol', '$recycle.bin', 'system volume information',
    'pagefile.sys', 'hiberfil.sys', 'swapfile.sys', 'dumpstack.log.tmp', 'dumpstack.log', 'config.msi', 'recovery',
    'documents and settings', 'appdata', 'application data', 'cookies', 'local settings', 'my documents', 'nethood',
    'printhood', 'recent', 'sendto', 'start menu', 'templates', '$winreagent', '$windows.~bt', '$windows.~ws',
    'msocache', 'perflogs', 'programdata',
  ].map((s) => s.toLowerCase()),
);

function isHiddenName(name: string): boolean {
  if (name.startsWith('.')) return true;
  if (name.startsWith('~$')) return true; // arquivos temporários do Office
  if (!isWin) return false;
  const lower = name.toLowerCase();
  return WINDOWS_HIDDEN.has(lower) || /^ntuser\./.test(lower);
}

/** Padrões ignorados nas buscas (dependências, caches, lixeiras, pastas de sistema). */
const SEARCH_IGNORE = [
  '**/node_modules/**',
  '**/.git/**',
  '**/.svn/**',
  '**/.hg/**',
  '**/__pycache__/**',
  '**/.venv/**',
  '**/venv/**',
  '**/.cache/**',
  '**/.npm/**',
  '**/.nuget/**',
  '**/.gradle/**',
  '**/.m2/**',
  '**/.cargo/registry/**',
  '**/.rustup/**',
  '**/.vscode/extensions/**',
  '**/AppData/Local/**',
  '**/AppData/LocalLow/**',
  '**/AppData/Roaming/**/Cache/**',
  '**/AppData/Roaming/**/Code Cache/**',
  '**/$Recycle.Bin/**',
  '**/System Volume Information/**',
  '**/Windows/WinSxS/**',
  '**/Library/Caches/**',
  '**/Library/Containers/**',
  '**/Library/Group Containers/**',
  '**/Library/Application Support/**/Cache*/**',
  '**/.Trash/**',
  '**/.local/share/Trash/**',
  '**/snap/**',
  '**/proc/**',
];

interface WalkOptions {
  root: string;
  onlyFiles: boolean;
  stats: boolean;
  deep: number;
  dot: boolean;
  budgetMs: number;
  signal?: AbortSignal;
}

/** Percorre uma árvore com fast-glob, respeitando orçamento de tempo e cancelamento. */
async function walk(opts: WalkOptions, onEntry: (entry: fg.Entry) => boolean | Promise<boolean>): Promise<{ timedOut: boolean }> {
  const stream = fg.stream('**/*', {
    cwd: opts.root,
    onlyFiles: opts.onlyFiles,
    stats: opts.stats,
    objectMode: true,
    deep: opts.deep,
    dot: opts.dot,
    followSymbolicLinks: false,
    suppressErrors: true,
    caseSensitiveMatch: false,
    ignore: SEARCH_IGNORE,
    unique: true,
  }) as unknown as Readable & AsyncIterable<fg.Entry>;
  let timedOut = false;
  const stop = () => stream.destroy();
  const timer = setTimeout(() => {
    timedOut = true;
    stop();
  }, opts.budgetMs);
  opts.signal?.addEventListener('abort', stop, { once: true });
  try {
    for await (const entry of stream) {
      if (opts.signal?.aborted) break;
      const keepGoing = await onEntry(entry);
      if (!keepGoing) break;
    }
  } catch (error) {
    if (!timedOut && !opts.signal?.aborted) throw error;
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', stop);
    stream.destroy();
  }
  throwIfAborted(opts.signal);
  return { timedOut };
}

// ─── list_directory ──────────────────────────────────────────────────────

interface DirEntryInfo {
  name: string;
  type: 'pasta' | 'arquivo' | 'atalho';
  kind: string;
  bytes: number | null;
  mtimeMs: number | null;
}

const listDirectory: ToolSpec = {
  name: 'list_directory',
  label: 'Listando pasta',
  group: 'computer',
  risk: 'safe',
  description:
    'Lista o conteúdo de uma pasta do computador (subpastas e arquivos com tipo, tamanho e data de modificação). ' +
    'Aceita caminhos absolutos, "~" e atalhos como "Área de Trabalho", "Documentos", "Downloads", "Imagens", "Músicas", "Vídeos" ' +
    '(ex.: "Documentos/Projetos"). Sem caminho, lista a pasta pessoal. Para achar algo sem saber onde está, use search_files.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Pasta a listar (padrão: pasta pessoal).' },
      show_hidden: { type: 'boolean', description: 'Incluir arquivos ocultos/de sistema (padrão false).' },
      sort: {
        type: 'string',
        enum: ['name', 'modified', 'size', 'type'],
        description: 'Ordenação: name (pastas primeiro), modified (mais recentes primeiro), size (maiores primeiro), type.',
      },
      limit: { type: 'integer', minimum: 1, maximum: 500, description: 'Máximo de itens (padrão 200, máx. 500).' },
    },
  },
  async execute(args, ctx) {
    const a = parseArgs(
      'list_directory',
      z.object({
        path: z.string().trim().nullish(),
        show_hidden: optionalBool,
        sort: z.enum(['name', 'modified', 'size', 'type']).nullish(),
        limit: optionalInt(1, 500),
      }),
      args,
    );
    const dir = a.path ? resolveUserPath(a.path) : os.homedir();
    const st = await requireExisting(dir);
    if (!st.isDirectory()) throw new Error(`"${dir}" é um arquivo, não uma pasta. Use read_file ou file_info.`);
    let dirents: fs.Dirent[];
    try {
      dirents = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch (error) {
      throw friendlyFsError(error, dir);
    }
    const hiddenCount = dirents.filter((d) => isHiddenName(d.name)).length;
    const visible = a.show_hidden ? dirents : dirents.filter((d) => !isHiddenName(d.name));
    throwIfAborted(ctx.signal);

    const infos = await runPool(visible, 48, async (d): Promise<DirEntryInfo> => {
      const full = path.join(dir, d.name);
      const isLink = d.isSymbolicLink();
      const s = await statOrNull(full);
      const isDir = s ? s.isDirectory() : d.isDirectory();
      return {
        name: d.name,
        type: isLink && !s ? 'atalho' : isDir ? 'pasta' : isLink ? 'atalho' : 'arquivo',
        kind: kindLabel(extOf(d.name), isDir),
        bytes: s && !isDir ? s.size : null,
        mtimeMs: s ? s.mtimeMs : null,
      };
    });

    const sort = a.sort ?? 'name';
    const collator = new Intl.Collator('pt-BR', { numeric: true, sensitivity: 'base' });
    infos.sort((x, y) => {
      if (sort === 'modified') return (y.mtimeMs ?? 0) - (x.mtimeMs ?? 0);
      if (sort === 'size') return (y.bytes ?? -1) - (x.bytes ?? -1);
      const dirFirst = Number(y.type === 'pasta') - Number(x.type === 'pasta');
      if (dirFirst !== 0) return dirFirst;
      if (sort === 'type') return collator.compare(x.kind, y.kind) || collator.compare(x.name, y.name);
      return collator.compare(x.name, y.name);
    });

    const limit = a.limit ?? 200;
    const tz = userTimeZone();
    const folders = infos.filter((i) => i.type === 'pasta').length;
    const files = infos.length - folders;
    const totalBytes = infos.reduce((sum, i) => sum + (i.bytes ?? 0), 0);
    return {
      output: {
        path: dir,
        folders,
        files,
        totalFileSize: formatBytes(totalBytes),
        ...(a.show_hidden ? {} : hiddenCount ? { hiddenItems: hiddenCount } : {}),
        entries: infos.slice(0, limit).map((i) => ({
          name: i.name,
          type: i.type,
          ...(i.type !== 'pasta' ? { kind: i.kind } : {}),
          ...(i.bytes !== null ? { size: formatBytes(i.bytes) } : {}),
          ...(i.mtimeMs !== null ? { modified: shortDateTime(i.mtimeMs, tz) } : {}),
        })),
        ...(infos.length > limit
          ? { truncated: true, note: `Mostrando ${limit} de ${infos.length} itens. Use sort/limit ou search_files para refinar.` }
          : {}),
      },
      summary: `${path.basename(dir) || dir}: ${plural(folders, 'pasta', 'pastas')}, ${plural(files, 'arquivo', 'arquivos')}`,
    };
  },
};

// ─── read_file ───────────────────────────────────────────────────────────

const FULL_READ_LIMIT = 8 * 1024 * 1024;

const readFile: ToolSpec = {
  name: 'read_file',
  label: 'Lendo arquivo',
  group: 'computer',
  risk: 'safe',
  description:
    'Lê o conteúdo de um arquivo de texto (código, .txt, .md, .csv, .json, logs...) e também extrai o texto de ' +
    'documentos Word (.docx), planilhas (.xlsx, .ods), apresentações (.pptx, .odp) e .odt. ' +
    'Arquivos longos vêm em partes: use offset (posição em caracteres) com o nextOffset devolvido para continuar. ' +
    'PDFs, imagens, áudios e vídeos: use analyze_file.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Caminho do arquivo.' },
      offset: { type: 'integer', minimum: 0, description: 'Posição inicial em caracteres (padrão 0).' },
      max_chars: {
        type: 'integer',
        minimum: 100,
        maximum: 100_000,
        description: 'Máximo de caracteres a devolver (padrão 20 000, máx. 100 000).',
      },
    },
    required: ['path'],
  },
  async execute(args, ctx) {
    const a = parseArgs(
      'read_file',
      z.object({
        path: requiredText('o caminho do arquivo'),
        offset: z.coerce.number().int().min(0).nullish(),
        max_chars: optionalInt(100, 100_000),
      }),
      args,
    );
    const file = resolveUserPath(a.path);
    const st = await requireExisting(file);
    if (st.isDirectory()) throw new Error(`"${file}" é uma pasta. Use list_directory.`);
    const ext = extOf(file);
    const offset = a.offset ?? 0;
    const maxChars = a.max_chars ?? 20_000;

    if (GEMINI_MIME[ext]) {
      return {
        output: {
          path: file,
          kind: kindLabel(ext, false),
          size: formatBytes(st.size),
          note: `Este é um arquivo ${kindLabel(ext, false)}; o conteúdo não é texto. Use analyze_file com uma pergunta para ver/ouvir/ler o conteúdo.`,
        },
        summary: `${path.basename(file)}: use analyze_file`,
      };
    }
    if (['doc', 'xls', 'ppt'].includes(ext)) {
      throw new Error(`O formato .${ext} antigo (Office 97-2003) não é suportado. Peça para salvar como .${ext}x ou PDF.`);
    }

    let text: string;
    let encoding = 'UTF-8';
    let totalChars: number | null;
    let approximate = false;
    if (OFFICE_EXTENSIONS.has(ext)) {
      text = await officeToText(file, ext);
      encoding = 'documento';
      totalChars = text.length;
      text = text.slice(offset, offset + maxChars);
    } else {
      if (st.size <= FULL_READ_LIMIT) {
        let buf: Buffer;
        try {
          buf = await fs.promises.readFile(file);
        } catch (error) {
          throw friendlyFsError(error, file);
        }
        if (looksBinary(buf)) {
          throw new Error(`"${path.basename(file)}" é um arquivo binário (${kindLabel(ext, false)}), não texto. Use file_info ou analyze_file.`);
        }
        const decoded = decodeText(buf);
        encoding = decoded.encoding;
        totalChars = decoded.text.length;
        text = decoded.text.slice(offset, offset + maxChars);
      } else {
        // Arquivo grande: lê só uma janela (offset tratado como bytes, ~ caracteres em texto ASCII).
        approximate = true;
        const handle = await fs.promises.open(file, 'r');
        try {
          const length = Math.min(maxChars * 2, st.size - Math.min(offset, st.size));
          const buf = Buffer.alloc(Math.max(0, length));
          const { bytesRead } = await handle.read(buf, 0, buf.length, offset);
          const window = trimUtf8Edges(buf.subarray(0, bytesRead));
          if (offset === 0 && looksBinary(window)) throw new Error(`"${path.basename(file)}" é um arquivo binário, não texto.`);
          const decoded = decodeText(window);
          encoding = decoded.encoding;
          text = decoded.text.slice(0, maxChars);
          totalChars = null;
        } finally {
          await handle.close();
        }
      }
    }
    throwIfAborted(ctx.signal);
    const end = offset + text.length;
    const hasMore = totalChars !== null ? end < totalChars : offset + text.length < st.size;
    return {
      output: {
        path: file,
        size: formatBytes(st.size),
        encoding,
        offset,
        returnedChars: text.length,
        ...(totalChars !== null ? { totalChars } : { note: 'Arquivo grande: offset e nextOffset são posições aproximadas (bytes).' }),
        ...(hasMore ? { truncated: true, nextOffset: approximate ? offset + Buffer.byteLength(text) : end } : {}),
        content: text,
      },
      summary: `${path.basename(file)} · ${text.length.toLocaleString('pt-BR')} caracteres${hasMore ? ' (parcial)' : ''}`,
    };
  },
};

// ─── analyze_file ────────────────────────────────────────────────────────

const INLINE_LIMIT = 14 * 1024 * 1024; // ~20 MB após base64
const UPLOAD_LIMIT = 1024 * 1024 * 1024;
const TEXT_ANALYSIS_LIMIT = 400_000;

const ANALYSIS_SYSTEM =
  'Você é o módulo de leitura e visão do Lärk, um assistente pessoal. Analise o arquivo fornecido e responda à ' +
  'pergunta em português do Brasil, com precisão e riqueza de detalhes úteis: cite números, nomes, datas e trechos ' +
  'relevantes; em imagens descreva o que importa; em áudios/vídeos transcreva ou resuma com marcações de tempo quando ' +
  'ajudar. Se algo não estiver no arquivo, diga claramente. Não invente.';

/** Executa uma chamada ao Gemini convertendo erros do SDK em mensagens amigáveis. */
async function viaGemini<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    throw new Error(classifyGeminiError(error).message, { cause: error });
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(new Error('A ação foi cancelada.'));
      },
      { once: true },
    );
  });
}

const analyzeFile: ToolSpec = {
  name: 'analyze_file',
  label: 'Analisando arquivo',
  group: 'computer',
  risk: 'safe',
  timeoutMs: 300_000,
  description:
    'Analisa o conteúdo de um arquivo com a visão/audição do Gemini e responde a uma pergunta sobre ele: ' +
    'PDFs (ler, resumir, extrair dados), imagens e fotos (descrever, ler texto, identificar), áudios (transcrever, resumir), ' +
    'vídeos (descrever, resumir), além de planilhas, documentos e código (análise profunda). ' +
    'Faça uma pergunta específica para respostas melhores (ex.: "qual o valor total da nota?").',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Caminho do arquivo.' },
      question: {
        type: 'string',
        description: 'O que você quer saber do arquivo (padrão: resumo completo do conteúdo).',
      },
    },
    required: ['path'],
  },
  async execute(args, ctx) {
    const a = parseArgs(
      'analyze_file',
      z.object({ path: requiredText('o caminho do arquivo'), question: z.string().trim().max(4000).nullish() }),
      args,
    );
    const file = resolveUserPath(a.path);
    const st = await requireExisting(file);
    if (st.isDirectory()) throw new Error(`"${file}" é uma pasta. Use list_directory.`);
    const ext = extOf(file);
    const name = path.basename(file);
    const question = a.question || 'Resuma e descreva o conteúdo deste arquivo de forma completa e organizada.';
    const kind = kindLabel(ext, false);

    if (config.mock) {
      return {
        output: { path: file, kind, analysis: `(Modo demonstração) Análise simulada de "${name}": aqui viria a resposta do Gemini para “${question}”.` },
        summary: `Analisado (demonstração): ${name}`,
      };
    }
    const ai = getClient();
    if (!ai) throw new Error('Para analisar arquivos preciso de uma chave do Google AI Studio (Configurações).');

    const parts: Part[] = [];
    let uploadedName: string | null = null;
    const mime = GEMINI_MIME[ext];
    try {
      if (mime) {
        if (st.size > UPLOAD_LIMIT) throw new Error(`Arquivo grande demais para análise (${formatBytes(st.size)}; máx. 1 GB).`);
        if (st.size <= INLINE_LIMIT) {
          const data = await fs.promises.readFile(file);
          parts.push({ inlineData: { mimeType: mime, data: data.toString('base64') } });
        } else {
          // Arquivos grandes vão pela Files API (processamento assíncrono do lado do Google).
          const safeName = name.normalize('NFD').replace(/[^\x20-\x7e]/g, '').slice(0, 100) || 'arquivo';
          let uploaded = await viaGemini(() =>
            ai.files.upload({ file, config: { mimeType: mime, displayName: safeName, abortSignal: ctx.signal } }),
          );
          uploadedName = uploaded.name ?? null;
          const deadline = Date.now() + 180_000;
          while (uploaded.state === 'PROCESSING') {
            if (Date.now() > deadline) throw new Error('O Google demorou demais para processar o arquivo.');
            await sleep(2500, ctx.signal);
            const current = uploaded;
            uploaded = await viaGemini(() => ai.files.get({ name: current.name! }));
          }
          if (uploaded.state === 'FAILED' || !uploaded.uri) throw new Error('O Google não conseguiu processar este arquivo.');
          parts.push(createPartFromUri(uploaded.uri, uploaded.mimeType ?? mime));
        }
      } else {
        let text: string;
        if (OFFICE_EXTENSIONS.has(ext)) text = await officeToText(file, ext);
        else {
          if (st.size > 20 * 1024 * 1024) throw new Error('Arquivo de texto grande demais para análise completa; use read_file por partes.');
          const buf = await fs.promises.readFile(file);
          if (looksBinary(buf)) throw new Error(`Formato .${ext || '?'} não suportado para análise (binário desconhecido).`);
          text = decodeText(buf).text;
        }
        const clipped = text.length > TEXT_ANALYSIS_LIMIT;
        parts.push({
          text: `Conteúdo do arquivo "${name}"${clipped ? ' (início; arquivo truncado)' : ''}:\n\n${text.slice(0, TEXT_ANALYSIS_LIMIT)}`,
        });
      }
      parts.push({ text: `Pergunta sobre o arquivo "${name}": ${question}` });

      const { response, model } = await viaGemini(() =>
        generateWithFallback(
          'chat',
          { contents: [{ role: 'user', parts }], config: { systemInstruction: ANALYSIS_SYSTEM, temperature: 0.3 } },
          { signal: ctx.signal, timeoutMs: 180_000 },
        ),
      );
      const analysis = response.text?.trim();
      if (!analysis) {
        const reason = response.promptFeedback?.blockReason ?? response.candidates?.[0]?.finishReason;
        throw new Error(`O Gemini não devolveu análise${reason ? ` (${reason})` : ''}.`);
      }
      return {
        output: { path: file, kind, size: formatBytes(st.size), model, analysis },
        summary: `Analisado: ${name}`,
      };
    } finally {
      if (uploadedName) {
        const uploaded = uploadedName;
        void ai.files.delete({ name: uploaded }).catch(() => undefined);
      }
    }
  },
};

// ─── search_files ────────────────────────────────────────────────────────

interface SearchHit {
  path: string;
  name: string;
  isDir: boolean;
  score: number;
  matches?: { line: number; text: string }[];
}

function nameScore(name: string, query: string, tokens: string[]): number {
  const folded = foldText(name);
  const stem = foldText(name.replace(/\.[^.]+$/, ''));
  if (stem === query || folded === query) return 100;
  if (folded.startsWith(query)) return 70;
  if (folded.includes(query)) return 50;
  if (tokens.length > 1 && tokens.every((t) => folded.includes(t))) return 30;
  return 0;
}

function globToRegExp(glob: string): RegExp {
  const escaped = foldText(glob)
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`);
}

async function searchContent(file: string, query: string): Promise<{ line: number; text: string }[] | null> {
  let buf: Buffer;
  try {
    buf = await fs.promises.readFile(file);
  } catch {
    return null;
  }
  if (looksBinary(buf)) return null;
  const { text } = decodeText(buf);
  if (!foldText(text).includes(query)) return null;
  const matches: { line: number; text: string }[] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length && matches.length < 3; i++) {
    if (foldText(lines[i]).includes(query)) {
      const line = lines[i].trim();
      matches.push({ line: i + 1, text: line.length > 200 ? `${line.slice(0, 200)}…` : line });
    }
  }
  return matches;
}

const searchFiles: ToolSpec = {
  name: 'search_files',
  label: 'Procurando arquivos',
  group: 'computer',
  risk: 'safe',
  timeoutMs: 90_000,
  description:
    'Procura arquivos e pastas no computador pelo nome (sem diferenciar maiúsculas nem acentos; várias palavras = todas ' +
    'precisam aparecer; aceita curingas como "*.pdf" ou "relatorio*2025*") e/ou pelo conteúdo de arquivos de texto/código. ' +
    'Por padrão procura em toda a pasta pessoal (ignorando caches, node_modules, .git e lixeira). ' +
    'Use root para restringir (ex.: "Documentos") e extensions para filtrar tipos.',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Parte do nome, curinga ou texto a procurar.' },
      root: { type: 'string', description: 'Pasta onde procurar (padrão: pasta pessoal). Ex.: "Downloads", "D:\\\\".' },
      by: {
        type: 'string',
        enum: ['name', 'content', 'both'],
        description: 'name = pelo nome (padrão); content = dentro de arquivos de texto até 2 MB; both = os dois.',
      },
      extensions: {
        type: 'array',
        items: { type: 'string' },
        description: 'Filtrar por extensões, ex.: ["pdf", "docx"].',
      },
      max_results: { type: 'integer', minimum: 1, maximum: 200, description: 'Máximo de resultados (padrão 50).' },
    },
    required: ['query'],
  },
  async execute(args, ctx) {
    const a = parseArgs(
      'search_files',
      z.object({
        query: requiredText('o que procurar').max(300),
        root: z.string().trim().nullish(),
        by: z.enum(['name', 'content', 'both']).nullish(),
        extensions: z.array(z.string()).max(30).nullish(),
        max_results: optionalInt(1, 200),
      }),
      args,
    );
    const root = a.root ? resolveUserPath(a.root) : os.homedir();
    const st = await requireExisting(root);
    if (!st.isDirectory()) throw new Error(`"${root}" não é uma pasta.`);
    const by = a.by ?? 'name';
    const max = a.max_results ?? 50;
    const query = foldText(a.query);
    const isGlob = /[*?]/.test(a.query);
    const globRe = isGlob ? globToRegExp(a.query) : null;
    const tokens = query.split(/\s+/).filter(Boolean);
    const exts = new Set((a.extensions ?? []).map((e) => e.toLowerCase().replace(/^\*?\./, '')).filter(Boolean));
    const started = Date.now();

    const nameHits: SearchHit[] = [];
    const contentCandidates: string[] = [];
    let scanned = 0;
    const skipCloud = isWin && !/[\\/]OneDrive/i.test(root);
    let skippedCloud = false;
    const MAX_NAME_HITS = Math.max(max * 4, 200);
    const MAX_CONTENT_FILES = 6000;

    const { timedOut } = await walk(
      { root, onlyFiles: by === 'content', stats: false, deep: 14, dot: false, budgetMs: by === 'name' ? 30_000 : 25_000, signal: ctx.signal },
      (entry) => {
        scanned++;
        const isDir = entry.dirent.isDirectory();
        const ext = extOf(entry.name);
        if (exts.size && (isDir || !exts.has(ext))) return true;
        const full = path.join(root, entry.path);
        if (by !== 'content') {
          const score = globRe ? (globRe.test(foldText(entry.name)) ? 60 : 0) : nameScore(entry.name, query, tokens);
          if (score > 0 && nameHits.length < MAX_NAME_HITS) nameHits.push({ path: full, name: entry.name, isDir, score });
        }
        if (
          by !== 'name' &&
          !isDir &&
          (TEXT_EXTENSIONS.has(ext) || (exts.size > 0 && exts.has(ext))) &&
          contentCandidates.length < MAX_CONTENT_FILES
        ) {
          // Ler arquivos "somente online" do OneDrive forçaria o download: só quando a busca é dentro dele.
          if (skipCloud && /[\\/]OneDrive[^\\/]*[\\/]/i.test(`/${entry.path}`)) skippedCloud = true;
          else contentCandidates.push(full);
        }
        return by === 'name' ? nameHits.length < MAX_NAME_HITS : contentCandidates.length < MAX_CONTENT_FILES || nameHits.length < MAX_NAME_HITS;
      },
    );

    const contentHits: SearchHit[] = [];
    let contentTimedOut = false;
    if (by !== 'name' && query) {
      const deadline = Date.now() + 30_000;
      const candidates = contentCandidates;
      await runPool(candidates, 8, async (file) => {
        if (contentHits.length >= max || ctx.signal?.aborted) return;
        if (Date.now() > deadline) {
          contentTimedOut = true;
          return;
        }
        const s = await statOrNull(file);
        if (!s || s.size > 2 * 1024 * 1024 || s.size === 0) return;
        const matches = await searchContent(file, query);
        if (matches && contentHits.length < max) {
          contentHits.push({ path: file, name: path.basename(file), isDir: false, score: 40 + Math.min(matches.length, 3), matches });
        }
      });
    }
    throwIfAborted(ctx.signal);

    // Une resultados (o mesmo arquivo pode aparecer por nome e por conteúdo).
    const merged = new Map<string, SearchHit>();
    for (const hit of [...nameHits, ...contentHits]) {
      const prev = merged.get(hit.path);
      merged.set(hit.path, prev ? { ...prev, score: prev.score + hit.score, matches: hit.matches ?? prev.matches } : hit);
    }
    const ranked = [...merged.values()].sort((x, y) => y.score - x.score || x.path.length - y.path.length).slice(0, max);
    const tz = userTimeZone();
    const results = await runPool(ranked, 16, async (hit) => {
      const s = await statOrNull(hit.path);
      return {
        path: hit.path,
        name: hit.name,
        type: hit.isDir ? 'pasta' : kindLabel(extOf(hit.name), false),
        ...(s && !hit.isDir ? { size: formatBytes(s.size) } : {}),
        ...(s ? { modified: shortDateTime(s.mtimeMs, tz) } : {}),
        ...(hit.matches ? { matches: hit.matches } : {}),
      };
    });
    const partial = timedOut || contentTimedOut;
    return {
      output: {
        query: a.query,
        root,
        by,
        count: results.length,
        results,
        scannedEntries: scanned,
        elapsedMs: Date.now() - started,
        ...(partial ? { partial: true, note: 'A busca atingiu o limite de tempo; resultados parciais. Restrinja com root ou extensions.' } : {}),
        ...(skippedCloud ? { cloudNote: 'O conteúdo de arquivos do OneDrive não foi lido (evita baixá-los); use root dentro do OneDrive para incluí-los.' } : {}),
        ...(results.length === 0
          ? { hint: 'Nada encontrado. Tente outra palavra, um trecho menor do nome, outra pasta (root) ou by="content".' }
          : {}),
      },
      summary:
        results.length === 0
          ? `Nada encontrado para "${a.query}"`
          : `${plural(results.length, 'resultado', 'resultados')} para "${a.query}"${partial ? ' (parcial)' : ''}`,
    };
  },
};

// ─── file_info ───────────────────────────────────────────────────────────

const fileInfo: ToolSpec = {
  name: 'file_info',
  label: 'Inspecionando arquivo',
  group: 'computer',
  risk: 'safe',
  timeoutMs: 60_000,
  description:
    'Detalhes de um arquivo ou pasta: tipo, tamanho, datas de criação/modificação/acesso, se é oculto ou somente leitura, ' +
    'destino de atalhos e, para pastas, quantos itens tem e (opcional) o tamanho total ocupado.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Caminho do arquivo ou pasta.' },
      include_folder_size: {
        type: 'boolean',
        description: 'Para pastas: somar o tamanho de todo o conteúdo (pode levar alguns segundos). Padrão false.',
      },
    },
    required: ['path'],
  },
  async execute(args, ctx) {
    const a = parseArgs(
      'file_info',
      z.object({ path: requiredText('o caminho'), include_folder_size: optionalBool }),
      args,
    );
    const target = resolveUserPath(a.path);
    let lst: fs.Stats;
    try {
      lst = await fs.promises.lstat(target);
    } catch {
      await requireExisting(target);
      throw new Error(`Não consegui inspecionar "${target}".`);
    }
    const st = (await statOrNull(target)) ?? lst;
    const isDir = st.isDirectory();
    const ext = extOf(target);
    const tz = userTimeZone();
    const info: Record<string, unknown> = {
      path: target,
      name: path.basename(target) || target,
      type: isDir ? 'pasta' : 'arquivo',
      kind: kindLabel(ext, isDir),
      ...(ext && !isDir ? { extension: ext } : {}),
      ...(!isDir && mimeOf(target) ? { mimeType: mimeOf(target) } : {}),
      created: shortDateTime(st.birthtimeMs || st.ctimeMs, tz),
      modified: shortDateTime(st.mtimeMs, tz),
      accessed: shortDateTime(st.atimeMs, tz),
      hidden: isHiddenName(path.basename(target)),
      readOnly: (st.mode & 0o200) === 0,
      ...(!isWin ? { permissions: (st.mode & 0o777).toString(8) } : {}),
    };
    if (lst.isSymbolicLink()) {
      try {
        info.linkTarget = await fs.promises.readlink(target);
      } catch {
        info.linkTarget = '(não foi possível ler)';
      }
    }
    if (!isDir) {
      info.size = formatBytes(st.size);
      info.bytes = st.size;
    } else {
      try {
        const items = await fs.promises.readdir(target);
        info.items = items.length;
      } catch {
        info.items = null;
      }
      if (a.include_folder_size) {
        let total = 0;
        let count = 0;
        const { timedOut } = await walk(
          { root: target, onlyFiles: true, stats: true, deep: 64, dot: true, budgetMs: 40_000, signal: ctx.signal },
          (entry) => {
            total += entry.stats?.size ?? 0;
            count++;
            return true;
          },
        );
        info.folderSize = formatBytes(total);
        info.folderBytes = total;
        info.filesCounted = count;
        if (timedOut) info.note = 'Soma interrompida por tempo: o tamanho real é maior. (Caches e node_modules são ignorados.)';
        else info.note = 'Caches, node_modules, .git e lixeira não entram na soma.';
      }
    }
    return {
      output: info,
      summary: `${info.name as string}: ${isDir ? `pasta${typeof info.items === 'number' ? ` com ${plural(info.items, 'item', 'itens')}` : ''}${info.folderSize ? ` · ${info.folderSize as string}` : ''}` : `${info.kind as string} de ${info.size as string}`}`,
    };
  },
};

// ─── Escrita ─────────────────────────────────────────────────────────────

function existsSync(p: string): boolean {
  try {
    fs.statSync(p);
    return true;
  } catch {
    return false;
  }
}

/** Resolve sem lançar (para describe/riskFor). */
function safeResolve(p: string): string {
  try {
    return resolveUserPath(p);
  } catch {
    return p;
  }
}

function preview(text: string, max = 400): string {
  return text.length > max ? `${text.slice(0, max)}… (+${(text.length - max).toLocaleString('pt-BR')} caracteres)` : text;
}

const writeFile: ToolSpec = {
  name: 'write_file',
  label: 'Escrevendo arquivo',
  group: 'computer',
  risk: 'confirm',
  riskFor: (args) => {
    if (argText(args, 'mode') !== 'overwrite') return 'confirm';
    return existsSync(safeResolve(argText(args, 'path'))) ? 'dangerous' : 'confirm';
  },
  description:
    'Cria ou altera um arquivo de texto (anotações, código, .md, .csv, .json, .html, scripts...). ' +
    'mode="create" (padrão) cria um arquivo novo e falha se já existir; "append" acrescenta ao final; ' +
    '"overwrite" substitui todo o conteúdo (destrutivo). Pastas intermediárias são criadas automaticamente. ' +
    'Para documentos que o usuário vai abrir no Word, prefira .md ou .txt (ou .html) e avise.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Caminho do arquivo (ex.: "Área de Trabalho/lista.txt").' },
      content: { type: 'string', description: 'Conteúdo a escrever (texto UTF-8).' },
      mode: { type: 'string', enum: ['create', 'overwrite', 'append'], description: 'Padrão "create".' },
    },
    required: ['path', 'content'],
  },
  describe: (args) => {
    const target = safeResolve(argText(args, 'path'));
    const content = typeof args.content === 'string' ? args.content : '';
    const mode = argText(args, 'mode') || 'create';
    const verb =
      mode === 'overwrite' ? (existsSync(target) ? 'Sobrescrever (substituir todo o conteúdo de)' : 'Criar') : mode === 'append' ? 'Acrescentar ao final de' : 'Criar';
    return `${verb} ${target} — ${content.length.toLocaleString('pt-BR')} caracteres:\n${preview(content)}`;
  },
  async execute(args, ctx) {
    const a = parseArgs(
      'write_file',
      z.object({
        path: requiredText('o caminho do arquivo'),
        content: z.string({ error: 'informe o conteúdo' }).max(5_000_000, 'conteúdo grande demais (máx. 5 MB)'),
        mode: z.enum(['create', 'overwrite', 'append']).nullish(),
      }),
      args,
    );
    const file = resolveUserPath(a.path);
    const mode = a.mode ?? 'create';
    const existing = await statOrNull(file);
    if (existing?.isDirectory()) throw new Error(`"${file}" é uma pasta; informe o caminho de um arquivo.`);
    assertNotProtected(file, existing && mode === 'overwrite' ? 'delete' : 'modify', existing ? 'alterar' : 'criar');
    if (mode === 'create' && existing) {
      throw new Error(`"${file}" já existe. Use mode="append" para acrescentar ou mode="overwrite" para substituir.`);
    }
    throwIfAborted(ctx.signal);
    // O Excel só reconhece acentos em CSV UTF-8 quando há BOM.
    const addBom = mode !== 'append' && extOf(file) === 'csv' && !a.content.startsWith('\ufeff');
    const content = addBom ? `\ufeff${a.content}` : a.content;
    try {
      await fs.promises.mkdir(path.dirname(file), { recursive: true });
      if (mode === 'append') await fs.promises.appendFile(file, content, 'utf8');
      else await fs.promises.writeFile(file, content, { encoding: 'utf8', flag: mode === 'create' ? 'wx' : 'w' });
    } catch (error) {
      throw friendlyFsError(error, file);
    }
    const st = await statOrNull(file);
    const action = mode === 'append' ? (existing ? 'appended' : 'created') : existing ? 'overwritten' : 'created';
    const label = { appended: 'Texto acrescentado em', created: 'Arquivo criado:', overwritten: 'Arquivo substituído:' }[action];
    return {
      output: {
        ok: true,
        path: file,
        action,
        size: formatBytes(st?.size ?? content.length),
        ...(addBom ? { note: 'CSV salvo em UTF-8 com BOM para abrir corretamente no Excel.' } : {}),
      },
      summary: `${label} ${path.basename(file)}`,
    };
  },
};

const createDirectory: ToolSpec = {
  name: 'create_directory',
  label: 'Criando pasta',
  group: 'computer',
  risk: 'confirm',
  description: 'Cria uma pasta (e as intermediárias que faltarem). Ex.: "Documentos/Projetos/2026".',
  parameters: {
    type: 'object',
    properties: { path: { type: 'string', description: 'Caminho da nova pasta.' } },
    required: ['path'],
  },
  describe: (args) => `Criar a pasta ${safeResolve(argText(args, 'path'))}`,
  async execute(args) {
    const a = parseArgs('create_directory', z.object({ path: requiredText('o caminho da pasta') }), args);
    const dir = resolveUserPath(a.path);
    const existing = await statOrNull(dir);
    if (existing) {
      if (existing.isDirectory()) return { output: { ok: true, path: dir, alreadyExisted: true }, summary: `A pasta já existia: ${path.basename(dir)}` };
      throw new Error(`Já existe um arquivo com esse nome: ${dir}`);
    }
    assertNotProtected(dir, 'modify', 'criar');
    try {
      await fs.promises.mkdir(dir, { recursive: true });
    } catch (error) {
      throw friendlyFsError(error, dir);
    }
    return { output: { ok: true, path: dir, created: true }, summary: `Pasta criada: ${path.basename(dir)}` };
  },
};

/** Destino final no estilo `mv`/`cp`: se `to` é uma pasta existente, o item vai para dentro dela. */
function finalDestination(from: string, to: string, toRaw: string): string {
  const st = (() => {
    try {
      return fs.statSync(to);
    } catch {
      return null;
    }
  })();
  if (st?.isDirectory() && path.resolve(from) !== path.resolve(to)) return path.join(to, path.basename(from));
  if (/[\\/]$/.test(toRaw)) return path.join(to, path.basename(from));
  return to;
}

function transferRisk(args: Record<string, unknown>): ToolRisk {
  try {
    const from = resolveUserPath(argText(args, 'from'));
    const to = finalDestination(from, resolveUserPath(argText(args, 'to')), argText(args, 'to'));
    const overwrite = args.overwrite === true || args.overwrite === 'true';
    return overwrite && existsSync(to) ? 'dangerous' : 'confirm';
  } catch {
    return 'confirm';
  }
}

function describeTransfer(verb: string) {
  return (args: Record<string, unknown>) => {
    const from = safeResolve(argText(args, 'from'));
    const toRaw = argText(args, 'to');
    const to = finalDestination(from, safeResolve(toRaw), toRaw);
    const overwrite = (args.overwrite === true || args.overwrite === 'true') && existsSync(to);
    return `${verb}:\n${from}\n→ ${to}${overwrite ? '\n(substituindo o que já existe no destino)' : ''}`;
  };
}

const transferSchema = z.object({
  from: requiredText('a origem (from)'),
  to: requiredText('o destino (to)'),
  overwrite: optionalBool,
});

async function prepareTransfer(tool: string, args: Record<string, unknown>) {
  const a = parseArgs(tool, transferSchema, args);
  const from = resolveUserPath(a.from);
  const fromStat = await requireExisting(from);
  const to = finalDestination(from, resolveUserPath(a.to), a.to);
  if (path.resolve(from) === path.resolve(to)) throw new Error('Origem e destino são o mesmo lugar.');
  if (fromStat.isDirectory() && (to + path.sep).toLowerCase().startsWith((from + path.sep).toLowerCase())) {
    throw new Error('Não dá para colocar uma pasta dentro dela mesma.');
  }
  let destStat = await statOrNull(to);
  // Mudança só de maiúsculas/minúsculas num sistema que não diferencia (mesmo arquivo).
  if (destStat && destStat.ino === fromStat.ino && destStat.dev === fromStat.dev && destStat.ino !== 0) destStat = null;
  if (destStat && !a.overwrite) {
    throw new Error(`Já existe "${to}". Escolha outro nome ou use overwrite=true para substituir.`);
  }
  if (destStat && destStat.isDirectory() !== fromStat.isDirectory()) {
    throw new Error(`Não dá para substituir ${destStat.isDirectory() ? 'uma pasta por um arquivo' : 'um arquivo por uma pasta'}.`);
  }
  return { from, to, fromStat, destStat, overwrite: Boolean(a.overwrite) };
}

const movePath: ToolSpec = {
  name: 'move_path',
  label: 'Movendo',
  group: 'computer',
  risk: 'confirm',
  riskFor: transferRisk,
  timeoutMs: 300_000,
  description:
    'Move ou RENOMEIA um arquivo ou pasta. Se "to" for uma pasta existente, o item vai para dentro dela; ' +
    'senão, "to" é o novo caminho/nome (ex.: renomear "Downloads/foto.png" para "Downloads/praia.png"). ' +
    'Não substitui nada no destino, a menos que overwrite=true.',
  parameters: {
    type: 'object',
    properties: {
      from: { type: 'string', description: 'Caminho atual.' },
      to: { type: 'string', description: 'Pasta de destino ou novo caminho/nome.' },
      overwrite: { type: 'boolean', description: 'Substituir se já existir no destino (padrão false).' },
    },
    required: ['from', 'to'],
  },
  describe: describeTransfer('Mover'),
  async execute(args, ctx) {
    const t = await prepareTransfer('move_path', args);
    assertNotProtected(t.from, 'delete', 'mover');
    assertNotProtected(t.to, t.destStat ? 'delete' : 'modify', t.destStat ? 'substituir' : 'criar');
    throwIfAborted(ctx.signal);
    try {
      await fs.promises.mkdir(path.dirname(t.to), { recursive: true });
      // O que estava no destino vai para a Lixeira (nunca é apagado de vez).
      if (t.destStat && t.overwrite) await trash(t.to, { glob: false });
      try {
        await fs.promises.rename(t.from, t.to);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
        // Outra unidade: copia e depois remove a origem.
        await fs.promises.cp(t.from, t.to, { recursive: true, errorOnExist: true, force: false, preserveTimestamps: true });
        await fs.promises.rm(t.from, { recursive: true, force: true });
      }
    } catch (error) {
      throw friendlyFsError(error, t.from);
    }
    const renamed = path.dirname(t.from) === path.dirname(t.to);
    return {
      output: { ok: true, from: t.from, to: t.to, ...(t.destStat ? { replaced: true, note: 'O item substituído foi para a Lixeira.' } : {}) },
      summary: renamed ? `Renomeado para ${path.basename(t.to)}` : `Movido para ${path.dirname(t.to)}`,
    };
  },
};

const copyPath: ToolSpec = {
  name: 'copy_path',
  label: 'Copiando',
  group: 'computer',
  risk: 'confirm',
  riskFor: transferRisk,
  timeoutMs: 300_000,
  description:
    'Copia um arquivo ou uma pasta inteira. Se "to" for uma pasta existente, a cópia vai para dentro dela. ' +
    'Não substitui nada no destino, a menos que overwrite=true.',
  parameters: {
    type: 'object',
    properties: {
      from: { type: 'string', description: 'O que copiar.' },
      to: { type: 'string', description: 'Pasta de destino ou caminho da cópia.' },
      overwrite: { type: 'boolean', description: 'Substituir se já existir no destino (padrão false).' },
    },
    required: ['from', 'to'],
  },
  describe: describeTransfer('Copiar'),
  async execute(args, ctx) {
    const t = await prepareTransfer('copy_path', args);
    assertNotProtected(t.to, t.destStat ? 'delete' : 'modify', t.destStat ? 'substituir' : 'criar');
    throwIfAborted(ctx.signal);
    try {
      await fs.promises.mkdir(path.dirname(t.to), { recursive: true });
      // O que estava no destino vai para a Lixeira (nunca é apagado de vez).
      if (t.destStat && t.overwrite) await trash(t.to, { glob: false });
      await fs.promises.cp(t.from, t.to, { recursive: true, errorOnExist: true, force: false, preserveTimestamps: true });
    } catch (error) {
      throw friendlyFsError(error, t.to);
    }
    const st = await statOrNull(t.to);
    return {
      output: { ok: true, from: t.from, to: t.to, ...(st && !st.isDirectory() ? { size: formatBytes(st.size) } : {}) },
      summary: `Copiado para ${path.dirname(t.to)}`,
    };
  },
};

const deletePath: ToolSpec = {
  name: 'delete_path',
  label: 'Enviando para a Lixeira',
  group: 'computer',
  risk: 'dangerous',
  timeoutMs: 120_000,
  description:
    'Apaga um arquivo ou pasta enviando para a LIXEIRA do sistema (recuperável). Nunca apaga permanentemente. ' +
    'Confirme o caminho exato antes (list_directory/search_files). Pastas críticas do sistema são protegidas.',
  parameters: {
    type: 'object',
    properties: { path: { type: 'string', description: 'Caminho do arquivo ou pasta a apagar.' } },
    required: ['path'],
  },
  describe: (args) => {
    const target = safeResolve(argText(args, 'path'));
    try {
      const st = fs.statSync(target);
      if (st.isDirectory()) {
        const n = fs.readdirSync(target).length;
        return `Mover para a Lixeira a PASTA ${target} (${plural(n, 'item', 'itens')} no primeiro nível)`;
      }
      return `Mover para a Lixeira o arquivo ${target} (${formatBytes(st.size)})`;
    } catch {
      return `Mover para a Lixeira: ${target}`;
    }
  },
  async execute(args, ctx) {
    const a = parseArgs('delete_path', z.object({ path: requiredText('o caminho') }), args);
    const target = resolveUserPath(a.path);
    const st = await requireExisting(target);
    assertNotProtected(target, 'delete', 'apagar');
    throwIfAborted(ctx.signal);
    try {
      await trash(target, { glob: false });
    } catch (error) {
      throw new Error(
        `Não consegui mover para a Lixeira: ${error instanceof Error ? error.message : String(error)}. Nada foi apagado.`,
      );
    }
    if (await statOrNull(target)) throw new Error(`"${target}" continua existindo; talvez esteja em uso por outro programa.`);
    return {
      output: { ok: true, path: target, type: st.isDirectory() ? 'pasta' : 'arquivo', recoverable: true, note: 'Enviado para a Lixeira; pode ser restaurado de lá.' },
      summary: `${path.basename(target)} foi para a Lixeira`,
    };
  },
};

// ─── open_path ───────────────────────────────────────────────────────────

const ALLOWED_URL_SCHEMES = new Set([
  'http',
  'https',
  'mailto',
  'tel',
  'ms-settings',
  'x-apple.systempreferences',
  'spotify',
  'whatsapp',
  'tg',
  'zoommtg',
  'msteams',
  'discord',
  'slack',
  'obsidian',
  'notion',
  'steam',
]);

function urlScheme(target: string): string | null {
  const m = target.match(/^([a-z][a-z0-9+.-]*):/i);
  if (!m) return null;
  if (m[1].length === 1) return null; // "C:\..." é caminho de unidade, não URL
  return m[1].toLowerCase();
}

function appFor(name: string): string | readonly string[] {
  const key = foldText(name);
  if (/chrome/.test(key)) return apps.chrome;
  if (/firefox/.test(key)) return apps.firefox;
  if (/edge/.test(key)) return apps.edge;
  if (/brave/.test(key)) return apps.brave;
  if (/^(navegador|browser|navegador padrao)$/.test(key)) return apps.browser;
  return name;
}

const openPath: ToolSpec = {
  name: 'open_path',
  label: 'Abrindo',
  group: 'computer',
  risk: 'confirm',
  riskFor: (args) => {
    const target = argText(args, 'path_or_url');
    if (urlScheme(target)) return 'confirm';
    return EXECUTABLE_EXTENSIONS.has(extOf(target)) ? 'dangerous' : 'confirm';
  },
  description:
    'Abre um arquivo ou pasta no programa padrão do sistema (foto no visualizador, PDF no leitor, pasta no Explorer/Finder) ' +
    'ou um link no navegador (http/https, mailto:, ms-settings: para páginas de configuração do Windows). ' +
    'Opcionalmente escolha o programa (ex.: app="chrome", "firefox", "notepad", "code"). Para abrir programas pelo nome, use open_app.',
  parameters: {
    type: 'object',
    properties: {
      path_or_url: { type: 'string', description: 'Caminho do arquivo/pasta ou URL.' },
      app: { type: 'string', description: 'Programa para abrir (opcional).' },
    },
    required: ['path_or_url'],
  },
  describe: (args) => {
    const raw = argText(args, 'path_or_url');
    const target = urlScheme(raw) ? raw : safeResolve(raw);
    const app = argText(args, 'app');
    const exec = !urlScheme(raw) && EXECUTABLE_EXTENSIONS.has(extOf(raw)) ? ' (EXECUTA um programa)' : '';
    return `Abrir ${target}${app ? ` com ${app}` : ''}${exec}`;
  },
  async execute(args) {
    const a = parseArgs(
      'open_path',
      z.object({ path_or_url: requiredText('o caminho ou URL'), app: z.string().trim().nullish() }),
      args,
    );
    const scheme = urlScheme(a.path_or_url);
    let target: string;
    if (scheme) {
      if (!ALLOWED_URL_SCHEMES.has(scheme)) {
        throw new Error(`Por segurança não abro links do tipo "${scheme}:". Tipos permitidos: http, https, mailto, ms-settings e apps conhecidos.`);
      }
      target = a.path_or_url;
    } else {
      target = resolveUserPath(a.path_or_url);
      await requireExisting(target);
    }
    const child = await open(target, {
      wait: false,
      ...(a.app ? { app: { name: appFor(a.app) } } : {}),
    });
    // Erros do lançador aparecem logo após o spawn (ex.: programa inexistente).
    const failure = await new Promise<string | null>((resolve) => {
      const timer = setTimeout(() => resolve(null), 1200);
      child.once('error', (error) => {
        clearTimeout(timer);
        resolve(error.message);
      });
      child.once('exit', (code) => {
        clearTimeout(timer);
        resolve(code && code !== 0 ? `o lançador terminou com código ${code}` : null);
      });
    });
    child.unref();
    if (failure) throw new Error(`Não consegui abrir${a.app ? ` com "${a.app}"` : ''}: ${failure}.`);
    return {
      output: { ok: true, opened: target, ...(a.app ? { app: a.app } : {}) },
      summary: `Aberto: ${scheme ? target.slice(0, 80) : path.basename(target) || target}`,
    };
  },
};

// ─── recent_files ────────────────────────────────────────────────────────

const recentFiles: ToolSpec = {
  name: 'recent_files',
  label: 'Buscando arquivos recentes',
  group: 'computer',
  risk: 'safe',
  timeoutMs: 60_000,
  description:
    'Lista os arquivos modificados recentemente (do mais novo para o mais antigo). Sem root, olha Área de Trabalho, ' +
    'Documentos, Downloads, Imagens, Vídeos e Músicas. Útil para "o que eu baixei hoje?", "em que arquivo eu estava trabalhando?".',
  parameters: {
    type: 'object',
    properties: {
      root: { type: 'string', description: 'Pasta onde procurar (opcional).' },
      days: { type: 'integer', minimum: 1, maximum: 365, description: 'Quantos dias para trás (padrão 7).' },
      limit: { type: 'integer', minimum: 1, maximum: 100, description: 'Máximo de arquivos (padrão 30).' },
      extensions: { type: 'array', items: { type: 'string' }, description: 'Filtrar por extensões (ex.: ["pdf"]).' },
    },
  },
  async execute(args, ctx) {
    const a = parseArgs(
      'recent_files',
      z.object({
        root: z.string().trim().nullish(),
        days: optionalInt(1, 365),
        limit: optionalInt(1, 100),
        extensions: z.array(z.string()).max(30).nullish(),
      }),
      args,
    );
    const days = a.days ?? 7;
    const limit = a.limit ?? 30;
    const cutoff = Date.now() - days * 86_400_000;
    const exts = new Set((a.extensions ?? []).map((e) => e.toLowerCase().replace(/^\*?\./, '')).filter(Boolean));
    let roots: string[];
    if (a.root) roots = [resolveUserPath(a.root)];
    else {
      const wanted = new Set(['desktop', 'documents', 'downloads', 'pictures', 'videos', 'music']);
      roots = knownFolders()
        .filter((f) => wanted.has(f.key) && f.exists)
        .map((f) => f.path);
      // Evita percorrer duas vezes pastas aninhadas.
      roots = roots.filter((r, i) => !roots.some((o, j) => j !== i && r !== o && r.startsWith(o + path.sep)));
    }
    const found: { path: string; mtimeMs: number; size: number }[] = [];
    let partial = false;
    const budget = Math.max(5_000, Math.floor(40_000 / Math.max(1, roots.length)));
    for (const root of roots) {
      if (!(await statOrNull(root))?.isDirectory()) continue;
      const { timedOut } = await walk(
        { root, onlyFiles: true, stats: true, deep: 8, dot: false, budgetMs: budget, signal: ctx.signal },
        (entry) => {
          const mtime = entry.stats?.mtimeMs ?? 0;
          if (mtime >= cutoff && !isHiddenName(entry.name) && (!exts.size || exts.has(extOf(entry.name)))) {
            found.push({ path: path.join(root, entry.path), mtimeMs: mtime, size: entry.stats?.size ?? 0 });
          }
          return found.length < 20_000;
        },
      );
      partial ||= timedOut;
    }
    found.sort((x, y) => y.mtimeMs - x.mtimeMs);
    const tz = userTimeZone();
    const results = found.slice(0, limit).map((f) => ({
      path: f.path,
      name: path.basename(f.path),
      kind: kindLabel(extOf(f.path), false),
      size: formatBytes(f.size),
      modified: shortDateTime(f.mtimeMs, tz),
    }));
    return {
      output: {
        days,
        roots,
        totalFound: found.length,
        results,
        ...(partial ? { partial: true, note: 'Algumas pastas são grandes e a varredura foi interrompida por tempo.' } : {}),
      },
      summary: `${plural(found.length, 'arquivo alterado', 'arquivos alterados')} nos últimos ${plural(days, 'dia', 'dias')}`,
    };
  },
};

export const fileTools: ToolSpec[] = [
  listDirectory,
  readFile,
  analyzeFile,
  searchFiles,
  fileInfo,
  recentFiles,
  writeFile,
  createDirectory,
  movePath,
  copyPath,
  deletePath,
  openPath,
];

/** Exportado para testes. */
export const __test = { decodeText, looksBinary, xlsxToText, pptxToText, readZip, trimUtf8Edges, finalDestination };
