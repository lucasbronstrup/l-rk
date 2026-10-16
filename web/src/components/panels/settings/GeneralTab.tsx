import { useMemo } from 'react';
import { LocateFixed } from 'lucide-react';
import type { Settings } from '@shared/types';
import { HudButton } from '@/components/ui';
import { formatDateTime } from '@/lib/format';
import { useData } from '@/store/data';
import { FieldLabel, Select, useFieldId, useNow } from '../parts';
import { DebouncedText, Section } from './common';

const FALLBACK_ZONES = [
  'America/Sao_Paulo',
  'America/Manaus',
  'America/Belem',
  'America/Fortaleza',
  'America/Recife',
  'America/Cuiaba',
  'America/Rio_Branco',
  'America/Noronha',
  'Europe/Lisbon',
  'America/New_York',
  'Europe/London',
  'UTC',
];

function listTimeZones(): string[] {
  try {
    const supported = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.('timeZone');
    if (supported?.length) return supported;
  } catch {
    /* navegador sem suporte */
  }
  return FALLBACK_ZONES;
}

const deviceZone = () => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
};

export function GeneralTab({ settings }: { settings: Settings }) {
  const save = useData((s) => s.saveSettings);
  const zones = useMemo(() => {
    const list = listTimeZones();
    return list.includes(settings.timezone) ? list : [settings.timezone, ...list];
  }, [settings.timezone]);
  const tzId = useFieldId('tz');
  const now = useNow(30_000);
  const local = deviceZone();

  return (
    <>
      <Section title="Identidade" code="GEN-01" description="Como o Lärk se dirige a você. Um nome dito no momento certo vale mais que mil elogios.">
        <DebouncedText
          label="Como devo te chamar"
          value={settings.userName}
          placeholder="Ex.: Lucas, chefe, senhor"
          maxLength={60}
          onSave={(userName) => void save({ userName: userName.trim() }, { toast: 'Nome atualizado' })}
        />
      </Section>

      <Section title="Tempo" code="GEN-02" description="Usado para lembretes, cobranças, horário silencioso e o briefing da manhã.">
        <div>
          <FieldLabel htmlFor={tzId} hint={`Agora: ${formatDateTime(now, settings.timezone)}`}>
            Fuso horário
          </FieldLabel>
          <div className="flex flex-col gap-2 sm:flex-row">
            <div className="min-w-0 flex-1">
              <Select id={tzId} value={settings.timezone} onChange={(e) => void save({ timezone: e.target.value }, { toast: 'Fuso horário atualizado' })}>
                {zones.map((z) => (
                  <option key={z} value={z}>
                    {z.replace(/_/g, ' ')}
                  </option>
                ))}
              </Select>
            </div>
            {local !== settings.timezone && (
              <HudButton size="md" variant="outline" icon={<LocateFixed size={13} />} onClick={() => void save({ timezone: local }, { toast: 'Fuso horário atualizado' })}>
                Usar {local.split('/').pop()?.replace(/_/g, ' ')}
              </HudButton>
            )}
          </div>
        </div>
      </Section>

      <Section
        title="Personalidade"
        code="GEN-03"
        description="O Lärk já fala como um orador mestre. Aqui você afina o tom: o que valoriza, o que evitar, referências que gosta."
      >
        <DebouncedText
          label="Notas de personalidade"
          multiline
          rows={6}
          maxLength={4000}
          value={settings.personaNotes}
          placeholder={'Ex.: Seja direto pela manhã e mais reflexivo à noite.\nUse analogias de esporte. Nunca me chame de "usuário".'}
          hint="salva ao parar de digitar"
          onSave={(personaNotes) => void save({ personaNotes }, { toast: 'Personalidade ajustada' })}
        />
      </Section>
    </>
  );
}
