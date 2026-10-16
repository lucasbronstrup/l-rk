import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const env = vi.hoisted(() => {
  process.env.LARK_DB_PATH = ':memory:';
  const base = `${process.env.TMPDIR || '/tmp'}/lark-paths-${process.pid}-${Date.now()}`;
  const previous = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME };
  process.env.HOME = base;
  process.env.USERPROFILE = base;
  delete process.env.XDG_CONFIG_HOME;
  return { base, previous };
});

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { updateSettings } from '../memory/settings.js';
import {
  assertNotProtected,
  expandEnvVars,
  foldText,
  knownFolders,
  protectionReason,
  ProtectedPathError,
  resetPathCaches,
  resolveUserPath,
} from './paths.js';

const home = env.base;
const isLinux = process.platform === 'linux';

beforeAll(() => {
  fs.mkdirSync(path.join(home, '.config'), { recursive: true });
  fs.mkdirSync(path.join(home, 'Área de Trabalho'), { recursive: true });
  fs.mkdirSync(path.join(home, 'Documentos'), { recursive: true });
  fs.writeFileSync(
    path.join(home, '.config', 'user-dirs.dirs'),
    ['# gerado', 'XDG_DESKTOP_DIR="$HOME/Área de Trabalho"', 'XDG_DOCUMENTS_DIR="$HOME/Documentos"', 'XDG_DOWNLOAD_DIR="$HOME/Downloads"'].join('\n'),
  );
  resetPathCaches();
});

afterAll(() => {
  fs.rmSync(home, { recursive: true, force: true });
  for (const [key, value] of Object.entries(env.previous)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('resolveUserPath', () => {
  it('usa a pasta pessoal do ambiente de teste', () => {
    expect(os.homedir()).toBe(home);
    expect(resolveUserPath('~')).toBe(home);
  });

  it('expande ~, variáveis de ambiente e URLs file://', () => {
    expect(resolveUserPath('~/notas/a.txt')).toBe(path.join(home, 'notas', 'a.txt'));
    expect(resolveUserPath('$HOME/x')).toBe(path.join(home, 'x'));
    expect(resolveUserPath('${HOME}/y')).toBe(path.join(home, 'y'));
    expect(resolveUserPath('%USERPROFILE%/z')).toBe(path.join(home, 'z'));
    expect(expandEnvVars('%VARIAVEL_QUE_NAO_EXISTE%/a')).toBe('%VARIAVEL_QUE_NAO_EXISTE%/a');
    if (process.platform !== 'win32') expect(resolveUserPath('file:///tmp/arquivo%20com%20espaco.txt')).toBe('/tmp/arquivo com espaco.txt');
  });

  it('remove aspas e resolve relativos a partir da pasta pessoal', () => {
    expect(resolveUserPath('"projetos/lark"')).toBe(path.join(home, 'projetos', 'lark'));
    expect(resolveUserPath('  “notas.txt”  ')).toBe(path.join(home, 'notas.txt'));
  });

  it.runIf(isLinux)('entende atalhos em português e inglês usando as pastas XDG reais', () => {
    expect(resolveUserPath('Área de Trabalho/projeto')).toBe(path.join(home, 'Área de Trabalho', 'projeto'));
    expect(resolveUserPath('area de trabalho')).toBe(path.join(home, 'Área de Trabalho'));
    expect(resolveUserPath('Desktop/a.png')).toBe(path.join(home, 'Área de Trabalho', 'a.png'));
    expect(resolveUserPath('documents/cv.pdf')).toBe(path.join(home, 'Documentos', 'cv.pdf'));
    expect(resolveUserPath('Meus Documentos')).toBe(path.join(home, 'Documentos'));
    expect(resolveUserPath('downloads')).toBe(path.join(home, 'Downloads'));
    expect(resolveUserPath('Músicas')).toBe(path.join(home, 'Music'));
  });

  it('aceita favoritos das configurações como atalhos pelo nome da pasta', () => {
    const fav = path.join(home, 'Trabalho', 'Clientes');
    updateSettings({ computer: { favoritePaths: [fav] } });
    try {
      expect(resolveUserPath('clientes/acme')).toBe(path.join(fav, 'acme'));
      expect(knownFolders().some((f) => f.key === 'favorite' && f.path === fav)).toBe(true);
    } finally {
      updateSettings({ computer: { favoritePaths: [] } });
    }
  });

  it('recusa caminho vazio', () => {
    expect(() => resolveUserPath('   ')).toThrow(/caminho/i);
  });
});

describe('knownFolders', () => {
  it('lista as pastas principais com rótulos em português', () => {
    const folders = knownFolders();
    const keys = folders.map((f) => f.key);
    expect(keys).toEqual(expect.arrayContaining(['home', 'desktop', 'documents', 'downloads', 'pictures', 'music', 'videos']));
    const desktop = folders.find((f) => f.key === 'desktop')!;
    expect(desktop.label).toBe('Área de Trabalho');
    if (isLinux) {
      expect(desktop.path).toBe(path.join(home, 'Área de Trabalho'));
      expect(desktop.exists).toBe(true);
    }
  });

  it('normaliza texto sem acentos', () => {
    expect(foldText('  Área de TRABALHO ')).toBe('area de trabalho');
  });
});

describe('proteção de pastas críticas', () => {
  it('permite operar dentro da pasta pessoal', () => {
    expect(protectionReason(path.join(home, 'Documentos', 'a.txt'), 'delete')).toBeNull();
    expect(protectionReason(path.join(home, 'nova'), 'modify')).toBeNull();
  });

  it('bloqueia apagar a raiz, a pasta pessoal e pastas conhecidas inteiras', () => {
    expect(protectionReason(path.parse(home).root, 'delete')).toMatch(/raiz/);
    expect(protectionReason(home, 'delete')).not.toBeNull();
    if (isLinux) expect(protectionReason(path.join(home, 'Documentos'), 'delete')).toMatch(/Documentos/);
  });

  it('bloqueia chaves SSH mesmo para escrita', () => {
    expect(protectionReason(path.join(home, '.ssh', 'authorized_keys'), 'modify')).toMatch(/SSH/);
  });

  it.runIf(process.platform !== 'win32')('bloqueia áreas do sistema operacional', () => {
    expect(protectionReason('/usr/bin/node', 'delete')).toMatch(/sistema/);
    expect(protectionReason('/etc/hosts', 'modify')).toMatch(/sistema/);
    expect(protectionReason('/home', 'delete')).not.toBeNull();
    expect(() => assertNotProtected('/etc/passwd', 'delete', 'apagar')).toThrow(ProtectedPathError);
  });

  it.runIf(process.platform === 'win32')('bloqueia a pasta do Windows', () => {
    const systemRoot = process.env.SystemRoot || 'C:\\Windows';
    expect(protectionReason(path.join(systemRoot, 'System32', 'drivers'), 'delete')).toMatch(/sistema/);
    expect(protectionReason('C:\\', 'delete')).toMatch(/raiz/);
  });
});
