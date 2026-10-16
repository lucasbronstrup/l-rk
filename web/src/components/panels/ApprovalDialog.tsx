import { useCallback, useEffect, useRef, useState } from 'react';
import { motion } from 'motion/react';
import { ShieldAlert, ShieldCheck, ShieldX, TerminalSquare } from 'lucide-react';
import type { ApprovalRequest } from '@shared/types';
import { Badge, HudButton, HudPanel } from '@/components/ui';
import { cn } from '@/lib/cn';
import { playSfx } from '@/lib/sfx';
import { useData } from '@/store/data';
import { useUi } from '@/store/ui';
import { Dialog, EASE_OUT_EXPO, isTopLayer, useNow } from './parts';

/** Tempo após o diálogo surgir em que o Enter é ignorado (evita autorizar com um Enter que era do chat). */
const ARM_DELAY_MS = 700;

const COMMAND_KEYS = ['command', 'cmd', 'script', 'shell'];

const KEY_LABEL: Record<string, string> = {
  path: 'Caminho',
  paths: 'Caminhos',
  from: 'Origem',
  to: 'Destino',
  source: 'Origem',
  destination: 'Destino',
  target: 'Alvo',
  cwd: 'Pasta',
  url: 'Endereço',
  app: 'Aplicativo',
  name: 'Nome',
  content: 'Conteúdo',
  text: 'Texto',
  query: 'Consulta',
  pattern: 'Padrão',
  recursive: 'Recursivo',
  overwrite: 'Sobrescrever',
};

function stringify(v: unknown): string {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return v === true ? 'sim' : v === false ? 'não' : String(v);
  if (v === null || v === undefined) return '—';
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

function ArgsBlock({ args }: { args: Record<string, unknown> }) {
  const entries = Object.entries(args ?? {}).filter(([, v]) => v !== undefined && v !== null && v !== '');
  const command = entries.find(([k, v]) => COMMAND_KEYS.includes(k) && typeof v === 'string');
  const rest = entries.filter((e) => e !== command);
  if (!entries.length) return null;

  return (
    <div className="space-y-2">
      {command && (
        <div className="border border-red/40 bg-black/70 shadow-[inset_0_0_24px_rgb(255_30_60/0.08)]">
          <div className="flex items-center gap-2 border-b border-red/20 px-3 py-1.5">
            <TerminalSquare size={12} className="text-red" aria-hidden />
            <span className="font-mono text-[9.5px] uppercase tracking-[0.24em] text-dim">Terminal</span>
            {typeof args.cwd === 'string' && <span className="ml-auto truncate font-mono text-[10px] text-dim">{args.cwd}</span>}
          </div>
          <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all px-3 py-2.5 font-mono text-[12.5px] leading-relaxed text-ink">
            <span className="select-none text-red-bright">$ </span>
            {command[1] as string}
          </pre>
        </div>
      )}
      {rest.filter(([k]) => !(command && k === 'cwd')).length > 0 && (
        <dl className="divide-y divide-line-neutral border border-line-neutral bg-black/40">
          {rest
            .filter(([k]) => !(command && k === 'cwd'))
            .map(([k, v]) => {
              const text = stringify(v);
              const long = text.length > 90 || text.includes('\n');
              return (
                <div key={k} className={cn('px-3 py-1.5', long ? 'block' : 'flex items-baseline gap-3')}>
                  <dt className="shrink-0 font-mono text-[9.5px] uppercase tracking-[0.2em] text-dim">{KEY_LABEL[k] ?? k}</dt>
                  <dd className={cn('min-w-0 font-mono text-[12px] text-ink', long ? 'mt-1' : 'truncate')} title={long ? undefined : text}>
                    {long ? <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all text-[11.5px] leading-relaxed">{text.length > 4000 ? `${text.slice(0, 4000)}…` : text}</pre> : text}
                  </dd>
                </div>
              );
            })}
        </dl>
      )}
    </div>
  );
}

function Countdown({ request, onExpire }: { request: ApprovalRequest; onExpire: () => void }) {
  const now = useNow(1000);
  const end = Date.parse(request.expiresAt);
  const start = Date.parse(request.createdAt);
  const total = Math.max(1, end - start);
  const left = Math.max(0, end - now);
  const secs = Math.ceil(left / 1000);
  const expireRef = useRef(onExpire);
  expireRef.current = onExpire;

  useEffect(() => {
    if (Number.isFinite(end) && left <= 0) expireRef.current();
  }, [left, end]);

  if (!Number.isFinite(end)) return null;
  const critical = secs <= 10;
  return (
    <div>
      <div className="mb-1 flex items-center justify-between font-mono text-[10px] uppercase tracking-[0.2em]">
        <span className="text-dim">Expira em</span>
        <span className={cn('tabular', critical ? 'text-red-bright motion-safe:animate-pulse-red' : 'text-muted')}>
          {Math.floor(secs / 60)}:{String(secs % 60).padStart(2, '0')}
        </span>
      </div>
      <div className="h-[2px] w-full bg-white/[0.06]" role="progressbar" aria-label="Tempo restante" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round((left / total) * 100)}>
        <div className={cn('h-full origin-left transition-transform duration-1000 ease-linear', critical ? 'bg-red-bright shadow-glow-sm' : 'bg-red')} style={{ transform: `scaleX(${left / total})` }} />
      </div>
    </div>
  );
}

function ApprovalCard({ request, position, total, layerId }: { request: ApprovalRequest; position: number; total: number; layerId: number }) {
  const shownAt = useRef(Date.now());
  const rootRef = useRef<HTMLDivElement>(null);
  const [busy, setBusy] = useState(false);
  const dangerous = request.risk === 'dangerous';

  // Ao avançar na fila, o foco volta para a nova solicitação (o cartão anterior foi desmontado).
  useEffect(() => {
    const el = rootRef.current;
    if (el && !el.contains(document.activeElement)) el.focus({ preventScroll: true });
  }, []);

  const decide = useCallback(
    (approved: boolean) => {
      if (busy) return;
      setBusy(true);
      playSfx(approved ? 'send' : 'stop');
      void useData.getState().resolveApproval(request.id, approved);
    },
    [busy, request.id],
  );

  const expire = useCallback(() => {
    useData.getState().expireApproval(request.id);
    useData.getState().pushToast({ kind: 'warn', title: 'Autorização expirou', body: `${request.label}: sem resposta a tempo — a ação foi negada por segurança.` });
  }, [request.id, request.label]);

  // Enter autoriza (com trava inicial). Com o foco em um botão, Enter aciona o próprio botão.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Enter' || e.isComposing || e.shiftKey || e.altKey) return;
      if (!isTopLayer(layerId)) return;
      const armed = Date.now() - shownAt.current > ARM_DELAY_MS;
      const onButton = document.activeElement instanceof HTMLButtonElement && document.activeElement.closest('[data-approval]');
      if (!armed) {
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      if (onButton) return;
      e.preventDefault();
      e.stopPropagation();
      decide(true);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [decide, layerId]);

  return (
    <motion.div
      ref={rootRef}
      data-approval
      data-initial-focus
      tabIndex={-1}
      initial={{ opacity: 0, x: 16 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ duration: 0.3, ease: EASE_OUT_EXPO }}
      className="space-y-4 p-4 outline-none sm:p-5"
    >
      <div className="flex items-start gap-4">
        <div
          className={cn(
            'relative grid h-12 w-12 shrink-0 place-items-center border',
            dangerous ? 'border-red bg-red/15 text-red-bright shadow-glow' : 'border-warn/60 bg-warn/10 text-warn',
          )}
          aria-hidden
        >
          {dangerous && <span className="absolute inset-0 border border-red-bright motion-safe:animate-ping motion-safe:[animation-duration:2.2s]" />}
          <ShieldAlert size={22} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            {dangerous ? <Badge tone="red">Ação perigosa</Badge> : <Badge tone="warn">Requer confirmação</Badge>}
            <span className="truncate font-mono text-[10px] tracking-[0.12em] text-dim">{request.toolName}</span>
          </div>
          <h3 className="mt-1.5 font-hud text-lg font-semibold leading-tight tracking-wide text-ink">{request.label}</h3>
          {request.description && <p className="mt-1 break-words text-[13.5px] leading-relaxed text-muted">{request.description}</p>}
        </div>
      </div>

      <ArgsBlock args={request.args} />

      <Countdown request={request} onExpire={expire} />

      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:items-center sm:justify-end">
        <p className="mr-auto hidden text-[11.5px] italic text-dim sm:block">Na dúvida, negue — eu encontro outro caminho.</p>
        <HudButton variant="outline" onClick={() => decide(false)} disabled={busy} icon={<ShieldX size={14} />} className="sm:min-w-[132px]">
          Negar <kbd className="kbd ml-1 hidden text-[10px] sm:inline-flex">Esc</kbd>
        </HudButton>
        <HudButton variant="primary" onClick={() => decide(true)} disabled={busy} icon={<ShieldCheck size={14} />} className="sm:min-w-[150px]">
          Autorizar <kbd className="kbd ml-1 hidden border-white/30 text-[10px] text-white/80 sm:inline-flex">Enter</kbd>
        </HudButton>
      </div>
      {total > 1 && (
        <p className="text-center font-mono text-[10px] uppercase tracking-[0.24em] text-dim">
          Solicitação {position} de {total}
        </p>
      )}
    </motion.div>
  );
}

/**
 * Autorização de ações no computador: modal de alta prioridade (acima do modo de voz),
 * com fila quando houver várias solicitações. Enter autoriza, Esc nega.
 */
export function ApprovalDialog() {
  const approvals = useData((s) => s.approvals);
  const [layerId, setLayerId] = useState(0);
  const current = approvals[0];
  const queue = approvals.length;

  // O núcleo fica em alerta enquanto houver autorização pendente.
  useEffect(() => {
    const ui = useUi.getState();
    if (queue > 0) {
      if (ui.orbState !== 'alert') ui.setOrbState('alert');
    } else if (ui.orbState === 'alert') ui.setOrbState('idle');
  }, [queue]);

  const deny = useCallback(() => {
    const first = useData.getState().approvals[0];
    if (!first) return;
    playSfx('stop');
    void useData.getState().resolveApproval(first.id, false);
  }, []);

  return (
    <Dialog
      open={Boolean(current)}
      onClose={deny}
      label="Autorização necessária"
      role="alertdialog"
      zClass="z-[100]"
      closeOnBackdrop={false}
      initialFocus="[data-initial-focus]"
      onLayer={setLayerId}
      className="max-w-xl"
    >
      <HudPanel
        title="Autorização necessária"
        code="AUT-07"
        icon={<ShieldAlert size={14} />}
        className={cn('max-h-full w-full bg-abyss/[0.98]', current?.risk === 'dangerous' ? 'border-red/60 shadow-glow-lg' : 'shadow-glow')}
        bodyClassName="overflow-y-auto"
        actions={queue > 1 ? <Badge tone="red">{queue} na fila</Badge> : undefined}
      >
        {current && <ApprovalCard key={current.id} request={current} position={1} total={queue} layerId={layerId} />}
      </HudPanel>
    </Dialog>
  );
}
