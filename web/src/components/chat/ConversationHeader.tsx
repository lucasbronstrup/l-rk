import { History, Plus, Radio, VolumeX } from 'lucide-react';
import type { Conversation } from '@shared/types';
import { IconButton } from '@/components/ui';
import { useChat } from '@/store/chat';
import { useData } from '@/store/data';
import { useUi } from '@/store/ui';
import { cn } from '@/lib/cn';
import { stopSpeaking, useSpeech } from '@/lib/audio/speak';

/** Cabeçalho do canal: título da conversa, estado da transmissão e ações (histórico, nova). */
export function ConversationHeader() {
  const conversationId = useChat((s) => s.conversationId);
  const stored = useChat((s) => s.conversation);
  const count = useChat((s) => s.messages.length);
  const streaming = useChat((s) => s.streaming);
  const connection = useUi((s) => s.connection);
  const speaking = useSpeech((s) => s.speaking);

  // O título pode ser atualizado em segundo plano (resumo automático): prefira a lista viva.
  const liveTitle = useData((s) => {
    const list = (s as { conversations?: unknown }).conversations;
    if (!conversationId || !Array.isArray(list)) return null;
    return (list as Conversation[]).find((c) => c?.id === conversationId)?.title ?? null;
  });
  const title = liveTitle || stored?.title || 'Nova conversa';

  const status = streaming
    ? { text: 'TRANSMITINDO', cls: 'text-red-bright' }
    : connection === 'offline'
      ? { text: 'NÚCLEO OFFLINE', cls: 'text-red-soft' }
      : connection === 'connecting'
        ? { text: 'SINCRONIZANDO', cls: 'text-warn' }
        : { text: 'CANAL SEGURO', cls: 'text-muted' };

  return (
    <header className="flex shrink-0 items-center gap-2.5 border-b border-line px-3 py-2 sm:gap-3 sm:px-4">
      <span
        aria-hidden
        className={cn(
          'flex h-8 w-8 shrink-0 items-center justify-center border text-red transition-shadow',
          streaming ? 'border-red/60 shadow-glow-sm' : 'border-line',
        )}
      >
        <Radio size={15} className={cn(streaming && 'animate-pulse')} />
      </span>

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 font-mono text-[9.5px] tracking-[0.26em]">
          <span className="text-dim">COM-01</span>
          <span aria-hidden className="text-dim">//</span>
          <span className={cn('truncate', status.cls)} role="status">
            {status.text}
          </span>
        </div>
        <h2
          className="truncate font-hud text-[13px] font-semibold uppercase leading-tight tracking-[0.18em] text-ink sm:text-sm"
          title={title}
        >
          {title}
        </h2>
      </div>

      {speaking && (
        <button
          type="button"
          onClick={stopSpeaking}
          className="inline-flex h-7 shrink-0 items-center gap-1.5 border border-red/50 bg-red/10 px-2 font-hud text-[10.5px] font-semibold uppercase tracking-[0.18em] text-red-bright transition-colors hover:bg-red/20"
          aria-label="Silenciar a voz do Lärk"
        >
          <VolumeX size={13} aria-hidden />
          <span className="hidden sm:inline">Silenciar</span>
        </button>
      )}

      <span className="hidden shrink-0 font-mono text-[10px] tracking-[0.16em] text-muted tabular lg:inline">
        MSG {String(count).padStart(3, '0')}
      </span>

      <div className="flex shrink-0 items-center gap-1">
        <IconButton size="sm" label="Histórico de conversas" onClick={() => useUi.getState().set({ conversationsOpen: true })}>
          <History size={14} aria-hidden />
        </IconButton>
        <IconButton size="sm" label="Nova conversa" onClick={() => void useChat.getState().newConversation()}>
          <Plus size={15} aria-hidden />
        </IconButton>
      </div>
    </header>
  );
}
