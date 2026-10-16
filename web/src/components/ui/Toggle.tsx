import { cn } from '@/lib/cn';

interface ToggleProps {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  description?: string;
  disabled?: boolean;
}

export function Toggle({ checked, onChange, label, description, disabled }: ToggleProps) {
  return (
    <label className={cn('flex cursor-pointer items-start justify-between gap-4 py-2', disabled && 'opacity-50')}>
      <span className="min-w-0">
        <span className="block font-hud text-sm font-semibold tracking-wide text-ink">{label}</span>
        {description && <span className="mt-0.5 block text-xs text-muted">{description}</span>}
      </span>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={cn(
          'relative mt-0.5 h-5 w-10 shrink-0 border transition-colors',
          checked ? 'border-red bg-red/25 shadow-glow-sm' : 'border-line-neutral bg-white/5',
        )}
      >
        <span
          className={cn(
            'absolute top-0.5 h-3.5 w-3.5 transition-all',
            checked ? 'left-[22px] bg-red-bright' : 'left-0.5 bg-dim',
          )}
        />
      </button>
    </label>
  );
}
