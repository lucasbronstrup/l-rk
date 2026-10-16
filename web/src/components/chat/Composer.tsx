import { useCallback, useEffect, useLayoutEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { AudioLines, KeyRound, Mic, SendHorizontal, Square, TriangleAlert } from 'lucide-react';
import { useChat } from '@/store/chat';
import { useData } from '@/store/data';
import { useUi } from '@/store/ui';
import { cn } from '@/lib/cn';
import { playSfx } from '@/lib/sfx';
import { useSpeechRecognition } from '@/hooks/useSpeechRecognition';

const DRAFT_KEY = 'lark-draft';
const MAX_HEIGHT = 220;

function readDraft(): string {
  try {
    return window.sessionStorage.getItem(DRAFT_KEY) ?? '';
  } catch {
    return '';
  }
}

function writeDraft(v: string) {
  try {
    if (v) window.sessionStorage.setItem(DRAFT_KEY, v);
    else window.sessionStorage.removeItem(DRAFT_KEY);
  } catch {
    /* armazenamento indisponível: rascunho só em memória */
  }
}

/** Barras de nível do microfone (lê useUi.voiceLevel; só este componente re-renderiza). */
function MicLevel() {
  const level = useUi((s) => s.voiceLevel);
  const bars = [0.55, 0.85, 1, 0.75, 0.5];
  return (
    <span className="flex h-4 items-end gap-[2px]" aria-hidden>
      {bars.map((w, i) => (
        <span
          key={i}
          className="lark-level-bar block h-4 w-[2px] bg-red-bright"
          style={{ transform: `scaleY(${Math.max(0.12, Math.min(1, level * w * 1.25))})` }}
        />
      ))}
    </span>
  );
}

/** Campo de mensagem: texto autoexpansível, ditado, modo de voz e enviar/parar. */
export function Composer() {
  const [draft, setDraft] = useState(readDraft);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const dictationBase = useRef('');

  const streaming = useChat((s) => s.streaming);
  const settings = useData((s) => s.settings);
  const health = useData((s) => s.health);
  const connection = useUi((s) => s.connection);

  const mock = health?.mock ?? false;
  const noKey = !mock && (settings ? !settings.hasApiKey : health ? !health.hasApiKey : false);

  const joinDictation = (text: string) => {
    const base = dictationBase.current;
    if (!text) return base;
    return base ? `${base.replace(/\s+$/, '')} ${text}` : text;
  };

  const dictation = useSpeechRecognition({
    continuous: false,
    silenceMs: 0,
    withLevel: true,
    onInterim: (text) => setDraft(joinDictation(text)),
    onFinal: (text) => {
      const next = joinDictation(text);
      dictationBase.current = next;
      setDraft(next);
      requestAnimationFrame(() => {
        const ta = taRef.current;
        if (ta) {
          ta.focus();
          ta.setSelectionRange(ta.value.length, ta.value.length);
        }
      });
    },
  });

  // O modo de voz assume o microfone: encerra o ditado se ele estiver ativo.
  const voiceMode = useUi((s) => s.voiceMode);
  const abortDictation = dictation.abort;
  useEffect(() => {
    if (voiceMode) abortDictation();
  }, [voiceMode, abortDictation]);

  // Autoexpansão sem saltos.
  useLayoutEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    const h = Math.min(ta.scrollHeight, MAX_HEIGHT);
    ta.style.height = `${h}px`;
    ta.style.overflowY = ta.scrollHeight > MAX_HEIGHT ? 'auto' : 'hidden';
  }, [draft]);

  useEffect(() => {
    const t = setTimeout(() => writeDraft(draft), 300);
    return () => clearTimeout(t);
  }, [draft]);

  // Evento global para focar (e opcionalmente preencher) o campo.
  useEffect(() => {
    const onFocus = (e: Event) => {
      const detail = (e as CustomEvent<{ text?: string } | undefined>).detail;
      if (detail && typeof detail.text === 'string') setDraft(detail.text);
      requestAnimationFrame(() => {
        const ta = taRef.current;
        if (!ta) return;
        ta.focus();
        ta.setSelectionRange(ta.value.length, ta.value.length);
      });
    };
    window.addEventListener('lark:focus-input', onFocus);
    return () => window.removeEventListener('lark:focus-input', onFocus);
  }, []);

  const submit = useCallback(() => {
    const text = draft.trim();
    if (!text) return;
    if (dictation.listening) dictation.abort();
    dictationBase.current = '';
    setDraft('');
    writeDraft('');
    void useChat.getState().sendMessage(text);
  }, [draft, dictation]);

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (streaming) useChat.getState().stop();
    else submit();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      if (!streaming) submit();
    }
    if (e.key === 'Escape' && dictation.listening) {
      e.preventDefault();
      dictation.stop();
    }
  };

  const toggleDictation = () => {
    if (dictation.listening) {
      dictation.stop();
      playSfx('stop');
    } else {
      dictationBase.current = draft;
      dictation.start();
      playSfx('listen');
    }
  };

  const openVoice = () => {
    if (dictation.listening) dictation.abort();
    useUi.getState().set({ voiceMode: true });
  };

  const canSend = draft.trim().length > 0;

  return (
    <div className="shrink-0 border-t border-line bg-abyss/70 pb-3 pl-[max(0.75rem,env(safe-area-inset-left))] pr-[max(0.75rem,env(safe-area-inset-right))] pt-2.5 backdrop-blur-md sm:px-6">
      <div className="mx-auto w-full max-w-3xl">
        <AnimatePresence initial={false}>
          {noKey && (
            <motion.div
              key="nokey"
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 'auto' }}
              exit={{ opacity: 0, height: 0 }}
              className="overflow-hidden"
            >
              <div className="mb-2 flex items-center gap-3 border border-warn/35 bg-warn/[0.07] px-3 py-2" role="alert">
                <KeyRound size={15} className="shrink-0 text-warn" aria-hidden />
                <p className="min-w-0 flex-1 text-[12.5px] leading-snug text-ink/90">
                  <span className="font-semibold text-warn">Sem chave da API.</span> Conecte sua chave gratuita do Google AI Studio
                  para despertar o pensamento do Lärk.
                </p>
                <button
                  type="button"
                  onClick={() => useUi.getState().set({ settingsOpen: true })}
                  className="shrink-0 border border-warn/50 px-2.5 py-1 font-hud text-[11px] font-semibold uppercase tracking-[0.18em] text-warn transition-colors hover:bg-warn/15"
                >
                  Configurar
                </button>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {dictation.error && !dictation.listening && (
          <p className="mb-2 flex items-center gap-2 text-[12px] text-red-soft" role="alert">
            <TriangleAlert size={13} aria-hidden className="shrink-0" />
            {dictation.error}
          </p>
        )}

        <form
          onSubmit={onSubmit}
          className={cn(
            'relative flex items-end gap-1 border bg-black/45 p-1.5 transition-[border-color,box-shadow] duration-200',
            dictation.listening
              ? 'border-red/70 shadow-glow-sm'
              : 'border-line-strong focus-within:border-red/70 focus-within:shadow-glow-sm',
          )}
        >
          <span aria-hidden className="pointer-events-none absolute -left-px -top-px h-2.5 w-2.5 border-l-2 border-t-2 border-red" />
          <span aria-hidden className="pointer-events-none absolute -bottom-px -right-px h-2.5 w-2.5 border-b-2 border-r-2 border-red" />

          {dictation.supported && (
            <button
              type="button"
              onClick={toggleDictation}
              aria-label={dictation.listening ? 'Parar ditado' : 'Ditar mensagem'}
              title={dictation.listening ? 'Parar ditado' : 'Ditar mensagem'}
              aria-pressed={dictation.listening}
              className={cn(
                'flex h-9 w-9 shrink-0 items-center justify-center border transition-colors',
                dictation.listening
                  ? 'border-red bg-red/15 text-red-bright'
                  : 'border-transparent text-muted hover:border-line hover:text-ink',
              )}
            >
              {dictation.listening ? <MicLevel /> : <Mic size={17} aria-hidden />}
            </button>
          )}

          <label htmlFor="lark-composer" className="sr-only">
            Mensagem para o Lärk
          </label>
          <textarea
            id="lark-composer"
            ref={taRef}
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value);
              if (!dictation.listening) dictationBase.current = e.target.value;
            }}
            onKeyDown={onKeyDown}
            rows={1}
            enterKeyHint="send"
            autoComplete="off"
            spellCheck
            placeholder={dictation.listening ? 'Ouvindo… fale naturalmente' : 'Fale com o Lärk…'}
            className="max-h-[220px] min-h-9 min-w-0 flex-1 resize-none bg-transparent px-1.5 py-[7px] font-sans text-base leading-[1.45] text-ink outline-none placeholder:text-muted/60 focus-visible:outline-none sm:text-[15px]"
          />

          <button
            type="button"
            onClick={openVoice}
            aria-label="Abrir modo de voz"
            title="Modo de voz (Ctrl+Shift+Espaço)"
            className="flex h-9 w-9 shrink-0 items-center justify-center border border-transparent text-muted transition-colors hover:border-line hover:text-red-bright"
          >
            <AudioLines size={17} aria-hidden />
          </button>

          {streaming ? (
            <button
              type="submit"
              aria-label="Parar a resposta"
              title="Parar"
              className="flex h-9 w-9 shrink-0 items-center justify-center border border-red bg-red/15 text-red-bright transition-colors hover:bg-red/30"
            >
              <Square size={13} className="fill-current" aria-hidden />
            </button>
          ) : (
            <button
              type="submit"
              disabled={!canSend}
              aria-label="Enviar mensagem"
              title="Enviar (Enter)"
              className={cn(
                'flex h-9 w-9 shrink-0 items-center justify-center border transition-all duration-150',
                canSend
                  ? 'border-red-bright/70 bg-red/90 text-white shadow-glow-sm hover:bg-red hover:shadow-glow'
                  : 'border-line-neutral text-dim',
              )}
            >
              <SendHorizontal size={16} aria-hidden />
            </button>
          )}
        </form>

        <div className="mt-1.5 hidden items-center justify-between gap-4 font-mono text-[9.5px] tracking-[0.18em] text-muted md:flex">
          <span>
            <kbd className="kbd">ENTER</kbd> ENVIAR · <kbd className="kbd">SHIFT</kbd>+<kbd className="kbd">ENTER</kbd> NOVA LINHA
          </span>
          <span className="flex items-center gap-2">
            {connection === 'offline' ? (
              <span className="flex items-center gap-1.5 text-red-soft">
                <span className="h-1.5 w-1.5 bg-red-soft lark-blink" aria-hidden />
                NÚCLEO DESCONECTADO
              </span>
            ) : dictation.listening ? (
              <span className="text-red-bright">DITADO ATIVO · ESC PARA PARAR</span>
            ) : (
              <span>
                <kbd className="kbd">CTRL</kbd>+<kbd className="kbd">K</kbd> FOCAR · <kbd className="kbd">CTRL</kbd>+<kbd className="kbd">SHIFT</kbd>+<kbd className="kbd">ESPAÇO</kbd> VOZ
              </span>
            )}
          </span>
        </div>
      </div>
    </div>
  );
}
