/**
 * Banco de dados do Lärk (SQLite via better-sqlite3).
 *
 * - Abre o arquivo em `config.dbPath` (ou um banco em memória quando LARK_DB_PATH=':memory:').
 * - Aplica pragmas de desempenho/segurança (WAL, foreign_keys, busy_timeout).
 * - Executa migrações versionadas na importação (tabela `schema_version`).
 *
 * Convenções do esquema:
 * - Datas são TEXT em ISO-8601 UTC (`new Date().toISOString()`), comparáveis lexicograficamente.
 * - `messages` e `memories` têm `seq INTEGER PRIMARY KEY` (rowid estável) usado pelas tabelas FTS5
 *   de conteúdo externo, além do `id` (UUID) exposto ao resto do sistema.
 * - Embeddings ficam em BLOB (Float32 little-endian, normalizados) com o modelo que os gerou em
 *   `embedding_model`; `embedding_model IS NULL` ⇔ ainda não processado.
 */
import BetterSqlite3 from 'better-sqlite3';
import { config } from '../config.js';

export type Database = BetterSqlite3.Database;

export interface Migration {
  version: number;
  name: string;
  up: (db: Database) => void;
}

/** Tokenizer das buscas textuais: ignora acentos ("memória" ≡ "memoria") e caixa. */
const FTS_TOKENIZE = "tokenize = 'unicode61 remove_diacritics 2'";

/**
 * Migrações em ordem crescente de versão. Nunca edite uma migração já publicada:
 * acrescente uma nova versão ao final do array.
 */
export const migrations: Migration[] = [
  {
    version: 1,
    name: 'esquema inicial',
    up: (db) => {
      db.exec(`
        CREATE TABLE settings (
          key        TEXT PRIMARY KEY,
          value      TEXT NOT NULL,            -- JSON
          updated_at TEXT NOT NULL
        );

        CREATE TABLE conversations (
          id         TEXT PRIMARY KEY,
          title      TEXT NOT NULL,
          summary    TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX idx_conversations_updated ON conversations (updated_at DESC);

        CREATE TABLE messages (
          seq             INTEGER PRIMARY KEY AUTOINCREMENT,
          id              TEXT NOT NULL UNIQUE,
          conversation_id TEXT NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
          role            TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
          content         TEXT NOT NULL DEFAULT '',
          thoughts        TEXT,
          tool_calls      TEXT,                  -- JSON ToolCallInfo[]
          kind            TEXT NOT NULL DEFAULT 'chat' CHECK (kind IN ('chat', 'voice', 'proactive', 'briefing')),
          created_at      TEXT NOT NULL,
          embedding       BLOB,
          embedding_model TEXT
        );
        CREATE INDEX idx_messages_conversation ON messages (conversation_id, created_at);
        CREATE INDEX idx_messages_created ON messages (created_at);
        CREATE INDEX idx_messages_embedding ON messages (embedding_model, conversation_id);

        CREATE TABLE memories (
          seq              INTEGER PRIMARY KEY AUTOINCREMENT,
          id               TEXT NOT NULL UNIQUE,
          content          TEXT NOT NULL,
          category         TEXT NOT NULL DEFAULT 'other',
          importance       INTEGER NOT NULL DEFAULT 3 CHECK (importance BETWEEN 1 AND 5),
          source           TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('auto', 'tool', 'manual')),
          pinned           INTEGER NOT NULL DEFAULT 0,
          created_at       TEXT NOT NULL,
          updated_at       TEXT NOT NULL,
          last_accessed_at TEXT,
          access_count     INTEGER NOT NULL DEFAULT 0,
          embedding        BLOB,
          embedding_model  TEXT,
          archived         INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX idx_memories_category ON memories (archived, category);
        CREATE INDEX idx_memories_updated ON memories (archived, pinned, updated_at);
        CREATE INDEX idx_memories_core ON memories (archived, pinned, importance);
        CREATE INDEX idx_memories_embedding ON memories (embedding_model, archived);

        CREATE TABLE commitments (
          id              TEXT PRIMARY KEY,
          description     TEXT NOT NULL,
          due_at          TEXT,
          status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'done', 'missed', 'cancelled')),
          created_at      TEXT NOT NULL,
          updated_at      TEXT NOT NULL,
          completed_at    TEXT,
          last_checked_at TEXT,
          check_count     INTEGER NOT NULL DEFAULT 0,
          notes           TEXT
        );
        CREATE INDEX idx_commitments_status ON commitments (status, due_at);

        CREATE TABLE reminders (
          id         TEXT PRIMARY KEY,
          text       TEXT NOT NULL,
          due_at     TEXT NOT NULL,
          recurrence TEXT NOT NULL DEFAULT 'none' CHECK (recurrence IN ('none', 'daily', 'weekdays', 'weekly', 'monthly')),
          status     TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'fired', 'dismissed', 'cancelled')),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          fired_at   TEXT
        );
        CREATE INDEX idx_reminders_status_due ON reminders (status, due_at);
        CREATE INDEX idx_reminders_due ON reminders (due_at);

        -- Busca textual (FTS5, conteúdo externo) sincronizada por gatilhos.
        CREATE VIRTUAL TABLE messages_fts USING fts5 (
          content, content = 'messages', content_rowid = 'seq', ${FTS_TOKENIZE}
        );
        CREATE TRIGGER messages_fts_ai AFTER INSERT ON messages BEGIN
          INSERT INTO messages_fts (rowid, content) VALUES (new.seq, new.content);
        END;
        CREATE TRIGGER messages_fts_ad AFTER DELETE ON messages BEGIN
          INSERT INTO messages_fts (messages_fts, rowid, content) VALUES ('delete', old.seq, old.content);
        END;
        CREATE TRIGGER messages_fts_au AFTER UPDATE OF content ON messages BEGIN
          INSERT INTO messages_fts (messages_fts, rowid, content) VALUES ('delete', old.seq, old.content);
          INSERT INTO messages_fts (rowid, content) VALUES (new.seq, new.content);
        END;

        CREATE VIRTUAL TABLE memories_fts USING fts5 (
          content, content = 'memories', content_rowid = 'seq', ${FTS_TOKENIZE}
        );
        CREATE TRIGGER memories_fts_ai AFTER INSERT ON memories BEGIN
          INSERT INTO memories_fts (rowid, content) VALUES (new.seq, new.content);
        END;
        CREATE TRIGGER memories_fts_ad AFTER DELETE ON memories BEGIN
          INSERT INTO memories_fts (memories_fts, rowid, content) VALUES ('delete', old.seq, old.content);
        END;
        CREATE TRIGGER memories_fts_au AFTER UPDATE OF content ON memories BEGIN
          INSERT INTO memories_fts (memories_fts, rowid, content) VALUES ('delete', old.seq, old.content);
          INSERT INTO memories_fts (rowid, content) VALUES (new.seq, new.content);
        END;
      `);
    },
  },
];

/** Versão mais recente do esquema conhecida por este código. */
export const LATEST_SCHEMA_VERSION = migrations.reduce((max, m) => Math.max(max, m.version), 0);

/** Versão atualmente aplicada ao banco (0 = vazio). */
export function getSchemaVersion(database: Database): number {
  const row = database.prepare('SELECT MAX(version) AS v FROM schema_version').get() as { v: number | null } | undefined;
  return row?.v ?? 0;
}

/** Aplica, em transação, todas as migrações ainda não executadas. Idempotente. */
export function runMigrations(database: Database, list: Migration[] = migrations): number {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version    INTEGER PRIMARY KEY,
      name       TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);
  const current = getSchemaVersion(database);
  const pending = [...list].sort((a, b) => a.version - b.version).filter((m) => m.version > current);
  const record = database.prepare('INSERT INTO schema_version (version, name, applied_at) VALUES (?, ?, ?)');
  for (const migration of pending) {
    const apply = database.transaction(() => {
      migration.up(database);
      record.run(migration.version, migration.name, new Date().toISOString());
    });
    try {
      apply.immediate();
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`Falha ao aplicar a migração ${migration.version} (${migration.name}): ${reason}`);
    }
  }
  return pending.length;
}

/**
 * Abre (ou cria) um banco, aplica pragmas e migrações.
 * Use `':memory:'` para um banco temporário (testes).
 */
export function openDatabase(filename: string): Database {
  const database = new BetterSqlite3(filename);
  if (filename !== ':memory:') {
    database.pragma('journal_mode = WAL');
    database.pragma('synchronous = NORMAL');
  }
  database.pragma('foreign_keys = ON');
  database.pragma('busy_timeout = 5000');
  database.pragma('temp_store = MEMORY');
  runMigrations(database);
  return database;
}

/** Caminho efetivo: respeita LARK_DB_PATH=':memory:' (o config resolveria como arquivo). */
export function resolveDatabasePath(): string {
  return process.env.LARK_DB_PATH?.trim() === ':memory:' ? ':memory:' : config.dbPath;
}

/** Conexão única do processo, pronta para uso (migrações aplicadas). */
export const db: Database = openDatabase(resolveDatabasePath());

// Fecha de forma limpa ao encerrar (garante checkpoint do WAL).
process.once('exit', () => {
  try {
    if (db.open) db.close();
  } catch {
    // Encerrando o processo: nada mais a fazer.
  }
});
