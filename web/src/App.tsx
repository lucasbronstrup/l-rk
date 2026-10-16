import { useMemo } from 'react';
import { AnimatePresence, MotionConfig, motion, type Transition } from 'motion/react';
import { Bell, Brain, Cpu, ListChecks } from 'lucide-react';
import { useUi } from '@/store/ui';
import { cn } from '@/lib/cn';
import { ChatPanel } from '@/components/chat';
import { VoiceController, VoiceModeOverlay } from '@/components/voice';
import {
  ApprovalDialog,
  AuthGate,
  CommitmentsPanel,
  ConversationsDrawer,
  MemoryPanel,
  NotificationCenter,
  RemindersPanel,
  SettingsModal,
  SystemPanel,
} from '@/components/panels';
import { useDataBootstrap } from '@/hooks/useDataBootstrap';
import {
  Background,
  BootSequence,
  CoreStage,
  MobileCore,
  MobileTabBar,
  ModuleBoundary,
  PanelSlot,
  StatusFooter,
  TabbedDock,
  TopBar,
  clamp,
  useBreakpoint,
  useGlobalShortcuts,
  useViewportHeight,
  type DockTab,
} from '@/components/hud';

// ─── Entrada dos módulos após a abertura ────────────────────────────────

const EASE_OUT_EXPO = [0.16, 1, 0.3, 1] as const;

/** Props de motion para revelar uma coluna quando a abertura termina. */
function reveal(ready: boolean, delay: number, from: { x?: number; y?: number }) {
  const hidden = { opacity: 0, x: from.x ?? 0, y: from.y ?? 0 };
  const transition: Transition = { duration: 0.75, delay: ready ? delay : 0, ease: EASE_OUT_EXPO };
  return {
    initial: hidden,
    animate: ready ? { opacity: 1, x: 0, y: 0 } : hidden,
    transition,
  };
}

// ─── Layouts ────────────────────────────────────────────────────────────

/** Desktop (≥1280px): memória/sistema | núcleo + chat | promessas/lembretes. */
function DesktopLayout({ ready }: { ready: boolean }) {
  const vh = useViewportHeight();
  const orbSize = clamp(Math.round(vh * 0.27), 180, 300);

  return (
    <main className="grid min-h-0 flex-1 grid-cols-[clamp(320px,21vw,360px)_minmax(0,1fr)_clamp(340px,23vw,380px)] grid-rows-[minmax(0,1fr)] gap-4 px-6 py-4">
      <motion.aside
        {...reveal(ready, 0.12, { x: -28 })}
        aria-label="Memória e sistema"
        className="grid min-h-0 grid-rows-[minmax(0,3fr)_minmax(0,2fr)] gap-4"
      >
        <PanelSlot name="Memória">
          <MemoryPanel />
        </PanelSlot>
        <PanelSlot name="Sistema">
          <SystemPanel />
        </PanelSlot>
      </motion.aside>

      <motion.section {...reveal(ready, 0, { y: 18 })} aria-label="Núcleo e conversa" className="flex min-h-0 min-w-0 flex-col gap-3">
        <CoreStage size={orbSize} />
        <PanelSlot name="Chat" className="flex-1">
          <ChatPanel />
        </PanelSlot>
      </motion.section>

      <motion.aside
        {...reveal(ready, 0.2, { x: 28 })}
        aria-label="Promessas e lembretes"
        className="grid min-h-0 grid-rows-[minmax(0,1fr)_minmax(0,1fr)] gap-4"
      >
        <PanelSlot name="Promessas">
          <CommitmentsPanel />
        </PanelSlot>
        <PanelSlot name="Lembretes">
          <RemindersPanel />
        </PanelSlot>
      </motion.aside>
    </main>
  );
}

/** Tablet (768–1279px): núcleo + chat | painéis em abas. */
function TabletLayout({ ready }: { ready: boolean }) {
  const vh = useViewportHeight();
  const orbSize = clamp(Math.round(vh * 0.22), 140, 220);

  const tabs = useMemo<DockTab[]>(
    () => [
      { id: 'memory', label: 'Memória', icon: <Brain size={15} />, render: () => <MemoryPanel /> },
      { id: 'commitments', label: 'Promessas', icon: <ListChecks size={15} />, render: () => <CommitmentsPanel /> },
      { id: 'reminders', label: 'Lembretes', icon: <Bell size={15} />, render: () => <RemindersPanel /> },
      { id: 'system', label: 'Sistema', icon: <Cpu size={15} />, render: () => <SystemPanel /> },
    ],
    [],
  );

  return (
    <main className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_minmax(300px,360px)] grid-rows-[minmax(0,1fr)] gap-3 py-3 pl-[max(1rem,env(safe-area-inset-left))] pr-[max(1rem,env(safe-area-inset-right))]">
      <motion.section {...reveal(ready, 0, { y: 16 })} aria-label="Núcleo e conversa" className="flex min-h-0 min-w-0 flex-col gap-2">
        <CoreStage size={orbSize} />
        <PanelSlot name="Chat" className="flex-1">
          <ChatPanel />
        </PanelSlot>
      </motion.section>
      <motion.aside {...reveal(ready, 0.15, { x: 24 })} aria-label="Painéis do sistema" className="flex min-h-0 flex-col">
        <TabbedDock tabs={tabs} storageKey="lark:tablet-tab" className="flex-1" />
      </motion.aside>
    </main>
  );
}

/** Celular (<768px): orbe compacto + chat, demais módulos em abas inferiores. */
function MobileLayout({ ready }: { ready: boolean }) {
  const tab = useUi((s) => s.mobileTab);
  const vh = useViewportHeight();
  // Teclado virtual aberto ou tela baixa: o orbe encolhe — e some de vez em telas muito baixas
  // (celular deitado), quando o botão de voz da barra superior basta.
  const small = vh < 600;
  const hideCore = vh < 460;
  const onChat = tab === 'chat';

  return (
    <>
      <motion.main
        {...reveal(ready, 0, { y: 14 })}
        className="relative flex min-h-0 flex-1 flex-col pb-2 pl-[max(0.75rem,env(safe-area-inset-left))] pr-[max(0.75rem,env(safe-area-inset-right))]"
      >
        {/* O chat permanece montado (preserva rascunho e rolagem) e só é ocultado. */}
        <section
          aria-label="Núcleo e conversa"
          inert={!onChat}
          className={cn(
            'flex min-h-0 flex-1 flex-col',
            hideCore && 'pt-2',
            !onChat && 'pointer-events-none invisible absolute inset-0 -z-10',
          )}
        >
          {!hideCore && <MobileCore small={small} />}
          <PanelSlot name="Chat" className="flex-1">
            <ChatPanel />
          </PanelSlot>
        </section>

        <AnimatePresence mode="wait" initial={false}>
          {!onChat && (
            <motion.section
              key={tab}
              className="flex min-h-0 flex-1 flex-col pt-3"
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              transition={{ duration: 0.18, ease: 'easeOut' }}
            >
              {tab === 'memory' && (
                <PanelSlot name="Memória" className="flex-1">
                  <MemoryPanel />
                </PanelSlot>
              )}
              {tab === 'protocols' && (
                <div className="grid min-h-0 flex-1 grid-rows-[minmax(0,1fr)_minmax(0,1fr)] gap-3">
                  <PanelSlot name="Promessas">
                    <CommitmentsPanel />
                  </PanelSlot>
                  <PanelSlot name="Lembretes">
                    <RemindersPanel />
                  </PanelSlot>
                </div>
              )}
              {tab === 'system' && (
                <PanelSlot name="Sistema" className="flex-1">
                  <SystemPanel />
                </PanelSlot>
              )}
            </motion.section>
          )}
        </AnimatePresence>
      </motion.main>
      <MobileTabBar />
    </>
  );
}

// ─── Sobreposições globais (montadas uma única vez) ─────────────────────

function Overlays() {
  return (
    <>
      <ModuleBoundary name="Configurações" fallback="silent">
        <SettingsModal />
      </ModuleBoundary>
      <ModuleBoundary name="Conversas" fallback="silent">
        <ConversationsDrawer />
      </ModuleBoundary>
      <ModuleBoundary name="Notificações" fallback="silent">
        <NotificationCenter />
      </ModuleBoundary>
      <ModuleBoundary name="Aprovações" fallback="silent">
        <ApprovalDialog />
      </ModuleBoundary>
      <ModuleBoundary name="Modo de voz" fallback="silent">
        <VoiceModeOverlay />
      </ModuleBoundary>
      <ModuleBoundary name="Controle de voz" fallback="silent">
        <VoiceController />
      </ModuleBoundary>
    </>
  );
}

// ─── Casca ──────────────────────────────────────────────────────────────

/** Tudo o que existe depois da autenticação: dados, atalhos, layout, sobreposições e abertura. */
function Shell() {
  useDataBootstrap();
  useGlobalShortcuts();
  const bootDone = useUi((s) => s.bootDone);
  const bp = useBreakpoint();

  return (
    <>
      <div className="relative flex h-dvh flex-col overflow-hidden" inert={!bootDone}>
        <TopBar />
        {bp === 'desktop' && <DesktopLayout ready={bootDone} />}
        {bp === 'tablet' && <TabletLayout ready={bootDone} />}
        {bp === 'mobile' && <MobileLayout ready={bootDone} />}
        {bp === 'desktop' && <StatusFooter />}
      </div>

      <Overlays />

      <AnimatePresence>{!bootDone && <BootSequence key="boot" />}</AnimatePresence>
    </>
  );
}

/**
 * Raiz da interface do Lärk. O fundo vivo fica fora do AuthGate para acompanhar também
 * a tela de acesso; o resto só monta depois da autenticação.
 */
export function App() {
  return (
    <MotionConfig reducedMotion="user">
      <Background />
      {/* `relative` sem z-index: pinta acima do fundo sem criar contexto de empilhamento. */}
      <div className="relative h-full">
        <AuthGate>
          <Shell />
        </AuthGate>
      </div>
    </MotionConfig>
  );
}

export default App;
