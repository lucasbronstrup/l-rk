import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const env = vi.hoisted(() => {
  process.env.LARK_DB_PATH = ':memory:';
  process.env.GEMINI_API_KEY = '';
  process.env.GOOGLE_API_KEY = '';
  const base = `${process.env.TMPDIR || '/tmp'}/lark-files-${process.pid}-${Date.now()}`;
  const previous = {
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
    XDG_DATA_HOME: process.env.XDG_DATA_HOME,
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
  };
  process.env.HOME = base;
  process.env.USERPROFILE = base;
  process.env.XDG_DATA_HOME = `${base}/.local/share`;
  delete process.env.XDG_CONFIG_HOME;
  return { base, previous };
});

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileTools, __test } from './files.js';
import { resetPathCaches } from './paths.js';
import type { ToolContext } from './types.js';

const home = env.base;
const work = path.join(home, 'trabalho');
const ctx: ToolContext = { conversationId: 'teste', mode: 'text', emit: () => undefined };
const tool = (name: string) => {
  const t = fileTools.find((x) => x.name === name);
  if (!t) throw new Error(`ferramenta ${name} não encontrada`);
  return t;
};
const run = (name: string, args: Record<string, unknown>) => tool(name).execute(args, ctx);

/** ZIP mínimo (entradas "stored" ou "deflate") para simular documentos do Office. */
function makeZip(entries: Record<string, string>, deflate = false): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(entries)) {
    const raw = Buffer.from(content, 'utf8');
    const data = deflate ? zlib.deflateRawSync(raw) : raw;
    const nameBuf = Buffer.from(name, 'utf8');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(deflate ? 8 : 0, 8);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(deflate ? 8 : 0, 10);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBuf, data);
    centrals.push(central, nameBuf);
    offset += local.length + nameBuf.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(Object.keys(entries).length, 8);
  eocd.writeUInt16LE(Object.keys(entries).length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

const XLSX = {
  'xl/workbook.xml':
    '<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Vendas" sheetId="1" r:id="rId1"/></sheets></workbook>',
  'xl/_rels/workbook.xml.rels':
    '<Relationships><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
  'xl/sharedStrings.xml': '<sst><si><t>Produto</t></si><si><t>Valor</t></si><si><r><t>Café</t></r><r><t xml:space="preserve"> &amp; pão</t></r></si></sst>',
  'xl/worksheets/sheet1.xml':
    '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>' +
    '<row r="2"><c r="A2" t="s"><v>2</v></c><c r="C2"><f>SUM(1,2)</f><v>12.5</v></c></row>' +
    '<row r="3"><c r="A3" t="inlineStr"><is><t>Total</t></is></c><c r="B3" t="b"><v>1</v></c></row></sheetData></worksheet>',
};

beforeAll(() => {
  fs.mkdirSync(work, { recursive: true });
  fs.mkdirSync(path.join(home, 'Documents'), { recursive: true });
  fs.writeFileSync(path.join(work, 'Relatório de Vendas 2026.txt'), 'Linha um\nO faturamento subiu 12%\nfim');
  fs.writeFileSync(path.join(work, '.oculto'), 'segredo');
  fs.writeFileSync(path.join(work, 'grande.txt'), 'a'.repeat(5000));
  fs.writeFileSync(path.join(work, 'latin.txt'), Buffer.from([0x63, 0x61, 0x66, 0xe9])); // "café" em Windows-1252
  fs.writeFileSync(path.join(work, 'binario.dat'), Buffer.from([0, 1, 2, 3, 0, 255]));
  fs.writeFileSync(path.join(work, 'foto.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  fs.writeFileSync(path.join(work, 'planilha.xlsx'), makeZip(XLSX, true));
  fs.writeFileSync(
    path.join(work, 'slides.pptx'),
    makeZip({
      'ppt/slides/slide2.xml': '<p:sld><a:p><a:r><a:t>Segundo slide</a:t></a:r></a:p></p:sld>',
      'ppt/slides/slide1.xml': '<p:sld><a:p><a:r><a:t>Visão</a:t></a:r><a:r><a:t> geral</a:t></a:r></a:p><a:p><a:r><a:t>Metas 2026</a:t></a:r></a:p></p:sld>',
    }),
  );
  fs.writeFileSync(
    path.join(work, 'carta.docx'),
    makeZip({
      '[Content_Types].xml':
        '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
      '_rels/.rels':
        '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
      'word/document.xml':
        '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Prezado Lucas,</w:t></w:r></w:p><w:p><w:r><w:t>Seu contrato foi aprovado.</w:t></w:r></w:p></w:body></w:document>',
    }),
  );
  fs.mkdirSync(path.join(work, 'node_modules', 'pacote'), { recursive: true });
  fs.writeFileSync(path.join(work, 'node_modules', 'pacote', 'relatorio-ignorado.txt'), 'faturamento');
  resetPathCaches();
});

afterAll(() => {
  fs.rmSync(home, { recursive: true, force: true });
  for (const [key, value] of Object.entries(env.previous)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('list_directory', () => {
  it('lista com tipos, tamanhos e esconde ocultos', async () => {
    const r = await run('list_directory', { path: work });
    const names = (r.output.entries as { name: string }[]).map((e) => e.name);
    expect(names[0]).toBe('node_modules'); // pastas primeiro
    expect(names).toContain('Relatório de Vendas 2026.txt');
    expect(names).not.toContain('.oculto');
    expect(r.output.hiddenItems).toBe(1);
    const shown = await run('list_directory', { path: work, show_hidden: true, sort: 'size', limit: 2 });
    expect((shown.output.entries as unknown[]).length).toBe(2);
    expect(shown.output.truncated).toBe(true);
  });

  it('dá erro claro para caminho inexistente ou arquivo', async () => {
    await expect(run('list_directory', { path: path.join(work, 'nada') })).rejects.toThrow(/Não encontrei/);
    await expect(run('list_directory', { path: path.join(work, 'latin.txt') })).rejects.toThrow(/não uma pasta/);
  });
});

describe('read_file', () => {
  it('lê texto em partes com offset', async () => {
    const first = await run('read_file', { path: path.join(work, 'grande.txt'), max_chars: 1000 });
    expect(first.output.returnedChars).toBe(1000);
    expect(first.output.truncated).toBe(true);
    expect(first.output.nextOffset).toBe(1000);
    const last = await run('read_file', { path: path.join(work, 'grande.txt'), offset: 4500, max_chars: 1000 });
    expect(last.output.returnedChars).toBe(500);
    expect(last.output.truncated).toBeUndefined();
  });

  it('detecta Windows-1252 e recusa binários', async () => {
    const r = await run('read_file', { path: path.join(work, 'latin.txt') });
    expect(r.output.content).toBe('café');
    expect(r.output.encoding).toBe('Windows-1252');
    await expect(run('read_file', { path: path.join(work, 'binario.dat') })).rejects.toThrow(/binário/);
  });

  it('orienta a usar analyze_file para mídia/PDF', async () => {
    const r = await run('read_file', { path: path.join(work, 'foto.png') });
    expect(String(r.output.note)).toMatch(/analyze_file/);
  });

  it('extrai texto de planilhas, apresentações e Word', async () => {
    const xlsx = String((await run('read_file', { path: path.join(work, 'planilha.xlsx') })).output.content);
    expect(xlsx).toContain('## Planilha: Vendas');
    expect(xlsx).toContain('Produto\tValor');
    expect(xlsx).toContain('Café & pão\t\t12.5');
    expect(xlsx).toContain('Total\tVERDADEIRO');

    const pptx = String((await run('read_file', { path: path.join(work, 'slides.pptx') })).output.content);
    expect(pptx.indexOf('## Slide 1')).toBeLessThan(pptx.indexOf('## Slide 2'));
    expect(pptx).toContain('Visão geral\nMetas 2026');

    const docx = String((await run('read_file', { path: path.join(work, 'carta.docx') })).output.content);
    expect(docx).toContain('Prezado Lucas,');
    expect(docx).toContain('Seu contrato foi aprovado.');
  });
});

describe('utilitários internos', () => {
  it('corta sequências UTF-8 incompletas nas bordas', () => {
    const buf = Buffer.from('ação', 'utf8');
    expect(__test.trimUtf8Edges(buf.subarray(0, 2)).toString('utf8')).toBe('a');
    expect(__test.trimUtf8Edges(buf.subarray(2)).toString('utf8')).toBe('ão');
  });

  it('detecta binário e BOM UTF-16', () => {
    expect(__test.looksBinary(Buffer.from([0x41, 0x00, 0x42]))).toBe(true);
    expect(__test.looksBinary(Buffer.from([0xff, 0xfe, 0x41, 0x00]))).toBe(false);
    expect(__test.decodeText(Buffer.from([0xff, 0xfe, 0x41, 0x00, 0xe7, 0x00])).text).toBe('Aç');
  });
});

describe('escrita', () => {
  it('cria, recusa recriar, acrescenta e sobrescreve', async () => {
    const file = path.join(work, 'novo', 'notas.md');
    const created = await run('write_file', { path: file, content: '# Notas' });
    expect(created.output.action).toBe('created');
    await expect(run('write_file', { path: file, content: 'x' })).rejects.toThrow(/já existe/);
    await run('write_file', { path: file, content: '\n- item', mode: 'append' });
    expect(fs.readFileSync(file, 'utf8')).toBe('# Notas\n- item');
    await run('write_file', { path: file, content: 'novo', mode: 'overwrite' });
    expect(fs.readFileSync(file, 'utf8')).toBe('novo');
  });

  it('eleva o risco ao sobrescrever um arquivo existente', () => {
    const spec = tool('write_file');
    expect(spec.riskFor?.({ path: path.join(work, 'latin.txt'), content: 'x', mode: 'overwrite' })).toBe('dangerous');
    expect(spec.riskFor?.({ path: path.join(work, 'inexistente.txt'), content: 'x', mode: 'overwrite' })).toBe('confirm');
    expect(spec.riskFor?.({ path: path.join(work, 'latin.txt'), content: 'x', mode: 'append' })).toBe('confirm');
    expect(spec.describe?.({ path: path.join(work, 'latin.txt'), content: 'abc', mode: 'overwrite' })).toMatch(/Sobrescrever/);
  });

  it('cria pastas e informa quando já existem', async () => {
    const dir = path.join(work, 'Projetos', '2026');
    expect((await run('create_directory', { path: dir })).output.created).toBe(true);
    expect((await run('create_directory', { path: dir })).output.alreadyExisted).toBe(true);
  });

  it('move para dentro de pastas, renomeia e não sobrescreve sem permissão', async () => {
    const src = path.join(work, 'mover.txt');
    fs.writeFileSync(src, 'conteúdo');
    const moved = await run('move_path', { from: src, to: path.join(work, 'Projetos') });
    const dest = path.join(work, 'Projetos', 'mover.txt');
    expect(moved.output.to).toBe(dest);
    expect(fs.existsSync(dest)).toBe(true);
    const renamed = await run('move_path', { from: dest, to: path.join(work, 'Projetos', 'movido.txt') });
    expect(renamed.summary).toMatch(/Renomeado/);
    fs.writeFileSync(path.join(work, 'Projetos', 'outro.txt'), 'x');
    await expect(run('move_path', { from: path.join(work, 'Projetos', 'outro.txt'), to: path.join(work, 'Projetos', 'movido.txt') })).rejects.toThrow(
      /Já existe/,
    );
    await expect(run('move_path', { from: path.join(work, 'Projetos'), to: path.join(work, 'Projetos', '2026') })).rejects.toThrow(/dentro dela mesma/);
  });

  it('copia pastas inteiras', async () => {
    const r = await run('copy_path', { from: path.join(work, 'Projetos'), to: path.join(work, 'Backup') });
    expect(r.output.to).toBe(path.join(work, 'Backup'));
    expect(fs.existsSync(path.join(work, 'Backup', 'movido.txt'))).toBe(true);
    expect(fs.existsSync(path.join(work, 'Projetos', 'movido.txt'))).toBe(true);
  });

  it.runIf(process.platform === 'linux')('apaga mandando para a Lixeira (recuperável)', async () => {
    const target = path.join(work, 'Backup');
    const r = await run('delete_path', { path: target });
    expect(r.output.recoverable).toBe(true);
    expect(fs.existsSync(target)).toBe(false);
    const infoDir = path.join(home, '.local', 'share', 'Trash', 'info');
    const infos = fs.readdirSync(infoDir).map((f) => fs.readFileSync(path.join(infoDir, f), 'utf8'));
    expect(infos.some((info) => info.includes(`Path=${target}`))).toBe(true);
  });

  it('protege pastas críticas', async () => {
    await expect(run('delete_path', { path: home })).rejects.toThrow(/Por segurança/);
    if (process.platform !== 'win32') await expect(run('write_file', { path: '/etc/lark-teste.txt', content: 'x' })).rejects.toThrow(/Por segurança/);
  });
});

describe('search_files', () => {
  it('procura pelo nome sem acentos, com várias palavras e curingas, ignorando node_modules', async () => {
    const r = await run('search_files', { query: 'relatorio vendas', root: work });
    const names = (r.output.results as { name: string }[]).map((x) => x.name);
    expect(names).toEqual(['Relatório de Vendas 2026.txt']);
    const glob = await run('search_files', { query: '*.xlsx', root: work });
    expect((glob.output.results as { name: string }[]).map((x) => x.name)).toEqual(['planilha.xlsx']);
  });

  it('procura dentro dos arquivos de texto e mostra a linha', async () => {
    const r = await run('search_files', { query: 'FATURAMENTO', root: work, by: 'content' });
    const results = r.output.results as { name: string; matches: { line: number; text: string }[] }[];
    expect(results).toHaveLength(1);
    expect(results[0].matches[0]).toEqual({ line: 2, text: 'O faturamento subiu 12%' });
  });

  it('filtra por extensão e informa quando nada foi encontrado', async () => {
    const r = await run('search_files', { query: 'zzz-nada', root: work, extensions: ['.pdf'] });
    expect(r.output.count).toBe(0);
    expect(String(r.output.hint)).toMatch(/Nada encontrado/);
  });
});

describe('file_info e recent_files', () => {
  it('mostra detalhes e soma o tamanho de pastas', async () => {
    const f = await run('file_info', { path: path.join(work, 'grande.txt') });
    expect(f.output.bytes).toBe(5000);
    expect(f.output.kind).toBe('texto');
    const d = await run('file_info', { path: work, include_folder_size: true });
    expect(d.output.type).toBe('pasta');
    expect(Number(d.output.folderBytes)).toBeGreaterThanOrEqual(5000);
  });

  it('lista arquivos recentes das pastas conhecidas', async () => {
    fs.writeFileSync(path.join(home, 'Documents', 'recente.txt'), 'oi');
    const old = path.join(home, 'Documents', 'antigo.txt');
    fs.writeFileSync(old, 'velho');
    const past = new Date(Date.now() - 30 * 86_400_000);
    fs.utimesSync(old, past, past);
    const r = await run('recent_files', { days: 7 });
    const names = (r.output.results as { name: string }[]).map((x) => x.name);
    expect(names).toContain('recente.txt');
    expect(names).not.toContain('antigo.txt');
  });
});

describe('analyze_file', () => {
  it('explica que precisa da chave do Gemini', async () => {
    await expect(run('analyze_file', { path: path.join(work, 'foto.png') })).rejects.toThrow(/chave do Google AI Studio/);
  });
});

describe('open_path', () => {
  it('recusa esquemas de URL perigosos e marca executáveis como perigosos', async () => {
    await expect(run('open_path', { path_or_url: 'javascript:alert(1)' })).rejects.toThrow(/Por segurança/);
    await expect(run('open_path', { path_or_url: 'ms-msdt:/id' })).rejects.toThrow(/Por segurança/);
    expect(tool('open_path').riskFor?.({ path_or_url: 'C:/Downloads/instalador.exe' })).toBe('dangerous');
    expect(tool('open_path').riskFor?.({ path_or_url: 'https://exemplo.com' })).toBe('confirm');
  });
});
