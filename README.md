<div align="center">

# L Ä R K

**A consciência do seu computador.**

Assistente pessoal no estilo J.A.R.V.I.S. — com memória permanente, voz humanizada,
cobrança de promessas e acesso total ao seu computador. Movido pela API **gratuita** do Google AI Studio (Gemini).

`Node 20+` · `Gemini (plano gratuito)` · `SQLite local` · `Interface HUD preto e vermelho`

</div>

---

## O que é o Lärk

O Lärk é um assistente que **mora no seu computador**. Ele é assistente, professor e amigo: conversa por texto ou
por voz, lembra de tudo o que importa, cobra o que você prometeu e mexe no seu computador quando você pede.

E ele não fala como um robô. O Lärk fala como um **palestrante profissional** — mestre da oratória e da persuasão —
e toda resposta carrega um pensamento, uma reflexão, algo que valha a pena ouvir.

> *"Quando eu falo oi, já venci."*

## Recursos

| | |
|---|---|
| 🧠 **Memória permanente** | Tudo fica num banco SQLite no seu disco. Ele extrai fatos, preferências, pessoas e metas das conversas e busca por significado (busca semântica + textual). Nada se perde ao fechar. |
| 🤝 **Promessas e cobranças** | Disse que ia fazer algo? O Lärk anota e, quando o prazo passa, **pergunta se você cumpriu** — com tato, no máximo 3 vezes, respeitando o horário silencioso. |
| ⏰ **Lembretes** | "Me lembra amanhã às 9h de ligar para a Ana" — com recorrência diária, dias úteis, semanal ou mensal. O lembrete chega na conversa, com som e notificação. |
| 🌅 **Briefing do dia** | Na primeira conversa do dia: agenda, promessas pendentes e um pensamento para começar com direção. |
| 🎙️ **Voz humanizada ao vivo** | Fale com ele e ele responde falando, em tempo real (Gemini Live), com voz grave e calorosa de orador. Dá para interromper no meio, como numa conversa de verdade. |
| 💬 **Chat com voz opcional** | No chat por texto, ative em Configurações → Voz → "Responder com voz também no chat" para ouvir as respostas. |
| 🖥️ **Acesso ao computador** | Arquivos (ler, procurar, criar, mover, apagar para a Lixeira), terminal, programas, área de transferência, captura de tela, processos, volume, sistema — com **níveis de aprovação**. |
| 🌐 **Web** | Pesquisa na internet, lê páginas e consulta o clima. |
| 🛰️ **Interface HUD** | Preto e vermelho, orbe reativo à voz, painéis de memória, promessas, lembretes e sinais vitais do computador. Funciona no celular também. |

## Requisitos

- **Node.js 20.11 ou mais novo** — [nodejs.org](https://nodejs.org) (versão LTS).
- **Google Chrome ou Microsoft Edge** — para a voz ao vivo e para abrir o Lärk como aplicativo.
- Uma **chave gratuita do Google AI Studio** (passo 3 abaixo).
- Windows 10/11, macOS 12+ ou Linux.

## Instalação passo a passo

### 1. Instale o Node.js
Baixe a versão **LTS** em [nodejs.org](https://nodejs.org) e instale com as opções padrão.
Para conferir, abra um terminal e rode `node -v` — deve aparecer `v20` ou mais.

### 2. Baixe o Lärk
Clone o repositório (ou baixe o ZIP pelo GitHub e extraia):

```bash
git clone https://github.com/<seu-usuario>/l-rk.git
cd l-rk
npm install
```

### 3. Crie sua chave grátis do Gemini
1. Acesse **https://aistudio.google.com/apikey** e entre com sua conta Google.
2. Clique em **Create API key** e copie a chave.

Agora escolha **uma** das opções:
- **Pela interface (mais fácil):** abra o Lärk, vá em **Configurações → Inteligência** e cole a chave. Pronto.
- **Pelo arquivo `.env`:** copie `.env.example` para `.env` e preencha `GEMINI_API_KEY=sua-chave`.

### 4. Inicie

**Duplo clique** no atalho do seu sistema, na pasta do projeto:

| Sistema | Atalho |
|---|---|
| Windows | `Lark.bat` |
| macOS | `Lark.command` |
| Linux | `lark.sh` |

Na primeira vez ele instala o que faltar e compila tudo sozinho. Depois abre o Lärk numa **janela própria de aplicativo**
(Chrome/Edge em modo app). Fechou a janela, o Lärk encerra.

Prefere o terminal? Dá no mesmo:

```bash
node scripts/lark.mjs          # compila se preciso, inicia e abre a janela
# ou, manualmente:
npm run build
node scripts/lark.mjs --no-open   # só o servidor → http://localhost:8787
```

> No Windows, use `node scripts/lark.mjs` em vez de `npm start` (o script `start` usa sintaxe de variável de ambiente do Linux/macOS).

## Desenvolvimento

```bash
npm run dev
```

Sobe o servidor (porta 8787, recarrega ao salvar) e a interface pelo Vite em **http://localhost:5173**
(com proxy para a API e para o WebSocket da voz). Outros comandos:

```bash
npm test           # testes (vitest)
npm run typecheck  # TypeScript do servidor e da interface
```

## Iniciar junto com o sistema

```bash
node scripts/autostart.mjs install            # inicia no login e abre a janela
node scripts/autostart.mjs install --no-open  # só o servidor em segundo plano (lembretes continuam valendo)
node scripts/autostart.mjs uninstall          # desliga
node scripts/autostart.mjs status
```

- **Windows:** cria um atalho oculto na pasta *Inicializar*.
- **macOS:** cria um LaunchAgent (`~/Library/LaunchAgents/com.lark.assistant.plist`).
- **Linux:** cria `~/.config/autostart/lark.desktop`.

Em segundo plano, o log fica em `data/lark.log`. Para encerrar: `node scripts/lark.mjs --stop`.

## Acessar pelo celular

Por padrão o Lärk só aceita conexões **deste computador** (`127.0.0.1`). Para usar no celular, na mesma rede Wi-Fi:

1. No `.env`, defina:
   ```env
   HOST=0.0.0.0
   LARK_PASSWORD=uma-senha-forte-de-verdade
   ```
2. Reinicie o Lärk e abra no celular `http://IP-DO-COMPUTADOR:8787` (ex.: `http://192.168.0.15:8787`).
3. Entre com a senha. A sessão vale por 30 dias.

> 🔒 **O Lärk se recusa a iniciar** com `HOST` fora do loopback sem `LARK_PASSWORD`. Ele controla o seu computador —
> ficar exposto na rede sem senha seria entregar a chave da casa.
>
> O microfone no navegador do celular exige HTTPS fora do `localhost`. Para a voz no celular, use um túnel com HTTPS
> (ex.: Tailscale, Cloudflare Tunnel) e adicione o domínio em `LARK_ALLOWED_HOSTS`. O chat funciona normalmente sem isso.

## Modo demonstração

Quer ver a interface sem chave nenhuma?

```bash
LARK_MOCK=1 npm run dev        # macOS/Linux
set LARK_MOCK=1 && npm run dev # Windows (cmd)
```

As respostas são simuladas (sem chamar o Gemini), mas memória, promessas, lembretes e cobranças funcionam de verdade.

## Onde ficam seus dados

- **Tudo** fica no seu computador, em `data/lark.db` (SQLite). Nada vai para servidores do Lärk — não existem servidores do Lärk.
- O que sai do seu computador: o texto das conversas (e o áudio, no modo de voz) enviado ao **Google Gemini** para gerar as respostas.
- **Backup:** em Configurações → Dados → *Exportar backup* você baixa um JSON completo (`lark-backup-AAAA-MM-DD.json`)
  com conversas, memórias, promessas, lembretes e configurações (**sem** a chave da API). *Importar* mescla um backup
  sem apagar nada do que já existe. Também dá para simplesmente copiar a pasta `data/` com o Lärk fechado.
- A chave da API fica no banco local (ou no `.env`) e **nunca** é enviada para a interface.

## Segurança: o que o acesso ao computador permite

O Lärk pode **ler, procurar, criar, mover e apagar arquivos**, **executar comandos no terminal**, abrir programas,
ler e escrever a área de transferência, tirar capturas de tela, listar e encerrar processos, ajustar volume e bloquear a tela.
Por isso, cada ação tem um nível de risco:

| Nível | Exemplos | Comportamento padrão |
|---|---|---|
| 🟢 **Seguro** | ler e procurar arquivos, sinais vitais, clima, memória | executa direto |
| 🟡 **Confirmar** | criar/mover/copiar arquivos, abrir programas, mudar volume | pede sua autorização |
| 🔴 **Perigoso** | comandos no terminal, apagar (vai para a Lixeira), encerrar processos | pede sua autorização com destaque |

Em **Configurações → Computador** você escolhe:
- **Perguntar antes de ações que modificam** (padrão): confirma tudo que não é seguro;
- **Perguntar só antes de ações perigosas**;
- **Nunca perguntar (controle total)**: autonomia total — use só se souber o que está fazendo;
- ou **desligar** o acesso ao computador por completo.

Os pedidos de autorização aparecem na tela e expiram sozinhos (expirou = negado). Apagar sempre manda para a **Lixeira**
(recuperável), pastas críticas do sistema são protegidas e o banco de memória do Lärk nunca é tocado pelas ferramentas.

Proteções da API: ela recusa requisições vindas de outros sites (CSRF) e de domínios estranhos (DNS rebinding);
com senha, o login usa cookie `httpOnly` assinado (HMAC-SHA256), comparação em tempo constante e limite de tentativas.

## Limites do plano gratuito do Gemini

O plano gratuito do Google AI Studio tem limites de **requisições por minuto e por dia**, que variam por modelo e mudam
com o tempo (veja os seus em [aistudio.google.com](https://aistudio.google.com)). O Lärk lida com isso sozinho:

- escolhe automaticamente o melhor modelo **gratuito** disponível para cada função (chat, rápido, voz, ao vivo, embeddings)
  e **troca de modelo** quando um estoura a cota ou está sobrecarregado (erro 429/503);
- se a voz do Gemini ficar indisponível, usa a voz do navegador;
- modelos *Pro* (que exigem cobrança) nunca são escolhidos automaticamente.

Em Configurações → Inteligência você pode fixar um modelo específico para cada função.

## Solução de problemas

| Sintoma | Solução |
|---|---|
| "A porta 8787 já está em uso" | O Lärk já está aberto (acesse http://localhost:8787) ou mude `PORT` no `.env`. |
| "O Lärk precisa do Node.js 20.11…" | Atualize o Node em [nodejs.org](https://nodejs.org). |
| "Ainda não tenho uma chave…" | Cole a chave em Configurações ou no `.env` (`GEMINI_API_KEY`). |
| Respostas de cota / "muitas requisições" | Limite do plano gratuito: espere alguns minutos — o Lärk já tenta outros modelos. |
| O microfone não funciona | Use Chrome ou Edge, permita o microfone no cadeado da barra de endereço e acesse por `localhost` (ou HTTPS). |
| A voz soa robótica | A voz do Gemini ficou indisponível (cota/sem chave) e o navegador assumiu. Confira a chave e a cota. |
| "Host não autorizado" | Você acessou por um nome de domínio: adicione-o em `LARK_ALLOWED_HOSTS` (ou defina `LARK_PASSWORD`). |
| Esqueci a senha | Troque `LARK_PASSWORD` no `.env` e reinicie (todas as sessões antigas expiram). |
| A janela não abre como aplicativo | Instale Chrome ou Edge; sem eles, o Lärk abre no navegador padrão. |
| Erro ao instalar `better-sqlite3` | Use uma versão LTS do Node (20, 22 ou 24); no Windows, reinstale o Node marcando "Tools for Native Modules". |

## Arquitetura em resumo

```
┌──────────── Interface (React + Vite + Tailwind) ────────────┐
│  HUD · chat · modo de voz · painéis · configurações        │
└──────────────┬───────────────────────┬─────────────────────┘
        REST + SSE (/api)        WebSocket (/api/voice)
┌──────────────┴───────────────────────┴─────────────────────┐
│ Servidor Node (Hono)                                        │
│  agente (persona do orador, ferramentas, contexto)          │
│  memória (SQLite + FTS5 + embeddings) · proatividade        │
│  voz (Gemini Live + TTS) · ferramentas do computador        │
└──────────────┬──────────────────────────────────────────────┘
               │  @google/genai
          Google Gemini (plano gratuito)
```

Detalhes, contratos entre módulos e a API HTTP completa: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).
Guia de instalação detalhado: [docs/SETUP.md](docs/SETUP.md).

---

<div align="center">

**Medo é o ingresso. Bora?**

</div>
