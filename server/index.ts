/**
 * Entrada do servidor do Lärk.
 *
 * - Recusa iniciar exposto na rede sem senha (o Lärk controla o computador).
 * - Monta a API em /api (REST + chat + voz), o WebSocket da voz em /api/voice e, em produção,
 *   a interface compilada (dist/web) com fallback de SPA para index.html.
 * - Liga o worker de embeddings e o agendador proativo (lembretes, cobranças, briefing).
 * - Encerramento gracioso em SIGINT/SIGTERM.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Server } from 'node:http';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { config } from './config.js';
import { assertSafeStartup, installVoiceAuth, isAuthRequired, isLoopbackHost } from './lib/auth.js';
import { closeAllEventStreams } from './lib/sse.js';
import { getApiKey } from './memory/settings.js';
import { startEmbeddingWorker, stopEmbeddingWorker } from './memory/embeddings.js';
import { apiRoutes, handleApiError } from './routes/index.js';
import { startScheduler, stopScheduler, waitForSchedulerIdle } from './proactive/scheduler.js';
import { attachVoiceServer, shutdownVoiceServer } from './voice/live.js';
import { cancelAllApprovals } from './tools/approvals.js';
import { disposeMathEngine } from './tools/utility.js';

// ─── Cores do console (ANSI, desligadas fora de terminais) ───────────────

const useColor = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
const paint = (code: string) => (text: string) => (useColor ? `\x1b[${code}m${text}\x1b[0m` : text);
const red = paint('38;5;196');
const darkRed = paint('38;5;88');
const gray = paint('90');
const bold = paint('1');
const green = paint('32');
const yellow = paint('33');

// ─── Segurança antes de tudo ─────────────────────────────────────────────

try {
  assertSafeStartup();
} catch (error) {
  console.error(`\n${red('✖ O Lärk não vai iniciar por segurança.')}\n\n${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}

// ─── Aplicação HTTP ──────────────────────────────────────────────────────

const app = new Hono();

/** Log discreto: só erros, requisições lentas e ações que mudam dados (sem ruído de polling). */
app.use('/api/*', async (c, next) => {
  const started = performance.now();
  await next();
  const ms = Math.round(performance.now() - started);
  const method = c.req.method;
  const status = c.res.status;
  const streaming = (c.res.headers.get('content-type') ?? '').includes('text/event-stream');
  const noisy = method === 'GET' && status < 400 && ms < 3000;
  if (noisy || streaming) return;
  const color = status >= 500 ? red : status >= 400 ? yellow : gray;
  console.log(color(`  ${method.padEnd(6)} ${c.req.path} → ${status} ${gray(`${ms} ms`)}`));
});

app.onError(handleApiError);
app.route('/api', apiRoutes);

const webIndex = path.join(config.webDist, 'index.html');
const serveWeb = config.isProd || process.env.LARK_SERVE_WEB === '1';

if (serveWeb && fs.existsSync(webIndex)) {
  // Arquivos com hash no nome podem ficar em cache para sempre; o resto é revalidado.
  app.use('/assets/*', async (c, next) => {
    await next();
    if (c.res.ok) c.header('Cache-Control', 'public, max-age=31536000, immutable');
  });
  app.use('*', serveStatic({ root: config.webDist }));
  // Fallback de SPA: qualquer rota de página volta para o index.html.
  app.get('*', async (c) => {
    try {
      const html = await fs.promises.readFile(webIndex, 'utf8');
      c.header('Cache-Control', 'no-cache');
      return c.html(html);
    } catch {
      return c.text('Interface do Lärk não encontrada. Rode "npm run build".', 500);
    }
  });
} else {
  app.get('/', (c) =>
    c.html(
      `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>Lärk — servidor</title>
<style>body{background:#050505;color:#eee;font:16px/1.6 system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0}
main{max-width:560px;padding:32px;border:1px solid #5a0000;border-radius:12px;background:#0b0b0b}h1{color:#ff1a1a;letter-spacing:.2em;margin-top:0}
code{background:#1a0000;padding:2px 6px;border-radius:4px;color:#ff6b6b}a{color:#ff4d4d}</style></head>
<body><main><h1>LÄRK</h1><p>O núcleo está no ar. ${
        serveWeb
          ? 'A interface ainda não foi compilada: rode <code>npm run build</code> e reinicie.'
          : 'Em desenvolvimento, a interface roda pelo Vite: abra <a href="http://localhost:5173">http://localhost:5173</a> (ou use <code>npm run dev</code>).'
      }</p><p>API: <a href="/api/health">/api/health</a></p></main></body></html>`,
    ),
  );
}

app.notFound((c) =>
  c.req.path.startsWith('/api') ? c.json({ error: 'Rota da API não encontrada.' }, 404) : c.text('Não encontrado.', 404),
);

// ─── Inicialização ───────────────────────────────────────────────────────

function displayHost(host: string): string {
  if (host === '0.0.0.0' || host === '::') return 'localhost';
  return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
}

function printBanner(url: string): void {
  const logo = [
    '  ██╗      █████╗ ██████╗ ██╗  ██╗',
    '  ██║     ██╔══██╗██╔══██╗██║ ██╔╝',
    '  ██║     ███████║██████╔╝█████╔╝ ',
    '  ██║     ██╔══██║██╔══██╗██╔═██╗ ',
    '  ███████╗██║  ██║██║  ██║██║  ██╗',
    '  ╚══════╝╚═╝  ╚═╝╚═╝  ╚═╝╚═╝  ╚═╝',
  ];
  const keyStatus = config.mock
    ? yellow('modo demonstração (LARK_MOCK=1) — respostas simuladas')
    : getApiKey()
      ? green('chave do Gemini configurada')
      : yellow('sem chave do Gemini — cole a sua em Configurações (grátis em https://aistudio.google.com/apikey)');
  const exposure = isLoopbackHost(config.host)
    ? gray('somente neste computador')
    : yellow(`rede (${config.host}) — protegido por senha`);
  const lines = [
    '',
    ...logo.map((l, i) => (i < 3 ? red(l) : darkRed(l))),
    `  ${gray('A consciência do seu computador.')}  ${gray(`v${config.version}`)}`,
    '',
    `  ${bold('Interface')}   ${red(url)}${serveWeb ? '' : gray('  (dev: http://localhost:5173)')}`,
    `  ${bold('Cérebro')}     ${keyStatus}`,
    `  ${bold('Acesso')}      ${exposure}${isAuthRequired() ? gray(' · login por senha ativo') : ''}`,
    `  ${bold('Memória')}     ${gray(process.env.LARK_DB_PATH?.trim() === ':memory:' ? 'banco temporário em memória' : config.dbPath)}`,
    '',
    `  ${gray('Ctrl+C para encerrar.')}`,
    '',
  ];
  console.log(lines.join('\n'));
}

const server = serve({ fetch: app.fetch, port: config.port, hostname: config.host }, (info) => {
  printBanner(`http://${displayHost(config.host)}:${info.port}`);
}) as Server;

server.on('error', (error: NodeJS.ErrnoException) => {
  if (error.code === 'EADDRINUSE') {
    console.error(
      `\n${red('✖ A porta ' + config.port + ' já está em uso.')} Talvez o Lärk já esteja aberto — acesse http://localhost:${config.port}.\n` +
        'Para usar outra porta, defina PORT no arquivo .env.\n',
    );
  } else if (error.code === 'EACCES') {
    console.error(`\n${red('✖ Sem permissão para usar a porta ' + config.port + '.')} Escolha outra porta (PORT) acima de 1024.\n`);
  } else {
    console.error(`\n${red('✖ Falha no servidor:')}`, error);
  }
  process.exit(1);
});

attachVoiceServer(server);
installVoiceAuth();
startEmbeddingWorker();
startScheduler();

// ─── Encerramento gracioso ───────────────────────────────────────────────

let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) {
    console.log(gray('  Encerrando à força.'));
    process.exit(1);
  }
  shuttingDown = true;
  console.log(gray(`\n  ${signal} recebido — o Lärk está se despedindo…`));
  const force = setTimeout(() => {
    console.warn(yellow('  Encerramento demorou demais; saindo assim mesmo.'));
    process.exit(0);
  }, 5000);
  force.unref();

  stopScheduler();
  stopEmbeddingWorker();
  cancelAllApprovals();
  shutdownVoiceServer();
  closeAllEventStreams();
  try {
    await waitForSchedulerIdle();
    await disposeMathEngine();
  } catch {
    // seguindo com o encerramento
  }
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
    // Conexões keep-alive ociosas não podem segurar o encerramento.
    (server as Server & { closeIdleConnections?: () => void }).closeIdleConnections?.();
  });
  console.log(gray('  Até logo. Quando você falar oi, eu já venci.'));
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('unhandledRejection', (reason) => {
  console.error(red('[Lärk] Promessa rejeitada sem tratamento:'), reason);
});
