import { useEffect } from 'react';
import {
  SpeechRecognizer,
  isRecognitionBusy,
  isSpeechRecognitionSupported,
  normalizeSpeech,
  onRecognitionBusyChange,
} from '@/lib/audio/recognition';
import { useUi } from '@/store/ui';
import { useVoiceSession } from './useVoiceSession';

/** Variações aceitas da palavra de ativação, já sem acento (Lärk, Lárk, Lark, Lerk...). */
const WAKE_WORDS = new Set(['lark', 'lerk', 'larc', 'larck', 'larque', 'larke']);
/** Interjeições comuns antes do nome ("ei, Lärk", "ok Lärk"). */
const LEAD_INS = new Set(['ei', 'hey', 'oi', 'ok', 'ola', 'e', 'o', 'fala', 'alo']);

/**
 * Procura a palavra de ativação no início da frase.
 * Retorna o restante da frase (com acentos originais) ou null se não houver ativação.
 */
export function matchWakeWord(text: string): { rest: string } | null {
  const words = text.trim().split(/\s+/).filter(Boolean);
  for (let i = 0; i < Math.min(words.length, 3); i++) {
    const w = normalizeSpeech(words[i]);
    if (WAKE_WORDS.has(w)) {
      const rest = words
        .slice(i + 1)
        .join(' ')
        .replace(/^[\s,.;:!?…-]+/, '')
        .trim();
      return { rest };
    }
    if (!LEAD_INS.has(w)) return null;
  }
  return null;
}

/**
 * Escuta contínua pela palavra de ativação ("Lärk, ..."), em pt-BR.
 * Pausa quando o modo de voz está ativo, quando a aba está oculta ou quando outro
 * reconhecimento (ditado, modo clássico) está em uso; reinicia sozinho depois.
 */
export function useVoiceWake(enabled: boolean): void {
  useEffect(() => {
    if (!enabled || !isSpeechRecognitionSupported()) return;

    let rec: SpeechRecognizer | null = null;
    let disposed = false;
    let blocked = false;

    const canRun = () =>
      !disposed && !blocked && !document.hidden && !isRecognitionBusy() && !useUi.getState().voiceMode;

    const stopRec = () => {
      rec?.abort();
      rec = null;
    };

    const trigger = (text: string) => {
      const match = matchWakeWord(text);
      if (!match) return;
      stopRec();
      const session = useVoiceSession.getState();
      if (match.rest) session.queueInitialText(match.rest);
      useUi.getState().set({ voiceMode: true, mobileTab: 'chat' });
    };

    const startRec = () => {
      if (rec || !canRun()) return;
      rec = new SpeechRecognizer({
        lang: 'pt-BR',
        continuous: true,
        silenceMs: 900,
        exclusive: false,
        onUtterance: trigger,
        onError: (kind) => {
          // Sem permissão ou sem microfone: desiste até a preferência ser religada.
          if (kind === 'denied' || kind === 'no-mic' || kind === 'unsupported') {
            blocked = true;
            stopRec();
            console.warn('[Lärk] Palavra de ativação desativada:', kind);
          }
        },
      });
      rec.start();
    };

    const sync = () => (canRun() ? startRec() : stopRec());

    sync();
    document.addEventListener('visibilitychange', sync);
    const offBusy = onRecognitionBusyChange(() => {
      // O navegador precisa de um instante para liberar o microfone entre sessões.
      setTimeout(sync, 300);
    });
    const offUi = useUi.subscribe((s, prev) => {
      if (s.voiceMode !== prev.voiceMode) setTimeout(sync, s.voiceMode ? 0 : 600);
    });

    return () => {
      disposed = true;
      stopRec();
      document.removeEventListener('visibilitychange', sync);
      offBusy();
      offUi();
    };
  }, [enabled]);
}
