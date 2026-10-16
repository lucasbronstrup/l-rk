/**
 * AudioContext compartilhado pela voz do Lärk (TTS, player do modo Live e captura do microfone).
 * Um único contexto evita limites do navegador e mantém a latência baixa.
 */

type AudioContextCtor = typeof AudioContext;

let ctx: AudioContext | null = null;
let unlockInstalled = false;

function getCtor(): AudioContextCtor | null {
  if (typeof window === 'undefined') return null;
  const w = window as Window & { webkitAudioContext?: AudioContextCtor };
  return window.AudioContext ?? w.webkitAudioContext ?? null;
}

/** Retorna (criando sob demanda) o AudioContext compartilhado, ou null se o navegador não suportar Web Audio. */
export function getAudioContext(): AudioContext | null {
  if (ctx && ctx.state !== 'closed') return ctx;
  const Ctor = getCtor();
  if (!Ctor) return null;
  try {
    ctx = new Ctor({ latencyHint: 'interactive' });
  } catch {
    ctx = null;
  }
  return ctx;
}

/** Garante o contexto em execução (políticas de autoplay podem deixá-lo suspenso). */
export async function resumeAudioContext(): Promise<AudioContext | null> {
  const ac = getAudioContext();
  if (!ac) return null;
  if (ac.state === 'suspended') {
    try {
      await ac.resume();
    } catch {
      /* sem gesto do usuário ainda — tentaremos de novo no próximo gesto */
    }
  }
  return ac;
}

/**
 * Instala ouvintes de primeiro gesto (clique/tecla/toque) que "destravam" o áudio.
 * Assim falas proativas (lembretes, cobranças) conseguem tocar mais tarde sem interação.
 */
export function unlockAudioOnGesture(): void {
  if (unlockInstalled || typeof window === 'undefined') return;
  unlockInstalled = true;
  const unlock = () => {
    void resumeAudioContext().then((ac) => {
      if (ac && ac.state === 'running') {
        window.removeEventListener('pointerdown', unlock, true);
        window.removeEventListener('keydown', unlock, true);
        window.removeEventListener('touchend', unlock, true);
      }
    });
  };
  window.addEventListener('pointerdown', unlock, true);
  window.addEventListener('keydown', unlock, true);
  window.addEventListener('touchend', unlock, true);
}
