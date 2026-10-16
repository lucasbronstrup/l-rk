import { memo } from 'react';
import {
  AppWindow,
  Calculator,
  Check,
  Clipboard,
  Clock,
  Cpu,
  Database,
  FileText,
  Globe,
  LoaderCircle,
  LockKeyhole,
  ScanEye,
  Search,
  ShieldAlert,
  SquareTerminal,
  Wrench,
  X,
  type LucideIcon,
} from 'lucide-react';
import type { ToolCallInfo } from '@shared/types';
import { cn } from '@/lib/cn';

/** Ícone por família de ferramenta (pelo nome técnico). A ordem importa: do mais específico ao geral. */
export function toolIcon(name: string): LucideIcon {
  const n = name.toLowerCase();
  if (/screen|screenshot|tela|capture/.test(n)) return ScanEye;
  if (/memor|remember|recall|forget|commitment|reminder|lembr/.test(n)) return Database;
  if (/web|fetch|http|url|browse|news|weather|clima/.test(n)) return Globe;
  if (/shell|command|terminal|exec|powershell|bash|cmd|run_/.test(n)) return SquareTerminal;
  if (/file|dir|folder|path|read|write|move|copy|rename|trash|delete|glob|zip|document|pdf|docx/.test(n)) return FileText;
  if (/clipboard/.test(n)) return Clipboard;
  if (/calc|math/.test(n)) return Calculator;
  if (/time|date|clock|timer/.test(n)) return Clock;
  if (/app|open|launch|window/.test(n)) return AppWindow;
  if (/system|vital|process|cpu|battery|volume|network|disk|kill/.test(n)) return Cpu;
  if (/search|find/.test(n)) return Search;
  return Wrench;
}

/** Primeiro argumento textual relevante (caminho, consulta, comando...) para contexto. */
function primaryArg(args: Record<string, unknown>): string | null {
  const preferred = ['path', 'query', 'command', 'url', 'pattern', 'name', 'text', 'content', 'app', 'target'];
  for (const k of preferred) {
    const v = args?.[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  for (const v of Object.values(args ?? {})) {
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return null;
}

const STATUS_TEXT: Record<ToolCallInfo['status'], string> = {
  running: 'Executando',
  awaiting_approval: 'Aguardando aprovação',
  done: 'Concluído',
  error: 'Falhou',
  denied: 'Negado',
};

function StatusIcon({ status }: { status: ToolCallInfo['status'] }) {
  switch (status) {
    case 'running':
      return <LoaderCircle size={13} className="animate-spin text-red-bright" aria-hidden />;
    case 'awaiting_approval':
      return <LockKeyhole size={13} className="text-warn" aria-hidden />;
    case 'done':
      return <Check size={13} className="text-ok" aria-hidden />;
    case 'error':
      return <X size={13} className="text-red-bright" aria-hidden />;
    case 'denied':
      return <ShieldAlert size={13} className="text-muted" aria-hidden />;
  }
}

interface ToolCallChipProps {
  call: ToolCallInfo;
  /** Versão enxuta (modo de voz): sem resumo nem argumento. */
  compact?: boolean;
  className?: string;
}

/** Chip de ferramenta: ícone por tipo, rótulo, estado e resumo do resultado. */
export const ToolCallChip = memo(function ToolCallChip({ call, compact, className }: ToolCallChipProps) {
  const Icon = toolIcon(call.name);
  const detail = call.summary?.trim() || primaryArg(call.args);
  const awaiting = call.status === 'awaiting_approval';
  const failed = call.status === 'error';
  const statusText = STATUS_TEXT[call.status];

  return (
    <div
      role="status"
      aria-label={`${call.label}: ${statusText}${detail ? ` — ${detail}` : ''}`}
      title={detail ?? call.label}
      className={cn(
        'relative flex min-w-0 max-w-full items-center gap-2 border bg-white/[0.02] transition-colors',
        compact ? 'px-2 py-1' : 'px-2 py-1.5',
        awaiting
          ? 'border-warn/45 bg-warn/[0.06]'
          : failed
            ? 'border-red/45 bg-red/[0.05]'
            : call.risk === 'dangerous'
              ? 'border-red-deep/70'
              : 'border-line-neutral',
        className,
      )}
    >
      <span
        aria-hidden
        className={cn(
          'flex shrink-0 items-center justify-center border',
          compact ? 'h-5 w-5' : 'h-6 w-6',
          call.status === 'running' ? 'border-red/50 text-red-bright shadow-glow-sm' : 'border-line text-red/80',
        )}
      >
        <Icon size={compact ? 11 : 13} />
      </span>
      <span className="flex min-w-0 flex-1 flex-col leading-tight">
        <span className="flex items-center gap-2">
          <span className="truncate font-hud text-[11px] font-semibold uppercase tracking-[0.16em] text-ink">{call.label}</span>
          {awaiting && (
            <span className="shrink-0 font-mono text-[9px] tracking-[0.2em] text-warn lark-blink">AGUARDANDO APROVAÇÃO</span>
          )}
        </span>
        {!compact && detail && <span className="truncate font-mono text-[10.5px] text-muted">{detail}</span>}
      </span>
      <span className="ml-1 flex shrink-0 items-center gap-1.5">
        <StatusIcon status={call.status} />
        <span className="sr-only">{statusText}</span>
      </span>
    </div>
  );
});
