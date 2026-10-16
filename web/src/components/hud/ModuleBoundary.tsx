import { Component, type ErrorInfo, type ReactNode } from 'react';
import { RotateCcw, TriangleAlert } from 'lucide-react';
import { HudButton } from '@/components/ui';

interface ModuleBoundaryProps {
  /** Nome legível do módulo, exibido no aviso de falha (ex.: "Memória"). */
  name: string;
  /** 'panel' mostra um painel de falha com botão de reinício; 'silent' apenas oculta o módulo. */
  fallback?: 'panel' | 'silent';
  children: ReactNode;
}

interface ModuleBoundaryState {
  error: Error | null;
}

/**
 * Isola falhas de renderização: se um painel quebrar, só ele mostra o aviso —
 * o resto da HUD continua funcionando.
 */
export class ModuleBoundary extends Component<ModuleBoundaryProps, ModuleBoundaryState> {
  override state: ModuleBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ModuleBoundaryState {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(`[Lärk] Falha no módulo "${this.props.name}":`, error, info.componentStack);
  }

  private reset = () => this.setState({ error: null });

  override render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    if (this.props.fallback === 'silent') return null;

    return (
      <section
        role="alert"
        className="relative flex min-h-0 flex-col items-center justify-center gap-3 border border-line bg-surface/70 p-6 text-center"
      >
        <TriangleAlert size={22} className="text-red-bright" aria-hidden />
        <div>
          <p className="font-hud text-sm font-semibold uppercase tracking-[0.22em] text-ink">Falha no módulo {this.props.name}</p>
          <p className="mt-1 max-w-xs font-mono text-[11px] text-muted">{error.message || 'Erro inesperado de renderização.'}</p>
        </div>
        <HudButton size="sm" variant="outline" icon={<RotateCcw size={13} />} onClick={this.reset}>
          Reiniciar módulo
        </HudButton>
      </section>
    );
  }
}
