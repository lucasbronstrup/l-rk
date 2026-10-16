/**
 * Web: pesquisa com o Google (grounding do Gemini), leitura de páginas com proteção contra SSRF
 * e previsão do tempo (Open-Meteo, sem chave).
 */
import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import zlib from 'node:zlib';
import { parse as parseHtml, type HTMLElement } from 'node-html-parser';
import { z } from 'zod';
import { config } from '../config.js';
import { classifyGeminiError, generateWithFallback, getClient } from '../llm/gemini.js';
import { foldText } from './paths.js';
import {
  clipMiddle,
  describeNow,
  formatBytes,
  optionalInt,
  parseArgs,
  requiredText,
  userTimeZone,
  withTimeoutSignal,
  type ToolSpec,
} from './utility.js';

// ─── Pesquisa no Google (grounding) ─────────────────────────────────────

const SEARCH_SYSTEM =
  'Você é o módulo de pesquisa do Lärk. Pesquise na web e responda em português do Brasil de forma factual, ' +
  'atual e concisa (até ~250 palavras), com datas, números e nomes concretos. Se as fontes divergirem, diga. ' +
  'Não invente: se não encontrar, diga que não encontrou.';

const webSearch: ToolSpec = {
  name: 'web_search',
  label: 'Pesquisando na web',
  group: 'web',
  risk: 'safe',
  timeoutMs: 60_000,
  description:
    'Pesquisa no Google e devolve um resumo atualizado com as fontes. Use para notícias, fatos recentes, preços, ' +
    'resultados de jogos, cotações, horários, lançamentos, qualquer coisa que possa ter mudado depois do seu treinamento ' +
    'ou que precise de confirmação. Escreva a consulta como uma pergunta clara e específica.',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'O que pesquisar (pergunta ou palavras-chave).' },
    },
    required: ['query'],
  },
  async execute(args, ctx) {
    const a = parseArgs('web_search', z.object({ query: requiredText('a pesquisa').max(1000) }), args);
    if (config.mock) {
      return {
        output: {
          query: a.query,
          answer: `(Modo demonstração) Aqui viria um resumo pesquisado no Google sobre “${a.query}”.`,
          sources: [{ title: 'exemplo.com', url: 'https://exemplo.com' }],
        },
        summary: `Pesquisa simulada: ${a.query}`,
      };
    }
    if (!getClient()) throw new Error('Para pesquisar na web preciso de uma chave do Google AI Studio (Configurações).');
    const now = describeNow(userTimeZone());
    let result: Awaited<ReturnType<typeof generateWithFallback>>;
    try {
      result = await generateWithFallback(
        'fast',
        {
          contents: [{ role: 'user', parts: [{ text: `Hoje é ${now.local} (${now.timezone}).\nPesquisa: ${a.query}` }] }],
          config: { systemInstruction: SEARCH_SYSTEM, tools: [{ googleSearch: {} }], temperature: 0.2 },
        },
        { signal: ctx.signal, timeoutMs: 45_000 },
      );
    } catch (error) {
      throw new Error(classifyGeminiError(error).message, { cause: error });
    }
    const { response, model } = result;
    const candidate = response.candidates?.[0];
    const meta = candidate?.groundingMetadata;
    const seen = new Set<string>();
    const sources: { title: string; url: string }[] = [];
    for (const chunk of meta?.groundingChunks ?? []) {
      const uri = chunk.web?.uri;
      if (!uri || seen.has(uri)) continue;
      seen.add(uri);
      sources.push({ title: chunk.web?.title || chunk.web?.domain || new URL(uri).hostname, url: uri });
    }
    const answer = response.text?.trim() ?? '';
    if (!answer) throw new Error('A pesquisa não trouxe resposta. Tente reformular a consulta.');
    return {
      output: {
        query: a.query,
        answer,
        sources: sources.slice(0, 10),
        ...(meta?.webSearchQueries?.length ? { searchQueries: meta.webSearchQueries } : {}),
        ...(sources.length === 0 ? { note: 'O modelo respondeu sem citar fontes da web; trate como menos confiável.' } : {}),
        model,
      },
      summary: `${sources.length ? `${sources.length} fontes` : 'Sem fontes'} · ${a.query.slice(0, 60)}`,
    };
  },
};

// ─── Leitura de páginas com proteção SSRF ───────────────────────────────

/** Redes que nunca podem ser acessadas por fetch_url (rede local, loopback, metadados de nuvem...). */
const BLOCKED = new net.BlockList();
for (const [addr, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  BLOCKED.addSubnet(addr, prefix, 'ipv4');
}
for (const [addr, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['::', 96], // IPv4-compatível (obsoleto)
  ['64:ff9b::', 96], // NAT64
  ['100::', 64],
  ['2001:db8::', 32],
  ['fc00::', 7],
  ['fe80::', 10],
  ['fec0::', 10],
  ['ff00::', 8],
] as const) {
  BLOCKED.addSubnet(addr, prefix, 'ipv6');
}

/** true para endereços privados/locais/reservados (inclui IPv4 mapeado em IPv6). */
export function isBlockedAddress(address: string): boolean {
  const family = net.isIP(address);
  if (family === 4) return BLOCKED.check(address, 'ipv4');
  if (family === 6) return BLOCKED.check(address, 'ipv6');
  return true;
}

export class BlockedUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BlockedUrlError';
  }
}

const BLOCKED_HOST_SUFFIXES = ['.localhost', '.local', '.internal', '.lan', '.home', '.intranet', '.corp'];

/**
 * Valida o URL antes de qualquer conexão: só http/https, sem credenciais, sem hosts locais
 * e sem IP literal privado. (Nomes de domínio são revalidados na resolução DNS.)
 */
export function assertPublicUrl(raw: string | URL): URL {
  let url: URL;
  try {
    url = raw instanceof URL ? raw : new URL(String(raw).trim());
  } catch {
    throw new BlockedUrlError('URL inválido. Use um endereço completo, como https://exemplo.com/pagina.');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new BlockedUrlError('Só leio páginas http:// ou https://.');
  if (url.username || url.password) throw new BlockedUrlError('URLs com usuário/senha embutidos não são permitidos.');
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase().replace(/\.$/, '');
  if (!host) throw new BlockedUrlError('URL sem endereço de servidor.');
  if (host === 'localhost' || BLOCKED_HOST_SUFFIXES.some((s) => host.endsWith(s)) || !host.includes('.') && !net.isIP(host)) {
    throw new BlockedUrlError('Por segurança, não acesso endereços da rede local ou do próprio computador.');
  }
  if (net.isIP(host) && isBlockedAddress(host)) {
    throw new BlockedUrlError('Por segurança, não acesso endereços da rede local ou do próprio computador.');
  }
  return url;
}

type LookupCallback = (err: NodeJS.ErrnoException | null, address: string | dns.LookupAddress[], family?: number) => void;

/** `lookup` para http/https que recusa resoluções para endereços privados (impede DNS rebinding). */
function safeLookup(hostname: string, options: dns.LookupOptions, callback: LookupCallback): void {
  dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err, '');
    const list = addresses as dns.LookupAddress[];
    if (list.length === 0) return callback(Object.assign(new Error(`Endereço não encontrado: ${hostname}`), { code: 'ENOTFOUND' }), '');
    if (list.some((a) => isBlockedAddress(a.address))) {
      return callback(new BlockedUrlError(`Por segurança, não acesso ${hostname}: ele aponta para a rede local.`), '');
    }
    if (options.all) callback(null, list);
    else callback(null, list[0].address, list[0].family);
  });
}

const MAX_BODY_BYTES = 5 * 1024 * 1024;
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36 Lark/0.1';

interface FetchedPage {
  url: string;
  status: number;
  contentType: string;
  body: Buffer;
  truncated: boolean;
}

function requestOnce(url: URL, signal: AbortSignal): Promise<{ res: http.IncomingMessage }> {
  return new Promise((resolve, reject) => {
    const mod = url.protocol === 'https:' ? https : http;
    const req = mod.request(
      url,
      {
        method: 'GET',
        lookup: safeLookup as unknown as http.RequestOptions['lookup'],
        signal,
        headers: {
          'User-Agent': USER_AGENT,
          Accept: 'text/html,application/xhtml+xml,application/json,text/plain;q=0.9,*/*;q=0.5',
          'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8',
          'Accept-Encoding': 'gzip, deflate, br',
        },
      },
      (res) => resolve({ res }),
    );
    req.on('error', reject);
    req.end();
  });
}

function readBody(res: http.IncomingMessage, signal: AbortSignal): Promise<{ body: Buffer; truncated: boolean }> {
  return new Promise((resolve, reject) => {
    const encoding = String(res.headers['content-encoding'] ?? '').toLowerCase();
    let stream: NodeJS.ReadableStream = res;
    if (encoding.includes('gzip')) stream = res.pipe(zlib.createGunzip());
    else if (encoding.includes('br')) stream = res.pipe(zlib.createBrotliDecompress());
    else if (encoding.includes('deflate')) stream = res.pipe(zlib.createInflate());
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    const finish = (truncated: boolean) => {
      if (done) return;
      done = true;
      resolve({ body: Buffer.concat(chunks), truncated });
    };
    stream.on('data', (chunk: Buffer) => {
      if (done) return;
      const room = MAX_BODY_BYTES - size;
      if (chunk.length >= room) {
        chunks.push(chunk.subarray(0, room));
        size += room;
        res.destroy();
        finish(true);
        return;
      }
      chunks.push(chunk);
      size += chunk.length;
    });
    stream.on('end', () => finish(false));
    stream.on('error', (error) => (done ? undefined : reject(error)));
    res.on('aborted', () => (done ? undefined : reject(new Error('A conexão foi interrompida.'))));
    signal.addEventListener('abort', () => (done ? undefined : reject(new Error('Tempo esgotado ao ler a página.'))), { once: true });
  });
}

/** GET seguro: valida cada redirecionamento, limita tamanho e tempo. */
export async function safeFetch(rawUrl: string, signal: AbortSignal, maxRedirects = 5): Promise<FetchedPage> {
  let url = assertPublicUrl(rawUrl);
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const { res } = await requestOnce(url, signal);
    const status = res.statusCode ?? 0;
    if ([301, 302, 303, 307, 308].includes(status) && res.headers.location) {
      res.resume();
      url = assertPublicUrl(new URL(res.headers.location, url));
      continue;
    }
    const { body, truncated } = await readBody(res, signal);
    return { url: url.toString(), status, contentType: String(res.headers['content-type'] ?? ''), body, truncated };
  }
  throw new Error('Redirecionamentos demais.');
}

function charsetOf(contentType: string, body: Buffer): string {
  const fromHeader = contentType.match(/charset=["']?([\w-]+)/i)?.[1];
  if (fromHeader) return fromHeader.toLowerCase();
  const head = body.subarray(0, 4096).toString('latin1');
  return (head.match(/<meta[^>]+charset=["']?([\w-]+)/i)?.[1] ?? 'utf-8').toLowerCase();
}

function decodeBody(body: Buffer, charset: string): string {
  try {
    return new TextDecoder(charset).decode(body);
  } catch {
    return new TextDecoder('utf-8').decode(body);
  }
}

const REMOVE_SELECTORS = [
  'script',
  'style',
  'noscript',
  'svg',
  'canvas',
  'iframe',
  'template',
  'form',
  'button',
  'select',
  'nav',
  'footer',
  'aside',
  '[role=navigation]',
  '[role=banner]',
  '[role=contentinfo]',
  '[aria-hidden=true]',
];

/** Extrai título, descrição, texto legível e links principais de um HTML. */
export function extractReadableText(html: string, baseUrl: string): { title: string; description: string; text: string; links: { text: string; url: string }[] } {
  const root = parseHtml(html, { comment: false });
  const title = root.querySelector('title')?.text.trim() || root.querySelector('meta[property="og:title"]')?.getAttribute('content')?.trim() || '';
  const description =
    root.querySelector('meta[name="description"]')?.getAttribute('content')?.trim() ||
    root.querySelector('meta[property="og:description"]')?.getAttribute('content')?.trim() ||
    '';
  for (const selector of REMOVE_SELECTORS) for (const node of root.querySelectorAll(selector)) node.remove();
  for (const header of root.querySelectorAll('header')) if (!header.closest('article, main')) header.remove();

  const candidates = [root.querySelector('article'), root.querySelector('main'), root.querySelector('[role=main]'), root.querySelector('body'), root];
  const main = (candidates.find((c) => c && c.structuredText.trim().length > 200) ?? root.querySelector('body') ?? root) as HTMLElement;

  const text = main.structuredText
    .replace(/[ \t ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  const seen = new Set<string>();
  const links: { text: string; url: string }[] = [];
  for (const a of main.querySelectorAll('a[href]')) {
    if (links.length >= 40) break;
    const label = a.text.replace(/\s+/g, ' ').trim();
    const href = a.getAttribute('href') ?? '';
    if (!label || label.length < 3 || href.startsWith('#') || /^javascript:/i.test(href)) continue;
    let abs: string;
    try {
      abs = new URL(href, baseUrl).toString();
    } catch {
      continue;
    }
    if (!/^https?:/i.test(abs) || seen.has(abs)) continue;
    seen.add(abs);
    links.push({ text: label.slice(0, 120), url: abs });
  }
  return { title, description, text, links };
}

const fetchUrl: ToolSpec = {
  name: 'fetch_url',
  label: 'Lendo página da web',
  group: 'web',
  risk: 'safe',
  timeoutMs: 30_000,
  description:
    'Baixa uma página da web pública e devolve o texto legível (sem menus/scripts), o título e os principais links. ' +
    'Use para ler um artigo, documentação, receita ou página que o usuário mencionou, ou para aprofundar uma fonte do web_search. ' +
    'Endereços da rede local e do próprio computador são bloqueados por segurança.',
  parameters: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'Endereço completo (https://...).' },
      max_chars: { type: 'integer', minimum: 500, maximum: 100_000, description: 'Máximo de caracteres de texto (padrão 20 000).' },
    },
    required: ['url'],
  },
  async execute(args, ctx) {
    const a = parseArgs('fetch_url', z.object({ url: requiredText('o URL').max(4000), max_chars: optionalInt(500, 100_000) }), args);
    const raw = /^[a-z][a-z0-9+.-]*:\/\//i.test(a.url) ? a.url : `https://${a.url}`;
    assertPublicUrl(raw);
    const signal = withTimeoutSignal(ctx.signal, 15_000);
    let page: FetchedPage;
    try {
      page = await safeFetch(raw, signal);
    } catch (error) {
      if (error instanceof BlockedUrlError) throw error;
      if (signal.aborted && !ctx.signal?.aborted) throw new Error('A página demorou mais de 15 s para responder.');
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') throw new Error('Não encontrei esse endereço (domínio inexistente ou sem internet).');
      if (code === 'ECONNREFUSED') throw new Error('O servidor recusou a conexão.');
      if (code === 'CERT_HAS_EXPIRED' || /certificate/i.test(String((error as Error).message))) {
        throw new Error('O certificado de segurança do site é inválido.');
      }
      throw new Error(`Não consegui abrir a página: ${error instanceof Error ? error.message : String(error)}`);
    }
    const maxChars = a.max_chars ?? 20_000;
    const type = page.contentType.split(';')[0].trim().toLowerCase();
    const base = { url: page.url, status: page.status, contentType: type || 'desconhecido', bytes: formatBytes(page.body.length) };
    if (page.status >= 400) {
      throw new Error(`A página respondeu com erro HTTP ${page.status}${page.status === 404 ? ' (não encontrada)' : page.status === 403 ? ' (acesso negado)' : ''}.`);
    }

    if (type.includes('html') || (!type && /<html|<body/i.test(page.body.subarray(0, 2000).toString('latin1')))) {
      const html = decodeBody(page.body, charsetOf(page.contentType, page.body));
      const { title, description, text, links } = extractReadableText(html, page.url);
      const clipped = clipMiddle(text, maxChars);
      return {
        output: {
          ...base,
          title,
          ...(description ? { description } : {}),
          content: clipped.text,
          chars: text.length,
          ...(clipped.truncated || page.truncated ? { truncated: true } : {}),
          ...(text.length < 200 ? { note: 'Pouco texto extraído: a página pode depender de JavaScript ou exigir login.' } : {}),
          links: links.slice(0, 25),
        },
        summary: `${title || new URL(page.url).hostname} · ${text.length.toLocaleString('pt-BR')} caracteres`,
      };
    }
    if (type.startsWith('text/') || /json|xml|javascript|csv|yaml|markdown/.test(type)) {
      let text = decodeBody(page.body, charsetOf(page.contentType, page.body));
      if (type.includes('json')) {
        try {
          text = JSON.stringify(JSON.parse(text), null, 2);
        } catch {
          // Mantém como veio.
        }
      }
      const clipped = clipMiddle(text, maxChars);
      return {
        output: { ...base, content: clipped.text, chars: text.length, ...(clipped.truncated || page.truncated ? { truncated: true } : {}) },
        summary: `${new URL(page.url).hostname} · ${type}`,
      };
    }
    return {
      output: {
        ...base,
        note: `O endereço é um arquivo ${type || 'binário'} (${formatBytes(page.body.length)}), não uma página de texto. Para analisá-lo, baixe-o (run_command) e use analyze_file.`,
      },
      summary: `Arquivo ${type || 'binário'} (não é texto)`,
    };
  },
};

// ─── Previsão do tempo (Open-Meteo) ─────────────────────────────────────

const WEATHER_CODES: Record<number, string> = {
  0: 'céu limpo',
  1: 'predominantemente limpo',
  2: 'parcialmente nublado',
  3: 'nublado',
  45: 'nevoeiro',
  48: 'nevoeiro com geada',
  51: 'garoa fraca',
  53: 'garoa moderada',
  55: 'garoa intensa',
  56: 'garoa congelante fraca',
  57: 'garoa congelante intensa',
  61: 'chuva fraca',
  63: 'chuva moderada',
  65: 'chuva forte',
  66: 'chuva congelante fraca',
  67: 'chuva congelante forte',
  71: 'neve fraca',
  73: 'neve moderada',
  75: 'neve forte',
  77: 'grãos de neve',
  80: 'pancadas de chuva fracas',
  81: 'pancadas de chuva moderadas',
  82: 'pancadas de chuva violentas',
  85: 'pancadas de neve fracas',
  86: 'pancadas de neve fortes',
  95: 'trovoada',
  96: 'trovoada com granizo fraco',
  99: 'trovoada com granizo forte',
};

const BR_STATES: Record<string, string> = {
  ac: 'acre', al: 'alagoas', ap: 'amapa', am: 'amazonas', ba: 'bahia', ce: 'ceara', df: 'distrito federal',
  es: 'espirito santo', go: 'goias', ma: 'maranhao', mt: 'mato grosso', ms: 'mato grosso do sul', mg: 'minas gerais',
  pa: 'para', pb: 'paraiba', pr: 'parana', pe: 'pernambuco', pi: 'piaui', rj: 'rio de janeiro', rn: 'rio grande do norte',
  rs: 'rio grande do sul', ro: 'rondonia', rr: 'roraima', sc: 'santa catarina', sp: 'sao paulo', se: 'sergipe', to: 'tocantins',
};

interface GeoResult {
  name: string;
  latitude: number;
  longitude: number;
  country?: string;
  country_code?: string;
  admin1?: string;
  timezone?: string;
  population?: number;
}

async function getJson<T>(url: string, signal: AbortSignal): Promise<T> {
  const res = await fetch(url, { signal, headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' } });
  if (!res.ok) throw new Error(`O serviço de clima respondeu ${res.status}.`);
  return (await res.json()) as T;
}

const WEEKDAYS_SHORT = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];

const getWeather: ToolSpec = {
  name: 'get_weather',
  label: 'Consultando o clima',
  group: 'web',
  risk: 'safe',
  timeoutMs: 30_000,
  description:
    'Clima atual e previsão (até 16 dias) de uma cidade: temperatura, sensação térmica, chuva, vento, UV, nascer/pôr do sol ' +
    'e as próximas horas. Informe a cidade (e, se ajudar, estado/país: "Campinas, SP", "Lisboa, Portugal"). ' +
    'Se o usuário não disser a cidade, use a que você sabe da memória dele.',
  parameters: {
    type: 'object',
    properties: {
      location: { type: 'string', description: 'Cidade (opcionalmente com estado/país).' },
      days: { type: 'integer', minimum: 1, maximum: 16, description: 'Dias de previsão (padrão 3).' },
    },
    required: ['location'],
  },
  async execute(args, ctx) {
    const a = parseArgs('get_weather', z.object({ location: requiredText('a cidade').max(200), days: optionalInt(1, 16) }), args);
    const signal = withTimeoutSignal(ctx.signal, 20_000);
    const [cityPart, ...qualifiers] = a.location.split(',').map((s) => s.trim()).filter(Boolean);
    const qualifier = foldText(qualifiers.join(' '));
    const qualifierFull = BR_STATES[qualifier] ?? qualifier;

    let geo: { results?: GeoResult[] };
    try {
      geo = await getJson(
        `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(cityPart)}&count=10&language=pt&format=json`,
        signal,
      );
    } catch (error) {
      throw new Error(`Não consegui consultar o clima agora: ${error instanceof Error ? error.message : String(error)}`);
    }
    const results = geo.results ?? [];
    if (results.length === 0) throw new Error(`Não encontrei a cidade "${a.location}". Tente outro nome ou inclua o país.`);
    const tz = userTimeZone();
    const scored = results.map((r, i) => {
      let score = -i * 0.1 + Math.log10((r.population ?? 0) + 10) * 0.2;
      if (qualifierFull) {
        const fields = [r.admin1, r.country, r.country_code].filter(Boolean).map((f) => foldText(String(f)));
        if (fields.some((f) => f === qualifierFull || f.includes(qualifierFull))) score += 5;
      }
      if (r.timezone === tz) score += 1;
      return { r, score };
    });
    scored.sort((x, y) => y.score - x.score);
    const place = scored[0].r;
    const days = a.days ?? 3;

    interface Forecast {
      timezone: string;
      current: Record<string, number | string>;
      hourly: { time: string[]; temperature_2m: number[]; precipitation_probability: number[]; weather_code: number[] };
      daily: {
        time: string[];
        weather_code: number[];
        temperature_2m_max: number[];
        temperature_2m_min: number[];
        precipitation_probability_max: (number | null)[];
        precipitation_sum: number[];
        sunrise: string[];
        sunset: string[];
        uv_index_max: (number | null)[];
      };
    }
    const params = new URLSearchParams({
      latitude: String(place.latitude),
      longitude: String(place.longitude),
      current: 'temperature_2m,relative_humidity_2m,apparent_temperature,is_day,precipitation,weather_code,wind_speed_10m,wind_gusts_10m',
      hourly: 'temperature_2m,precipitation_probability,weather_code',
      daily: 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,precipitation_sum,sunrise,sunset,uv_index_max',
      timezone: 'auto',
      forecast_days: String(days),
      forecast_hours: '12',
      wind_speed_unit: 'kmh',
    });
    let f: Forecast;
    try {
      f = await getJson<Forecast>(`https://api.open-meteo.com/v1/forecast?${params}`, signal);
    } catch (error) {
      throw new Error(`Não consegui obter a previsão: ${error instanceof Error ? error.message : String(error)}`);
    }
    const c = f.current;
    const condition = WEATHER_CODES[Number(c.weather_code)] ?? 'condição desconhecida';
    const placeName = [place.name, place.admin1, place.country].filter(Boolean).join(', ');
    const dayLabel = (iso: string) => {
      const [y, m, d] = iso.split('-').map(Number);
      return `${WEEKDAYS_SHORT[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]}, ${String(d).padStart(2, '0')}/${String(m).padStart(2, '0')}`;
    };
    return {
      output: {
        place: placeName,
        timezone: f.timezone,
        now: {
          condition,
          temperatureC: c.temperature_2m,
          feelsLikeC: c.apparent_temperature,
          humidityPct: c.relative_humidity_2m,
          precipitationMm: c.precipitation,
          windKmh: c.wind_speed_10m,
          gustsKmh: c.wind_gusts_10m,
          isDay: c.is_day === 1,
        },
        nextHours: (f.hourly?.time ?? []).map((t, i) => ({
          time: t.slice(11, 16),
          temperatureC: f.hourly.temperature_2m[i],
          rainChancePct: f.hourly.precipitation_probability[i],
          condition: WEATHER_CODES[f.hourly.weather_code[i]] ?? '',
        })),
        days: f.daily.time.map((t, i) => ({
          day: dayLabel(t),
          condition: WEATHER_CODES[f.daily.weather_code[i]] ?? '',
          minC: f.daily.temperature_2m_min[i],
          maxC: f.daily.temperature_2m_max[i],
          rainChancePct: f.daily.precipitation_probability_max[i],
          rainMm: f.daily.precipitation_sum[i],
          uvMax: f.daily.uv_index_max[i],
          sunrise: f.daily.sunrise[i]?.slice(11, 16),
          sunset: f.daily.sunset[i]?.slice(11, 16),
        })),
        source: 'Open-Meteo',
      },
      summary: `${place.name}: ${Math.round(Number(c.temperature_2m))} °C, ${condition}`,
    };
  },
};

export const webTools: ToolSpec[] = [webSearch, fetchUrl, getWeather];
