import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { cn } from '@/lib/cn';

type Variant = 'primary' | 'ghost' | 'danger' | 'outline';

interface HudButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: 'sm' | 'md';
  icon?: ReactNode;
}

const variants: Record<Variant, string> = {
  primary:
    'bg-red/90 text-white hover:bg-red shadow-glow-sm hover:shadow-glow border border-red-bright/60',
  outline: 'border border-line-strong text-ink hover:border-red hover:text-white hover:bg-red/10',
  ghost: 'text-muted hover:text-ink hover:bg-white/5 border border-transparent',
  danger: 'border border-red-deep bg-red-dark/40 text-red-soft hover:bg-red-deep/60 hover:text-white',
};

export const HudButton = forwardRef<HTMLButtonElement, HudButtonProps>(function HudButton(
  { variant = 'outline', size = 'md', icon, className, children, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      className={cn(
        'inline-flex select-none items-center justify-center gap-2 font-hud font-semibold uppercase tracking-[0.16em] transition-all duration-150 disabled:pointer-events-none disabled:opacity-40 focus-visible:outline focus-visible:outline-1 focus-visible:outline-red',
        size === 'sm' ? 'h-8 px-3 text-[11px]' : 'h-10 px-4 text-xs',
        variants[variant],
        className,
      )}
      {...rest}
    >
      {icon}
      {children}
    </button>
  );
});
