import { memo, useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Brain, LoaderCircle, Pencil, Pin, PinOff, Plus, Search, Sparkles, X } from 'lucide-react';
import type { Memory, MemoryCategory, MemoryStats } from '@shared/types';
import { HudButton, HudPanel, IconButton } from '@/components/ui';
import { cn } from '@/lib/cn';
import { daysSince, formatNumber, relativeTime } from '@/lib/format';
import { playSfx } from '@/lib/sfx';
import { useData } from '@/store/data';
import { CATEGORY_LABEL, MEMORY_CATEGORIES, SOURCE_LABEL } from './labels';
import {
  ConfirmDelete,
  EASE_OUT_EXPO,
  FieldLabel,
  ImportanceMeter,
  PanelEmpty,
  PanelError,
  PanelSkeleton,
  Select,
  TextArea,
  useFieldId,
  useNow,
} from './parts';

/** Tons de vermelho para a barra de distribuição por categoria (do mais intenso ao mais sutil). */
const CATEGORY_SHADES = ['#ff1e3c', '#ff4b5f', '#d4152f', '#ff7a88', '#b0102a', '#ff6b3d', '#8a0c20', '#ff9aa5', '#5c0715', '#a39597'];

// ─── Estatísticas ───────────────────────────────────────────────────────

function Stat({ label, value, unit, code }: { label: string; value: string; unit?: string; code: string }) {
  return (
    <div className="min-w-0 px-3 py-2.5">
      <div className="flex items-center justify-between gap-1">
        <span className="truncate font-hud text-[10px] font-semibold uppercase tracking-[0.22em] text-muted">{label}</span>
        <span aria-hidden className="font-mono text-[8.5px] tracking-widest text-dim">
          {code}
        </span>
      </div>
      <p className="mt-0.5 truncate">
        <span className="tabular font-display text-lg font-semibold text-ink">{value}</span>
        {unit && <span className="ml-1 font-hud text-[11px] font-semibold uppercase tracking-[0.14em] text-muted">{unit}</span>}
      </p>
    </div>
  );
}

function StatsStrip({ stats }: { stats: MemoryStats | null }) {
  const now = useNow(60_000);
  const days = daysSince(stats?.firstInteractionAt ?? null, now);
  const distribution = useMemo(() => {
    if (!stats) return [];
    const total = Object.values(stats.byCategory).reduce((a, b) => a + b, 0);
    if (!total) return [];
    return MEMORY_CATEGORIES.map((c, i) => ({ c, n: stats.byCategory[c] ?? 0, color: CATEGORY_SHADES[i] }))
      .filter((x) => x.n > 0)
      .map((x) => ({ ...x, pct: (x.n / total) * 100 }));
  }, [stats]);

  return (
    <div className="shrink-0 border-b border-line">
      <div className="grid grid-cols-3 divide-x divide-line">
        <Stat label="Memórias" code="M" value={stats ? formatNumber(stats.memories) : '—'} />
        <Stat label="Mensagens" code="T" value={stats ? formatNumber(stats.messages) : '—'} />
        <Stat
          label="Juntos há"
          code="Δ"
          value={days === null ? '—' : days === 0 ? 'Hoje' : formatNumber(days)}
          unit={days === null || days === 0 ? undefined : days === 1 ? 'dia' : 'dias'}
        />
      </div>
      {distribution.length > 0 && (
        <div className="flex h-[3px] w-full gap-px bg-black/40" role="img" aria-label="Distribuição das memórias por categoria">
          {distribution.map((d) => (
            <motion.span
              key={d.c}
              title={`${CATEGORY_LABEL[d.c]}: ${formatNumber(d.n)}`}
              className="h-full origin-left"
              style={{ backgroundColor: d.color, width: `${d.pct}%` }}
              initial={{ scaleX: 0 }}
              animate={{ scaleX: 1 }}
              transition={{ duration: 0.7, ease: EASE_OUT_EXPO }}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Formulário (nova memória / edição) ─────────────────────────────────

interface MemoryDraft {
  content: string;
  category: MemoryCategory;
  importance: number;
}

function MemoryForm({
  initial,
  submitLabel,
  onSubmit,
  onCancel,
  autoFocus = true,
}: {
  initial: MemoryDraft;
  submitLabel: string;
  onSubmit: (d: MemoryDraft) => Promise<boolean> | boolean;
  onCancel: () => void;
  autoFocus?: boolean;
}) {
  const [draft, setDraft] = useState(initial);
  const [busy, setBusy] = useState(false);
  const textId = useFieldId('mem-text');
  const catId = useFieldId('mem-cat');
  const valid = draft.content.trim().length > 1;

  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    if (!valid || busy) return;
    setBusy(true);
    const ok = await onSubmit({ ...draft, content: draft.content.trim() });
    setBusy(false);
    if (!ok) return;
  };

  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      void submit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      onCancel();
    }
  };

  return (
    <form onSubmit={submit} onKeyDown={onKey} className="space-y-3">
      <div>
        <FieldLabel htmlFor={textId} hint="Ctrl+Enter salva">
          Conteúdo
        </FieldLabel>
        <TextArea
          id={textId}
          autoFocus={autoFocus}
          rows={3}
          maxLength={2000}
          value={draft.content}
          onChange={(e) => setDraft({ ...draft, content: e.target.value })}
          placeholder="Ex.: Prefere café sem açúcar e reuniões depois das 10h."
        />
      </div>
      <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
        <div>
          <FieldLabel htmlFor={catId}>Categoria</FieldLabel>
          <Select id={catId} value={draft.category} onChange={(e) => setDraft({ ...draft, category: e.target.value as MemoryCategory })}>
            {MEMORY_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {CATEGORY_LABEL[c]}
              </option>
            ))}
          </Select>
        </div>
        <div>
          <FieldLabel>Importância</FieldLabel>
          <ImportanceMeter value={draft.importance} onChange={(importance) => setDraft({ ...draft, importance })} size="md" />
        </div>
      </div>
      <div className="flex justify-end gap-2">
        <HudButton type="button" size="sm" variant="ghost" onClick={onCancel}>
          Cancelar
        </HudButton>
        <HudButton type="submit" size="sm" variant="primary" disabled={!valid || busy} icon={busy ? <LoaderCircle size={13} className="animate-spin" /> : undefined}>
          {submitLabel}
        </HudButton>
      </div>
    </form>
  );
}

// ─── Item ────────────────────────────────────────────────────────────────

const MemoryItem = memo(function MemoryItem({ memory, fresh, now }: { memory: Memory; fresh: boolean; now: number }) {
  const [editing, setEditing] = useState(false);
  const pending = memory.id.startsWith('tmp-');
  const { updateMemory, deleteMemory } = useData.getState();

  return (
    <motion.li
      layout="position"
      initial={{ opacity: 0, x: -10 }}
      animate={{ opacity: pending ? 0.55 : 1, x: 0 }}
      exit={{ opacity: 0, x: 12, transition: { duration: 0.18 } }}
      transition={{ duration: 0.35, ease: EASE_OUT_EXPO }}
      className={cn(
        'group relative border-b border-line-neutral px-3 py-2.5 transition-colors focus-within:bg-white/[0.025] hover:bg-white/[0.02]',
        memory.pinned && 'bg-red/[0.03]',
      )}
    >
      {/* Barra lateral: fixada = vermelho contínuo; nova = brilho que se apaga. */}
      <span aria-hidden className={cn('absolute inset-y-0 left-0 w-[2px]', memory.pinned ? 'bg-red/70' : 'bg-transparent')} />
      {fresh && (
        <motion.span
          aria-hidden
          className="pointer-events-none absolute inset-0 border-l-2 border-red-bright bg-gradient-to-r from-red/20 via-red/[0.06] to-transparent"
          initial={{ opacity: 1 }}
          animate={{ opacity: 0 }}
          transition={{ duration: 5.5, ease: 'easeOut' }}
        />
      )}

      {editing ? (
        <MemoryForm
          initial={{ content: memory.content, category: memory.category, importance: memory.importance }}
          submitLabel="Salvar"
          onCancel={() => setEditing(false)}
          onSubmit={async (d) => {
            const ok = await updateMemory(memory.id, d);
            if (ok) {
              setEditing(false);
              playSfx('click');
            }
            return Boolean(ok);
          }}
        />
      ) : (
        <>
          <div className="flex items-start gap-2">
            <p className="min-w-0 flex-1 whitespace-pre-line break-words text-[13px] leading-snug text-ink">
              {memory.pinned && <Pin size={11} className="mr-1.5 inline-block -translate-y-px text-red-bright" aria-label="Fixada" />}
              {memory.content}
            </p>
            {!pending && (
              <div className="-mr-1 -mt-0.5 flex shrink-0 items-center gap-1 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100">
                <IconButton
                  size="sm"
                  label={memory.pinned ? 'Desafixar' : 'Fixar — sempre presente no contexto'}
                  active={memory.pinned}
                  onClick={() => {
                    playSfx('click');
                    void updateMemory(memory.id, { pinned: !memory.pinned });
                  }}
                >
                  {memory.pinned ? <PinOff size={12} /> : <Pin size={12} />}
                </IconButton>
                <IconButton size="sm" label="Editar" onClick={() => setEditing(true)}>
                  <Pencil size={12} />
                </IconButton>
                <ConfirmDelete label="Esquecer memória" onConfirm={() => void deleteMemory(memory.id)} />
              </div>
            )}
          </div>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-2.5 gap-y-1">
            <ImportanceMeter value={memory.importance} />
            <span className="font-hud text-[10.5px] font-semibold uppercase tracking-[0.16em] text-red-soft">{CATEGORY_LABEL[memory.category] ?? memory.category}</span>
            <span aria-hidden className="h-2.5 w-px bg-line" />
            <time dateTime={memory.createdAt} title={new Date(memory.createdAt).toLocaleString('pt-BR')} className="font-mono text-[10px] text-dim">
              {relativeTime(memory.createdAt, now)}
            </time>
            <span className="font-mono text-[9.5px] uppercase tracking-[0.18em] text-dim">{SOURCE_LABEL[memory.source] ?? memory.source}</span>
            {memory.accessCount > 0 && (
              <span className="font-mono text-[9.5px] text-dim" title="Vezes que o Lärk recorreu a esta memória">
                ↺{memory.accessCount}
              </span>
            )}
          </div>
        </>
      )}
    </motion.li>
  );
});

// ─── Painel ──────────────────────────────────────────────────────────────

export function MemoryPanel() {
  const memories = useData((s) => s.memories);
  const total = useData((s) => s.memoriesTotal);
  const status = useData((s) => s.memoriesStatus);
  const error = useData((s) => s.memoriesError);
  const query = useData((s) => s.memoryQuery);
  const category = useData((s) => s.memoryCategory);
  const stats = useData((s) => s.memoryStats);
  const fresh = useData((s) => s.freshMemoryIds);
  const loadingMore = useData((s) => s.memoriesLoadingMore);
  const now = useNow(30_000);

  const [adding, setAdding] = useState(false);
  const [search, setSearch] = useState(query);
  const listRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const searchId = useFieldId('mem-search');

  // Busca com debounce.
  useEffect(() => {
    if (search === query) return;
    const t = window.setTimeout(() => useData.getState().setMemoryFilter({ q: search.trim() }), 320);
    return () => window.clearTimeout(t);
  }, [search, query]);

  // Rolagem infinita.
  useEffect(() => {
    const el = sentinelRef.current;
    const root = listRef.current;
    if (!el || !root || memories.length >= total) return;
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) void useData.getState().loadMoreMemories();
    }, { root, rootMargin: '120px' });
    io.observe(el);
    return () => io.disconnect();
  }, [memories.length, total]);

  const ordered = useMemo(() => {
    const pinned = memories.filter((m) => m.pinned);
    return pinned.length ? [...pinned, ...memories.filter((m) => !m.pinned)] : memories;
  }, [memories]);

  const filtering = Boolean(query) || category !== null;
  const freshSet = useMemo(() => new Set(fresh), [fresh]);

  const pickCategory = (c: MemoryCategory | null) => {
    playSfx('click');
    useData.getState().setMemoryFilter({ category: c });
    listRef.current?.scrollTo({ top: 0 });
  };

  return (
    <HudPanel
      title="Memória"
      code="MEM-01"
      icon={<Brain size={14} />}
      bodyClassName="flex flex-col"
      actions={
        <IconButton
          size="sm"
          label={adding ? 'Fechar formulário' : 'Registrar memória manualmente'}
          active={adding}
          onClick={() => {
            playSfx('click');
            setAdding((v) => !v);
          }}
        >
          {adding ? <X size={13} /> : <Plus size={13} />}
        </IconButton>
      }
    >
      <StatsStrip stats={stats} />

      {/* Busca */}
      <div className="shrink-0 space-y-2 border-b border-line-neutral px-3 pb-2.5 pt-3">
        <div className="relative">
          <label htmlFor={searchId} className="sr-only">
            Buscar nas memórias
          </label>
          <Search size={14} aria-hidden className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-dim" />
          <input
            id={searchId}
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape' && search) {
                e.stopPropagation();
                setSearch('');
              }
            }}
            placeholder="Buscar na memória…"
            autoComplete="off"
            className="h-9 w-full border border-line-neutral bg-black/40 pl-9 pr-9 text-[13px] text-ink placeholder:text-dim focus:border-red focus:shadow-glow-sm focus:outline-none [&::-webkit-search-cancel-button]:hidden"
          />
          {search && (
            <button
              type="button"
              aria-label="Limpar busca"
              onClick={() => setSearch('')}
              className="absolute right-2 top-1/2 grid h-6 w-6 -translate-y-1/2 place-items-center text-dim hover:text-ink focus-visible:outline focus-visible:outline-1 focus-visible:outline-red"
            >
              <X size={13} />
            </button>
          )}
        </div>

        {/* Categorias */}
        <div className="-mx-3 flex gap-1.5 overflow-x-auto px-3 pb-0.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden" role="group" aria-label="Filtrar por categoria">
          <CategoryChip active={category === null} onClick={() => pickCategory(null)} label="Todas" count={stats?.memories} />
          {MEMORY_CATEGORIES.map((c) => (
            <CategoryChip
              key={c}
              active={category === c}
              onClick={() => pickCategory(category === c ? null : c)}
              label={CATEGORY_LABEL[c]}
              count={stats?.byCategory[c] ?? 0}
              muted={!!stats && !(stats.byCategory[c] ?? 0)}
            />
          ))}
        </div>
      </div>

      {/* Nova memória */}
      <AnimatePresence initial={false}>
        {adding && (
          <motion.div
            key="add"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.28, ease: EASE_OUT_EXPO }}
            className="shrink-0 overflow-hidden border-b border-line bg-red/[0.03]"
          >
            <div className="p-3">
              <MemoryForm
                initial={{ content: '', category: category ?? 'fact', importance: 3 }}
                submitLabel="Registrar"
                onCancel={() => setAdding(false)}
                onSubmit={async (d) => {
                  const saved = await useData.getState().createMemory(d);
                  if (saved) {
                    setAdding(false);
                    playSfx('send');
                    useData.getState().pushToast({ kind: 'memory', title: 'Memória registrada', body: 'Guardado para sempre — ou até você pedir para esquecer.' });
                  }
                  return Boolean(saved);
                }}
              />
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Lista */}
      <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        {status === 'loading' && !memories.length ? (
          <PanelSkeleton rows={5} />
        ) : status === 'error' && !memories.length ? (
          <PanelError message={error ?? 'Não consegui acessar a memória.'} onRetry={() => void useData.getState().loadMemories()} />
        ) : !memories.length ? (
          filtering ? (
            <PanelEmpty
              icon={<Search size={20} />}
              title="Nada encontrado"
              quote="Nem tudo o que se busca está perdido — às vezes, apenas ainda não foi dito."
              action={
                <HudButton
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    setSearch('');
                    useData.getState().setMemoryFilter({ q: '', category: null });
                  }}
                >
                  Limpar filtros
                </HudButton>
              }
            />
          ) : (
            <PanelEmpty
              icon={<Sparkles size={20} />}
              title="Memória em branco"
              quote="Toda grande parceria começa com uma primeira lembrança. Conte-me algo sobre você."
            />
          )
        ) : (
          <>
            {filtering && (
              <p className="px-3 pb-1 pt-2.5 font-mono text-[10px] uppercase tracking-[0.2em] text-dim" aria-live="polite">
                {formatNumber(total)} {total === 1 ? 'resultado' : 'resultados'}
                {query && <span className="normal-case tracking-normal text-muted"> para “{query}”</span>}
              </p>
            )}
            <ul aria-label="Memórias">
              <AnimatePresence initial={false}>
                {ordered.map((m) => (
                  <MemoryItem key={m.id} memory={m} fresh={freshSet.has(m.id)} now={now} />
                ))}
              </AnimatePresence>
            </ul>
            {memories.length < total && (
              <div ref={sentinelRef} className="flex justify-center py-3">
                <HudButton size="sm" variant="ghost" disabled={loadingMore} onClick={() => void useData.getState().loadMoreMemories()}>
                  {loadingMore ? <LoaderCircle size={13} className="animate-spin" /> : null}
                  {loadingMore ? 'Carregando' : `Carregar mais (${formatNumber(total - memories.length)})`}
                </HudButton>
              </div>
            )}
            {memories.length >= total && memories.length > 6 && (
              <p className="py-4 text-center font-mono text-[9.5px] uppercase tracking-[0.3em] text-dim">— fim do registro —</p>
            )}
          </>
        )}
      </div>
    </HudPanel>
  );
}

function CategoryChip({ label, count, active, muted, onClick }: { label: string; count?: number; active: boolean; muted?: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        'inline-flex h-7 shrink-0 items-center gap-1.5 border px-2.5 font-hud text-[11px] font-semibold uppercase tracking-[0.14em] transition-colors focus-visible:outline focus-visible:outline-1 focus-visible:outline-red',
        active
          ? 'border-red bg-red/15 text-red-bright shadow-glow-sm'
          : cn('border-line-neutral hover:border-line-strong hover:text-ink', muted ? 'text-dim' : 'text-muted'),
      )}
    >
      {label}
      {count !== undefined && <span className={cn('tabular font-mono text-[9.5px]', active ? 'text-red-soft' : 'text-dim')}>{count}</span>}
    </button>
  );
}
