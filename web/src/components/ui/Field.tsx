import { forwardRef, type InputHTMLAttributes } from 'react';
import { cn } from '@/lib/cn';

interface FieldProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  hint?: string;
}

export const Field = forwardRef<HTMLInputElement, FieldProps>(function Field({ label, hint, className, id, ...rest }, ref) {
  const inputId = id ?? (label ? `f-${label.replace(/\s+/g, '-').toLowerCase()}` : undefined);
  return (
    <div className="space-y-1">
      {label && (
        <label htmlFor={inputId} className="block font-hud text-[11px] font-semibold uppercase tracking-[0.2em] text-muted">
          {label}
        </label>
      )}
      <input
        ref={ref}
        id={inputId}
        className={cn(
          'h-10 w-full border border-line-neutral bg-black/40 px-3 font-sans text-sm text-ink placeholder:text-dim focus:border-red focus:outline-none focus:shadow-glow-sm',
          className,
        )}
        {...rest}
      />
      {hint && <p className="text-[11px] text-dim">{hint}</p>}
    </div>
  );
});
