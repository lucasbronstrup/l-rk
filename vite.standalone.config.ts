/**
 * Build da edição web standalone do Lärk (sem servidor): `npx vite build --config vite.standalone.config.ts`.
 * - Entrada: web/standalone.html → web/src/standalone/main.tsx (backend simulado no navegador).
 * - Saída: dist/standalone com caminhos RELATIVOS (base './'), servível em qualquer subcaminho.
 * - Nomes de arquivo estáveis (sem hash): republicar substitui os arquivos em vez de acumulá-los.
 * - index.html sai no formato de página de Artifact do claude.ai: só o conteúdo (título, metas, estilos,
 *   #root e script), sem <!doctype>/<html>/<head>/<body> — o claude.ai embrulha a página ao publicar.
 */
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath } from 'node:url';
import { promises as fs } from 'node:fs';
import path from 'node:path';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));
/**
 * LARK_TARGET=pages gera dist/pages: documento HTML completo + manifest relativo (instalável no celular),
 * para o GitHub Pages, onde o navegador fala direto com a API do Gemini (voz, Live e microfone).
 * Sem a variável, gera dist/standalone no formato de página de Artifact do claude.ai.
 */
const isPages = process.env.LARK_TARGET === 'pages';
const outDir = r(isPages ? './dist/pages' : './dist/standalone');

/** Manifest PWA com caminhos relativos: funciona em qualquer subcaminho (ex.: /l-rk/). */
const PAGES_MANIFEST = {
  name: 'Lärk',
  short_name: 'Lärk',
  description: 'Assistente pessoal com memória, promessas, lembretes e voz humanizada.',
  id: './',
  start_url: './',
  scope: './',
  display: 'standalone',
  orientation: 'portrait',
  background_color: '#030303',
  theme_color: '#030303',
  lang: 'pt-BR',
  icons: [
    { src: './icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
    { src: './icon-maskable.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'maskable' },
  ],
};

/** Converte o documento completo do Vite no conteúdo de página que o Artifact espera. */
export function toArtifactPage(html: string): string {
  const head = /<head[^>]*>([\s\S]*?)<\/head>/i.exec(html)?.[1] ?? '';
  const body = /<body[^>]*>([\s\S]*?)<\/body>/i.exec(html)?.[1] ?? html;
  const title = /<title>[\s\S]*?<\/title>/i.exec(head)?.[0] ?? '<title>Lärk</title>';
  const tidy = (s: string) =>
    s
      // Mesma origem: dispensa o modo CORS (evita bloquear CSS/fontes se o host não mandar cabeçalhos CORS).
      .replace(/\s+crossorigin(?:=["'][^"']*["'])?/gi, '')
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .join('\n');
  const headRest = head.replace(/<title>[\s\S]*?<\/title>/i, '').replace(/<meta\s+charset=[^>]*>/i, '');
  return `${title}\n${tidy(headRest)}\n${tidy(body)}\n`;
}

function standaloneOutput(): Plugin {
  return {
    name: 'lark-standalone-output',
    apply: 'build',
    async closeBundle() {
      const built = path.join(outDir, 'standalone.html');
      const html = await fs.readFile(built, 'utf8');
      await fs.rm(built, { force: true });
      // O manifest PWA da interface usa caminhos absolutos ("/"): não serve num subcaminho.
      await fs.rm(path.join(outDir, 'manifest.webmanifest'), { force: true });
      if (isPages) {
        const page = html.replace('</head>', '    <link rel="manifest" href="./manifest.webmanifest" />\n  </head>');
        await fs.writeFile(path.join(outDir, 'index.html'), page);
        await fs.writeFile(path.join(outDir, '404.html'), page);
        await fs.writeFile(path.join(outDir, 'manifest.webmanifest'), JSON.stringify(PAGES_MANIFEST, null, 2));
        await fs.writeFile(path.join(outDir, '.nojekyll'), '');
      } else {
        await fs.writeFile(path.join(outDir, 'index.html'), toArtifactPage(html));
      }
      // Bibliotecas de markdown trazem U+FFFD literal dentro de strings; o publicador do Artifact
      // recusa esse caractere, então ele vira a sequência de escape equivalente (�).
      const js = path.join(outDir, 'assets/lark.js');
      const code = await fs.readFile(js, 'utf8');
      if (code.includes('�')) await fs.writeFile(js, code.replaceAll('�', '\\uFFFD'));
    },
  };
}

export default defineConfig({
  root: r('./web'),
  base: './',
  plugins: [react(), tailwindcss(), standaloneOutput()],
  resolve: {
    alias: { '@': r('./web/src'), '@shared': r('./shared') },
  },
  server: { port: 5174, host: true },
  build: {
    outDir,
    emptyOutDir: true,
    assetsInlineLimit: 0,
    rolldownOptions: {
      input: r('./web/standalone.html'),
      output: {
        entryFileNames: 'assets/lark.js',
        chunkFileNames: 'assets/[name].js',
        assetFileNames: (info) => (/\.css$/i.test(info.names?.[0] ?? '') ? 'assets/lark[extname]' : 'assets/[name][extname]'),
      },
    },
  },
});
