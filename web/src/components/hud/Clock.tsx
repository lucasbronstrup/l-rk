import { useEffect, useMemo, useState } from 'react';
import { cn } from '@/lib/cn';

interface Formatters {
  time: Intl.DateTimeFormat;
  date: Intl.DateTimeFormat;
  dateLong: Intl.DateTimeFormat;
}

/** Cria os formatadores PT-BR; fuso inválido cai no fuso local sem quebrar a HUD. */
function makeFormatters(timeZone?: string): Formatters {
  const build = (tz?: string): Formatters => ({
    time: new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, timeZone: tz }),
    date: new Intl.DateTimeFormat('pt-BR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: tz }),
    dateLong: new Intl.DateTimeFormat('pt-BR', { day: 'numeric', month: 'long', year: 'numeric', timeZone: tz }),
  });
  try {
    return build(timeZone || undefined);
  } catch {
    return build(undefined);
  }
}

/** Relógio que atualiza alinhado à virada de cada segundo. */
function useNow(): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    let interval = 0;
    const timeout = window.setTimeout(
      () => {
        setNow(new Date());
        interval = window.setInterval(() => setNow(new Date()), 1000);
      },
      1000 - (Date.now() % 1000),
    );
    return () => {
      window.clearTimeout(timeout);
      window.clearInterval(interval);
    };
  }, []);
  return now;
}

/** Data por extenso: com dia da semana ('full'), sem ('long'), oculta ('none')
 *  ou 'responsive' (sem dia da semana até 1536px, completa acima). */
type DateMode = 'none' | 'long' | 'full' | 'responsive';

interface ClockProps {
  timeZone?: string;
  date?: DateMode;
  align?: 'left' | 'right';
  className?: string;
}

/** Relógio HH:MM:SS com data por extenso em português. Componente isolado: só ele re-renderiza a cada segundo. */
export function Clock({ timeZone, date: dateMode = 'full', align = 'right', className }: ClockProps) {
  const now = useNow();
  const fmt = useMemo(() => makeFormatters(timeZone), [timeZone]);

  const time = fmt.time.format(now);
  const [hh = '00', mm = '00', ss = '00'] = time.split(':');
  const date = fmt.date.format(now);
  const dateLong = fmt.dateLong.format(now);

  return (
    <time
      dateTime={now.toISOString()}
      className={cn('flex flex-col leading-none', align === 'right' ? 'items-end' : 'items-start', className)}
    >
      <span className="sr-only">{`${time}, ${date}`}</span>
      <span className="tabular flex items-baseline font-display text-[17px] font-semibold tracking-[0.08em] text-ink" aria-hidden>
        {hh}
        <span className="mx-[1px] text-red">:</span>
        {mm}
        <span className="ml-1 text-[11px] font-normal text-red-bright">{ss}</span>
      </span>
      {dateMode !== 'none' && (
        <span className="mt-1 font-hud text-[10.5px] font-medium uppercase tracking-[0.2em] text-muted" aria-hidden>
          {dateMode === 'full' && date}
          {dateMode === 'long' && dateLong}
          {dateMode === 'responsive' && (
            <>
              <span className="2xl:hidden">{dateLong}</span>
              <span className="hidden 2xl:inline">{date}</span>
            </>
          )}
        </span>
      )}
    </time>
  );
}
