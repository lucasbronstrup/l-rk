import { useCallback, useEffect, useRef, useState } from 'react';
import {
  SpeechRecognizer,
  isSpeechRecognitionSupported,
  type RecognitionErrorKind,
} from '@/lib/audio/recognition';
import { startMicCapture, type MicCapture } from '@/lib/audio/mic';
import { LEVEL_PRIORITY, setLevelSource } from '@/lib/audio/levels';
import { useUi } from '@/store/ui';

export interface UseSpeechRecognitionOptions {
  lang?: string;
  /** Continua ouvindo após cada frase (true) ou encerra quando o navegador detecta o fim (false). */
  continuous?: boolean;
  /** Silêncio em ms para fechar uma frase (0 = só no fim da sessão). */
  silenceMs?: number;
  /** Mede o nível do microfone e o publica na HUD (useUi.voiceLevel / orbe "ouvindo"). */
  withLevel?: boolean;
  onInterim?: (text: string) => void;
  onFinal?: (text: string) => void;
}

export interface UseSpeechRecognition {
  supported: boolean;
  listening: boolean;
  /** Texto provisório da frase atual. */
  interim: string;
  error: string | null;
  errorKind: RecognitionErrorKind | null;
  start: () => void;
  stop: () => void;
  abort: () => void;
}

const LEVEL_KEY = 'dictation';

/**
 * Reconhecimento de fala pt-BR (Web Speech API) como hook React.
 * Exclusivo: enquanto ativo, a palavra de ativação fica pausada.
 */
export function useSpeechRecognition(options: UseSpeechRecognitionOptions = {}): UseSpeechRecognition {
  const optsRef = useRef(options);
  optsRef.current = options;

  const [supported] = useState(isSpeechRecognitionSupported);
  const [listening, setListening] = useState(false);
  const [interim, setInterim] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [errorKind, setErrorKind] = useState<RecognitionErrorKind | null>(null);

  const recRef = useRef<SpeechRecognizer | null>(null);
  const micRef = useRef<MicCapture | null>(null);
  const micToken = useRef(0);

  const releaseMic = useCallback(() => {
    micToken.current++;
    micRef.current?.stop();
    micRef.current = null;
    setLevelSource(LEVEL_KEY, null);
    const ui = useUi.getState();
    if (ui.orbState === 'listening' && !ui.voiceMode) ui.setOrbState('idle');
  }, []);

  const attachMic = useCallback(async () => {
    const token = ++micToken.current;
    try {
      const mic = await startMicCapture();
      if (token !== micToken.current) {
        mic.stop();
        return;
      }
      micRef.current = mic;
      setLevelSource(LEVEL_KEY, mic.readLevel, LEVEL_PRIORITY.dictation);
    } catch {
      // Medidor é opcional: o reconhecimento segue mesmo sem ele.
    }
  }, []);

  const start = useCallback(() => {
    if (!supported || recRef.current?.listening) return;
    setError(null);
    setErrorKind(null);
    setInterim('');
    recRef.current?.abort();
    const o = optsRef.current;
    const rec = new SpeechRecognizer({
      lang: o.lang ?? 'pt-BR',
      continuous: o.continuous ?? false,
      silenceMs: o.silenceMs ?? 0,
      exclusive: true,
      onInterim: (text) => {
        setInterim(text);
        optsRef.current.onInterim?.(text);
      },
      onUtterance: (text) => {
        setInterim('');
        optsRef.current.onFinal?.(text);
      },
      onError: (kind, message) => {
        setError(message);
        setErrorKind(kind);
      },
      onStateChange: (on) => {
        setListening(on);
        if (on) {
          const ui = useUi.getState();
          if (!ui.voiceMode && ui.orbState !== 'speaking') ui.setOrbState('listening');
        } else if (recRef.current === rec && !rec.listening) {
          releaseMic();
        }
      },
    });
    recRef.current = rec;
    if (rec.start() && o.withLevel) void attachMic();
  }, [supported, attachMic, releaseMic]);

  const stop = useCallback(() => {
    recRef.current?.stop();
    releaseMic();
  }, [releaseMic]);

  const abort = useCallback(() => {
    recRef.current?.abort();
    recRef.current = null;
    setListening(false);
    setInterim('');
    releaseMic();
  }, [releaseMic]);

  useEffect(
    () => () => {
      recRef.current?.abort();
      recRef.current = null;
      micToken.current++;
      micRef.current?.stop();
      micRef.current = null;
      setLevelSource(LEVEL_KEY, null);
    },
    [],
  );

  return { supported, listening, interim, error, errorKind, start, stop, abort };
}
