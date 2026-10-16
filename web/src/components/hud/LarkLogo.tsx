import { cn } from '@/lib/cn';

type LogoSize = 'sm' | 'md' | 'lg' | 'xl';

const SIZES: Record<LogoSize, string> = {
  sm: 'text-[17px]',
  md: 'text-2xl',
  lg: 'text-4xl sm:text-5xl',
  xl: 'text-5xl sm:text-6xl',
};

interface LarkLogoProps {
  size?: LogoSize;
  className?: string;
  /** Brilho no trema (padrão: sim). */
  glow?: boolean;
}

/**
 * Logotipo "LÄRK" em Orbitron. O trema é desenhado à parte, em vermelho com brilho,
 * para ser o ponto focal da marca. O espaçamento usa margem (não letter-spacing)
 * para que o trema fique centrado exatamente sobre o "A".
 */
export function LarkLogo({ size = 'sm', className, glow = true }: LarkLogoProps) {
  const dot = cn(
    'block h-[0.14em] w-[0.14em] bg-red-bright',
    glow && 'shadow-[0_0_6px_rgb(255_30_60/0.95),0_0_14px_rgb(255_30_60/0.55)]',
  );
  return (
    <span
      role="img"
      aria-label="Lärk"
      className={cn('inline-flex select-none items-baseline font-display font-extrabold leading-none text-ink', SIZES[size], className)}
    >
      <span aria-hidden className="mr-[0.26em] inline-block">
        L
      </span>
      <span aria-hidden className="relative mr-[0.26em] inline-block">
        A
        {/* Métricas do Orbitron: topo da maiúscula a ~0,16em do topo da caixa (line-height 1). */}
        <span className="absolute left-1/2 top-[-0.075em] flex -translate-x-1/2 gap-[0.16em]">
          <i className={dot} />
          <i className={dot} />
        </span>
      </span>
      <span aria-hidden className="mr-[0.26em] inline-block">
        R
      </span>
      <span aria-hidden className="inline-block">
        K
      </span>
    </span>
  );
}
