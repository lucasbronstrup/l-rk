# Notas de integração

## Scripts npm sugeridos (S3 — não aplicados: o package.json é do integrador)

O script `start` atual (`NODE_ENV=production node dist/server/index.js`) não funciona no `cmd`/PowerShell do Windows.
Sugestões, sem dependências novas:

```jsonc
{
  "scripts": {
    "start": "node scripts/lark.mjs --no-open",        // multiplataforma (compila se preciso e define NODE_ENV)
    "app": "node scripts/lark.mjs",                    // inicia e abre a janela de aplicativo
    "app:background": "node scripts/lark.mjs --background",
    "app:stop": "node scripts/lark.mjs --stop",
    "autostart:install": "node scripts/autostart.mjs install",
    "autostart:uninstall": "node scripts/autostart.mjs uninstall"
  }
}
```

O servidor já lê o `.env` sozinho (dotenv em `server/config.ts`); o inicializador define `NODE_ENV=production`,
que faz o servidor servir `dist/web` (alternativa: `LARK_SERVE_WEB=1`).

## Pendências observadas fora do S3

- `server/llm/gemini.ts` — `PREFERRED_MODELS.embedding` começa por `gemini-embedding-002`, que **não existe**
  (ver "Fatos verificados" no ARCHITECTURE.md: use `gemini-embedding-2`). No modo demonstração o `/api/health`
  mostra esse nome. A lista `live` também usa `gemini-live-2.5-flash-native-audio` em vez de
  `gemini-2.5-flash-native-audio-latest`, e `chat` não inclui `gemini-3.7-flash`/`gemini-3.6-flash`.

## Decisões do S3

- **Proatividade × configurações:** a interface rotula `proactive.enabled` como "Cobrar promessas" e diz que o
  horário silencioso não afeta lembretes. Por isso: `enabled` controla só as cobranças; o briefing automático segue
  `morningBriefing`; lembretes agendados disparam sempre (inclusive no horário silencioso).
- **Cobranças:** não interrompem uma conversa em andamento (esperam 2 min sem mensagens na conversa ativa).
- **POST /briefing** sem `force` devolve `{message: null}` se o briefing matinal estiver desligado.
- **Proteção de origem** (`server/lib/auth.ts → originGuard`): bloqueia escrita com `Origin` de outro site e, sem senha,
  hosts que não sejam locais (DNS rebinding). Domínios próprios entram em `LARK_ALLOWED_HOSTS`.
- **Backup:** `/api/import` aplica as configurações do arquivo (nunca a chave) e mescla o resto ignorando ids existentes;
  as chaves de `imported` estão em PT-BR porque a interface as exibe direto.
