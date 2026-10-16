import { memo, useMemo, useState, type FormEvent, type KeyboardEvent } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { AlarmClock, BellOff, BellRing, Clock, LoaderCircle, Plus, Repeat, X } from 'lucide-react';
import type { Recurrence, Reminder } from '@shared/types';
import { Badge, HudButton, HudPanel, IconButton } from '@/components/ui';
import { cn } from '@/lib/cn';
import { formatCountdown, formatDateTime, formatWhen, fromLocalInputValue, relativeTime, toLocalInputValue } from '@/lib/format';
import { playSfx } from '@/lib/sfx';
import { snoozeDate, useData, type SnoozeTarget } from '@/store/data';
import { RECURRENCES, RECURRENCE_LABEL } from './labels';
import { ConfirmDelete, EASE_OUT_EXPO, FieldLabel, PanelEmpty, PanelError, PanelSkeleton, SectionLabel, Select, TextInput, useFieldId, useNow } from './parts';

const DAY = 86_400_000;

// ─── Contagem regressiva ao vivo ────────────────────────────────────────

/** Contagem regressiva que se atualiza a cada segundo (só ela re-renderiza, não a lista). */
function Countdown({ dueAt, className, live = true }: { dueAt: string; className?: string; live?: boolean }) {
  const now = useNow(live ? 1000 : 30_000);
  const ms = Date.parse(dueAt) - now;
  const label = ms <= 0 ? 'agora' : ms < DAY ? formatCountdown(ms) : relativeTime(dueAt, now);
  return (
    <span className={cn('tabular', className)} aria-label={ms <= 0 ? 'vencendo agora' : `faltam ${label}`}>
      {label}
    </span>
  );
}

// ─── Adiar ──────────────────────────────────────────────────────────────

const SNOOZES: { target: SnoozeTarget; label: string }[] = [
  { target: '10m', label: '+10 min' },
  { target: '1h', label: '+1 h' },
  { target: 'tomorrow', label: 'Amanhã' },
];

function SnoozeGroup({ reminder, onDone }: { reminder: Reminder; onDone?: () => void }) {
  return (
    <div className="flex flex-wrap items-center gap-1" role="group" aria-label="Adiar lembrete">
      {SNOOZES.map((s) => (
        <button
          key={s.target}
          type="button"
          title={formatWhen(snoozeDate(reminder, s.target))}
          onClick={() => {
            playSfx('click');
            void useData
              .getState()
              .snoozeReminder(reminder.id, s.target)
              .then((r) => {
                if (r) useData.getState().pushToast({ kind: 'reminder', title: 'Lembrete adiado', body: `Novo horário: ${formatWhen(r.dueAt)}.`, duration: 3000 });
              });
            onDone?.();
          }}
          className="h-7 border border-line-neutral px-2 font-hud text-[11px] font-semibold uppercase tracking-[0.12em] text-muted transition-colors hover:border-red/60 hover:bg-red/10 hover:text-ink focus-visible:outline focus-visible:outline-1 focus-visible:outline-red"
        >
          {s.label}
        </button>
      ))}
    </div>
  );
}

// ─── Itens ───────────────────────────────────────────────────────────────

const ReminderItem = memo(function ReminderItem({ r, now }: { r: Reminder; now: number }) {
  const [snoozing, setSnoozing] = useState(false);
  const pending = r.id.startsWith('tmp-');
  const fired = r.status === 'fired';
  const soon = Date.parse(r.dueAt) - now < DAY;

  return (
    <motion.li
      layout="position"
      initial={{ opacity: 0, y: -6 }}
      animate={{ opacity: pending ? 0.55 : 1, y: 0 }}
      exit={{ opacity: 0, x: 24, transition: { duration: 0.2 } }}
      transition={{ duration: 0.3, ease: EASE_OUT_EXPO }}
      className={cn(
        'group relative border-b border-line-neutral px-3 py-2.5 transition-colors hover:bg-white/[0.02] focus-within:bg-white/[0.025]',
        fired && 'bg-red/[0.06]',
      )}
    >
      {fired && <span aria-hidden className="absolute inset-y-0 left-0 w-[2px] bg-red-bright shadow-glow-sm motion-safe:animate-pulse-red" />}
      <div className="flex items-start gap-3">
        <span className={cn('mt-0.5 shrink-0', fired ? 'text-red-bright motion-safe:animate-pulse-red' : 'text-red/70')} aria-hidden>
          {fired ? <BellRing size={14} /> : <AlarmClock size={14} />}
        </span>
        <div className="min-w-0 flex-1">
          <p className="break-words text-[13px] leading-snug text-ink">{r.text}</p>
          <div className="mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-1">
            {fired ? (
              <span className="font-hud text-[11.5px] font-semibold tracking-[0.06em] text-red-bright">disparado {relativeTime(r.firedAt ?? r.dueAt, now)}</span>
            ) : (
              <>
                <Countdown dueAt={r.dueAt} live={soon} className={cn('font-mono text-[11.5px]', soon ? 'text-red-soft' : 'text-muted')} />
                <span className="font-hud text-[11.5px] font-medium tracking-[0.04em] text-muted" title={formatDateTime(r.dueAt)}>
                  {formatWhen(r.dueAt, now)}
                </span>
              </>
            )}
            {r.recurrence !== 'none' && (
              <Badge tone="red">
                <Repeat size={9} aria-hidden />
                {RECURRENCE_LABEL[r.recurrence]}
              </Badge>
            )}
          </div>
        </div>
        {!pending && (
          <div className="-mr-1 flex shrink-0 items-center gap-1 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100">
            <IconButton size="sm" label="Adiar" active={snoozing} onClick={() => setSnoozing((v) => !v)}>
              <Clock size={12} />
            </IconButton>
            <IconButton
              size="sm"
              label="Dispensar"
              onClick={() => {
                playSfx('click');
                void useData.getState().dismissReminder(r.id);
              }}
            >
              <BellOff size={12} />
            </IconButton>
            <ConfirmDelete label="Apagar lembrete" onConfirm={() => void useData.getState().deleteReminder(r.id)} />
          </div>
        )}
      </div>
      <AnimatePresence initial={false}>
        {(snoozing || (fired && !pending)) && (
          <motion.div
            key="snooze"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="overflow-hidden pl-[26px]"
          >
            <div className="flex flex-wrap items-center gap-2 pt-2">
              <span className="font-hud text-[10px] font-semibold uppercase tracking-[0.22em] text-dim">Adiar</span>
              <SnoozeGroup reminder={r} onDone={() => setSnoozing(false)} />
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.li>
  );
});

// ─── Formulário ─────────────────────────────────────────────────────────

function defaultDue(): string {
  const d = new Date(Date.now() + 60 * 60_000);
  d.setMinutes(Math.ceil(d.getMinutes() / 5) * 5, 0, 0);
  return toLocalInputValue(d);
}

function ReminderForm({ onClose }: { onClose: () => void }) {
  const [text, setText] = useState('');
  const [due, setDue] = useState(defaultDue);
  const [recurrence, setRecurrence] = useState<Recurrence>('none');
  const [busy, setBusy] = useState(false);
  const textId = useFieldId('rmd-text');
  const dueId = useFieldId('rmd-due');
  const recId = useFieldId('rmd-rec');
  const dueIso = fromLocalInputValue(due);
  const inPast = dueIso ? Date.parse(dueIso) < Date.now() - 30_000 : false;
  const valid = text.trim().length > 1 && !!dueIso && !inPast;

  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    if (!valid || busy || !dueIso) return;
    setBusy(true);
    const saved = await useData.getState().createReminder({ text: text.trim(), dueAt: dueIso, recurrence });
    setBusy(false);
    if (saved) {
      playSfx('send');
      useData.getState().pushToast({ kind: 'reminder', title: 'Lembrete agendado', body: `${formatWhen(saved.dueAt)} — pode deixar comigo.` });
      onClose();
    }
  };

  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      onClose();
    }
  };

  const quick = (minutes: number | 'tomorrow') => {
    const d = new Date();
    if (minutes === 'tomorrow') {
      d.setDate(d.getDate() + 1);
      d.setHours(9, 0, 0, 0);
    } else d.setTime(d.getTime() + minutes * 60_000);
    setDue(toLocalInputValue(d));
  };

  return (
    <form onSubmit={submit} onKeyDown={onKey} className="space-y-3">
      <div>
        <FieldLabel htmlFor={textId}>Lembrar de</FieldLabel>
        <TextInput id={textId} autoFocus maxLength={300} value={text} onChange={(e) => setText(e.target.value)} placeholder="Ex.: Ligar para a minha mãe." />
      </div>
      <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,0.8fr)]">
        <div>
          <FieldLabel htmlFor={dueId}>Quando</FieldLabel>
          <TextInput id={dueId} type="datetime-local" required value={due} onChange={(e) => setDue(e.target.value)} className="[color-scheme:dark]" aria-invalid={inPast} />
        </div>
        <div>
          <FieldLabel htmlFor={recId}>Repetir</FieldLabel>
          <Select id={recId} value={recurrence} onChange={(e) => setRecurrence(e.target.value as Recurrence)}>
            {RECURRENCES.map((r) => (
              <option key={r} value={r}>
                {RECURRENCE_LABEL[r]}
              </option>
            ))}
          </Select>
        </div>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {(
          [
            [15, '+15 min'],
            [60, '+1 h'],
            [180, '+3 h'],
            ['tomorrow', 'Amanhã 9h'],
          ] as const
        ).map(([v, label]) => (
          <button
            key={label}
            type="button"
            onClick={() => quick(v)}
            className="h-6 border border-line-neutral px-2 font-hud text-[10.5px] font-semibold uppercase tracking-[0.14em] text-muted hover:border-line-strong hover:text-ink focus-visible:outline focus-visible:outline-1 focus-visible:outline-red"
          >
            {label}
          </button>
        ))}
      </div>
      {inPast && <p className="text-[12px] text-red-soft">Esse horário já passou. O futuro é o único lugar onde um lembrete faz sentido.</p>}
      <div className="flex justify-end gap-2">
        <HudButton type="button" size="sm" variant="ghost" onClick={onClose}>
          Cancelar
        </HudButton>
        <HudButton type="submit" size="sm" variant="primary" disabled={!valid || busy} icon={busy ? <LoaderCircle size={13} className="animate-spin" /> : undefined}>
          Agendar
        </HudButton>
      </div>
    </form>
  );
}

// ─── Painel ──────────────────────────────────────────────────────────────

export function RemindersPanel() {
  const reminders = useData((s) => s.reminders);
  const status = useData((s) => s.remindersStatus);
  const now = useNow(30_000);
  const [adding, setAdding] = useState(false);

  const { upcoming, fired } = useMemo(() => {
    const up = reminders.filter((r) => r.status === 'scheduled').sort((a, b) => Date.parse(a.dueAt) - Date.parse(b.dueAt));
    const fr = reminders
      .filter((r) => r.status === 'fired' && now - Date.parse(r.firedAt ?? r.dueAt) < DAY)
      .sort((a, b) => Date.parse(b.firedAt ?? b.dueAt) - Date.parse(a.firedAt ?? a.dueAt));
    return { upcoming: up, fired: fr };
  }, [reminders, now]);

  const next = upcoming[0];

  return (
    <HudPanel
      title="Lembretes"
      code="RMD-03"
      icon={<BellRing size={14} />}
      bodyClassName="flex flex-col"
      actions={
        <IconButton
          size="sm"
          label={adding ? 'Fechar formulário' : 'Novo lembrete'}
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
      {/* Próximo lembrete em destaque */}
      {next && !adding && (
        <div className="relative shrink-0 overflow-hidden border-b border-line px-3 py-3">
          <span aria-hidden className="pointer-events-none absolute inset-0 bg-gradient-to-r from-red/[0.08] via-transparent to-transparent" />
          <div className="relative flex items-end justify-between gap-3">
            <div className="min-w-0">
              <span className="font-hud text-[10px] font-semibold uppercase tracking-[0.28em] text-muted">Próximo</span>
              <p className="mt-0.5 truncate text-[13px] text-ink" title={next.text}>
                {next.text}
              </p>
              <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-dim">{formatWhen(next.dueAt, now)}</p>
            </div>
            <Countdown dueAt={next.dueAt} live={Date.parse(next.dueAt) - now < DAY} className="shrink-0 font-display text-xl font-semibold text-red-bright text-glow-soft sm:text-2xl" />
          </div>
        </div>
      )}

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
              <ReminderForm onClose={() => setAdding(false)} />
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        {status === 'loading' && !reminders.length ? (
          <PanelSkeleton rows={3} />
        ) : status === 'error' && !reminders.length ? (
          <PanelError message="Não consegui carregar seus lembretes." onRetry={() => void useData.getState().loadReminders()} />
        ) : !upcoming.length && !fired.length ? (
          <PanelEmpty
            icon={<AlarmClock size={20} />}
            title="Nenhum lembrete agendado"
            quote="O tempo é o único recurso que não se recupera. Diga-me o que não pode ser esquecido."
          />
        ) : (
          <>
            {fired.length > 0 && (
              <section aria-label="Lembretes disparados">
                <SectionLabel count={fired.length}>Disparados</SectionLabel>
                <ul>
                  <AnimatePresence initial={false}>
                    {fired.map((r) => (
                      <ReminderItem key={r.id} r={r} now={now} />
                    ))}
                  </AnimatePresence>
                </ul>
              </section>
            )}
            {upcoming.length > 0 && (
              <section aria-label="Próximos lembretes">
                {fired.length > 0 && <SectionLabel count={upcoming.length}>Agendados</SectionLabel>}
                <ul>
                  <AnimatePresence initial={false}>
                    {upcoming.map((r) => (
                      <ReminderItem key={r.id} r={r} now={now} />
                    ))}
                  </AnimatePresence>
                </ul>
              </section>
            )}
          </>
        )}
      </div>
    </HudPanel>
  );
}
