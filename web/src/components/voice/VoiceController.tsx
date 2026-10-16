import { useEffect } from 'react';
import { usePrefs } from '@/store/prefs';
import { useUi } from '@/store/ui';
import { unlockAudioOnGesture } from '@/lib/audio/context';
import { isSpeaking, stopSpeaking } from '@/lib/audio/speak';
import { useVoiceWake } from '@/hooks/useVoiceWake';
import { focusChatInput } from '@/components/hud/useGlobalShortcuts';

function isTypingTarget(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  if (el.isContentEditable) return true;
  if (el.tagName === 'TEXTAREA') return true;
  if (el.tagName === 'INPUT') {
    const type = (el as HTMLInputElement).type;
    return !['checkbox', 'radio', 'button', 'submit', 'range', 'color', 'file'].includes(type);
  }
  return false;
}

const hasOpenDialog = () => Boolean(document.querySelector('[aria-modal="true"]'));

/**
 * Controlador de voz sem interface:
 *  - palavra de ativação "Lärk" (quando habilitada nas preferências);
 *  - destrava o áudio no primeiro gesto (para falas proativas tocarem depois);
 *  - interrompe a fala quando o usuário começa a digitar;
 *  - atalhos: "/" foca o campo de mensagem e Esc silencia a fala em andamento.
 *    (Ctrl/⌘+Shift+Espaço e F2 para o modo de voz ficam nos atalhos globais da HUD.)
 */
export function VoiceController(): null {
  const wakeWord = usePrefs((s) => s.wakeWord);

  useVoiceWake(wakeWord);

  useEffect(() => {
    unlockAudioOnGesture();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing) return;
      const typing = isTypingTarget(e.target);
      const ui = useUi.getState();
      if (ui.voiceMode) return;

      if (typing && isSpeaking() && !e.ctrlKey && !e.metaKey && !e.altKey && (e.key.length === 1 || e.key === 'Backspace')) {
        stopSpeaking();
        return;
      }

      if (e.key === 'Escape' && isSpeaking()) {
        stopSpeaking();
        return;
      }

      if (!typing && e.key === '/' && !e.ctrlKey && !e.metaKey && !e.altKey && !hasOpenDialog()) {
        e.preventDefault();
        focusChatInput();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return null;
}
