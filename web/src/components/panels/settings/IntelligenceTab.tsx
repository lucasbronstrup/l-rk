import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { ExternalLink, Eye, EyeOff, KeyRound, LoaderCircle, RefreshCw } from 'lucide-react';
import type { ModelInfo, ModelRole, Settings } from '@shared/types';
import { Badge, HudButton, IconButton, Toggle } from '@/components/ui';
import { playSfx } from '@/lib/sfx';
import { useData } from '@/store/data';
import { FieldLabel, Select, TextInput, useFieldId } from '../parts';
import { Section } from './common';

const ROLES: { role: ModelRole; label: string; description: string }[] = [
  { role: 'chat', label: 'Chat', description: 'Conversa principal, raciocínio e uso de ferramentas.' },
  { role: 'fast', label: 'Rápido', description: 'Tarefas internas: resumos, extração de memórias e promessas.' },
  { role: 'live', label: 'Voz ao vivo', description: 'Modo de voz em tempo real (fala e escuta simultâneas).' },
  { role: 'tts', label: 'TTS', description: 'Voz humanizada das respostas no chat.' },
  { role: 'embedding', label: 'Embeddings', description: 'Memória semântica: encontrar lembranças pelo significado.' },
];

const short = (id?: string | null) => (id ? id.replace(/^models\//, '') : null);

function ModelSelect({ role, label, description, value, models, active }: { role: ModelRole; label: string; description: string; value: string; models: ModelInfo[] | null; active?: string }) {
  const id = useFieldId(`model-${role}`);
  const options = useMemo(() => {
    const list = (models ?? []).filter((m) => m.roles.includes(role));
    if (value && !list.some((m) => m.id === value)) list.unshift({ id: value, displayName: short(value) ?? value, roles: [role] });
    return list;
  }, [models, role, value]);

  return (
    <div className="grid gap-1.5 sm:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)] sm:items-center sm:gap-4">
      <div className="min-w-0">
        <FieldLabel htmlFor={id}>{label}</FieldLabel>
        <p className="-mt-0.5 text-[11.5px] leading-snug text-dim">{description}</p>
      </div>
      <div className="min-w-0">
        <Select
          id={id}
          value={value}
          disabled={models === null}
          onChange={(e) => void useData.getState().saveSettings({ models: { [role]: e.target.value } }, { toast: `Modelo de ${label.toLowerCase()} atualizado` })}
        >
          <option value="">Automático (recomendado)</option>
          {options.map((m) => (
            <option key={m.id} value={m.id}>
              {m.displayName || short(m.id)}
            </option>
          ))}
        </Select>
        <p className="mt-1 truncate font-mono text-[10px] text-dim">
          em uso: <span className="text-muted">{short(active) ?? '—'}</span>
        </p>
      </div>
    </div>
  );
}

export function IntelligenceTab({ settings }: { settings: Settings }) {
  const health = useData((s) => s.health);
  const models = useData((s) => s.models);
  const modelsError = useData((s) => s.modelsError);
  const [key, setKey] = useState('');
  const [reveal, setReveal] = useState(false);
  const [saving, setSaving] = useState(false);
  const [reloading, setReloading] = useState(false);
  const keyId = useFieldId('apikey');

  useEffect(() => {
    if (models === null) void useData.getState().loadModels();
  }, [models]);

  const submitKey = async (e: FormEvent) => {
    e.preventDefault();
    const clean = key.trim();
    if (clean.length < 20 || saving) return;
    setSaving(true);
    const ok = await useData.getState().saveSettings({ apiKey: clean }, { toast: 'Chave salva — o núcleo despertou' });
    setSaving(false);
    if (ok) {
      setKey('');
      setReveal(false);
      playSfx('boot');
      void useData.getState().loadModels();
    }
  };

  const reloadModels = async () => {
    setReloading(true);
    await useData.getState().loadModels();
    await useData.getState().loadHealth();
    setReloading(false);
  };

  return (
    <>
      <Section
        title="Chave da API"
        code="INT-01"
        description={
          <>
            O cérebro do Lärk é o Gemini, do Google — gratuito pelo Google AI Studio. A chave fica guardada apenas no seu computador e nunca volta para a
            interface.
          </>
        }
      >
        <div className="flex flex-wrap items-center gap-2">
          {settings.hasApiKey ? <Badge tone="ok">Chave configurada</Badge> : <Badge tone="warn">Sem chave</Badge>}
          {health?.mock && <Badge tone="dim">Modo demonstração</Badge>}
          {health && !health.mock && settings.hasApiKey && <Badge tone="neutral">{short(health.activeModels.chat) ?? 'resolvendo modelo'}</Badge>}
        </div>
        <form onSubmit={submitKey} className="space-y-2">
          <FieldLabel htmlFor={keyId} hint={settings.hasApiKey ? 'deixe em branco para manter a atual' : undefined}>
            {settings.hasApiKey ? 'Substituir chave' : 'Colar chave'}
          </FieldLabel>
          <div className="flex gap-2">
            <div className="relative min-w-0 flex-1">
              <TextInput
                id={keyId}
                type={reveal ? 'text' : 'password'}
                autoComplete="off"
                spellCheck={false}
                value={key}
                onChange={(e) => setKey(e.target.value)}
                placeholder="AIza…"
                className="pr-10 font-mono"
              />
              <button
                type="button"
                onClick={() => setReveal((v) => !v)}
                aria-label={reveal ? 'Ocultar chave' : 'Mostrar chave'}
                className="absolute right-1 top-1/2 grid h-8 w-8 -translate-y-1/2 place-items-center text-dim hover:text-ink focus-visible:outline focus-visible:outline-1 focus-visible:outline-red"
              >
                {reveal ? <EyeOff size={14} /> : <Eye size={14} />}
              </button>
            </div>
            <HudButton type="submit" variant="primary" disabled={key.trim().length < 20 || saving} icon={saving ? <LoaderCircle size={13} className="animate-spin" /> : <KeyRound size={13} />}>
              Salvar
            </HudButton>
          </div>
          <a
            href="https://aistudio.google.com/apikey"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 font-hud text-[12px] font-semibold uppercase tracking-[0.14em] text-red-soft hover:text-red-bright focus-visible:outline focus-visible:outline-1 focus-visible:outline-red"
          >
            Obter chave gratuita no Google AI Studio <ExternalLink size={12} aria-hidden />
          </a>
        </form>
      </Section>

      <Section
        title="Modelos"
        code="INT-02"
        description="No automático, o Lärk escolhe o melhor modelo disponível para cada função e troca sozinho se um deles atingir o limite gratuito."
      >
        <div className="flex items-center justify-end">
          <IconButton size="sm" label="Atualizar lista de modelos" onClick={() => void reloadModels()} disabled={reloading}>
            <RefreshCw size={12} className={reloading ? 'animate-spin' : undefined} />
          </IconButton>
        </div>
        {modelsError && models === null && (
          <p className="border border-warn/30 bg-warn/[0.06] px-3 py-2 text-[12px] text-warn">
            Não consegui listar os modelos ({modelsError}). Sem chave válida, apenas o modo automático fica disponível.
          </p>
        )}
        <div className="space-y-4">
          {ROLES.map((r) => (
            <ModelSelect
              key={r.role}
              role={r.role}
              label={r.label}
              description={r.description}
              value={settings.models[r.role] ?? ''}
              models={models ?? (modelsError ? [] : null)}
              active={health?.activeModels[r.role]}
            />
          ))}
        </div>
      </Section>

      <Section title="Transparência" code="INT-03">
        <Toggle
          label="Mostrar raciocínio"
          description="Exibe o resumo do pensamento do modelo antes de cada resposta — os bastidores de cada argumento."
          checked={settings.showThoughts}
          onChange={(showThoughts) => void useData.getState().saveSettings({ showThoughts })}
        />
      </Section>
    </>
  );
}
