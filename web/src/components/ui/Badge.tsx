import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

type Tone = 'red' | 'neutral' | 'ok' | 'warn' | 'dim';

const tones: Record<Tone, string> = {
  red: 'border-red/50 text-red-bright bg-red/10',
  neutral: 'border-line-neutral text-muted bg-white/[0.03]',
  ok: 'border-ok/40 text-ok bg-ok/10',
  warn: 'border-warn/40 text-warn bg-warn/10',
  dim: 'border-line-neutral text-dim',
};

export function Badge({ tone = 'neutral', className, children }: { tone?: Tone; className?: string; children: ReactNode }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 border px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider',
        tones[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}
