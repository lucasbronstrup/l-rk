import { useEffect, useState } from 'react';
import { BellRing } from 'lucide-react';
import type { Settings } from '@shared/types';
import { Badge, HudButton, Toggle } from '@/components/ui';
import { useData } from '@/store/data';
import { usePrefs } from '@/store/prefs';
import { FieldLabel, useFieldId } from '../parts';
import { DebouncedText, Section } from './common';

type Permission = NotificationPermission | 'unsupported';

const readPermission = (): Permission => ('Notification' in window ? Notification.permission : 'unsupported');

function CheckInInterval({ value }: { value: number }) {
  const [draft, setDraft] = useState(value);
  const id = useFieldId('checkin');
  useEffect(() => setDraft(value), [value]);

  // Salva quando o usuário para de arrastar (debounce curto).
  useEffect(() => {
    if (draft === value) return;
    const t = window.setTimeout(() => void useData.getState().saveSettings({ proactive: { checkInEveryHours: draft } }, { toast: 'Intervalo de cobranças atualizado' }), 600);
    return () => window.clearTimeout(t);
  }, [draft, value]);

  const label = draft < 24 ? `a cada ${draft} h` : draft % 24 === 0 ? `a cada ${draft / 24} ${draft === 24 ? 'dia' : 'dias'}` : `a cada ${draft} h`;

  return (
    <div>
      <FieldLabel htmlFor={id} hint={label}>
        Intervalo mínimo entre cobranças
      </FieldLabel>
      <input
        id={id}
        type="range"
        min={1}
        max={72}
        step={1}
        value={draft}
        onChange={(e) => setDraft(Number(e.target.value))}
        className="h-1 w-full cursor-pointer appearance-none bg-white/10 accent-[#ff1e3c] focus-visible:outline focus-visible:outline-1 focus-visible:outline-red"
        aria-valuetext={label}
      />
      <div className="mt-1 flex justify-between font-mono text-[9.5px] text-dim">
        <span>1 h</span>
        <span>24 h</span>
        <span>72 h</span>
      </div>
    </div>
  );
}

export function ProactiveTab({ settings }: { settings: Settings }) {
  const save = useData((s) => s.saveSettings);
  const notifications = usePrefs((s) => s.notifications);
  const setPrefs = usePrefs((s) => s.set);
  const [permission, setPermission] = useState<Permission>(readPermission);
  const p = settings.proactive;

  const requestPermission = async () => {
    if (!('Notification' in window)) return;
    try {
      setPermission(await Notification.requestPermission());
    } catch {
      setPermission(readPermission());
    }
  };

  const saveQuiet = (patch: { quietHoursStart?: string; quietHoursEnd?: string }) => {
    const value = patch.quietHoursStart ?? patch.quietHoursEnd;
    if (!value || !/^\d{2}:\d{2}$/.test(value)) return;
    void save({ proactive: patch }, { toast: 'Horário silencioso atualizado' });
  };

  return (
    <>
      <Section
        title="Cobranças"
        code="PRO-01"
        description="Um bom mentor não esquece o que você prometeu. O Lärk pergunta — no momento certo, com tato — se você cumpriu."
      >
        <Toggle
          label="Cobrar promessas"
          description="Perguntas proativas sobre compromissos pendentes ou vencidos."
          checked={p.enabled}
          onChange={(enabled) => void save({ proactive: { enabled } }, { toast: enabled ? 'Cobranças ativadas' : 'Cobranças pausadas' })}
        />
        <div className={p.enabled ? undefined : 'pointer-events-none opacity-50'} aria-disabled={!p.enabled}>
          <CheckInInterval value={p.checkInEveryHours} />
        </div>
      </Section>

      <Section title="Horário silencioso" code="PRO-02" description="Nada de cobranças nem alertas proativos neste intervalo. Lembretes agendados por você continuam valendo.">
        <div className="grid grid-cols-2 gap-3">
          <DebouncedText label="Início" type="time" value={p.quietHoursStart} delay={900} onSave={(v) => saveQuiet({ quietHoursStart: v })} />
          <DebouncedText label="Fim" type="time" value={p.quietHoursEnd} delay={900} onSave={(v) => saveQuiet({ quietHoursEnd: v })} />
        </div>
      </Section>

      <Section title="Rituais" code="PRO-03">
        <Toggle
          label="Briefing matinal"
          description="Na primeira conversa do dia: agenda, promessas, lembretes e um pensamento para começar com direção."
          checked={p.morningBriefing}
          onChange={(morningBriefing) => void save({ proactive: { morningBriefing } }, { toast: morningBriefing ? 'Briefing matinal ativado' : 'Briefing matinal desativado' })}
        />
      </Section>

      <Section title="Notificações do navegador" code="PRO-04" description="Avisos do sistema para lembretes, cobranças e autorizações quando a aba do Lärk estiver em segundo plano.">
        <Toggle
          label="Notificações neste dispositivo"
          checked={notifications}
          onChange={(v) => {
            setPrefs({ notifications: v });
            if (v && permission === 'default') void requestPermission();
          }}
        />
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-hud text-[11px] font-semibold uppercase tracking-[0.2em] text-muted">Permissão</span>
          {permission === 'granted' && <Badge tone="ok">Concedida</Badge>}
          {permission === 'denied' && <Badge tone="red">Bloqueada</Badge>}
          {permission === 'default' && <Badge tone="warn">Pendente</Badge>}
          {permission === 'unsupported' && <Badge tone="dim">Indisponível</Badge>}
          {permission === 'default' && (
            <HudButton size="sm" variant="outline" icon={<BellRing size={12} />} onClick={() => void requestPermission()}>
              Permitir
            </HudButton>
          )}
        </div>
        {permission === 'denied' && <p className="text-[12px] text-muted">O navegador bloqueou as notificações. Libere-as no ícone de cadeado da barra de endereço.</p>}
      </Section>
    </>
  );
}
