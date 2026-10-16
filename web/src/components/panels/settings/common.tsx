import { useEffect, useRef, useState, type ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { FieldLabel, TextArea, TextInput, useFieldId } from '../parts';

/** Bloco de configurações: título em caixa alta com código técnico e linha fina. */
export function Section({ title, code, description, children, className }: { title: string; code?: string; description?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cn('py-4 first:pt-1', className)}>
      <header className="mb-3">
        <div className="flex items-center gap-2">
          <h3 className="font-hud text-[12px] font-bold uppercase tracking-[0.24em] text-ink">{title}</h3>
          {code && <span className="font-mono text-[9.5px] tracking-[0.2em] text-dim">{code}</span>}
          <span aria-hidden className="h-px flex-1 bg-gradient-to-r from-line to-transparent" />
        </div>
        {description && <p className="mt-1.5 max-w-prose text-[12.5px] leading-relaxed text-muted">{description}</p>}
      </header>
      <div className="space-y-3">{children}</div>
    </section>
  );
}

interface DebouncedTextProps {
  label: string;
  value: string;
  onSave: (v: string) => void;
  placeholder?: string;
  hint?: ReactNode;
  multiline?: boolean;
  rows?: number;
  maxLength?: number;
  delay?: number;
  type?: string;
}

/**
 * Campo de texto que salva sozinho: após uma pausa na digitação (debounce) ou ao sair do campo.
 * Mantém um rascunho local para não brigar com o valor do servidor enquanto o usuário digita.
 */
export function DebouncedText({ label, value, onSave, placeholder, hint, multiline, rows = 4, maxLength, delay = 800, type = 'text' }: DebouncedTextProps) {
  const [draft, setDraft] = useState(value);
  const focused = useRef(false);
  const timer = useRef<number | undefined>(undefined);
  const lastSaved = useRef(value);
  const saveRef = useRef(onSave);
  saveRef.current = onSave;
  const id = useFieldId('cfg');

  // Valor mudou no servidor (outra aba, evento 'settings') e o campo não está em edição.
  useEffect(() => {
    if (!focused.current) {
      setDraft(value);
      lastSaved.current = value;
    }
  }, [value]);

  const flush = (v: string) => {
    window.clearTimeout(timer.current);
    if (v === lastSaved.current) return;
    lastSaved.current = v;
    saveRef.current(v);
  };

  useEffect(() => () => window.clearTimeout(timer.current), []);

  const change = (v: string) => {
    setDraft(v);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => flush(v), delay);
  };

  const common = {
    id,
    value: draft,
    placeholder,
    maxLength,
    onFocus: () => {
      focused.current = true;
    },
    onBlur: () => {
      focused.current = false;
      flush(draft);
    },
  };

  return (
    <div>
      <FieldLabel htmlFor={id} hint={hint}>
        {label}
      </FieldLabel>
      {multiline ? (
        <TextArea {...common} rows={rows} onChange={(e) => change(e.target.value)} />
      ) : (
        <TextInput {...common} type={type} onChange={(e) => change(e.target.value)} />
      )}
    </div>
  );
}

/** Opção em cartão (rádio) — usada para modos de aprovação e vozes. */
export function OptionCard({
  selected,
  onSelect,
  title,
  description,
  icon,
  tone = 'red',
  trailing,
  name,
}: {
  selected: boolean;
  onSelect: () => void;
  title: ReactNode;
  description?: ReactNode;
  icon?: ReactNode;
  tone?: 'red' | 'warn';
  trailing?: ReactNode;
  name: string;
}) {
  return (
    <div
      className={cn(
        'group relative flex items-start gap-3 border px-3 py-2.5 transition-colors',
        selected
          ? tone === 'warn'
            ? 'border-warn/60 bg-warn/[0.06]'
            : 'border-red/70 bg-red/[0.07] shadow-[inset_0_0_24px_rgb(255_30_60/0.08)]'
          : 'border-line-neutral hover:border-line-strong hover:bg-white/[0.02]',
      )}
    >
      <label className="flex min-w-0 flex-1 cursor-pointer items-start gap-3">
        <input type="radio" name={name} checked={selected} onChange={onSelect} className="peer sr-only" />
        <span
          aria-hidden
          className={cn(
            'mt-1 grid h-3.5 w-3.5 shrink-0 place-items-center border peer-focus-visible:outline peer-focus-visible:outline-1 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-red',
            selected ? (tone === 'warn' ? 'border-warn' : 'border-red') : 'border-line-strong',
          )}
        >
          {selected && <span className={cn('h-1.5 w-1.5', tone === 'warn' ? 'bg-warn' : 'bg-red-bright')} />}
        </span>
        <span className="min-w-0">
          <span className="flex items-center gap-2 font-hud text-[13.5px] font-semibold tracking-wide text-ink">
            {icon && <span className={selected ? (tone === 'warn' ? 'text-warn' : 'text-red-bright') : 'text-muted'}>{icon}</span>}
            {title}
          </span>
          {description && <span className="mt-0.5 block text-[12px] leading-relaxed text-muted">{description}</span>}
        </span>
      </label>
      {trailing}
    </div>
  );
}
