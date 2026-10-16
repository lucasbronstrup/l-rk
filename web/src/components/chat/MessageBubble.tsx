import { memo } from 'react';
import { motion } from 'motion/react';
import { AudioLines, Bell, BellRing, Square, Sunrise, Volume2, type LucideIcon } from 'lucide-react';
import type { ChatMessage } from '@shared/types';
import { cn } from '@/lib/cn';
import { speak, stopSpeaking, useSpeech } from '@/lib/audio/speak';
import { CopyButton, Markdown } from './Markdown';
import { ThoughtBlock } from './ThoughtBlock';
import { ToolCallChip } from './ToolCallChip';
import { formatTime, isFresh, proactiveFlavor, type ProactiveFlavor } from './format';

interface MessageBubbleProps {
  message: ChatMessage;
  streaming: boolean;
  showThoughts: boolean;
  userLabel: string;
  timeZone?: string;
}

const EASE = [0.2, 0.8, 0.2, 1] as const;

const FLAVORS: Record<ProactiveFlavor, { label: string; Icon: LucideIcon; code: string }> = {
  reminder: { label: 'Lembrete', Icon: Bell, code: 'RMD' },
  checkin: { label: 'Cobrança', Icon: BellRing, code: 'CMP' },
  briefing: { label: 'Briefing', Icon: Sunrise, code: 'BRF' },
};

/** Mensagem do chat (Lärk à esquerda, usuário à direita). Memoizada: só re-renderiza quando muda. */
export const MessageBubble = memo(function MessageBubble(props: MessageBubbleProps) {
  if (props.message.role === 'user') return <UserBubble {...props} />;
  if (props.message.role === 'system') return <SystemNote message={props.message} />;
  return <AssistantBubble {...props} />;
});

function enter(m: ChatMessage, from: 'left' | 'right') {
  if (!isFresh(m)) return false as const;
  return { opacity: 0, x: from === 'left' ? -6 : 6, y: 6 };
}

function SpeakButton({ message }: { message: ChatMessage }) {
  const active = useSpeech((s) => s.speaking && s.currentKey === message.id);
  return (
    <button
      type="button"
      onClick={() => {
        if (active) stopSpeaking();
        else void speak(message.content, { key: message.id, interrupt: true });
      }}
      aria-label={active ? 'Parar a leitura em voz' : 'Ouvir esta mensagem'}
      title={active ? 'Parar' : 'Ouvir'}
      aria-pressed={active}
      className={cn(
        'inline-flex h-6 items-center gap-1.5 border px-1.5 font-mono text-[10px] tracking-[0.18em] transition-colors',
        active ? 'border-red/50 bg-red/10 text-red-bright' : 'border-transparent text-muted hover:border-line hover:text-ink',
      )}
    >
      {active ? <Square size={10} aria-hidden className="fill-current" /> : <Volume2 size={12} aria-hidden />}
      <span>{active ? 'PARAR' : 'OUVIR'}</span>
    </button>
  );
}

function AssistantBubble({ message, streaming, showThoughts, timeZone }: MessageBubbleProps) {
  const flavor = proactiveFlavor(message);
  const band = flavor ? FLAVORS[flavor] : null;
  const thoughts = message.thoughts?.trim() ?? '';
  const tools = message.toolCalls ?? [];
  const hasContent = message.content.trim().length > 0;
  const waiting = streaming && !hasContent;

  return (
    <motion.article
      initial={enter(message, 'left')}
      animate={{ opacity: 1, x: 0, y: 0 }}
      transition={{ duration: 0.32, ease: EASE }}
      aria-label="Mensagem do Lärk"
      className={cn('group relative isolate pl-5 sm:pl-6', band && 'py-1')}
    >
      {/* Trilho vertical + losango: assinatura visual das falas do Lärk. */}
      <span aria-hidden className="absolute bottom-1 left-[3px] top-2 w-px bg-gradient-to-b from-red/70 via-red/20 to-transparent" />
      <span
        aria-hidden
        className={cn(
          'absolute left-0 top-[7px] h-[7px] w-[7px] rotate-45 border border-red bg-void',
          streaming && 'bg-red shadow-glow-sm',
        )}
      />
      {band && (
        <span
          aria-hidden
          className="pointer-events-none absolute inset-y-0 left-2 right-0 -z-10 bg-gradient-to-r from-red/[0.07] via-red/[0.02] to-transparent"
        />
      )}

      {band && (
        <div className="mb-2 flex items-center gap-2">
          <span className="inline-flex items-center gap-1.5 border border-line-strong bg-red/10 px-2 py-0.5 font-hud text-[10px] font-bold uppercase tracking-[0.28em] text-red-bright">
            <band.Icon size={12} aria-hidden />
            {band.label}
          </span>
          <span className="font-mono text-[9px] tracking-[0.25em] text-dim">{band.code}//PROATIVO</span>
        </div>
      )}

      <header className="mb-1.5 flex min-h-6 flex-wrap items-center gap-x-2.5 gap-y-1">
        <span className="font-hud text-[11px] font-bold uppercase tracking-[0.32em] text-red text-glow-soft">Lärk</span>
        {message.kind === 'voice' && <AudioLines size={12} className="text-red-bright/80" aria-label="Conversa por voz" />}
        <time dateTime={message.createdAt} className="font-mono text-[10px] text-muted tabular">
          {formatTime(message.createdAt, timeZone)}
        </time>
        {streaming && (
          <span className="font-mono text-[9px] tracking-[0.24em] text-red-bright/80">
            TRANSMITINDO<span className="lark-blink">_</span>
          </span>
        )}
        {!streaming && hasContent && (
          <div className="ml-auto flex items-center gap-0.5 transition-opacity focus-within:opacity-100 [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover:opacity-100">
            <SpeakButton message={message} />
            <CopyButton text={message.content} label="Copiar resposta" />
          </div>
        )}
      </header>

      {showThoughts && thoughts && <ThoughtBlock text={thoughts} streaming={streaming} />}

      {tools.length > 0 && (
        <div className="mb-3 flex max-w-xl flex-col gap-1.5">
          {tools.map((call) => (
            <ToolCallChip key={call.id} call={call} />
          ))}
        </div>
      )}

      {hasContent ? (
        <Markdown text={message.content} className={cn(streaming && 'lark-streaming')} />
      ) : waiting ? (
        <ThinkingLine hasTools={tools.length > 0} />
      ) : null}
    </motion.article>
  );
}

/** Indicador antes do primeiro token. */
function ThinkingLine({ hasTools }: { hasTools: boolean }) {
  return (
    <div className="flex items-center gap-3 py-1" role="status" aria-live="polite">
      <span className="flex items-end gap-[3px]" aria-hidden>
        {[0, 1, 2, 3].map((i) => (
          <motion.span
            key={i}
            className="block h-3 w-[3px] origin-bottom bg-red"
            animate={{ scaleY: [0.3, 1, 0.3], opacity: [0.5, 1, 0.5] }}
            transition={{ duration: 0.9, repeat: Infinity, delay: i * 0.12, ease: 'easeInOut' }}
          />
        ))}
      </span>
      <span className="font-mono text-[10px] tracking-[0.28em] text-muted">
        {hasTools ? 'OPERANDO NO SISTEMA' : 'ORGANIZANDO O PENSAMENTO'}
      </span>
    </div>
  );
}

function UserBubble({ message, userLabel, timeZone }: MessageBubbleProps) {
  const pending = message.id.startsWith('local-');
  const failed = message.id.startsWith('failed-');
  return (
    <motion.article
      initial={enter(message, 'right')}
      animate={{ opacity: 1, x: 0, y: 0 }}
      transition={{ duration: 0.28, ease: EASE }}
      aria-label="Sua mensagem"
      className="flex justify-end"
    >
      <div
        className={cn(
          'relative min-w-0 max-w-[min(88%,38rem)] border bg-white/[0.025] px-3.5 py-2.5 sm:px-4',
          failed ? 'border-red/35' : 'border-line-neutral',
          pending && 'opacity-80',
        )}
      >
        <span aria-hidden className="pointer-events-none absolute -right-px -top-px h-2.5 w-2.5 border-r border-t border-red/80" />
        <span aria-hidden className="pointer-events-none absolute -bottom-px -left-px h-2.5 w-2.5 border-b border-l border-line-strong" />
        <header className="mb-1 flex items-center justify-end gap-2">
          {message.kind === 'voice' && <AudioLines size={12} className="text-muted" aria-label="Enviado por voz" />}
          <time dateTime={message.createdAt} className={cn('font-mono text-[10px] tabular', failed ? 'text-red-soft' : 'text-muted')}>
            {pending ? 'ENVIANDO' : failed ? 'NÃO ENTREGUE' : formatTime(message.createdAt, timeZone)}
          </time>
          <span className="max-w-[12rem] truncate font-hud text-[10px] font-semibold uppercase tracking-[0.28em] text-muted">
            {userLabel}
          </span>
        </header>
        <p className="whitespace-pre-wrap break-words text-[15px] leading-relaxed text-ink [overflow-wrap:anywhere]">
          {message.content}
        </p>
      </div>
    </motion.article>
  );
}

function SystemNote({ message }: { message: ChatMessage }) {
  return (
    <div className="flex items-center gap-3 py-1" role="note">
      <span aria-hidden className="h-px flex-1 bg-line" />
      <span className="max-w-[80%] text-center font-mono text-[10.5px] tracking-[0.12em] text-muted">{message.content}</span>
      <span aria-hidden className="h-px flex-1 bg-line" />
    </div>
  );
}
