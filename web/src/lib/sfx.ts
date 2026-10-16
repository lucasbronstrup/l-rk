import { usePrefs } from '@/store/prefs';

/** Efeitos sonoros sintetizados (WebAudio) — discretos, estilo HUD. */
export type Sfx = 'boot' | 'send' | 'receive' | 'alert' | 'listen' | 'stop' | 'click' | 'error';

let ctx: AudioContext | null = null;
const getCtx = () => {
  if (!ctx) {
    const AC = window.AudioContext || (window as any).webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
  }
  if (ctx.state === 'suspended') void ctx.resume();
  return ctx;
};

const tone = (ac: AudioContext, freq: number, start: number, dur: number, type: OscillatorType, gain: number, endFreq?: number) => {
  const o = ac.createOscillator();
  const g = ac.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, ac.currentTime + start);
  if (endFreq) o.frequency.exponentialRampToValueAtTime(endFreq, ac.currentTime + start + dur);
  g.gain.setValueAtTime(0.0001, ac.currentTime + start);
  g.gain.exponentialRampToValueAtTime(gain, ac.currentTime + start + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, ac.currentTime + start + dur);
  o.connect(g).connect(ac.destination);
  o.start(ac.currentTime + start);
  o.stop(ac.currentTime + start + dur + 0.02);
};

export function playSfx(kind: Sfx): void {
  if (!usePrefs.getState().sfx) return;
  const ac = getCtx();
  if (!ac) return;
  switch (kind) {
    case 'boot':
      tone(ac, 110, 0, 0.9, 'sawtooth', 0.04, 220);
      tone(ac, 440, 0.5, 0.25, 'sine', 0.05, 880);
      tone(ac, 880, 0.75, 0.35, 'sine', 0.04);
      break;
    case 'send':
      tone(ac, 660, 0, 0.08, 'sine', 0.05, 990);
      break;
    case 'receive':
      tone(ac, 990, 0, 0.07, 'sine', 0.04);
      tone(ac, 1320, 0.07, 0.1, 'sine', 0.03);
      break;
    case 'alert':
      tone(ac, 880, 0, 0.12, 'square', 0.03);
      tone(ac, 660, 0.15, 0.12, 'square', 0.03);
      tone(ac, 880, 0.3, 0.2, 'square', 0.03);
      break;
    case 'listen':
      tone(ac, 520, 0, 0.12, 'sine', 0.05, 1040);
      break;
    case 'stop':
      tone(ac, 1040, 0, 0.12, 'sine', 0.05, 520);
      break;
    case 'click':
      tone(ac, 1800, 0, 0.03, 'square', 0.015);
      break;
    case 'error':
      tone(ac, 220, 0, 0.25, 'sawtooth', 0.04, 110);
      break;
  }
}
