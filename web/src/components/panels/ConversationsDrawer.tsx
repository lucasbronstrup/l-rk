import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Check, MessageSquarePlus, MessagesSquare, Pencil, Search, X } from 'lucide-react';
import type { Conversation } from '@shared/types';
import { HudButton, HudPanel, IconButton } from '@/components/ui';
import { cn } from '@/lib/cn';
import { dateBucket, formatDateTime, formatNumber, relativeTime } from '@/lib/format';
import { playSfx } from '@/lib/sfx';
import { useChat } from '@/store/chat';
import { useData } from '@/store/data';
import { useUi } from '@/store/ui';
import { ConfirmDelete, Dialog, EASE_OUT_EXPO, PanelEmpty, PanelError, PanelSkeleton, SectionLabel, useNow } from './parts';

const BUCKET_ORDER = ['Hoje', 'Ontem', 'Esta semana', 'Este mês', 'Anteriores'];

function closeDrawer() {
  useUi.getState().set({ conversationsOpen: false });
}

/** Leva o usuário ao chat (no celular troca de aba) e fecha a gaveta. */
function focusChat() {
  useUi.getState().set({ conversationsOpen: false, mobileTab: 'chat' });
}

function ConversationRow({ c, active, now }: { c: Conversation; active: boolean; now: number }) {
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(c.title);

  useEffect(() => {
    if (!editing) setTitle(c.title);
  }, [c.title, editing]);

  const open = () => {
    playSfx('click');
    void useChat.getState().loadConversation(c.id);
    focusChat();
  };

  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    const clean = title.trim();
    setEditing(false);
    if (clean && clean !== c.title) await useData.getState().renameConversation(c.id, clean);
    else setTitle(c.title);
  };

  const remove = async () => {
    const ok = await useData.getState().deleteConversation(c.id);
    if (!ok) return;
    if (useChat.getState().conversationId === c.id) {
      const next = useData.getState().conversations[0];
      if (next) await useChat.getState().loadConversation(next.id);
      else await useChat.getState().newConversation();
    }
  };

  return (
    <motion.li
      layout="position"
      initial={{ opacity: 0, x: -8 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: -16, transition: { duration: 0.18 } }}
      transition={{ duration: 0.28, ease: EASE_OUT_EXPO }}
      className={cn('group relative border-b border-line-neutral', active ? 'bg-red/[0.08]' : 'hover:bg-white/[0.025]')}
    >
      {active && <span aria-hidden className="absolute inset-y-0 left-0 w-[2px] bg-red shadow-glow-sm" />}
      {editing ? (
        <form onSubmit={submit} className="flex items-center gap-2 px-3 py-2">
          <input
            autoFocus
            value={title}
            maxLength={120}
            onChange={(e) => setTitle(e.target.value)}
            onBlur={() => void submit()}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                setTitle(c.title);
                setEditing(false);
              }
            }}
            aria-label="Novo título da conversa"
            className="h-8 min-w-0 flex-1 border border-red/60 bg-black/50 px-2 text-[13px] text-ink focus:outline-none focus:shadow-glow-sm"
          />
          <IconButton size="sm" type="submit" label="Salvar título" onMouseDown={(e) => e.preventDefault()}>
            <Check size={12} />
          </IconButton>
        </form>
      ) : (
        <div className="flex items-center gap-2 pr-2">
          <button
            type="button"
            onClick={open}
            aria-current={active ? 'true' : undefined}
            className="min-w-0 flex-1 px-3 py-2.5 text-left focus-visible:outline focus-visible:outline-1 focus-visible:-outline-offset-1 focus-visible:outline-red"
          >
            <span className={cn('block truncate text-[13.5px] leading-snug', active ? 'text-ink' : 'text-ink/90')}>{c.title || 'Conversa sem título'}</span>
            <span className="mt-0.5 flex items-center gap-2 font-mono text-[10px] text-dim">
              <time dateTime={c.updatedAt} title={formatDateTime(c.updatedAt)}>
                {relativeTime(c.updatedAt, now)}
              </time>
              <span aria-hidden>·</span>
              <span>
                {formatNumber(c.messageCount)} {c.messageCount === 1 ? 'mensagem' : 'mensagens'}
              </span>
            </span>
            {c.summary && <span className="mt-1 line-clamp-2 block text-[11.5px] leading-snug text-muted">{c.summary}</span>}
          </button>
          <div className="flex shrink-0 items-center gap-1 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100">
            <IconButton size="sm" label="Renomear" onClick={() => setEditing(true)}>
              <Pencil size={12} />
            </IconButton>
            <ConfirmDelete label="Apagar conversa" onConfirm={() => void remove()} />
          </div>
        </div>
      )}
    </motion.li>
  );
}

function DrawerBody() {
  const conversations = useData((s) => s.conversations);
  const status = useData((s) => s.conversationsStatus);
  const activeId = useChat((s) => s.conversationId);
  const now = useNow(60_000);
  const [filter, setFilter] = useState('');
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    void useData.getState().loadConversations();
  }, []);

  const groups = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    const list = needle
      ? conversations.filter((c) => c.title.toLowerCase().includes(needle) || (c.summary ?? '').toLowerCase().includes(needle))
      : conversations;
    const map = new Map<string, Conversation[]>();
    for (const c of list) {
      const b = dateBucket(c.updatedAt, now);
      const arr = map.get(b);
      if (arr) arr.push(c);
      else map.set(b, [c]);
    }
    return BUCKET_ORDER.filter((b) => map.has(b)).map((b) => ({ bucket: b, items: map.get(b) ?? [] }));
  }, [conversations, filter, now]);

  const create = async () => {
    setCreating(true);
    await useChat.getState().newConversation();
    setCreating(false);
    void useData.getState().loadConversations();
    focusChat();
  };

  return (
    <HudPanel
      title="Conversas"
      code="LOG-05"
      icon={<MessagesSquare size={14} />}
      className="h-full w-full border-y-0 border-l-0 bg-abyss/[0.97] shadow-glow-lg"
      bodyClassName="flex flex-col"
      actions={
        <IconButton label="Fechar conversas" size="sm" onClick={closeDrawer}>
          <X size={14} />
        </IconButton>
      }
    >
      <div className="shrink-0 space-y-2.5 border-b border-line p-3">
        <HudButton variant="primary" className="w-full" onClick={() => void create()} disabled={creating} icon={<MessageSquarePlus size={14} />}>
          Nova conversa
        </HudButton>
        <div className="relative">
          <Search size={13} aria-hidden className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-dim" />
          <input
            type="search"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape' && filter) {
                e.stopPropagation();
                setFilter('');
              }
            }}
            placeholder="Filtrar conversas…"
            aria-label="Filtrar conversas"
            className="h-9 w-full border border-line-neutral bg-black/40 pl-9 pr-3 text-[13px] text-ink placeholder:text-dim focus:border-red focus:shadow-glow-sm focus:outline-none"
          />
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        {status === 'loading' && !conversations.length ? (
          <PanelSkeleton rows={6} />
        ) : status === 'error' && !conversations.length ? (
          <PanelError message="Não consegui carregar o histórico." onRetry={() => void useData.getState().loadConversations()} />
        ) : !groups.length ? (
          filter ? (
            <PanelEmpty icon={<Search size={20} />} title="Nenhuma conversa encontrada" quote="Algumas conversas a gente não esquece — outras, só não tiveram esse nome." />
          ) : (
            <PanelEmpty icon={<MessagesSquare size={20} />} title="Nenhuma conversa ainda" quote="Toda jornada começa com uma pergunta. Qual é a sua?" />
          )
        ) : (
          groups.map((g) => (
            <section key={g.bucket} aria-label={g.bucket}>
              <SectionLabel count={g.items.length}>{g.bucket}</SectionLabel>
              <ul>
                <AnimatePresence initial={false}>
                  {g.items.map((c) => (
                    <ConversationRow key={c.id} c={c} active={c.id === activeId} now={now} />
                  ))}
                </AnimatePresence>
              </ul>
            </section>
          ))
        )}
      </div>
      <p className="shrink-0 border-t border-line-neutral px-3 py-2 font-mono text-[9.5px] uppercase tracking-[0.24em] text-dim">
        {formatNumber(conversations.length)} {conversations.length === 1 ? 'registro' : 'registros'} · memória permanente
      </p>
    </HudPanel>
  );
}

/** Gaveta lateral com o histórico de conversas (abre via useUi.conversationsOpen). */
export function ConversationsDrawer() {
  const open = useUi((s) => s.conversationsOpen);
  const close = useCallback(closeDrawer, []);
  return (
    <Dialog open={open} onClose={close} label="Conversas" placement="left" zClass="z-[55]" className="w-[min(380px,calc(100vw-2.5rem))]">
      <DrawerBody />
    </Dialog>
  );
}
