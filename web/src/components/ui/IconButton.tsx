import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { cn } from '@/lib/cn';

interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  label: string;
  active?: boolean;
  size?: 'sm' | 'md' | 'lg';
  children: ReactNode;
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, active, size = 'md', className, children, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      aria-label={label}
      title={label}
      className={cn(
        'inline-flex shrink-0 items-center justify-center border transition-all duration-150 disabled:opacity-40 focus-visible:outline focus-visible:outline-1 focus-visible:outline-red',
        size === 'sm' && 'h-7 w-7',
        size === 'md' && 'h-9 w-9',
        size === 'lg' && 'h-12 w-12',
        active
          ? 'border-red bg-red/15 text-red-bright shadow-glow-sm'
          : 'border-line-neutral text-muted hover:border-line-strong hover:text-ink',
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  );
});
