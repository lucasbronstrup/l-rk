import { useRef, useState, type ChangeEvent } from 'react';
import { Database, Download, LoaderCircle, Upload } from 'lucide-react';
import { Badge, HudButton } from '@/components/ui';
import { api, errorMessage, type LarkBackup } from '@/lib/api';
import { daysSince, formatBytes, formatDate, formatNumber } from '@/lib/format';
import { playSfx } from '@/lib/sfx';
import { useData } from '@/store/data';
import { Section } from './common';

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="border border-line-neutral bg-black/20 px-3 py-2.5">
      <span className="block font-hud text-[10px] font-semibold uppercase tracking-[0.22em] text-muted">{label}</span>
      <span className="tabular mt-0.5 block font-display text-lg font-semibold text-ink">{value}</span>
      {sub && <span className="block font-mono text-[10px] text-dim">{sub}</span>}
    </div>
  );
}

interface PendingImport {
  name: string;
  size: number;
  data: LarkBackup;
}

export function DataTab() {
  const stats = useData((s) => s.memoryStats);
  const [exporting, setExporting] = useState(false);
  const [importing, setImporting] = useState(false);
  const [pending, setPending] = useState<PendingImport | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const days = daysSince(stats?.firstInteractionAt ?? null);

  const doExport = async () => {
    setExporting(true);
    try {
      const { blob, filename } = await api.exportData();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
      useData.getState().pushToast({ kind: 'success', title: 'Backup exportado', body: `${filename} · ${formatBytes(blob.size)}. Memórias não deveriam depender de um único lugar.` });
    } catch (e) {
      useData.getState().pushToast({ kind: 'error', title: 'Exportação falhou', body: errorMessage(e) });
    } finally {
      setExporting(false);
    }
  };

  const pickFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try {
      const text = await file.text();
      const data = JSON.parse(text) as unknown;
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('O arquivo não parece um backup do Lärk.');
      setPending({ name: file.name, size: file.size, data: data as LarkBackup });
    } catch (err) {
      useData.getState().pushToast({
        kind: 'error',
        title: 'Arquivo inválido',
        body: err instanceof SyntaxError ? 'Não é um JSON válido.' : errorMessage(err),
      });
    }
  };

  const doImport = async () => {
    if (!pending) return;
    setImporting(true);
    try {
      const res = await api.importData(pending.data);
      const counts = res.imported
        ? Object.entries(res.imported)
            .filter(([, n]) => n > 0)
            .map(([k, n]) => `${formatNumber(n)} ${k}`)
            .join(', ')
        : '';
      setPending(null);
      playSfx('receive');
      useData.getState().pushToast({ kind: 'success', title: 'Backup importado', body: counts ? `Incorporado: ${counts}.` : 'Os dados foram incorporados à memória do Lärk.' });
      await useData.getState().loadAll();
    } catch (e) {
      useData.getState().pushToast({ kind: 'error', title: 'Importação falhou', body: errorMessage(e) });
    } finally {
      setImporting(false);
    }
  };

  return (
    <>
      <Section title="Memória permanente" code="DAT-01" description="Tudo o que o Lärk sabe vive em um banco de dados local, neste computador.">
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          <Stat label="Memórias" value={stats ? formatNumber(stats.memories) : '—'} />
          <Stat label="Mensagens" value={stats ? formatNumber(stats.messages) : '—'} />
          <Stat label="Conversas" value={stats ? formatNumber(stats.conversations) : '—'} />
          <Stat
            label="Primeiro contato"
            value={stats?.firstInteractionAt ? formatDate(stats.firstInteractionAt) : '—'}
            sub={days !== null ? (days === 0 ? 'hoje' : `há ${formatNumber(days)} ${days === 1 ? 'dia' : 'dias'}`) : undefined}
          />
          <div className="col-span-2 flex items-center gap-2 border border-line-neutral bg-black/20 px-3 py-2.5">
            <Database size={14} className="shrink-0 text-red/70" aria-hidden />
            <span className="font-hud text-[12px] font-semibold uppercase tracking-[0.16em] text-muted">Busca semântica</span>
            <span className="ml-auto">{stats?.embeddingsEnabled ? <Badge tone="ok">Ativa</Badge> : <Badge tone="dim">Somente textual</Badge>}</span>
          </div>
        </div>
      </Section>

      <Section title="Backup" code="DAT-02" description="Exporte tudo — memórias, promessas, lembretes, conversas e configurações (exceto a chave da API) — em um único arquivo JSON.">
        <div className="flex flex-wrap gap-2">
          <HudButton variant="primary" onClick={() => void doExport()} disabled={exporting} icon={exporting ? <LoaderCircle size={13} className="animate-spin" /> : <Download size={13} />}>
            Exportar backup
          </HudButton>
          <HudButton variant="outline" onClick={() => fileRef.current?.click()} disabled={importing} icon={<Upload size={13} />}>
            Importar backup
          </HudButton>
          <input ref={fileRef} type="file" accept="application/json,.json" className="sr-only" tabIndex={-1} aria-hidden onChange={(e) => void pickFile(e)} />
        </div>

        {pending && (
          <div role="alertdialog" aria-label="Confirmar importação" className="border border-warn/40 bg-warn/[0.05] p-3">
            <p className="font-hud text-[12px] font-bold uppercase tracking-[0.2em] text-warn">Confirmar importação</p>
            <p className="mt-1 text-[12.5px] leading-relaxed text-muted">
              <span className="font-mono text-ink">{pending.name}</span> ({formatBytes(pending.size)}). Os dados do backup serão incorporados ao Lärk. Exporte um backup atual antes,
              por prudência.
            </p>
            <div className="mt-3 flex justify-end gap-2">
              <HudButton size="sm" variant="ghost" onClick={() => setPending(null)} disabled={importing}>
                Cancelar
              </HudButton>
              <HudButton size="sm" variant="primary" onClick={() => void doImport()} disabled={importing} icon={importing ? <LoaderCircle size={13} className="animate-spin" /> : <Upload size={13} />}>
                Importar agora
              </HudButton>
            </div>
          </div>
        )}
      </Section>
    </>
  );
}
