import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { ModuleBoundary } from './ModuleBoundary';

interface PanelSlotProps {
  /** Nome do módulo (aparece no aviso caso o painel falhe). */
  name: string;
  className?: string;
  children: ReactNode;
}

/**
 * Contêiner de painel: estica o filho para toda a altura disponível (rolagem interna fica
 * a cargo do painel) e isola falhas de renderização com um ModuleBoundary.
 */
export function PanelSlot({ name, className, children }: PanelSlotProps) {
  return (
    <div className={cn('lark-slot flex min-h-0 min-w-0 flex-col', className)}>
      <ModuleBoundary name={name}>{children}</ModuleBoundary>
    </div>
  );
}
