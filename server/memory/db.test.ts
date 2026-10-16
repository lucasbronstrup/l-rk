import { describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  process.env.LARK_DB_PATH = ':memory:';
});

import { LATEST_SCHEMA_VERSION, db, getSchemaVersion, openDatabase, runMigrations } from '../db/index.js';

describe('banco de dados e migrações', () => {
  it('usa banco em memória nos testes e aplica todas as migrações na importação', () => {
    expect(db.memory).toBe(true);
    expect(getSchemaVersion(db)).toBe(LATEST_SCHEMA_VERSION);
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
  });

  it('cria as tabelas, índices e tabelas FTS esperados', () => {
    const names = (db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table', 'trigger')").all() as { name: string }[]).map(
      (r) => r.name,
    );
    for (const name of [
      'schema_version',
      'settings',
      'conversations',
      'messages',
      'memories',
      'commitments',
      'reminders',
      'messages_fts',
      'memories_fts',
      'messages_fts_ai',
      'messages_fts_ad',
      'messages_fts_au',
      'memories_fts_ai',
      'memories_fts_ad',
      'memories_fts_au',
    ]) {
      expect(names).toContain(name);
    }
    const memoryColumns = (db.prepare('PRAGMA table_info(memories)').all() as { name: string }[]).map((c) => c.name);
    expect(memoryColumns).toEqual(expect.arrayContaining(['embedding', 'embedding_model', 'archived']));
    const messageColumns = (db.prepare('PRAGMA table_info(messages)').all() as { name: string }[]).map((c) => c.name);
    expect(messageColumns).toEqual(expect.arrayContaining(['embedding', 'embedding_model', 'tool_calls', 'thoughts', 'kind']));
  });

  it('é idempotente: rodar as migrações de novo não faz nada', () => {
    const fresh = openDatabase(':memory:');
    expect(getSchemaVersion(fresh)).toBe(LATEST_SCHEMA_VERSION);
    expect(runMigrations(fresh)).toBe(0);
    fresh.close();
  });

  it('aplica migrações novas em ordem e registra a versão', () => {
    const fresh = openDatabase(':memory:');
    const applied = runMigrations(fresh, [
      { version: LATEST_SCHEMA_VERSION + 2, name: 'b', up: (d) => d.exec('CREATE TABLE extra_b (x)') },
      { version: LATEST_SCHEMA_VERSION + 1, name: 'a', up: (d) => d.exec('CREATE TABLE extra_a (x)') },
    ]);
    expect(applied).toBe(2);
    expect(getSchemaVersion(fresh)).toBe(LATEST_SCHEMA_VERSION + 2);
    fresh.close();
  });

  it('desfaz a migração inteira quando ela falha', () => {
    const fresh = openDatabase(':memory:');
    expect(() =>
      runMigrations(fresh, [
        {
          version: LATEST_SCHEMA_VERSION + 1,
          name: 'quebrada',
          up: (d) => d.exec('CREATE TABLE half (x); THIS IS NOT SQL'),
        },
      ]),
    ).toThrow(/migração/);
    expect(getSchemaVersion(fresh)).toBe(LATEST_SCHEMA_VERSION);
    expect(fresh.prepare("SELECT name FROM sqlite_master WHERE name = 'half'").get()).toBeUndefined();
    fresh.close();
  });

  it('mantém a FTS sincronizada (inserção, edição, exclusão e cascata)', () => {
    const d = openDatabase(':memory:');
    const now = new Date().toISOString();
    d.prepare('INSERT INTO conversations (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)').run('c1', 't', now, now);
    d.prepare(
      "INSERT INTO messages (id, conversation_id, role, content, kind, created_at) VALUES ('m1', 'c1', 'user', 'Pão de queijo mineiro', 'chat', ?)",
    ).run(now);
    const count = (q: string) => (d.prepare('SELECT COUNT(*) AS n FROM messages_fts WHERE messages_fts MATCH ?').get(q) as { n: number }).n;
    expect(count('"pao"')).toBe(1);
    d.prepare("UPDATE messages SET content = 'Café coado' WHERE id = 'm1'").run();
    expect(count('"pao"')).toBe(0);
    expect(count('"cafe"')).toBe(1);
    d.prepare("DELETE FROM conversations WHERE id = 'c1'").run();
    expect((d.prepare('SELECT COUNT(*) AS n FROM messages').get() as { n: number }).n).toBe(0);
    expect(count('"cafe"')).toBe(0);
    d.close();
  });
});
