import 'dotenv/config';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
/** Raiz do projeto (funciona tanto em server/ via tsx quanto em dist/server/ após o build). */
export const ROOT_DIR = path.resolve(here, here.includes(`${path.sep}dist${path.sep}`) ? '../..' : '..');

const num = (v: string | undefined, d: number) => (v && !Number.isNaN(Number(v)) ? Number(v) : d);

export const config = {
  version: '0.1.0',
  port: num(process.env.PORT, 8787),
  host: process.env.HOST || '127.0.0.1',
  isProd: process.env.NODE_ENV === 'production',
  dbPath: path.resolve(ROOT_DIR, process.env.LARK_DB_PATH || 'data/lark.db'),
  webDist: path.resolve(ROOT_DIR, 'dist/web'),
  /** Chave do Gemini vinda do .env. A chave salva pela interface (settings) tem prioridade. */
  geminiApiKey: process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '',
  /** Overrides opcionais de modelo via .env (vazio = automático). */
  models: {
    chat: process.env.LARK_MODEL_CHAT || '',
    fast: process.env.LARK_MODEL_FAST || '',
    tts: process.env.LARK_MODEL_TTS || '',
    live: process.env.LARK_MODEL_LIVE || '',
    embedding: process.env.LARK_MODEL_EMBEDDING || '',
  },
  timezone: process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/Sao_Paulo',
  password: process.env.LARK_PASSWORD || '',
  /** Modo demonstração: sem chamadas reais ao Gemini (respostas simuladas). */
  mock: process.env.LARK_MOCK === '1',
};

fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });
