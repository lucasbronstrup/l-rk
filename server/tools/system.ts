/**
 * Sinais vitais do computador (CPU, memória, discos, bateria, rede, processos) e ferramentas de
 * sistema: resumo de saúde, lista/encerramento de processos e informações de rede.
 *
 * Cada medição tem seu próprio cache e tolerância a falhas: se um sensor falhar (ex.: temperatura
 * sem permissão no Windows), o resto continua funcionando.
 */
import { execFile } from 'node:child_process';
import os from 'node:os';
import si from 'systeminformation';
import { z } from 'zod';
import { foldText } from './paths.js';
import { formatBytes, optionalBool, optionalInt, parseArgs, plural, type ToolSpec } from './utility.js';
import type { SystemVitals } from '../../shared/types.js';

const isWin = process.platform === 'win32';

// ─── Cache por medição ───────────────────────────────────────────────────

function timed<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout;
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${what}: tempo esgotado`)), ms);
      timer.unref();
    }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * Memoiza uma leitura assíncrona por `ttlMs`, compartilhando chamadas simultâneas e devolvendo o
 * último valor bom quando a leitura falha. Falhas repetidas esperam `failureTtlMs` antes de tentar de novo.
 */
function memo<T>(fn: () => Promise<T>, ttlMs: number, failureTtlMs = ttlMs) {
  let value: T | undefined;
  let at = 0;
  let failedAt = 0;
  let inflight: Promise<T | undefined> | null = null;
  return async (maxAgeMs = ttlMs): Promise<T | undefined> => {
    const now = Date.now();
    if (value !== undefined && now - at < maxAgeMs) return value;
    if (value === undefined && failedAt && now - failedAt < failureTtlMs) return undefined;
    if (!inflight) {
      inflight = fn()
        .then((v) => {
          value = v;
          at = Date.now();
          failedAt = 0;
          return v;
        })
        .catch(() => {
          failedAt = Date.now();
          return value;
        })
        .finally(() => {
          inflight = null;
        });
    }
    return inflight;
  };
}

const readCpuInfo = memo(() => timed(si.cpu(), 8000, 'cpu'), Number.POSITIVE_INFINITY, 60_000);
const readOsInfo = memo(() => timed(si.osInfo(), 8000, 'osInfo'), Number.POSITIVE_INFINITY, 60_000);
const readLoad = memo(() => timed(si.currentLoad(), 4000, 'currentLoad'), 1500, 5000);
const readMem = memo(() => timed(si.mem(), 4000, 'mem'), 1500, 5000);
const readDisks = memo(() => timed(si.fsSize(), 8000, 'fsSize'), 30_000, 30_000);
const readBattery = memo(() => timed(si.battery(), 6000, 'battery'), 30_000, 60_000);
// Temperatura costuma exigir privilégios no Windows: se falhar, só tenta de novo em 5 min.
const readTemp = memo(() => timed(si.cpuTemperature(), 5000, 'cpuTemperature'), 15_000, 5 * 60_000);
const readProcesses = memo(() => timed(si.processes(), 10_000, 'processes'), 7000, 10_000);
const readDefaultIface = memo(() => timed(si.networkInterfaceDefault(), 5000, 'networkInterfaceDefault'), 30_000, 30_000);
const readIfaces = memo(
  () => timed(si.networkInterfaces() as Promise<si.Systeminformation.NetworkInterfacesData[]>, 8000, 'networkInterfaces'),
  30_000,
  30_000,
);

/** Nome do sistema operacional por extenso (ex.: "Microsoft Windows 11 Pro 10.0.22631"). */
export async function getOsDescription(): Promise<string> {
  const info = await readOsInfo();
  if (info?.distro) return [info.distro, info.release].filter(Boolean).join(' ').trim();
  return `${os.type()} ${os.release()}`;
}

// ─── Sinais vitais ───────────────────────────────────────────────────────

const EXCLUDED_FS = /^(tmpfs|devtmpfs|squashfs|overlay|ramfs|proc|sysfs|cgroup2?|autofs|efivarfs|nsfs|devfs|fuse\.(snapfuse|portal|gvfsd-fuse))$/i;
const EXCLUDED_MOUNT =
  /^\/(snap|run|dev|sys|proc|boot\/efi|var\/lib\/docker)(\/|$)|^\/System\/Volumes\/(?!Data$)|^\/private\/var\/vm/;

function pickDisks(list: si.Systeminformation.FsSizeData[]): SystemVitals['disks'] {
  const seen = new Set<string>();
  const result: SystemVitals['disks'] = [];
  const hasMacData = list.some((d) => d.mount === '/System/Volumes/Data');
  for (const d of list) {
    if (!d || !(d.size > 0) || EXCLUDED_FS.test(d.type ?? '') || EXCLUDED_MOUNT.test(d.mount ?? '')) continue;
    // macOS: "/" e "/System/Volumes/Data" dividem o mesmo contêiner APFS; mostra um só, como "/".
    if (hasMacData && d.mount === '/') continue;
    const key = `${d.fs}|${d.size}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const isApfs = process.platform === 'darwin' && Number.isFinite(d.available) && d.available >= 0;
    const used = isApfs ? d.size - d.available : d.used;
    result.push({
      mount: d.mount === '/System/Volumes/Data' ? '/' : d.mount,
      totalBytes: d.size,
      usedBytes: Math.max(0, used),
      usedPct: Math.round((Number.isFinite(d.use) && !isApfs ? d.use : (used / d.size) * 100) * 10) / 10,
    });
  }
  return result.slice(0, 8);
}

async function networkSnapshot(): Promise<SystemVitals['network']> {
  const iface = await readDefaultIface();
  if (!iface) return null;
  const ifaces = (await readIfaces()) ?? [];
  const info = ifaces.find((i) => i.iface === iface);
  let rx: number | null = null;
  let tx: number | null = null;
  try {
    const stats = await timed(si.networkStats(iface), 4000, 'networkStats');
    const s = stats[0];
    if (s) {
      rx = Number.isFinite(s.rx_sec) && s.rx_sec >= 0 ? s.rx_sec : null;
      tx = Number.isFinite(s.tx_sec) && s.tx_sec >= 0 ? s.tx_sec : null;
    }
  } catch {
    // Sem taxa nesta leitura.
  }
  return { iface: info?.ifaceName || iface, ip4: info?.ip4 || null, rxSec: rx, txSec: tx };
}

const round1 = (n: number) => Math.round(n * 10) / 10;

/** Número com vírgula decimal (pt-BR). */
const pt = (n: number) => n.toLocaleString('pt-BR', { maximumFractionDigits: 1 });

/** Esconde o processo ocioso do Windows e os auxiliares do próprio Lärk (ex.: o "ps" usado na medição). */
function isUserVisibleProcess(p: si.Systeminformation.ProcessesProcessData): boolean {
  return p.pid > 0 && Boolean(p.name) && p.parentPid !== process.pid && !/^(System Idle Process|Idle)$/i.test(p.name);
}

async function collectVitals(): Promise<SystemVitals> {
  const [cpuInfo, osInfo, load, mem, disks, battery, temp, procs, network] = await Promise.all([
    readCpuInfo(),
    readOsInfo(),
    readLoad(),
    readMem(),
    readDisks(),
    readBattery(),
    readTemp(),
    readProcesses(),
    networkSnapshot().catch(() => null),
  ]);

  const cpus = os.cpus();
  const totalMem = mem?.total ?? os.totalmem();
  // "available" desconsidera cache/buffers (o "usado" real que o usuário espera ver).
  const usedMem = mem ? mem.total - (Number.isFinite(mem.available) ? mem.available : mem.free) : os.totalmem() - os.freemem();
  const loadPct = load && Number.isFinite(load.currentLoad) ? load.currentLoad : cpus.length ? (os.loadavg()[0] / cpus.length) * 100 : 0;
  const tempC = temp && Number.isFinite(temp.main) && temp.main > 0 ? round1(temp.main) : null;

  return {
    hostname: os.hostname(),
    platform: process.platform,
    osName: osInfo?.distro ? [osInfo.distro, osInfo.release].filter(Boolean).join(' ') : `${os.type()} ${os.release()}`,
    uptimeSec: Math.round(os.uptime()),
    cpu: {
      model: cpuInfo ? [cpuInfo.manufacturer, cpuInfo.brand].filter(Boolean).join(' ').trim() || cpus[0]?.model || '' : cpus[0]?.model?.trim() || '',
      cores: cpuInfo?.cores || cpus.length,
      loadPct: round1(Math.min(100, Math.max(0, loadPct))),
      tempC,
    },
    memory: { totalBytes: totalMem, usedBytes: Math.max(0, usedMem), usedPct: totalMem ? round1((usedMem / totalMem) * 100) : 0 },
    disks: disks ? pickDisks(disks) : [],
    battery: {
      hasBattery: Boolean(battery?.hasBattery),
      percent: battery?.hasBattery && Number.isFinite(battery.percent) ? battery.percent : null,
      charging: battery?.hasBattery ? Boolean(battery.isCharging || battery.acConnected) : null,
    },
    network,
    topProcesses: (procs?.list ?? [])
      .filter(isUserVisibleProcess)
      .sort((a, b) => (b.cpu || 0) - (a.cpu || 0))
      .slice(0, 6)
      .map((p) => ({ pid: p.pid, name: p.name, cpuPct: round1(p.cpu || 0), memPct: round1(p.mem || 0) })),
  };
}

let vitalsCache: { at: number; value: SystemVitals } | null = null;
let vitalsInflight: Promise<SystemVitals> | null = null;

/** Sinais vitais do computador (cache de 2 s; cada sensor falha de forma independente). */
export async function getSystemVitals(): Promise<SystemVitals> {
  if (vitalsCache && Date.now() - vitalsCache.at < 2000) return vitalsCache.value;
  if (!vitalsInflight) {
    vitalsInflight = collectVitals()
      .then((value) => {
        vitalsCache = { at: Date.now(), value };
        return value;
      })
      .finally(() => {
        vitalsInflight = null;
      });
  }
  return vitalsInflight;
}

function formatUptime(sec: number): string {
  const d = Math.floor(sec / 86_400);
  const h = Math.floor((sec % 86_400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d > 0) return `${d} d ${h} h`;
  if (h > 0) return `${h} h ${m} min`;
  return `${m} min`;
}

// ─── Ferramentas ─────────────────────────────────────────────────────────

const systemStatus: ToolSpec = {
  name: 'system_status',
  label: 'Lendo os sinais vitais',
  group: 'computer',
  risk: 'safe',
  description:
    'Mostra a saúde do computador agora: uso de CPU (e temperatura), memória RAM, espaço em cada disco, bateria, ' +
    'rede e os processos que mais consomem. Use quando o usuário perguntar como está o PC, se está lento, ' +
    'quanto espaço sobra, quanto de bateria tem, etc. Inclui alertas (disco quase cheio, RAM no limite...).',
  parameters: { type: 'object', properties: {} },
  async execute() {
    const v = await getSystemVitals();
    const warnings: string[] = [];
    if (v.cpu.loadPct >= 90) warnings.push(`CPU muito ocupada (${pt(v.cpu.loadPct)}%).`);
    if (v.cpu.tempC !== null && v.cpu.tempC >= 85) warnings.push(`CPU quente (${pt(v.cpu.tempC)} °C).`);
    if (v.memory.usedPct >= 90) warnings.push(`Memória quase esgotada (${pt(v.memory.usedPct)}%).`);
    for (const d of v.disks) {
      if (d.usedPct >= 90) warnings.push(`Disco ${d.mount} quase cheio (${pt(d.usedPct)}%, livres ${formatBytes(d.totalBytes - d.usedBytes)}).`);
    }
    if (v.battery.hasBattery && v.battery.percent !== null && v.battery.percent <= 20 && !v.battery.charging) {
      warnings.push(`Bateria baixa (${v.battery.percent}%) e fora da tomada.`);
    }
    const lines = [
      `CPU ${pt(v.cpu.loadPct)}% (${v.cpu.cores} núcleos${v.cpu.tempC !== null ? `, ${pt(v.cpu.tempC)} °C` : ''})`,
      `RAM ${formatBytes(v.memory.usedBytes)} de ${formatBytes(v.memory.totalBytes)} (${pt(v.memory.usedPct)}%)`,
      ...v.disks.map((d) => `Disco ${d.mount}: ${formatBytes(d.usedBytes)} de ${formatBytes(d.totalBytes)} (${pt(d.usedPct)}%)`),
      v.battery.hasBattery && v.battery.percent !== null
        ? `Bateria ${v.battery.percent}%${v.battery.charging ? ' (carregando)' : ''}`
        : 'Sem bateria (desktop ou na tomada)',
      `Ligado há ${formatUptime(v.uptimeSec)}`,
    ];
    return {
      output: {
        summary: lines.join(' · '),
        warnings,
        computer: { hostname: v.hostname, os: v.osName, cpuModel: v.cpu.model },
        cpu: v.cpu,
        memory: { ...v.memory, used: formatBytes(v.memory.usedBytes), total: formatBytes(v.memory.totalBytes) },
        disks: v.disks.map((d) => ({ ...d, free: formatBytes(d.totalBytes - d.usedBytes), total: formatBytes(d.totalBytes) })),
        battery: v.battery,
        network: v.network,
        uptime: formatUptime(v.uptimeSec),
        topProcesses: v.topProcesses,
      },
      summary: `CPU ${pt(v.cpu.loadPct)}% · RAM ${pt(v.memory.usedPct)}%${warnings.length ? ` · ${plural(warnings.length, 'alerta', 'alertas')}` : ''}`,
    };
  },
};

const listProcesses: ToolSpec = {
  name: 'list_processes',
  label: 'Listando processos',
  group: 'computer',
  risk: 'safe',
  description:
    'Lista os processos em execução (programas abertos e serviços) com PID, uso de CPU e memória, ordenados ' +
    'por consumo. Também agrupa por nome do programa (ex.: todas as abas do Chrome somadas). Use para descobrir ' +
    'o que está deixando o computador lento ou para achar o PID antes de encerrar algo.',
  parameters: {
    type: 'object',
    properties: {
      sort: { type: 'string', enum: ['cpu', 'memory', 'name'], description: 'Ordenação (padrão "cpu").' },
      limit: { type: 'integer', minimum: 1, maximum: 60, description: 'Quantidade máxima (padrão 15).' },
      filter: { type: 'string', description: 'Filtra pelo nome do processo (parcial, sem diferenciar maiúsculas).' },
    },
  },
  async execute(args) {
    const a = parseArgs(
      'list_processes',
      z.object({
        sort: z.enum(['cpu', 'memory', 'name']).nullish(),
        limit: optionalInt(1, 60),
        filter: z.string().trim().nullish(),
      }),
      args,
    );
    const data = await readProcesses(3000);
    if (!data) throw new Error('Não consegui ler a lista de processos agora.');
    const filter = a.filter ? foldText(a.filter) : '';
    let list = data.list.filter(isUserVisibleProcess);
    if (filter) list = list.filter((p) => foldText(p.name).includes(filter) || foldText(p.command ?? '').includes(filter));
    const sort = a.sort ?? 'cpu';
    list.sort((x, y) =>
      sort === 'name' ? x.name.localeCompare(y.name) : sort === 'memory' ? (y.memRss || 0) - (x.memRss || 0) : (y.cpu || 0) - (x.cpu || 0),
    );
    const limit = a.limit ?? 15;

    const groups = new Map<string, { name: string; count: number; cpuPct: number; memBytes: number }>();
    for (const p of list) {
      const key = foldText(p.name.replace(/\.exe$/i, ''));
      const g = groups.get(key) ?? { name: p.name, count: 0, cpuPct: 0, memBytes: 0 };
      g.count++;
      g.cpuPct += p.cpu || 0;
      g.memBytes += (p.memRss || 0) * 1024;
      groups.set(key, g);
    }
    const apps = [...groups.values()]
      .sort((x, y) => (sort === 'memory' ? y.memBytes - x.memBytes : y.cpuPct - x.cpuPct))
      .slice(0, 10)
      .map((g) => ({ name: g.name, processes: g.count, cpuPct: round1(g.cpuPct), memory: formatBytes(g.memBytes) }));

    return {
      output: {
        total: data.all,
        matched: list.length,
        sortedBy: sort,
        processes: list.slice(0, limit).map((p) => ({
          pid: p.pid,
          name: p.name,
          cpuPct: round1(p.cpu || 0),
          memPct: round1(p.mem || 0),
          memory: formatBytes((p.memRss || 0) * 1024),
          user: p.user || undefined,
          command: (p.path || p.command || '').slice(0, 200) || undefined,
        })),
        topApps: apps,
      },
      summary: `${plural(list.length, 'processo', 'processos')}${filter ? ` com "${a.filter}"` : ''}; top: ${apps
        .slice(0, 3)
        .map((g) => g.name)
        .join(', ')}`,
    };
  },
};

/** Processos que nunca devem ser encerrados (derrubariam o sistema ou a sessão). */
const CRITICAL_PROCESSES = new Set(
  [
    'system',
    'registry',
    'smss',
    'csrss',
    'wininit',
    'winlogon',
    'services',
    'lsass',
    'lsaiso',
    'svchost',
    'fontdrvhost',
    'dwm',
    'memory compression',
    'secure system',
    'launchd',
    'kernel_task',
    'windowserver',
    'loginwindow',
    'systemd',
    'init',
    'kthreadd',
    'xorg',
    'xwayland',
    'gnome-shell',
    'kwin_wayland',
    'kwin_x11',
    'sddm',
    'gdm',
    'dbus-daemon',
  ].map(foldText),
);

function processKey(name: string): string {
  return foldText(name.replace(/\.(exe|app)$/i, ''));
}

function protectedPidReason(pid: number, name?: string): string | null {
  if (pid === process.pid) return 'é o próprio Lärk';
  if (pid === process.ppid) return 'é o processo que mantém o Lärk rodando';
  if (pid <= 1 || (isWin && pid <= 4)) return 'é um processo essencial do sistema';
  if (name && CRITICAL_PROCESSES.has(processKey(name))) return 'é um processo essencial do sistema';
  return null;
}

function killPid(pid: number, force: boolean): Promise<void> {
  if (isWin) {
    return new Promise((resolve, reject) => {
      const args = ['/PID', String(pid), '/T', ...(force ? ['/F'] : [])];
      execFile('taskkill', args, { windowsHide: true, timeout: 15_000 }, (error, _stdout, stderr) => {
        if (!error) return resolve();
        // Sem /F, apps sem janela podem recusar o pedido educado: tenta à força.
        if (!force) {
          try {
            process.kill(pid);
            return resolve();
          } catch {
            // segue para o erro original
          }
        }
        reject(new Error(String(stderr || error.message).trim()));
      });
    });
  }
  try {
    process.kill(pid, force ? 'SIGKILL' : 'SIGTERM');
    return Promise.resolve();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return Promise.reject(
      new Error(code === 'EPERM' ? 'sem permissão (processo de outro usuário ou do sistema)' : code === 'ESRCH' ? 'processo não existe mais' : String(error)),
    );
  }
}

const killProcess: ToolSpec = {
  name: 'kill_process',
  label: 'Encerrando processo',
  group: 'computer',
  risk: 'dangerous',
  description:
    'Encerra um processo pelo PID ou todos os processos com um nome (ex.: "chrome", "notepad.exe"). ' +
    'Por padrão pede para fechar educadamente; use force=true só se o programa estiver travado (pode perder dados não salvos). ' +
    'Use list_processes antes para confirmar o nome/PID. Processos essenciais do sistema são protegidos.',
  parameters: {
    type: 'object',
    properties: {
      pid: { type: 'integer', description: 'PID do processo.' },
      name: { type: 'string', description: 'Nome do processo (encerra todas as instâncias). Use pid OU name.' },
      force: { type: 'boolean', description: 'Forçar o encerramento imediato (padrão false).' },
    },
  },
  describe: (args) => {
    const force = args.force === true || args.force === 'true' ? ' à força' : '';
    if (args.pid !== undefined && args.pid !== null && args.pid !== '') return `Encerrar${force} o processo PID ${String(args.pid)}`;
    return `Encerrar${force} todos os processos chamados "${String(args.name ?? '')}"`;
  },
  async execute(args) {
    const a = parseArgs(
      'kill_process',
      z
        .object({
          pid: z.coerce.number().int('PID deve ser inteiro').positive('PID inválido').nullish(),
          name: z.string().trim().min(1).nullish(),
          force: optionalBool,
        })
        .refine((v) => v.pid || v.name, { message: 'informe pid ou name' }),
      args,
    );
    const force = Boolean(a.force);
    const data = await readProcesses(0);
    const list = data?.list ?? [];

    let targets: { pid: number; name: string }[];
    if (a.pid) {
      const found = list.find((p) => p.pid === a.pid);
      targets = [{ pid: a.pid, name: found?.name ?? `PID ${a.pid}` }];
    } else {
      const key = processKey(a.name!);
      targets = list.filter((p) => processKey(p.name) === key).map((p) => ({ pid: p.pid, name: p.name }));
      if (targets.length === 0) {
        const similar = [...new Set(list.filter((p) => processKey(p.name).includes(key)).map((p) => p.name))].slice(0, 8);
        throw new Error(
          `Nenhum processo chamado "${a.name}" está rodando.${similar.length ? ` Parecidos: ${similar.join(', ')}.` : ' Use list_processes para ver os nomes.'}`,
        );
      }
      if (targets.length > 80) throw new Error(`"${a.name}" corresponde a ${targets.length} processos — seja mais específico ou use o PID.`);
    }

    const killed: { pid: number; name: string }[] = [];
    const failed: { pid: number; name: string; reason: string }[] = [];
    for (const t of targets) {
      const reason = protectedPidReason(t.pid, t.name);
      if (reason) {
        failed.push({ ...t, reason: `protegido: ${reason}` });
        continue;
      }
      try {
        await killPid(t.pid, force);
        killed.push(t);
      } catch (error) {
        failed.push({ ...t, reason: error instanceof Error ? error.message : String(error) });
      }
    }
    if (killed.length === 0) {
      throw new Error(`Não consegui encerrar: ${failed.map((f) => `${f.name} (PID ${f.pid}) — ${f.reason}`).join('; ')}`);
    }
    return {
      output: { ok: true, force, killed, ...(failed.length ? { failed } : {}) },
      summary: `${plural(killed.length, 'processo encerrado', 'processos encerrados')}: ${[...new Set(killed.map((k) => k.name))].join(', ')}`,
    };
  },
};

const networkInfo: ToolSpec = {
  name: 'network_info',
  label: 'Verificando a rede',
  group: 'computer',
  risk: 'safe',
  description:
    'Informações de rede: interfaces ativas (IP local, MAC, tipo, velocidade), Wi-Fi conectado (nome e sinal), ' +
    'taxa atual de download/upload e latência até a internet. Use para "estou conectado?", "qual meu IP local?", ' +
    '"a internet está lenta?".',
  parameters: { type: 'object', properties: {} },
  async execute() {
    const [ifaces, defaultIface, wifi, latency, snapshot] = await Promise.all([
      readIfaces(0),
      readDefaultIface(),
      timed(si.wifiConnections(), 6000, 'wifi').catch(() => []),
      timed(si.inetLatency('8.8.8.8'), 6000, 'latency').catch(() => null),
      networkSnapshot().catch(() => null),
    ]);
    const active = (ifaces ?? []).filter((i) => !i.internal && (i.ip4 || i.ip6) && i.operstate !== 'down');
    const online = typeof latency === 'number' && Number.isFinite(latency) && latency >= 0;
    const conn = wifi[0];
    return {
      output: {
        online,
        latencyMs: online ? Math.round(latency) : null,
        defaultInterface: defaultIface ?? null,
        interfaces: active.slice(0, 10).map((i) => ({
          name: i.ifaceName || i.iface,
          type: i.type === 'wireless' ? 'Wi-Fi' : i.type === 'wired' ? 'cabo' : i.type || 'desconhecido',
          ip4: i.ip4 || null,
          ip6: i.ip6 || null,
          mac: i.mac || null,
          speedMbps: i.speed ?? null,
          virtual: i.virtual || undefined,
          default: i.iface === defaultIface || undefined,
        })),
        wifi: conn ? { ssid: conn.ssid, signalDbm: conn.signalLevel, quality: conn.quality } : null,
        rates: snapshot ? { downloadPerSec: snapshot.rxSec !== null ? formatBytes(snapshot.rxSec) : null, uploadPerSec: snapshot.txSec !== null ? formatBytes(snapshot.txSec) : null } : null,
      },
      summary: online ? `Online · latência ${Math.round(latency as number)} ms${conn ? ` · Wi-Fi "${conn.ssid}"` : ''}` : 'Sem resposta da internet',
    };
  },
};

export const systemTools: ToolSpec[] = [systemStatus, listProcesses, killProcess, networkInfo];
