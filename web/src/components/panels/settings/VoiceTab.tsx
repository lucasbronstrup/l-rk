import { useEffect, useMemo, useRef, useState } from 'react';
import { AudioLines, LoaderCircle, Play, Square, Volume2 } from 'lucide-react';
import type { Settings } from '@shared/types';
import { IconButton, Toggle } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { stopSpeaking } from '@/lib/audio/speak';
import { cn } from '@/lib/cn';
import { useData } from '@/store/data';
import { usePrefs } from '@/store/prefs';
import { FieldLabel, Select, useFieldId } from '../parts';
import { DebouncedText, OptionCard, Section } from './common';

const DEMO_PHRASE =
  'Olá. Eu sou o Lärk. Cada palavra que eu digo foi escolhida para te levar um passo adiante — porque falar bem não é enfeite. É poder.';

// ─── Reprodução da prévia ───────────────────────────────────────────────

let previewAudio: HTMLAudioElement | null = null;
let previewUrl: string | null = null;

function stopPreview(): void {
  if (previewAudio) {
    previewAudio.pause();
    previewAudio.src = '';
    previewAudio = null;
  }
  if (previewUrl) {
    URL.revokeObjectURL(previewUrl);
    previewUrl = null;
  }
  if ('speechSynthesis' in window) {
    try {
      window.speechSynthesis.cancel();
    } catch {
      /* ignorado */
    }
  }
}

function playBlob(blob: Blob): Promise<void> {
  stopPreview();
  previewUrl = URL.createObjectURL(blob);
  const audio = new Audio(previewUrl);
  audio.volume = Math.max(0, Math.min(1, usePrefs.getState().volume));
  previewAudio = audio;
  return new Promise((resolve) => {
    const done = () => {
      if (previewAudio === audio) stopPreview();
      resolve();
    };
    audio.onended = done;
    audio.onerror = done;
    audio.play().catch(done);
  });
}

function speakBrowser(text: string, voiceURI: string | null): Promise<boolean> {
  if (!('speechSynthesis' in window)) return Promise.resolve(false);
  stopPreview();
  return new Promise((resolve) => {
    const u = new SpeechSynthesisUtterance(text);
    const voices = window.speechSynthesis.getVoices();
    const voice = (voiceURI && voices.find((v) => v.voiceURI === voiceURI)) || voices.find((v) => v.lang.toLowerCase() === 'pt-br') || null;
    if (voice) u.voice = voice;
    u.lang = voice?.lang ?? 'pt-BR';
    u.volume = Math.max(0, Math.min(1, usePrefs.getState().volume));
    u.onend = () => resolve(true);
    u.onerror = () => resolve(false);
    window.speechSynthesis.speak(u);
  });
}

function useBrowserVoices(): SpeechSynthesisVoice[] {
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  useEffect(() => {
    if (!('speechSynthesis' in window)) return;
    const synth = window.speechSynthesis;
    const load = () =>
      setVoices(
        synth
          .getVoices()
          .filter((v) => v.lang.toLowerCase().startsWith('pt'))
          .sort((a, b) => Number(b.lang.toLowerCase() === 'pt-br') - Number(a.lang.toLowerCase() === 'pt-br') || a.name.localeCompare(b.name)),
      );
    load();
    synth.addEventListener('voiceschanged', load);
    return () => synth.removeEventListener('voiceschanged', load);
  }, []);
  return voices;
}

// ─── Aba ─────────────────────────────────────────────────────────────────

export function VoiceTab({ settings }: { settings: Settings }) {
  const voices = useData((s) => s.voices);
  const save = useData((s) => s.saveSettings);
  const prefs = usePrefs();
  const browserVoices = useBrowserVoices();
  const [previewing, setPreviewing] = useState<string | null>(null);
  const previewToken = useRef(0);
  const fallbackId = useFieldId('fallback-voice');
  const volumeId = useFieldId('volume');

  useEffect(() => {
    if (voices === null) void useData.getState().loadVoices();
  }, [voices]);

  useEffect(() => () => stopPreview(), []);

  const voiceList = useMemo(() => {
    const list = voices ?? [];
    if (settings.voiceName && !list.some((v) => v.name === settings.voiceName)) return [{ name: settings.voiceName, description: 'Voz atual' }, ...list];
    return list;
  }, [voices, settings.voiceName]);

  const preview = async (voiceName: string) => {
    if (previewing === voiceName) {
      previewToken.current++;
      stopPreview();
      setPreviewing(null);
      return;
    }
    const token = ++previewToken.current;
    stopSpeaking();
    setPreviewing(voiceName);
    try {
      const blob = await api.tts(DEMO_PHRASE, { voiceName, style: settings.voiceStyle || undefined });
      if (token !== previewToken.current) return;
      if (blob) await playBlob(blob);
      else {
        useData.getState().pushToast({
          kind: 'warn',
          title: 'Voz do Gemini indisponível',
          body: 'Sem chave, em modo demonstração ou com a cota esgotada. Tocando a voz reserva do navegador.',
          key: 'tts-preview',
        });
        await speakBrowser(DEMO_PHRASE, prefs.fallbackVoiceURI);
      }
    } catch (e) {
      if (token === previewToken.current) useData.getState().pushToast({ kind: 'error', title: 'Prévia falhou', body: errorMessage(e), key: 'tts-preview' });
    } finally {
      if (token === previewToken.current) setPreviewing(null);
    }
  };

  const previewFallback = async () => {
    const token = ++previewToken.current;
    stopSpeaking();
    setPreviewing('__browser');
    const ok = await speakBrowser(DEMO_PHRASE, prefs.fallbackVoiceURI);
    if (!ok && token === previewToken.current) {
      useData.getState().pushToast({ kind: 'warn', title: 'Sem voz no navegador', body: 'Este navegador não oferece síntese de voz em português.' });
    }
    if (token === previewToken.current) setPreviewing(null);
  };

  return (
    <>
      <Section title="Voz do Lärk" code="VOZ-01" description="A voz neural do Gemini — a mesma usada no modo de voz ao vivo. Ouça antes de escolher: a voz é metade da presença.">
        {voices === null ? (
          <div className="flex items-center gap-2 py-4 text-[12px] text-muted">
            <LoaderCircle size={14} className="animate-spin text-red" /> Carregando vozes…
          </div>
        ) : voiceList.length === 0 ? (
          <p className="text-[12px] text-muted">Nenhuma voz disponível agora. Verifique a conexão com o servidor.</p>
        ) : (
          <div role="radiogroup" aria-label="Voz do Lärk" className="grid gap-2 sm:grid-cols-2">
            {voiceList.map((v) => (
              <OptionCard
                key={v.name}
                name="lark-voice"
                selected={settings.voiceName === v.name}
                onSelect={() => void save({ voiceName: v.name }, { toast: `Voz ${v.name} selecionada` })}
                title={v.name}
                description={v.description}
                trailing={
                  <IconButton
                    size="sm"
                    label={previewing === v.name ? `Parar prévia de ${v.name}` : `Ouvir ${v.name}`}
                    active={previewing === v.name}
                    onClick={() => void preview(v.name)}
                  >
                    {previewing === v.name ? <Square size={11} /> : <Play size={11} />}
                  </IconButton>
                }
              />
            ))}
          </div>
        )}
        <DebouncedText
          label="Estilo de fala"
          multiline
          rows={3}
          maxLength={600}
          value={settings.voiceStyle}
          placeholder="Ex.: Palestrante carismático, ritmo calmo, pausas dramáticas antes das ideias importantes."
          hint="direção de cena para a voz"
          onSave={(voiceStyle) => void save({ voiceStyle }, { toast: 'Estilo de fala atualizado' })}
        />
      </Section>

      <Section title="Quando falar" code="VOZ-02">
        <Toggle
          label="Responder com voz também no chat"
          description="Mesmo quando você digita, o Lärk responde em voz alta — além do texto."
          checked={settings.speakInChat}
          onChange={(speakInChat) => void save({ speakInChat }, { toast: speakInChat ? 'O Lärk vai falar no chat' : 'Respostas do chat apenas em texto' })}
        />
        <Toggle
          label="Palavra de ativação “Lärk”"
          description="Diga “Lärk” para abrir o modo de voz sem tocar em nada. O microfone fica atento enquanto esta aba estiver aberta."
          checked={prefs.wakeWord}
          onChange={(wakeWord) => prefs.set({ wakeWord })}
        />
        <Toggle label="Efeitos sonoros" description="Sinais discretos da interface: envio, alertas, ativação." checked={prefs.sfx} onChange={(sfx) => prefs.set({ sfx })} />
      </Section>

      <Section title="Áudio" code="VOZ-03">
        <div>
          <FieldLabel htmlFor={volumeId} hint={`${Math.round(prefs.volume * 100)}%`}>
            Volume da voz
          </FieldLabel>
          <div className="flex items-center gap-3">
            <Volume2 size={14} className="shrink-0 text-muted" aria-hidden />
            <input
              id={volumeId}
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={prefs.volume}
              onChange={(e) => prefs.set({ volume: Number(e.target.value) })}
              className="h-1 w-full cursor-pointer appearance-none bg-white/10 accent-[#ff1e3c] focus-visible:outline focus-visible:outline-1 focus-visible:outline-red"
            />
          </div>
        </div>
        <div>
          <FieldLabel htmlFor={fallbackId} hint="usada quando o Gemini não estiver disponível">
            Voz reserva do navegador
          </FieldLabel>
          <div className="flex gap-2">
            <div className="min-w-0 flex-1">
              <Select id={fallbackId} value={prefs.fallbackVoiceURI ?? ''} onChange={(e) => prefs.set({ fallbackVoiceURI: e.target.value || null })} disabled={!browserVoices.length}>
                <option value="">{browserVoices.length ? 'Automática (melhor voz pt-BR)' : 'Nenhuma voz em português neste navegador'}</option>
                {browserVoices.map((v) => (
                  <option key={v.voiceURI} value={v.voiceURI}>
                    {v.name} — {v.lang}
                    {/natural|neural|online/i.test(v.name) ? ' · neural' : ''}
                  </option>
                ))}
              </Select>
            </div>
            <IconButton
              label={previewing === '__browser' ? 'Parar' : 'Ouvir voz reserva'}
              active={previewing === '__browser'}
              disabled={!browserVoices.length}
              onClick={() => {
                if (previewing === '__browser') {
                  previewToken.current++;
                  stopPreview();
                  setPreviewing(null);
                } else void previewFallback();
              }}
              className={cn('h-10 w-10')}
            >
              {previewing === '__browser' ? <Square size={12} /> : <AudioLines size={14} />}
            </IconButton>
          </div>
        </div>
      </Section>
    </>
  );
}
