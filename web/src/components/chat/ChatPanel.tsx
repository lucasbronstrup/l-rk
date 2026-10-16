import { useEffect, useState } from 'react';
import { AnimatePresence, MotionConfig, motion } from 'motion/react';
import { KeyRound, RotateCcw, TriangleAlert, X } from 'lucide-react';
import { HudPanel } from '@/components/ui';
import { useChat } from '@/store/chat';
import { useData } from '@/store/data';
import { useUi } from '@/store/ui';
import { Composer } from './Composer';
import { ConversationHeader } from './ConversationHeader';
import { EmptyState } from './EmptyState';
import { MessageList } from './MessageList';
import './chat.css';

/** Painel de conversa completo. Ocupa 100% da altura do contêiner. */
export function ChatPanel() {
  const initialized = useChat((s) => s.initialized);
  const loading = useChat((s) => s.loading);
  const empty = useChat((s) => s.messages.length === 0);
  const connection = useUi((s) => s.connection);
  const userName = useData((s) => s.settings?.userName);

  useEffect(() => {
    void useChat.getState().init();
  }, []);

  // Servidor voltou: tenta de novo a carga inicial que falhou.
  useEffect(() => {
    if (connection === 'online' && !useChat.getState().initialized) void useChat.getState().init();
  }, [connection]);

  const pick = (text: string) => void useChat.getState().sendMessage(text);

  return (
    <MotionConfig reducedMotion="user">
      <HudPanel className="h-full min-h-0 min-w-0" bodyClassName="flex min-h-0 flex-col">
        <ConversationHeader />
        <div className="relative flex min-h-0 flex-1 flex-col">
          {empty && !initialized && loading ? (
            <LoadingState />
          ) : empty ? (
            <EmptyState userName={userName} onPick={pick} />
          ) : (
            <MessageList />
          )}
        </div>
        <ErrorBanner />
        <Composer />
        <ReplyAnnouncer />
      </HudPanel>
    </MotionConfig>
  );
}

function LoadingState() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 px-6" role="status" aria-live="polite">
      <div className="flex items-end gap-1" aria-hidden>
        {[0, 1, 2, 3, 4].map((i) => (
          <motion.span
            key={i}
            className="block h-5 w-[3px] origin-bottom bg-red"
            animate={{ scaleY: [0.25, 1, 0.25], opacity: [0.4, 1, 0.4] }}
            transition={{ duration: 1, repeat: Infinity, delay: i * 0.1, ease: 'easeInOut' }}
          />
        ))}
      </div>
      <p className="font-mono text-[10px] tracking-[0.32em] text-muted">SINCRONIZANDO MEMÓRIA</p>
    </div>
  );
}

function ErrorBanner() {
  const error = useChat((s) => s.error);
  const code = useChat((s) => s.errorCode);
  const canRetry = useChat((s) => Boolean(s.lastUserText) && !s.streaming);
  const initialized = useChat((s) => s.initialized);

  const action =
    code === 'no_api_key'
      ? { label: 'Configurar', Icon: KeyRound, run: () => useUi.getState().set({ settingsOpen: true }) }
      : !initialized
        ? { label: 'Reconectar', Icon: RotateCcw, run: () => void useChat.getState().init() }
        : canRetry && code !== 'auth'
          ? { label: 'Tentar de novo', Icon: RotateCcw, run: () => void useChat.getState().retry() }
          : null;

  return (
    <AnimatePresence initial={false}>
      {error && (
        <motion.div
          key="chat-error"
          initial={{ opacity: 0, height: 0 }}
          animate={{ opacity: 1, height: 'auto' }}
          exit={{ opacity: 0, height: 0 }}
          transition={{ duration: 0.2 }}
          className="shrink-0 overflow-hidden"
        >
          <div className="mx-auto w-full max-w-3xl px-3 pb-2 sm:px-6">
            <div role="alert" className="flex items-start gap-3 border border-red/40 bg-red/[0.07] px-3 py-2.5">
              <TriangleAlert size={16} className="mt-0.5 shrink-0 text-red-bright" aria-hidden />
              <p className="min-w-0 flex-1 text-[13px] leading-snug text-ink/90">{error}</p>
              <div className="flex shrink-0 items-center gap-1">
                {action && (
                  <button
                    type="button"
                    onClick={action.run}
                    className="inline-flex h-7 items-center gap-1.5 border border-red/50 px-2 font-hud text-[11px] font-semibold uppercase tracking-[0.16em] text-red-bright transition-colors hover:bg-red/15"
                  >
                    <action.Icon size={12} aria-hidden />
                    {action.label}
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => useChat.getState().clearError()}
                  aria-label="Dispensar aviso"
                  className="flex h-7 w-7 items-center justify-center text-muted transition-colors hover:text-ink"
                >
                  <X size={14} aria-hidden />
                </button>
              </div>
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

/** Região invisível para leitores de tela: anuncia cada resposta concluída (sem ler o streaming). */
function ReplyAnnouncer() {
  const reply = useChat((s) => s.lastReply);
  const [text, setText] = useState('');
  useEffect(() => {
    if (!reply?.content) return;
    const plain = reply.content.replace(/[#*_`>|~-]+/g, ' ').replace(/\s+/g, ' ').trim();
    setText(`Lärk respondeu: ${plain.length > 400 ? `${plain.slice(0, 400)}…` : plain}`);
  }, [reply]);
  return (
    <div className="sr-only" aria-live="polite" aria-atomic="true">
      {text}
    </div>
  );
}
