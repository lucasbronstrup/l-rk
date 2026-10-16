import { useMemo } from 'react';
import { motion } from 'motion/react';
import { CalendarClock, Cpu, FolderOpen, Sparkles, type LucideIcon } from 'lucide-react';
import { greeting } from './format';

interface Suggestion {
  text: string;
  hint: string;
  code: string;
  Icon: LucideIcon;
}

const SUGGESTIONS: Suggestion[] = [
  { text: 'O que tenho para hoje?', hint: 'Lembretes, promessas e prioridades', code: 'Q-01', Icon: CalendarClock },
  { text: 'Organize minha pasta Downloads', hint: 'Arquivos agrupados por tipo e data', code: 'Q-02', Icon: FolderOpen },
  { text: 'Me ensine algo fascinante', hint: 'Uma ideia que muda a forma de ver', code: 'Q-03', Icon: Sparkles },
  { text: 'Como está meu computador?', hint: 'CPU, memória, disco e processos', code: 'Q-04', Icon: Cpu },
];

/** Reflexões curtas para a abertura — o Lärk sempre começa com um pensamento. */
const REFLECTIONS = [
  'Toda grande mudança começa com uma boa pergunta. Qual é a sua hoje?',
  'A disciplina é a ponte entre o que você promete e o que você se torna.',
  'Quem organiza o dia, conquista a semana. Por onde começamos?',
  'Curiosidade é a forma mais elegante de coragem. O que vamos descobrir agora?',
  'O tempo não se administra — administram-se escolhas. Qual é a primeira de hoje?',
];

interface EmptyStateProps {
  userName?: string;
  onPick: (text: string) => void;
}

/** Abertura elegante de uma conversa vazia: saudação, reflexão e sugestões clicáveis. */
export function EmptyState({ userName, onPick }: EmptyStateProps) {
  const reflection = useMemo(() => REFLECTIONS[Math.floor(Math.random() * REFLECTIONS.length)], []);
  const hello = greeting();
  const name = userName?.trim();

  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto">
      <div className="m-auto w-full max-w-3xl px-4 py-8 sm:px-6 lg:px-8">
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, ease: [0.2, 0.8, 0.2, 1] }}
        >
          <div className="mb-5 flex items-center gap-3 font-mono text-[10px] tracking-[0.3em] text-dim">
            <span className="h-1.5 w-1.5 bg-red shadow-glow-sm lark-blink" aria-hidden />
            <span>CANAL ABERTO</span>
            <span aria-hidden className="h-px w-10 bg-line-strong" />
            <span className="text-muted">SYS//LÄRK</span>
          </div>

          <h2 className="font-display text-[clamp(1.6rem,4.2vw,2.6rem)] font-semibold leading-[1.15] tracking-[0.04em] text-ink">
            {hello}
            {name ? (
              <>
                , <span className="text-red text-glow">{name}</span>.
              </>
            ) : (
              '.'
            )}
          </h2>
          <p className="mt-4 max-w-xl text-[15px] leading-relaxed text-muted sm:text-base">{reflection}</p>
        </motion.div>

        <div className="mt-8 grid grid-cols-1 gap-2.5 sm:mt-10 sm:grid-cols-2 sm:gap-3">
          {SUGGESTIONS.map((s, i) => (
            <motion.button
              key={s.code}
              type="button"
              onClick={() => onPick(s.text)}
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.4, delay: 0.15 + i * 0.07, ease: [0.2, 0.8, 0.2, 1] }}
              className="group relative flex min-w-0 items-start gap-3 border border-line-neutral bg-white/[0.02] p-3.5 text-left transition-colors duration-200 hover:border-line-strong hover:bg-red/[0.05] focus-visible:border-red sm:p-4"
            >
              <span aria-hidden className="pointer-events-none absolute -left-px -top-px h-2 w-2 border-l border-t border-red/0 transition-colors group-hover:border-red" />
              <span aria-hidden className="pointer-events-none absolute -bottom-px -right-px h-2 w-2 border-b border-r border-red/0 transition-colors group-hover:border-red" />
              <span
                aria-hidden
                className="flex h-9 w-9 shrink-0 items-center justify-center border border-line text-red transition-shadow group-hover:shadow-glow-sm"
              >
                <s.Icon size={16} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block font-sans text-[14.5px] font-medium text-ink">{s.text}</span>
                <span className="mt-0.5 block truncate text-xs text-muted">{s.hint}</span>
              </span>
              <span className="shrink-0 font-mono text-[9px] tracking-[0.2em] text-dim transition-colors group-hover:text-red-bright">
                {s.code}
              </span>
            </motion.button>
          ))}
        </div>
      </div>
    </div>
  );
}
