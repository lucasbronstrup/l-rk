import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath } from 'node:url';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  root: r('./web'),
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { '@': r('./web/src'), '@shared': r('./shared') },
  },
  server: {
    port: 5173,
    host: true,
    // ws: true → o WebSocket da voz (/api/voice) também passa pelo proxy em desenvolvimento.
    proxy: { '/api': { target: `http://localhost:${process.env.PORT || 8787}`, changeOrigin: true, ws: true } },
  },
  build: { outDir: r('./dist/web'), emptyOutDir: true },
});
