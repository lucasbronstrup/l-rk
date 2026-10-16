/**
 * Edição web: instala, ANTES de a aplicação carregar, interceptadores para tudo que começa com /api.
 *  - window.fetch      → backend local (Response reais: JSON, 204, SSE em ReadableStream, WAV em Blob);
 *  - window.EventSource → '/api/events' alimentado pelo barramento local;
 *  - window.WebSocket   → '/api/voice' responde que a voz ao vivo exige o Lärk instalado (a interface cai no modo clássico);
 *  - <a download>       → no claude.ai, usa a capacidade "downloads" (o quadro bloqueia downloads diretos).
 * Qualquer outra URL segue para as implementações originais do navegador.
 */
import type { LarkEvent, VoiceServerMessage } from '@shared/types';
import { bus, handleApi, startBackend } from './backend';
import { nativeFetch } from './backend/net';
import { abortError } from './backend/util';

// ─── Identificação das URLs locais ──────────────────────────────────────

function apiPath(input: string): { path: string; query: URLSearchParams } | null {
  let url: URL;
  try {
    url = new URL(input, window.location.href);
  } catch {
    if (input === '/api' || input.startsWith('/api/') || input.startsWith('/api?')) {
      const [p, qs = ''] = input.split('?');
      return { path: p.slice(4) || '/', query: new URLSearchParams(qs) };
    }
    return null;
  }
  const relative = input.startsWith('/api');
  if (!relative && url.host !== window.location.host) return null;
  if (url.pathname !== '/api' && !url.pathname.startsWith('/api/')) return null;
  return { path: url.pathname.slice(4) || '/', query: url.searchParams };
}

function urlOf(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

// ─── fetch ───────────────────────────────────────────────────────────────

async function readBody(input: RequestInfo | URL, init: RequestInit | undefined, method: string): Promise<string | null> {
  const body = init?.body;
  if (body !== undefined && body !== null) {
    if (typeof body === 'string') return body;
    return new Response(body).text();
  }
  if (input instanceof Request && method !== 'GET' && method !== 'HEAD') return input.clone().text();
  return null;
}

async function localFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const target = apiPath(urlOf(input));
  if (!target) return nativeFetch(input, init);
  const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
  const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined) ?? undefined;
  if (signal?.aborted) throw abortError();
  const bodyText = await readBody(input, init, method);
  const pending = handleApi({ method, path: target.path, query: target.query, bodyText, signal });
  if (!signal) return pending;
  return new Promise<Response>((resolve, reject) => {
    const onAbort = () => reject(abortError());
    signal.addEventListener('abort', onAbort, { once: true });
    pending.then(
      (res) => {
        signal.removeEventListener('abort', onAbort);
        resolve(res);
      },
      (err: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(err);
      },
    );
  });
}

// ─── EventSource ─────────────────────────────────────────────────────────

type Handler = ((this: EventSource, ev: Event) => unknown) | null;
type MessageHandler = ((this: EventSource, ev: MessageEvent) => unknown) | null;

class LocalEventSource extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSED = 2;
  readonly url: string;
  readonly withCredentials: boolean;
  readyState = 0;
  onopen: Handler = null;
  onmessage: MessageHandler = null;
  onerror: Handler = null;
  private unsubscribe: (() => void) | null = null;
  private ping: number | undefined;

  constructor(url: string, init?: EventSourceInit) {
    super();
    this.url = new URL(url, window.location.href).href;
    this.withCredentials = Boolean(init?.withCredentials);
    window.setTimeout(() => this.open(), 0);
  }

  private open() {
    if (this.readyState === 2) return;
    this.readyState = 1;
    this.fire(new Event('open'));
    this.emit({ type: 'hello', serverTime: new Date().toISOString() });
    this.unsubscribe = bus.subscribe((e) => this.emit(e));
    this.ping = window.setInterval(() => this.emit({ type: 'ping', serverTime: new Date().toISOString() }), 20_000);
  }

  private emit(e: LarkEvent) {
    if (this.readyState !== 1) return;
    // Entrega assíncrona, como uma conexão de rede real.
    const data = JSON.stringify(e);
    window.setTimeout(() => {
      if (this.readyState !== 1) return;
      this.fire(new MessageEvent(e.type, { data, origin: window.location.origin }));
    }, 0);
  }

  private fire(ev: Event) {
    const self = this as unknown as EventSource;
    try {
      if (ev.type === 'open') this.onopen?.call(self, ev);
      else if (ev.type === 'error') this.onerror?.call(self, ev);
      else if (ev.type === 'message' && ev instanceof MessageEvent) this.onmessage?.call(self, ev);
    } catch (err) {
      console.error(err);
    }
    this.dispatchEvent(ev);
  }

  close() {
    this.readyState = 2;
    this.unsubscribe?.();
    this.unsubscribe = null;
    window.clearInterval(this.ping);
  }
}

// ─── WebSocket (/api/voice) ──────────────────────────────────────────────

const LIVE_UNAVAILABLE = 'O modo de voz ao vivo precisa do Lärk instalado no computador. Usando o modo clássico.';

type WsHandler<E extends Event> = ((this: WebSocket, ev: E) => unknown) | null;

class LocalVoiceSocket extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSING = 2;
  readonly CLOSED = 3;
  readonly url: string;
  readonly protocol = '';
  readonly extensions = '';
  readonly bufferedAmount = 0;
  binaryType: BinaryType = 'blob';
  readyState = 0;
  onopen: WsHandler<Event> = null;
  onmessage: WsHandler<MessageEvent> = null;
  onclose: WsHandler<CloseEvent> = null;
  onerror: WsHandler<Event> = null;

  constructor(url: string) {
    super();
    this.url = url;
    window.setTimeout(() => {
      if (this.readyState !== 0) return;
      this.readyState = 1;
      this.fire(new Event('open'));
    }, 30);
  }

  private fire(ev: Event) {
    const self = this as unknown as WebSocket;
    try {
      if (ev.type === 'open') this.onopen?.call(self, ev);
      else if (ev.type === 'message') this.onmessage?.call(self, ev as MessageEvent);
      else if (ev.type === 'close') this.onclose?.call(self, ev as CloseEvent);
      else if (ev.type === 'error') this.onerror?.call(self, ev);
    } catch (err) {
      console.error(err);
    }
    this.dispatchEvent(ev);
  }

  send(data: string | ArrayBufferLike | Blob | ArrayBufferView) {
    if (this.readyState !== 1 || typeof data !== 'string') return;
    let type = '';
    try {
      type = String((JSON.parse(data) as { type?: unknown }).type ?? '');
    } catch {
      return;
    }
    if (type !== 'start') return;
    window.setTimeout(() => {
      if (this.readyState !== 1) return;
      const msg: VoiceServerMessage = { type: 'error', code: 'provider', message: LIVE_UNAVAILABLE };
      this.fire(new MessageEvent('message', { data: JSON.stringify(msg) }));
      this.close(1000, 'web_edition');
    }, 60);
  }

  close(code = 1000, reason = '') {
    if (this.readyState === 2 || this.readyState === 3) return;
    this.readyState = 3;
    window.setTimeout(() => this.fire(new CloseEvent('close', { code, reason, wasClean: true })), 0);
  }
}

// ─── Downloads dentro do claude.ai ───────────────────────────────────────

interface DownloadsCap {
  save(req: { filename: string; data: Blob | string }): Promise<unknown>;
}

let downloads: DownloadsCap | null = null;

function installDownloadShim(): void {
  const runtime = (window as unknown as { claude?: { use?: (n: string) => Promise<unknown> } }).claude;
  if (!runtime || typeof runtime.use !== 'function') return;
  void Promise.race([runtime.use('downloads'), new Promise<null>((r) => setTimeout(() => r(null), 10_500))])
    .then((cap) => {
      if (cap && typeof (cap as DownloadsCap).save === 'function') downloads = cap as DownloadsCap;
    })
    .catch(() => undefined);

  const nativeClick = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function patchedClick(this: HTMLAnchorElement) {
    const cap = downloads;
    if (cap && this.hasAttribute('download') && /^(blob|data):/i.test(this.href)) {
      const filename = this.getAttribute('download') || 'lark-arquivo.json';
      void nativeFetch(this.href)
        .then((r) => r.blob())
        .then((blob) => cap.save({ filename, data: blob }))
        .catch((e: unknown) => console.warn('[Lärk web] Download não concluído:', e));
      return;
    }
    nativeClick.call(this);
  };
}

// ─── Instalação ──────────────────────────────────────────────────────────

function install(): void {
  const w = window as Window & { __larkWebInstalled?: boolean };
  if (w.__larkWebInstalled) return;
  w.__larkWebInstalled = true;

  window.fetch = localFetch as typeof fetch;

  const NativeES = window.EventSource;
  if (typeof NativeES === 'function') {
    window.EventSource = new Proxy(NativeES, {
      construct(target, args: [string | URL, EventSourceInit?], newTarget) {
        const url = String(args[0]);
        if (apiPath(url)) return new LocalEventSource(url, args[1]) as unknown as EventSource;
        return Reflect.construct(target, args, newTarget) as EventSource;
      },
    });
  } else {
    (window as unknown as { EventSource: unknown }).EventSource = LocalEventSource;
  }

  const NativeWS = window.WebSocket;
  if (typeof NativeWS === 'function') {
    window.WebSocket = new Proxy(NativeWS, {
      construct(target, args: [string | URL, (string | string[])?], newTarget) {
        const url = String(args[0]);
        let isVoice = false;
        try {
          const u = new URL(url, window.location.href);
          isVoice = u.host === window.location.host && u.pathname === '/api/voice';
        } catch {
          isVoice = url.endsWith('/api/voice');
        }
        if (isVoice) return new LocalVoiceSocket(url) as unknown as WebSocket;
        return Reflect.construct(target, args, newTarget) as WebSocket;
      },
    });
  }

  installDownloadShim();
  startBackend();
}

install();
