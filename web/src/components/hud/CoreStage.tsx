import { cn } from '@/lib/cn';
import { ReactorOrb } from './ReactorOrb';
import { Telemetry } from './Telemetry';

interface CoreStageProps {
  /** Diâmetro do orbe em px. */
  size: number;
  /** Colunas de telemetria nas laterais (aparecem só quando há largura suficiente). */
  telemetry?: boolean;
  className?: string;
}

/**
 * Palco central do desktop/tablet: o orbe com seu rótulo de estado e, havendo espaço,
 * colunas de telemetria nas laterais (container query — sem JavaScript de medição).
 */
export function CoreStage({ size, telemetry = true, className }: CoreStageProps) {
  return (
    <div className={cn('@container relative flex shrink-0 items-center justify-center', className)}>
      <div className="flex items-center justify-center gap-6">
        {telemetry && <Telemetry side="left" className="hidden @min-[40rem]:flex" />}
        <ReactorOrb size={size} variant="full" label="below" />
        {telemetry && <Telemetry side="right" className="hidden @min-[40rem]:flex" />}
      </div>
    </div>
  );
}

/** Versão do celular: orbe compacto com o rótulo ao lado. */
export function MobileCore({ small }: { small: boolean }) {
  return (
    <div className="flex shrink-0 items-center justify-center py-2">
      <ReactorOrb size={small ? 56 : 92} variant="compact" label="side" />
    </div>
  );
}
