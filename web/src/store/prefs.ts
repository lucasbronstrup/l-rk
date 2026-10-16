import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';

/** Preferências locais deste dispositivo (salvas no localStorage). */
interface PrefsState {
  /** Usar a palavra de ativação "Lärk" para abrir o modo de voz. */
  wakeWord: boolean;
  /** Efeitos sonoros da interface. */
  sfx: boolean;
  /** Notificações do navegador para lembretes e cobranças. */
  notifications: boolean;
  /** Voz do navegador usada como reserva quando o TTS do Gemini não estiver disponível. */
  fallbackVoiceURI: string | null;
  /** Volume da voz do Lärk 0..1. */
  volume: number;
  set: (patch: Partial<Omit<PrefsState, 'set'>>) => void;
}

const safeStorage = createJSONStorage(() => {
  try {
    return window.localStorage;
  } catch {
    const mem = new Map<string, string>();
    return {
      getItem: (k: string) => mem.get(k) ?? null,
      setItem: (k: string, v: string) => void mem.set(k, v),
      removeItem: (k: string) => void mem.delete(k),
    };
  }
});

export const usePrefs = create<PrefsState>()(
  persist(
    (set) => ({
      wakeWord: false,
      sfx: true,
      notifications: true,
      fallbackVoiceURI: null,
      volume: 1,
      set: (patch) => set(patch),
    }),
    { name: 'lark-prefs', storage: safeStorage },
  ),
);
