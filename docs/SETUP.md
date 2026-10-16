# Lärk — guia de instalação detalhado

Este guia complementa o [README](../README.md) com cada passo explicado, para quem nunca instalou um projeto Node.

## 1. Node.js

| Sistema | Como instalar |
|---|---|
| Windows | Baixe o instalador **LTS** em <https://nodejs.org>. Na instalação, deixe marcada a opção *"Automatically install the necessary tools"* (ajuda a compilar o banco SQLite se for preciso). |
| macOS | Instalador LTS de <https://nodejs.org> ou `brew install node`. |
| Linux | Use o pacote da sua distribuição se for ≥ 20.11, ou o [nvm](https://github.com/nvm-sh/nvm): `nvm install --lts`. |

Confira com `node -v` (precisa ser **v20.11** ou mais novo) e `npm -v`.

## 2. Baixar o projeto e instalar as dependências

```bash
git clone https://github.com/<seu-usuario>/l-rk.git
cd l-rk
npm install
```

Sem git? No GitHub, clique em **Code → Download ZIP**, extraia e abra um terminal dentro da pasta.
(O atalho de duplo clique também roda o `npm install` sozinho na primeira vez.)

## 3. Chave gratuita do Gemini

1. Entre em <https://aistudio.google.com/apikey> com sua conta Google.
2. **Create API key** → copie a chave (as chaves novas começam com `AQ.` ou `AIza`; as duas servem).
3. Cole em **Configurações → Inteligência** dentro do Lärk — ou crie o arquivo `.env`:

   ```bash
   cp .env.example .env      # Windows: copy .env.example .env
   ```

   e preencha `GEMINI_API_KEY=`.

A chave salva pela interface tem prioridade sobre a do `.env` e fica só no seu computador.

## 4. Iniciar

| Jeito | Comando |
|---|---|
| Duplo clique | `Lark.bat` (Windows) · `Lark.command` (macOS) · `lark.sh` (Linux) |
| Terminal | `node scripts/lark.mjs` |
| Só o servidor | `node scripts/lark.mjs --no-open` → abra <http://localhost:8787> |
| Segundo plano | `node scripts/lark.mjs --background` (log em `data/lark.log`; encerre com `--stop`) |
| Recompilar | `node scripts/lark.mjs --rebuild` |

O inicializador compila o projeto quando `dist/` não existe ou quando o código mudou, espera o servidor responder em
`/api/health` e abre o Lärk numa janela de aplicativo (Chrome, Edge, Brave ou Chromium com `--app`, usando um perfil
próprio em `data/app-window` para lembrar a permissão do microfone). Ao fechar a janela, o servidor também é encerrado.

> **macOS:** na primeira vez, o Gatekeeper pode bloquear o `Lark.command`. Clique com o botão direito → **Abrir**.
> Se aparecer "permissão negada", rode `chmod +x Lark.command lark.sh` no terminal.
>
> **Linux:** alguns gerenciadores de arquivos pedem para marcar "Permitir executar como programa" no `lark.sh`.

## 5. Primeira conversa

1. Diga **oi**. O Lärk se apresenta e, de manhã, abre o dia com o briefing.
2. Conte quem você é: nome, trabalho, objetivos — ele guarda na memória permanente.
3. Prometa algo com prazo ("vou correr amanhã às 7h") e veja a promessa aparecer no painel. Se o prazo passar, ele pergunta.
4. Use o botão de microfone para conversar por voz — e interrompa quando quiser, como numa conversa de verdade.

## 6. Iniciar com o sistema

```bash
node scripts/autostart.mjs install            # inicia no login e abre a janela
node scripts/autostart.mjs install --no-open  # só o servidor, em segundo plano
node scripts/autostart.mjs uninstall
```

Se você mover a pasta do projeto ou atualizar o Node, rode o `install` de novo (o caminho fica gravado no atalho).

## 7. Celular e rede local

No `.env`:

```env
HOST=0.0.0.0
LARK_PASSWORD=uma-senha-longa-e-unica
```

Descubra o IP do computador (`ipconfig` no Windows, `ipconfig getifaddr en0` no macOS, `hostname -I` no Linux) e abra
`http://IP:8787` no celular. Sem senha, o Lärk **se recusa a iniciar** fora do loopback.

Para a voz no celular (o navegador exige HTTPS para o microfone), publique o Lärk por um túnel com HTTPS
(Tailscale Serve, Cloudflare Tunnel…) e coloque o domínio em `LARK_ALLOWED_HOSTS`.

## 8. Variáveis de ambiente

| Variável | Padrão | Para quê |
|---|---|---|
| `GEMINI_API_KEY` | — | Chave do Google AI Studio (também aceita `GOOGLE_API_KEY`). |
| `LARK_MODEL_CHAT`, `_FAST`, `_TTS`, `_LIVE`, `_EMBEDDING` | automático | Fixar um modelo por função. |
| `PORT` | `8787` | Porta do servidor. |
| `HOST` | `127.0.0.1` | Endereço de escuta. Fora do loopback exige senha. |
| `TZ` | fuso do sistema | Fuso horário padrão (o da interface tem prioridade). |
| `LARK_PASSWORD` | — | Senha de acesso (login com cookie de 30 dias). |
| `LARK_ALLOWED_HOSTS` | — | Domínios extras aceitos (separados por vírgula). |
| `LARK_DB_PATH` | `./data/lark.db` | Banco da memória permanente (`:memory:` = temporário, para testes). |
| `LARK_MOCK` | `0` | `1` = modo demonstração, sem chamar o Gemini. |
| `LARK_SERVE_WEB` | — | `1` = serve a interface compilada mesmo fora de produção. |

## 9. Atualizar

```bash
git pull
npm install
node scripts/lark.mjs --rebuild
```

Seus dados em `data/` são preservados; o banco é migrado automaticamente.

## 10. Desinstalar

1. `node scripts/autostart.mjs uninstall` (se tiver ligado).
2. Faça um backup (Configurações → Dados → Exportar backup) se quiser guardar a memória.
3. Apague a pasta do projeto.
