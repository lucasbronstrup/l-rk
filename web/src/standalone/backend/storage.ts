/**
 * Armazenamento da edição web: localStorage com prefixo 'lark-web:' (cada tabela é um JSON).
 * Se o navegador bloquear o armazenamento (janela anônima restrita, prévia, dados bloqueados),
 * tudo continua funcionando em memória até a página fechar.
 */
import type { ChatMessage, Commitment, Conversation, Memory, Reminder } from '@shared/types';

const PREFIX = 'lark-web:';

interface RawStore {
  readonly persistent: boolean;
  get(key: string): string | null;
  set(key: string, value: string): void;
  remove(key: string): void;
}

function createRawStore(): RawStore {
  try {
    const ls = window.localStorage;
    const probe = `${PREFIX}__probe`;
    ls.setItem(probe, '1');
    ls.removeItem(probe);
    return {
      persistent: true,
      get: (k) => {
        try {
          return ls.getItem(PREFIX + k);
        } catch {
          return null;
        }
      },
      set: (k, v) => ls.setItem(PREFIX + k, v),
      remove: (k) => {
        try {
          ls.removeItem(PREFIX + k);
        } catch {
          /* ignorado */
        }
      },
    };
  } catch {
    const mem = new Map<string, string>();
    return {
      persistent: false,
      get: (k) => mem.get(k) ?? null,
      set: (k, v) => void mem.set(k, v),
      remove: (k) => void mem.delete(k),
    };
  }
}

const raw = createRawStore();
/** Último aviso de falta de espaço (para não repetir no console). */
let warnedQuota = false;

function isQuotaError(e: unknown): boolean {
  return e instanceof DOMException && (e.name === 'QuotaExceededError' || e.code === 22 || e.name === 'NS_ERROR_DOM_QUOTA_REACHED');
}

/** Grava com tolerância a erro; em falta de espaço chama `onQuota` uma vez e tenta de novo. */
function safeWrite(key: string, serialize: () => string, onQuota?: () => boolean): void {
  try {
    raw.set(key, serialize());
  } catch (e) {
    if (isQuotaError(e) && onQuota?.()) {
      try {
        raw.set(key, serialize());
        return;
      } catch {
        /* segue para o aviso */
      }
    }
    if (!warnedQuota) {
      warnedQuota = true;
      console.warn('[Lärk web] Não consegui gravar no armazenamento do navegador:', e);
    }
  }
}

function readJson<T>(key: string): T | undefined {
  const text = raw.get(key);
  if (!text) return undefined;
  try {
    return JSON.parse(text) as T;
  } catch {
    return undefined;
  }
}

export const storageIsPersistent = raw.persistent;

// ─── Coleções ────────────────────────────────────────────────────────────

export class Collection<T extends { id: string }> {
  private items: Map<string, T> | null = null;
  private readonly key: string;
  private readonly onQuota?: (c: Collection<T>) => boolean;

  constructor(key: string, onQuota?: (c: Collection<T>) => boolean) {
    this.key = key;
    this.onQuota = onQuota;
  }

  private map(): Map<string, T> {
    if (!this.items) {
      const list = readJson<unknown>(this.key);
      this.items = new Map();
      if (Array.isArray(list)) {
        for (const item of list) {
          if (item && typeof item === 'object' && typeof (item as { id?: unknown }).id === 'string') {
            this.items.set((item as T).id, item as T);
          }
        }
      }
    }
    return this.items;
  }

  private persist(): void {
    safeWrite(this.key, () => JSON.stringify([...this.map().values()]), this.onQuota ? () => this.onQuota!(this) : undefined);
  }

  all(): T[] {
    return [...this.map().values()];
  }

  get(id: string): T | null {
    return this.map().get(id) ?? null;
  }

  has(id: string): boolean {
    return this.map().has(id);
  }

  get size(): number {
    return this.map().size;
  }

  put(item: T): T {
    this.map().set(item.id, item);
    this.persist();
    return item;
  }

  putMany(items: T[]): void {
    const m = this.map();
    for (const item of items) m.set(item.id, item);
    this.persist();
  }

  delete(id: string): boolean {
    const ok = this.map().delete(id);
    if (ok) this.persist();
    return ok;
  }

  deleteWhere(pred: (item: T) => boolean): number {
    const m = this.map();
    let n = 0;
    for (const [id, item] of m) {
      if (pred(item)) {
        m.delete(id);
        n++;
      }
    }
    if (n) this.persist();
    return n;
  }

  /** Remove sem gravar (usado pela rotina de falta de espaço antes de tentar de novo). */
  dropSilently(ids: string[]): void {
    const m = this.map();
    for (const id of ids) m.delete(id);
  }
}

/** Sem espaço: descarta os 20% mais antigos das mensagens (memórias e promessas ficam intactas). */
function pruneMessages(c: Collection<ChatMessage>): boolean {
  const all = c.all().sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  if (all.length < 20) return false;
  const drop = all.slice(0, Math.ceil(all.length * 0.2)).map((m) => m.id);
  c.dropSilently(drop);
  console.warn(`[Lärk web] Armazenamento cheio: ${drop.length} mensagens antigas foram descartadas.`);
  return true;
}

export const tables = {
  conversations: new Collection<Conversation>('conversations'),
  messages: new Collection<ChatMessage>('messages', pruneMessages),
  memories: new Collection<Memory>('memories'),
  commitments: new Collection<Commitment>('commitments'),
  reminders: new Collection<Reminder>('reminders'),
};

// ─── Valores simples ─────────────────────────────────────────────────────

export function readValue<T>(key: 'settings' | 'apiKey' | 'kv'): T | undefined {
  return readJson<T>(key);
}

export function writeValue(key: 'settings' | 'apiKey' | 'kv', value: unknown): void {
  if (value === undefined || value === null) raw.remove(key);
  else safeWrite(key, () => JSON.stringify(value));
}

/** Pequeno armazenamento chave→valor para estados internos (ex.: primeiro contato). */
export const kv = {
  get<T>(key: string): T | undefined {
    const all = readJson<Record<string, unknown>>('kv') ?? {};
    return all[key] as T | undefined;
  },
  set(key: string, value: unknown): void {
    const all = readJson<Record<string, unknown>>('kv') ?? {};
    if (value === undefined) delete all[key];
    else all[key] = value;
    writeValue('kv', all);
  },
};
