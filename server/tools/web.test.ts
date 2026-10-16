import { afterEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  process.env.LARK_DB_PATH = ':memory:';
});

import dns from 'node:dns';
import { assertPublicUrl, BlockedUrlError, extractReadableText, isBlockedAddress, safeFetch, webTools } from './web.js';
import type { ToolContext } from './types.js';

const ctx: ToolContext = { conversationId: 'teste', mode: 'text', emit: () => undefined };
const fetchUrl = webTools.find((t) => t.name === 'fetch_url')!;

afterEach(() => {
  vi.restoreAllMocks();
});

describe('bloqueio de SSRF', () => {
  it.each([
    'http://localhost:8787/api/health',
    'http://127.0.0.1/',
    'http://2130706433/', // 127.0.0.1 em decimal
    'http://0x7f.1/',
    'http://10.0.0.5/admin',
    'http://172.20.1.1/',
    'http://192.168.0.1/',
    'http://169.254.169.254/latest/meta-data/',
    'http://[::1]/',
    'http://[::ffff:127.0.0.1]/',
    'http://[fd00::1]/',
    'http://0.0.0.0/',
    'http://impressora.local/',
    'http://metadata.google.internal/',
    'http://roteador/',
    'file:///etc/passwd',
    'ftp://exemplo.com/arquivo',
    'https://usuario:senha@exemplo.com/',
  ])('recusa %s', (url) => {
    expect(() => assertPublicUrl(url)).toThrow(BlockedUrlError);
  });

  it('aceita endereços públicos', () => {
    expect(assertPublicUrl('https://example.com/pagina?x=1').hostname).toBe('example.com');
    expect(assertPublicUrl('http://8.8.8.8/').hostname).toBe('8.8.8.8');
  });

  it('classifica endereços IP', () => {
    expect(isBlockedAddress('127.0.0.1')).toBe(true);
    expect(isBlockedAddress('100.64.1.1')).toBe(true);
    expect(isBlockedAddress('::ffff:192.168.1.1')).toBe(true);
    expect(isBlockedAddress('fe80::1')).toBe(true);
    expect(isBlockedAddress('1.1.1.1')).toBe(false);
    expect(isBlockedAddress('2606:4700:4700::1111')).toBe(false);
    expect(isBlockedAddress('não-é-ip')).toBe(true);
  });

  it('recusa domínios públicos que resolvem para a rede local (DNS rebinding)', async () => {
    vi.spyOn(dns, 'lookup').mockImplementation(((_host: string, _opts: unknown, cb: (e: null, a: dns.LookupAddress[]) => void) => {
      cb(null, [{ address: '127.0.0.1', family: 4 }]);
    }) as unknown as typeof dns.lookup);
    await expect(safeFetch('http://ataque.exemplo.com/', AbortSignal.timeout(5000))).rejects.toThrow(/rede local/);
  });

  it('a ferramenta fetch_url devolve erro amigável', async () => {
    await expect(fetchUrl.execute({ url: 'http://localhost:8787' }, ctx)).rejects.toThrow(/Por segurança/);
    await expect(fetchUrl.execute({ url: '192.168.0.1' }, ctx)).rejects.toThrow(/Por segurança/);
  });
});

describe('extração de texto de HTML', () => {
  const html = `<!doctype html><html><head><title>Receita de Pão</title>
    <meta name="description" content="Pão caseiro fácil"><style>body{color:red}</style></head>
    <body><header><nav><a href="/">Início</a></nav></header>
    <article><header><h1>Pão caseiro</h1></header>
      <p>Misture a farinha &amp; a água.</p><p>Asse por <b>40 minutos</b>.</p>
      <p>${'Texto de preenchimento para o artigo ter conteúdo suficiente. '.repeat(5)}</p>
      <a href="/receitas/bolo">Bolo de cenoura</a><a href="javascript:void(0)">nada</a>
      <script>alert('x')</script></article>
    <aside>Publicidade</aside><footer>Rodapé © 2026</footer></body></html>`;

  it('mantém o conteúdo principal e remove menus, scripts e rodapés', () => {
    const r = extractReadableText(html, 'https://receitas.exemplo.com/pao');
    expect(r.title).toBe('Receita de Pão');
    expect(r.description).toBe('Pão caseiro fácil');
    expect(r.text).toContain('Pão caseiro');
    expect(r.text).toContain('Misture a farinha & a água.');
    expect(r.text).toContain('Asse por 40 minutos.');
    expect(r.text).not.toMatch(/alert|Publicidade|Rodapé|Início|color:red/);
    expect(r.links).toEqual([{ text: 'Bolo de cenoura', url: 'https://receitas.exemplo.com/receitas/bolo' }]);
  });
});
