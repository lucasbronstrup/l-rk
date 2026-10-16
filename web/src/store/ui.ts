import { create } from 'zustand';

/** Estado visual do núcleo (orbe) — dirige animações em toda a HUD. */
export type OrbState = 'idle' | 'listening' | 'thinking' | 'speaking' | 'alert' | 'offline';
export type MobileTab = 'chat' | 'memory' | 'protocols' | 'system';

interface UiState {
  orbState: OrbState;
  /** Nível de áudio 0..1 (microfone ao ouvir, voz do Lärk ao falar). Atualizado ~60x/s. */
  voiceLevel: number;
  bootDone: boolean;
  settingsOpen: boolean;
  conversationsOpen: boolean;
  mobileTab: MobileTab;
  connection: 'connecting' | 'online' | 'offline';
  /** Modo de voz (sessão Live) ativo. */
  voiceMode: boolean;
  setOrbState: (s: OrbState) => void;
  setVoiceLevel: (v: number) => void;
  set: (patch: Partial<Omit<UiState, 'set' | 'setOrbState' | 'setVoiceLevel'>>) => void;
}

export const useUi = create<UiState>((set) => ({
  orbState: 'idle',
  voiceLevel: 0,
  bootDone: false,
  settingsOpen: false,
  conversationsOpen: false,
  mobileTab: 'chat',
  connection: 'connecting',
  voiceMode: false,
  setOrbState: (orbState) => set({ orbState }),
  setVoiceLevel: (voiceLevel) => set({ voiceLevel }),
  set: (patch) => set(patch),
}));
