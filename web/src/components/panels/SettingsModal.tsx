import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { AudioLines, BrainCircuit, Check, Database, LoaderCircle, Monitor, Settings2, Sparkles, UserRound, X } from 'lucide-react';
import { HudPanel, IconButton } from '@/components/ui';
import { cn } from '@/lib/cn';
import { useData } from '@/store/data';
import { useUi } from '@/store/ui';
import { Dialog, PanelError, PanelSkeleton } from './parts';
import { ComputerTab } from './settings/ComputerTab';
import { DataTab } from './settings/DataTab';
import { GeneralTab } from './settings/GeneralTab';
import { IntelligenceTab } from './settings/IntelligenceTab';
import { ProactiveTab } from './settings/ProactiveTab';
import { VoiceTab } from './settings/VoiceTab';

type TabId = 'general' | 'intelligence' | 'voice' | 'computer' | 'proactive' | 'data';

const TABS: { id: TabId; label: string; code: string; icon: ReactNode }[] = [
  { id: 'general', label: 'Geral', code: 'GEN', icon: <UserRound size={14} /> },
  { id: 'intelligence', label: 'Inteligência', code: 'INT', icon: <BrainCircuit size={14} /> },
  { id: 'voice', label: 'Voz', code: 'VOZ', icon: <AudioLines size={14} /> },
  { id: 'computer', label: 'Computador', code: 'CMP', icon: <Monitor size={14} /> },
  { id: 'proactive', label: 'Proatividade', code: 'PRO', icon: <Sparkles size={14} /> },
  { id: 'data', label: 'Dados', code: 'DAT', icon: <Database size={14} /> },
];

const TAB_KEY = 'lark:settings-tab';

function readTab(): TabId {
  try {
    const v = window.localStorage.getItem(TAB_KEY) as TabId | null;
    if (v && TABS.some((t) => t.id === v)) return v;
  } catch {
    /* armazenamento indisponível */
  }
  return 'general';
}

function SavingIndicator() {
  const saving = useData((s) => s.settingsSaving);
  return (
    <span className="mr-1 hidden items-center gap-1.5 font-mono text-[9.5px] uppercase tracking-[0.22em] sm:inline-flex" aria-live="polite">
      {saving ? (
        <>
          <LoaderCircle size={11} className="animate-spin text-red" aria-hidden />
          <span className="text-muted">Salvando</span>
        </>
      ) : (
        <>
          <Check size={11} className="text-ok" aria-hidden />
          <span className="text-dim">Sincronizado</span>
        </>
      )}
    </span>
  );
}

function SettingsBody({ onClose }: { onClose: () => void }) {
  const settings = useData((s) => s.settings);
  const health = useData((s) => s.health);
  const [tab, setTab] = useState<TabId>(readTab);
  const [loadFailed, setLoadFailed] = useState(false);
  const tabRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const scrollRef = useRef<HTMLDivElement>(null);

  // Abre sempre com dados frescos (outra aba pode ter mudado algo).
  useEffect(() => {
    void useData
      .getState()
      .loadSettings()
      .then(() => setLoadFailed(!useData.getState().settings));
    void useData.getState().loadMemoryStats();
  }, []);

  const select = useCallback((id: TabId, focus = false) => {
    setTab(id);
    scrollRef.current?.scrollTo({ top: 0 });
    try {
      window.localStorage.setItem(TAB_KEY, id);
    } catch {
      /* ignorado */
    }
    if (focus) tabRefs.current[id]?.focus();
  }, []);

  const onTabKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const i = TABS.findIndex((t) => t.id === tab);
    let next = -1;
    if (e.key === 'ArrowDown' || e.key === 'ArrowRight') next = (i + 1) % TABS.length;
    else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') next = (i - 1 + TABS.length) % TABS.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = TABS.length - 1;
    if (next === -1) return;
    e.preventDefault();
    select(TABS[next].id, true);
  };

  const current = TABS.find((t) => t.id === tab) ?? TABS[0];

  return (
    <HudPanel
      title="Configurações"
      code="CFG-00"
      icon={<Settings2 size={14} />}
      className="h-full w-full bg-abyss/[0.97] shadow-glow-lg"
      bodyClassName="flex min-h-0 flex-col md:flex-row"
      actions={
        <>
          <SavingIndicator />
          <IconButton label="Fechar configurações" size="sm" onClick={onClose}>
            <X size={14} />
          </IconButton>
        </>
      }
    >
      {/* Abas */}
      <div className="flex shrink-0 flex-col border-b border-line md:w-56 md:border-b-0 md:border-r">
        <div
          role="tablist"
          aria-label="Seções das configurações"
          aria-orientation="vertical"
          onKeyDown={onTabKey}
          className="flex gap-1 overflow-x-auto px-2 py-2 [scrollbar-width:none] md:flex-col md:overflow-visible md:px-2 md:py-3 [&::-webkit-scrollbar]:hidden"
        >
          {TABS.map((t) => {
            const active = t.id === tab;
            return (
              <button
                key={t.id}
                ref={(el) => {
                  tabRefs.current[t.id] = el;
                }}
                role="tab"
                id={`cfg-tab-${t.id}`}
                aria-selected={active}
                aria-controls="cfg-panel"
                tabIndex={active ? 0 : -1}
                onClick={() => select(t.id)}
                className={cn(
                  'relative flex h-9 shrink-0 items-center gap-2.5 px-3 font-hud text-[12.5px] font-semibold uppercase tracking-[0.14em] transition-colors focus-visible:outline focus-visible:outline-1 focus-visible:outline-red md:h-10 md:w-full',
                  active ? 'bg-red/[0.1] text-ink' : 'text-muted hover:bg-white/[0.03] hover:text-ink',
                )}
              >
                {active && (
                  <motion.span
                    layoutId="cfg-tab-indicator"
                    aria-hidden
                    className="absolute inset-x-2 bottom-0 h-[2px] bg-red shadow-glow-sm md:inset-x-auto md:inset-y-1.5 md:bottom-auto md:left-0 md:h-auto md:w-[2px]"
                    transition={{ duration: 0.25, ease: [0.16, 1, 0.3, 1] }}
                  />
                )}
                <span className={active ? 'text-red-bright' : 'text-dim'}>{t.icon}</span>
                <span>{t.label}</span>
                <span className="ml-auto hidden font-mono text-[9px] tracking-[0.2em] text-dim md:inline">{t.code}</span>
              </button>
            );
          })}
        </div>
        <div className="mt-auto hidden space-y-1 border-t border-line-neutral px-4 py-3 md:block">
          <p className="font-mono text-[9.5px] uppercase tracking-[0.24em] text-dim">Lärk v{health?.version ?? '—'}</p>
          <p className="truncate font-mono text-[9.5px] uppercase tracking-[0.24em] text-dim" title={health?.hostname}>
            Host // {health?.hostname ?? '—'}
          </p>
          {health?.mock && <p className="font-mono text-[9.5px] uppercase tracking-[0.24em] text-warn">Modo demonstração</p>}
        </div>
      </div>

      {/* Conteúdo */}
      <div ref={scrollRef} id="cfg-panel" role="tabpanel" aria-labelledby={`cfg-tab-${tab}`} className="min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-8 pt-3 sm:px-6">
        <p className="mb-1 font-mono text-[9.5px] uppercase tracking-[0.3em] text-dim">
          CFG // {current.code} — {current.label}
        </p>
        {!settings ? (
          loadFailed ? (
            <PanelError
              message="Não consegui ler as configurações do núcleo. Verifique se o servidor do Lärk está rodando."
              onRetry={() =>
                void useData
                  .getState()
                  .loadSettings()
                  .then(() => setLoadFailed(!useData.getState().settings))
              }
            />
          ) : (
            <PanelSkeleton rows={5} className="px-0" />
          )
        ) : (
          <AnimatePresence mode="wait" initial={false}>
            <motion.div key={tab} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -4 }} transition={{ duration: 0.18, ease: 'easeOut' }} className="divide-y divide-line-neutral">
              {tab === 'general' && <GeneralTab settings={settings} />}
              {tab === 'intelligence' && <IntelligenceTab settings={settings} />}
              {tab === 'voice' && <VoiceTab settings={settings} />}
              {tab === 'computer' && <ComputerTab settings={settings} />}
              {tab === 'proactive' && <ProactiveTab settings={settings} />}
              {tab === 'data' && <DataTab />}
            </motion.div>
          </AnimatePresence>
        )}
      </div>
    </HudPanel>
  );
}

/** Configurações do Lärk (abre via useUi.settingsOpen). Tudo salva automaticamente. */
export function SettingsModal() {
  const open = useUi((s) => s.settingsOpen);
  const close = useCallback(() => useUi.getState().set({ settingsOpen: false }), []);

  return (
    <Dialog open={open} onClose={close} label="Configurações" zClass="z-[60]" className="h-[min(800px,100%)] max-w-4xl">
      <SettingsBody onClose={close} />
    </Dialog>
  );
}
