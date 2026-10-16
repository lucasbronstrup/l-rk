import { useEffect, useId, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Brain, ChevronDown } from 'lucide-react';
import { cn } from '@/lib/cn';
import { ThoughtMarkdown } from './Markdown';

interface ThoughtBlockProps {
  text: string;
  /** Aberto enquanto o raciocínio chega; recolhe sozinho ao terminar (se o usuário não mexeu). */
  streaming: boolean;
}

/** Bloco recolhível "RACIOCÍNIO" com o resumo do pensamento do modelo. */
export function ThoughtBlock({ text, streaming }: ThoughtBlockProps) {
  const [open, setOpen] = useState(streaming);
  const touched = useRef(false);
  const bodyRef = useRef<HTMLDivElement>(null);
  const id = useId();

  useEffect(() => {
    if (!touched.current) setOpen(streaming);
  }, [streaming]);

  // Durante o streaming, acompanha o fim do texto dentro da caixa.
  useEffect(() => {
    if (open && streaming && bodyRef.current) bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
  }, [text, open, streaming]);

  const words = text.trim() ? text.trim().split(/\s+/).length : 0;

  return (
    <div className="mb-3 border-l border-red/25 pl-3">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => {
          touched.current = true;
          setOpen((v) => !v);
        }}
        className="group flex min-h-7 items-center gap-2 font-hud text-[11px] font-semibold uppercase tracking-[0.24em] text-muted transition-colors hover:text-ink"
      >
        <Brain size={13} aria-hidden className={cn('text-red', streaming && 'animate-pulse')} />
        <span>Raciocínio</span>
        {streaming ? (
          <span className="font-mono text-[10px] tracking-[0.18em] text-red-bright/80">
            PROCESSANDO<span className="lark-blink">_</span>
          </span>
        ) : (
          <span className="font-mono text-[10px] tracking-[0.14em] text-muted tabular">{words} PALAVRAS</span>
        )}
        <ChevronDown size={13} aria-hidden className={cn('transition-transform duration-200', open && 'rotate-180')} />
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            id={id}
            key="thought"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.22, ease: [0.2, 0.8, 0.2, 1] }}
            className="overflow-hidden"
          >
            <div ref={bodyRef} className="max-h-64 overflow-y-auto py-1 pr-2">
              <ThoughtMarkdown text={text} />
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
