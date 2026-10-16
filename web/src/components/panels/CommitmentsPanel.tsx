import { memo, useMemo, useState, type FormEvent, type KeyboardEvent, type ReactNode } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { AlarmClock, Ban, Check, ChevronDown, CircleSlash, Handshake, LoaderCircle, Pencil, Plus, RotateCcw, X } from 'lucide-react';
import type { Commitment } from '@shared/types';
import { Badge, HudButton, HudPanel, IconButton } from '@/components/ui';
import { cn } from '@/lib/cn';
import { describeDue, formatDateTime, formatNumber, fromLocalInputValue, relativeTime, toLocalInputValue } from '@/lib/format';
import { playSfx } from '@/lib/sfx';
import { useData } from '@/store/data';
import { COMMITMENT_STATUS_LABEL } from './labels';
import { ConfirmDelete, EASE_OUT_EXPO, FieldLabel, PanelEmpty, PanelError, PanelSkeleton, SectionLabel, TextArea, TextInput, useFieldId, useNow } from './parts';

const DONE_LINES = [
  'Disciplina é a ponte entre o que se promete e o que se conquista.',
  'Palavra cumprida é reputação construída — tijolo por tijolo.',
  'Quem cumpre o pequeno, prepara-se para o grande.',
  'Consistência vence talento quando o talento não é consistente.',
];
const MISSED_LINE = 'Registrado com honestidade. Reconhecer a falha é o primeiro passo para não repeti-la.';

const pick = (lines: string[]) => lines[Math.floor(Math.random() * lines.length)];

// ─── Atalhos de prazo ───────────────────────────────────────────────────

function quickDue(kind: 'today' | 'tomorrow' | 'week'): string {
  const d = new Date();
  if (kind === 'today') {
    d.setHours(Math.max(18, d.getHours() + 2), 0, 0, 0);
    if (d.getDate() !== new Date().getDate()) d.setHours(23, 59, 0, 0);
  } else if (kind === 'tomorrow') {
    d.setDate(d.getDate() + 1);
    d.setHours(9, 0, 0, 0);
  } else {
    d.setDate(d.getDate() + 7);
    d.setHours(9, 0, 0, 0);
  }
  return toLocalInputValue(d);
}

// ─── Formulário ─────────────────────────────────────────────────────────

function CommitmentForm({
  initial,
  submitLabel,
  onSubmit,
  onCancel,
  extra,
}: {
  initial: { description: string; due: string };
  submitLabel: string;
  onSubmit: (v: { description: string; dueAt: string | null }) => Promise<boolean>;
  onCancel: () => void;
  extra?: ReactNode;
}) {
  const [description, setDescription] = useState(initial.description);
  const [due, setDue] = useState(initial.due);
  const [busy, setBusy] = useState(false);
  const descId = useFieldId('prm-desc');
  const dueId = useFieldId('prm-due');
  const valid = description.trim().length > 2;

  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    if (!valid || busy) return;
    setBusy(true);
    await onSubmit({ description: description.trim(), dueAt: fromLocalInputValue(due) });
    setBusy(false);
  };

  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey || (e.target as HTMLElement).tagName === 'INPUT')) {
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
        <FieldLabel htmlFor={descId}>O que foi prometido</FieldLabel>
        <TextArea
          id={descId}
          autoFocus
          rows={2}
          maxLength={500}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Ex.: Enviar a proposta para o cliente."
        />
      </div>
      <div>
        <FieldLabel htmlFor={dueId} hint="opcional">
          Prazo
        </FieldLabel>
        <div className="flex flex-wrap items-center gap-2">
          <TextInput id={dueId} type="datetime-local" value={due} onChange={(e) => setDue(e.target.value)} className="w-auto min-w-0 flex-1 [color-scheme:dark]" />
          {due && (
            <IconButton size="md" label="Remover prazo" type="button" onClick={() => setDue('')}>
              <X size={13} />
            </IconButton>
          )}
        </div>
        <div className="mt-2 flex flex-wrap gap-1.5">
          {(
            [
              ['today', 'Hoje'],
              ['tomorrow', 'Amanhã 9h'],
              ['week', 'Em 1 semana'],
            ] as const
          ).map(([k, label]) => (
            <button
              key={k}
              type="button"
              onClick={() => setDue(quickDue(k))}
              className="h-6 border border-line-neutral px-2 font-hud text-[10.5px] font-semibold uppercase tracking-[0.14em] text-muted hover:border-line-strong hover:text-ink focus-visible:outline focus-visible:outline-1 focus-visible:outline-red"
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      <div className="flex items-center justify-end gap-2">
        {extra && <div className="mr-auto">{extra}</div>}
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

// ─── Itens ───────────────────────────────────────────────────────────────

function closeCommitment(c: Commitment, status: 'done' | 'missed' | 'cancelled') {
  const { updateCommitment, pushToast } = useData.getState();
  void updateCommitment(c.id, { status }).then((saved) => {
    if (!saved) return;
    if (status === 'done') {
      playSfx('receive');
      pushToast({ kind: 'success', title: 'Promessa cumprida', body: pick(DONE_LINES) });
    } else if (status === 'missed') {
      playSfx('click');
      pushToast({ kind: 'warn', title: 'Promessa não cumprida', body: MISSED_LINE });
    } else {
      playSfx('click');
      pushToast({ kind: 'info', title: 'Promessa cancelada', body: 'Mudar de ideia também é um direito — desde que seja uma decisão, não uma fuga.' });
    }
  });
}

const PendingItem = memo(function PendingItem({ c, now }: { c: Commitment; now: number }) {
  const [editing, setEditing] = useState(false);
  const pending = c.id.startsWith('tmp-');
  const due = describeDue(c.dueAt, now);

  if (editing) {
    return (
      <motion.li layout="position" className="border-b border-line-neutral bg-red/[0.03] px-3 py-3">
        <CommitmentForm
          initial={{ description: c.description, due: c.dueAt ? toLocalInputValue(c.dueAt) : '' }}
          submitLabel="Salvar"
          onCancel={() => setEditing(false)}
          extra={<ConfirmDelete label="Apagar promessa" onConfirm={() => void useData.getState().deleteCommitment(c.id)} />}
          onSubmit={async (v) => {
            const saved = await useData.getState().updateCommitment(c.id, v);
            if (saved) setEditing(false);
            return Boolean(saved);
          }}
        />
      </motion.li>
    );
  }

  return (
    <motion.li
      layout="position"
      initial={{ opacity: 0, y: -6 }}
      animate={{ opacity: pending ? 0.55 : 1, y: 0 }}
      exit={{ opacity: 0, x: 24, transition: { duration: 0.2 } }}
      transition={{ duration: 0.3, ease: EASE_OUT_EXPO }}
      className={cn(
        'group relative flex items-start gap-3 border-b border-line-neutral px-3 py-2.5 transition-colors hover:bg-white/[0.02] focus-within:bg-white/[0.025]',
        due?.overdue && 'bg-red/[0.045]',
      )}
    >
      {due?.overdue && <span aria-hidden className="absolute inset-y-0 left-0 w-[2px] bg-red-bright shadow-glow-sm motion-safe:animate-pulse-red" />}
      <button
        type="button"
        disabled={pending}
        onClick={() => closeCommitment(c, 'done')}
        aria-label={`Marcar como cumprida: ${c.description}`}
        title="Cumpri"
        className="group/check mt-0.5 grid h-[18px] w-[18px] shrink-0 place-items-center border border-line-strong text-transparent transition-all hover:border-red hover:bg-red/15 hover:text-red-bright hover:shadow-glow-sm focus-visible:outline focus-visible:outline-1 focus-visible:outline-red"
      >
        <Check size={12} strokeWidth={3} />
      </button>

      <div className="min-w-0 flex-1">
        <p className="break-words text-[13px] leading-snug text-ink">{c.description}</p>
        <div className="mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-1">
          {due ? (
            <span
              className={cn(
                'inline-flex items-center gap-1 font-hud text-[11.5px] font-semibold tracking-[0.06em]',
                due.overdue ? 'text-red-bright motion-safe:animate-pulse-red' : due.urgent ? 'text-ember' : 'text-muted',
              )}
              title={c.dueAt ? formatDateTime(c.dueAt) : undefined}
            >
              <AlarmClock size={11} aria-hidden />
              {due.label}
            </span>
          ) : (
            <span className="font-hud text-[11px] font-semibold uppercase tracking-[0.16em] text-dim">sem prazo</span>
          )}
          {c.checkCount > 0 && (
            <span className="font-mono text-[9.5px] uppercase tracking-[0.16em] text-dim" title={c.lastCheckedAt ? `Última cobrança ${relativeTime(c.lastCheckedAt, now)}` : undefined}>
              cobrada {c.checkCount}×
            </span>
          )}
        </div>
        {c.notes && <p className="mt-1 text-[12px] leading-snug text-muted">{c.notes}</p>}
      </div>

      {!pending && (
        <div className="-mr-1 flex shrink-0 items-center gap-1 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100">
          <IconButton size="sm" label="Não cumpri" onClick={() => closeCommitment(c, 'missed')} className="hover:border-red/60 hover:text-red-bright">
            <CircleSlash size={12} />
          </IconButton>
          <IconButton size="sm" label="Cancelar promessa" onClick={() => closeCommitment(c, 'cancelled')}>
            <Ban size={12} />
          </IconButton>
          <IconButton size="sm" label="Editar" onClick={() => setEditing(true)}>
            <Pencil size={12} />
          </IconButton>
        </div>
      )}
    </motion.li>
  );
});

function HistoryItem({ c, now }: { c: Commitment; now: number }) {
  const tone = c.status === 'done' ? 'ok' : c.status === 'missed' ? 'red' : 'dim';
  return (
    <li className="group flex items-start gap-3 border-b border-line-neutral px-3 py-2">
      <div className="min-w-0 flex-1">
        <p className={cn('break-words text-[12.5px] leading-snug', c.status === 'done' ? 'text-muted' : 'text-dim', c.status !== 'missed' && 'line-through decoration-white/20')}>
          {c.description}
        </p>
        <div className="mt-1 flex items-center gap-2">
          <Badge tone={tone}>{COMMITMENT_STATUS_LABEL[c.status]}</Badge>
          {c.completedAt && <span className="font-mono text-[10px] text-dim">{relativeTime(c.completedAt, now)}</span>}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100">
        <IconButton size="sm" label="Reabrir promessa" onClick={() => void useData.getState().updateCommitment(c.id, { status: 'pending' })}>
          <RotateCcw size={12} />
        </IconButton>
        <ConfirmDelete label="Apagar do histórico" onConfirm={() => void useData.getState().deleteCommitment(c.id)} />
      </div>
    </li>
  );
}

// ─── Painel ──────────────────────────────────────────────────────────────

export function CommitmentsPanel() {
  const commitments = useData((s) => s.commitments);
  const status = useData((s) => s.commitmentsStatus);
  const now = useNow(30_000);
  const [adding, setAdding] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);

  const { pending, history, overdue, keptPct } = useMemo(() => {
    const pendingList = commitments
      .filter((c) => c.status === 'pending')
      .sort((a, b) => {
        const da = a.dueAt ? Date.parse(a.dueAt) : Number.POSITIVE_INFINITY;
        const db = b.dueAt ? Date.parse(b.dueAt) : Number.POSITIVE_INFINITY;
        return da - db || Date.parse(b.createdAt) - Date.parse(a.createdAt);
      });
    const historyList = commitments
      .filter((c) => c.status !== 'pending')
      .sort((a, b) => Date.parse(b.completedAt ?? b.createdAt) - Date.parse(a.completedAt ?? a.createdAt));
    const done = historyList.filter((c) => c.status === 'done').length;
    const missed = historyList.filter((c) => c.status === 'missed').length;
    return {
      pending: pendingList,
      history: historyList,
      overdue: pendingList.filter((c) => c.dueAt && Date.parse(c.dueAt) < now).length,
      keptPct: done + missed > 0 ? Math.round((done / (done + missed)) * 100) : null,
    };
  }, [commitments, now]);

  return (
    <HudPanel
      title="Promessas"
      code="PRM-02"
      icon={<Handshake size={14} />}
      bodyClassName="flex flex-col"
      actions={
        <IconButton
          size="sm"
          label={adding ? 'Fechar formulário' : 'Nova promessa'}
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
      {/* Resumo */}
      <div className="grid shrink-0 grid-cols-3 divide-x divide-line border-b border-line">
        <Summary label="Pendentes" value={formatNumber(pending.length)} />
        <Summary label="Atrasadas" value={formatNumber(overdue)} alert={overdue > 0} />
        <Summary label="Cumpridas" value={keptPct === null ? '—' : `${keptPct}%`} meter={keptPct} />
      </div>

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
              <CommitmentForm
                initial={{ description: '', due: '' }}
                submitLabel="Registrar"
                onCancel={() => setAdding(false)}
                onSubmit={async (v) => {
                  const saved = await useData.getState().createCommitment(v);
                  if (saved) {
                    setAdding(false);
                    playSfx('send');
                    useData.getState().pushToast({ kind: 'checkin', title: 'Promessa registrada', body: 'Vou cobrar com carinho — e com insistência.' });
                  }
                  return Boolean(saved);
                }}
              />
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        {status === 'loading' && !commitments.length ? (
          <PanelSkeleton rows={3} />
        ) : status === 'error' && !commitments.length ? (
          <PanelError message="Não consegui carregar suas promessas." onRetry={() => void useData.getState().loadCommitments()} />
        ) : (
          <>
            {pending.length === 0 ? (
              <PanelEmpty icon={<Handshake size={20} />} title="Nenhuma promessa pendente" quote="Palavra dada, palavra cumprida." />
            ) : (
              <ul aria-label="Promessas pendentes">
                <AnimatePresence initial={false}>
                  {pending.map((c) => (
                    <PendingItem key={c.id} c={c} now={now} />
                  ))}
                </AnimatePresence>
              </ul>
            )}

            {history.length > 0 && (
              <section aria-label="Histórico de promessas">
                <SectionLabel
                  count={history.length}
                  action={
                    <button
                      type="button"
                      aria-expanded={historyOpen}
                      onClick={() => setHistoryOpen((v) => !v)}
                      className="grid h-6 w-6 place-items-center text-muted hover:text-ink focus-visible:outline focus-visible:outline-1 focus-visible:outline-red"
                      aria-label={historyOpen ? 'Recolher histórico' : 'Expandir histórico'}
                    >
                      <ChevronDown size={14} className={cn('transition-transform', historyOpen && 'rotate-180')} />
                    </button>
                  }
                >
                  <button type="button" onClick={() => setHistoryOpen((v) => !v)} className="uppercase hover:text-ink focus-visible:outline-none">
                    Histórico
                  </button>
                </SectionLabel>
                <AnimatePresence initial={false}>
                  {historyOpen && (
                    <motion.ul
                      key="history"
                      initial={{ height: 0, opacity: 0 }}
                      animate={{ height: 'auto', opacity: 1 }}
                      exit={{ height: 0, opacity: 0 }}
                      transition={{ duration: 0.25, ease: EASE_OUT_EXPO }}
                      className="overflow-hidden"
                    >
                      {history.slice(0, 60).map((c) => (
                        <HistoryItem key={c.id} c={c} now={now} />
                      ))}
                    </motion.ul>
                  )}
                </AnimatePresence>
              </section>
            )}
          </>
        )}
      </div>
    </HudPanel>
  );
}

function Summary({ label, value, alert, meter }: { label: string; value: string; alert?: boolean; meter?: number | null }) {
  return (
    <div className="relative min-w-0 px-3 py-2.5">
      <span className="block truncate font-hud text-[10px] font-semibold uppercase tracking-[0.22em] text-muted">{label}</span>
      <span className={cn('tabular mt-0.5 block font-display text-lg font-semibold', alert ? 'text-red-bright text-glow-soft motion-safe:animate-pulse-red' : 'text-ink')}>{value}</span>
      {meter !== undefined && meter !== null && (
        <span aria-hidden className="absolute inset-x-3 bottom-1.5 h-[2px] bg-white/[0.06]">
          <span className="block h-full origin-left bg-red transition-transform duration-700" style={{ transform: `scaleX(${meter / 100})` }} />
        </span>
      )}
    </div>
  );
}
