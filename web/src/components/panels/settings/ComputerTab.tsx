import { useState, type FormEvent } from 'react';
import { Folder, FolderPlus, ShieldAlert, ShieldCheck, ShieldOff, X } from 'lucide-react';
import type { Settings } from '@shared/types';
import { HudButton, IconButton, Toggle } from '@/components/ui';
import { useData } from '@/store/data';
import { APPROVAL_MODES } from '../labels';
import { FieldLabel, TextInput, useFieldId } from '../parts';
import { OptionCard, Section } from './common';

const MODE_ICON = {
  ask: <ShieldCheck size={14} />,
  'dangerous-only': <ShieldAlert size={14} />,
  never: <ShieldOff size={14} />,
} as const;

export function ComputerTab({ settings }: { settings: Settings }) {
  const save = useData((s) => s.saveSettings);
  const [path, setPath] = useState('');
  const pathId = useFieldId('fav-path');
  const { enabled, approvalMode, favoritePaths } = settings.computer;

  const addPath = (e: FormEvent) => {
    e.preventDefault();
    const clean = path.trim().replace(/^["']|["']$/g, '');
    if (!clean) return;
    if (favoritePaths.includes(clean)) {
      setPath('');
      return;
    }
    void save({ computer: { favoritePaths: [...favoritePaths, clean] } }, { toast: 'Pasta favorita adicionada' }).then((ok) => ok && setPath(''));
  };

  const removePath = (p: string) => void save({ computer: { favoritePaths: favoritePaths.filter((x) => x !== p) } }, { toast: 'Pasta removida' });

  return (
    <>
      <Section
        title="Acesso"
        code="CMP-01"
        description="Com acesso, o Lärk lê e organiza seus arquivos, executa comandos, abre aplicativos e observa a saúde da máquina. Ele e o computador passam a ser um só."
      >
        <Toggle
          label="Acesso ao computador"
          description={enabled ? 'Ativo — o Lärk é a consciência desta máquina.' : 'Desligado — o Lärk só conversa, sem tocar em nada.'}
          checked={enabled}
          onChange={(v) => void save({ computer: { enabled: v } }, { toast: v ? 'Acesso ao computador ativado' : 'Acesso ao computador desligado' })}
        />
      </Section>

      <Section title="Autorizações" code="CMP-02" description="Quando o Lärk deve pedir sua permissão antes de agir. Você pode mudar isso a qualquer momento.">
        <div role="radiogroup" aria-label="Modo de aprovação" className="space-y-2">
          {APPROVAL_MODES.map((m) => (
            <OptionCard
              key={m.value}
              name="approval-mode"
              selected={approvalMode === m.value}
              onSelect={() => void save({ computer: { approvalMode: m.value } }, { toast: 'Modo de autorização atualizado' })}
              title={m.title}
              description={m.description}
              icon={MODE_ICON[m.value]}
              tone={m.value === 'never' ? 'warn' : 'red'}
            />
          ))}
        </div>
      </Section>

      <Section title="Pastas favoritas" code="CMP-03" description="Atalhos que o Lärk conhece pelo nome — “abra meus projetos”, “organize os downloads”.">
        {favoritePaths.length > 0 ? (
          <ul className="space-y-1.5">
            {favoritePaths.map((p) => (
              <li key={p} className="group flex items-center gap-2 border border-line-neutral bg-black/20 px-2.5 py-1.5">
                <Folder size={13} className="shrink-0 text-red/70" aria-hidden />
                <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-ink" title={p}>
                  {p}
                </span>
                <IconButton size="sm" label={`Remover ${p}`} onClick={() => removePath(p)}>
                  <X size={12} />
                </IconButton>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-[12px] text-dim">Nenhuma pasta extra. Documentos, Downloads e Área de Trabalho já são conhecidos.</p>
        )}
        <form onSubmit={addPath}>
          <FieldLabel htmlFor={pathId}>Adicionar pasta</FieldLabel>
          <div className="flex gap-2">
            <TextInput
              id={pathId}
              value={path}
              onChange={(e) => setPath(e.target.value)}
              placeholder="Ex.: C:\Users\lucas\Projetos ou ~/Projetos"
              className="min-w-0 flex-1 font-mono"
              spellCheck={false}
              autoComplete="off"
            />
            <HudButton type="submit" variant="outline" disabled={!path.trim()} icon={<FolderPlus size={13} />}>
              Adicionar
            </HudButton>
          </div>
        </form>
      </Section>
    </>
  );
}
