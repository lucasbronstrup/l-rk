import { useEffect } from 'react';
import { useUi } from '@/store/ui';
import { getBreakpoint } from './hooks';

/** Evento que o campo do chat escuta para receber o foco. */
export const FOCUS_INPUT_EVENT = 'lark:focus-input';

/** Leva o foco ao campo do chat (no celular, troca para a aba Chat antes). */
export function focusChatInput() {
  const ui = useUi.getState();
  const patch: Parameters<typeof ui.set>[0] = {};
  if (ui.settingsOpen) patch.settingsOpen = false;
  if (ui.conversationsOpen) patch.conversationsOpen = false;
  const needsTab = getBreakpoint() === 'mobile' && ui.mobileTab !== 'chat';
  if (needsTab) patch.mobileTab = 'chat';
  if (Object.keys(patch).length > 0) ui.set(patch);
  // Espera o painel montar/aparecer antes de pedir o foco.
  const dispatch = () => window.dispatchEvent(new CustomEvent(FOCUS_INPUT_EVENT));
  if (needsTab) requestAnimationFrame(() => requestAnimationFrame(dispatch));
  else dispatch();
}

/**
 * Atalhos globais:
 *  - Ctrl/⌘+K: foca o campo do chat
 *  - Ctrl/⌘+Shift+Espaço ou F2: alterna o modo de voz
 *  - Ctrl/⌘+,: abre as configurações
 *  - Esc: fecha configurações e a gaveta de conversas
 * Ficam inativos durante a abertura (a abertura usa qualquer tecla para pular).
 */
export function useGlobalShortcuts() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing) return;
      const ui = useUi.getState();
      if (!ui.bootDone) return;

      const mod = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();

      if (mod && !e.shiftKey && !e.altKey && key === 'k') {
        e.preventDefault();
        focusChatInput();
        return;
      }
      if ((mod && e.shiftKey && (e.code === 'Space' || e.key === ' ')) || (e.key === 'F2' && !mod && !e.altKey && !e.shiftKey)) {
        if (e.repeat) return;
        e.preventDefault();
        ui.set({ voiceMode: !ui.voiceMode });
        return;
      }
      if (mod && !e.altKey && (e.key === ',' || e.code === 'Comma')) {
        e.preventDefault();
        ui.set({ settingsOpen: true, conversationsOpen: false });
        return;
      }
      if (e.key === 'Escape' && (ui.settingsOpen || ui.conversationsOpen)) {
        ui.set({ settingsOpen: false, conversationsOpen: false });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}
