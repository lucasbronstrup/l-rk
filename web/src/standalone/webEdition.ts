/**
 * Ajustes visuais da edição web, sem editar componentes existentes:
 *  - selo discreto "EDIÇÃO WEB";
 *  - textos que falam de "servidor/computador" trocados pelo equivalente desta edição;
 *  - botão "Ativar acesso" do painel Sistema oculto (não há acesso ao computador aqui);
 *  - aviso "Sem chave da API" oculto enquanto o Claude do claude.ai estiver pensando por ele;
 *  - a saúde (modelo em uso) é recarregada quando o motor de IA muda.
 */
import { engineState, onEngineChange } from './backend';
import { useData } from '@/store/data';

const REPLACEMENTS = new Map<string, string>([
  ['Acesso desligado', 'Edição web: acesso ao computador indisponível'],
  [
    'Sem acesso, sou apenas uma voz. Com ele, torno-me a consciência desta máquina.',
    'Arquivos, aplicativos e sensores exigem o Lärk instalado no computador. Aqui, sou memória, voz e parceiro de compromissos.',
  ],
  ['Desligado — o Lärk só conversa, sem tocar em nada.', 'Indisponível na edição web: instale o Lärk no computador para isso.'],
  [
    'O cérebro do Lärk é o Gemini, do Google — gratuito pelo Google AI Studio. A chave fica guardada apenas no seu computador e nunca volta para a interface.',
    'Nesta edição web, o Lärk pensa com o Claude (quando aberto no claude.ai) ou com o Gemini, usando uma chave gratuita do Google AI Studio. A chave fica guardada só neste navegador, neste aparelho.',
  ],
  [
    'Tudo o que o Lärk sabe vive em um banco de dados local, neste computador.',
    'Nesta edição web, tudo o que o Lärk sabe fica guardado neste navegador, neste aparelho. Exporte um backup de vez em quando.',
  ],
]);

const HIDE_BUTTON_LABELS = new Set(['Ativar acesso']);
const NO_KEY_MARK = 'Sem chave da API.';

const noKeyBanners = new Set<HTMLElement>();

function applyBannerVisibility(): void {
  const hide = engineState() === 'claude';
  for (const el of [...noKeyBanners]) {
    if (!el.isConnected) {
      noKeyBanners.delete(el);
      continue;
    }
    el.style.display = hide ? 'none' : '';
  }
}

function patchText(node: Text): void {
  const raw = node.nodeValue;
  if (!raw) return;
  const value = raw.trim();
  if (!value) return;
  const replacement = REPLACEMENTS.get(value);
  if (replacement) {
    node.nodeValue = replacement;
    return;
  }
  if (HIDE_BUTTON_LABELS.has(value)) {
    const btn = node.parentElement?.closest('button');
    if (btn) btn.style.display = 'none';
    return;
  }
  if (value === 'Desligado' && node.parentElement?.closest('div')?.querySelector('dt')?.textContent?.trim() === 'Acesso ao PC') {
    node.nodeValue = 'Indisponível na web';
    return;
  }
  if (value === NO_KEY_MARK) {
    const banner = node.parentElement?.closest<HTMLElement>('[role="alert"]');
    if (banner) {
      noKeyBanners.add(banner);
      applyBannerVisibility();
    }
  }
}

function scan(root: Node): void {
  if (root.nodeType === Node.TEXT_NODE) {
    patchText(root as Text);
    return;
  }
  if (root.nodeType !== Node.ELEMENT_NODE && root.nodeType !== Node.DOCUMENT_FRAGMENT_NODE) return;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) patchText(n as Text);
}

function startTextPatches(): void {
  const observer = new MutationObserver((records) => {
    for (const r of records) {
      if (r.type === 'characterData') patchText(r.target as Text);
      else r.addedNodes.forEach(scan);
    }
  });
  observer.observe(document.body, { subtree: true, childList: true, characterData: true });
  scan(document.body);
}

function mountBadge(): HTMLElement {
  const existing = document.getElementById('lark-web-badge');
  if (existing) return existing;
  const badge = document.createElement('div');
  badge.id = 'lark-web-badge';
  badge.setAttribute('aria-hidden', 'true');
  badge.textContent = 'Edição web';
  Object.assign(badge.style, {
    position: 'fixed',
    left: '50%',
    top: 'calc(env(safe-area-inset-top, 0px) + 18px)',
    transform: 'translateX(-50%)',
    zIndex: '35',
    pointerEvents: 'none',
    userSelect: 'none',
    whiteSpace: 'nowrap',
    padding: '1px 5px 0 7px',
    border: '1px solid rgb(255 30 60 / 0.32)',
    background: 'rgb(7 7 8 / 0.6)',
    color: 'rgb(255 75 95 / 0.75)',
    fontFamily: "var(--font-hud, 'Rajdhani', system-ui, sans-serif)",
    fontSize: '9px',
    fontWeight: '700',
    letterSpacing: '0.3em',
    textTransform: 'uppercase',
    lineHeight: '14px',
    textShadow: '0 0 6px rgb(255 30 60 / 0.4)',
  } satisfies Partial<CSSStyleDeclaration>);
  document.body.appendChild(badge);
  return badge;
}

/**
 * Celular e tablet: no centro da barra superior (espaço livre entre a marca e as ações).
 * Desktop: no centro do rodapé de status.
 */
function placeBadge(): void {
  const badge = document.getElementById('lark-web-badge');
  if (!badge) return;
  if (window.innerWidth >= 1280) {
    badge.style.top = 'auto';
    badge.style.bottom = 'calc(env(safe-area-inset-bottom, 0px) + 7px)';
    return;
  }
  const row = document.querySelector('header')?.firstElementChild;
  badge.style.bottom = 'auto';
  if (row instanceof HTMLElement) {
    const r = row.getBoundingClientRect();
    if (r.height > 0) {
      badge.style.top = `${Math.round(r.top + r.height / 2 - badge.offsetHeight / 2)}px`;
      return;
    }
  }
  badge.style.top = 'calc(env(safe-area-inset-top, 0px) + 18px)';
}

export function mountWebEdition(): void {
  document.documentElement.lang = 'pt-BR';
  const start = () => {
    mountBadge();
    startTextPatches();
    let queued = false;
    const schedule = () => {
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => {
        queued = false;
        placeBadge();
      });
    };
    schedule();
    // A barra superior aparece depois da abertura e muda de altura com a área segura.
    new MutationObserver(schedule).observe(document.body, { childList: true, subtree: false });
    window.addEventListener('resize', schedule);
    const timer = window.setInterval(() => {
      schedule();
      if (document.querySelector('header')) window.clearInterval(timer);
    }, 250);
  };
  if (document.body) start();
  else document.addEventListener('DOMContentLoaded', start, { once: true });

  onEngineChange(() => {
    applyBannerVisibility();
    void useData.getState().loadHealth();
  });
}
