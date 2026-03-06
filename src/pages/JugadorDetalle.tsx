import { useState } from "react";
import { useParams, Link } from "react-router-dom";
import DashboardLayout from "@/components/DashboardLayout";
import { getPlayers } from "@/lib/playerStore";
import { computeFisica } from "@/lib/charRulesStore";
import {
  Calificacion,
  PotenciaExpRecord,
  AgilidadRecord,
  SprintRecord,
  BiomecanicaRecord,
  ResistenciaInterRecord,
  VO2Record,
} from "@/types/player";
import {
  ArrowLeft, Trophy, Video, TrendingDown, TrendingUp,
  Timer, Zap, Wind, Activity, Heart, Gauge,
} from "lucide-react";

// ── helpers ───────────────────────────────────────────────────────────────────

function fmt(v: number) { return v.toFixed(2); }
function fmtDate(d: string) {
  const [y, m, day] = d.split("-");
  return `${day}/${m}/${y}`;
}

// ── Calificacion badge ────────────────────────────────────────────────────────

function CalBadge({ cal }: { cal: Calificacion }) {
  const styles: Record<Calificacion, string> = {
    bueno:   "bg-green-500/15 text-green-400 border-green-500/30",
    promedio:"bg-yellow-500/15 text-yellow-400 border-yellow-500/30",
    bajo:    "bg-red-500/15 text-red-400 border-red-500/30",
  };
  const labels: Record<Calificacion, string> = {
    bueno: "Bueno", promedio: "Promedio", bajo: "Bajo",
  };
  return (
    <span className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold capitalize ${styles[cal]}`}>
      {labels[cal]}
    </span>
  );
}

// ── Calificacion circular indicator ───────────────────────────────────────────

const CAL_META: Record<Calificacion, { color: string; stroke: string; pct: number }> = {
  bueno:   { color: "hsl(142 71% 45%)", stroke: "hsl(142 71% 45%)", pct: 0.85 },
  promedio:{ color: "hsl(48 96% 53%)",  stroke: "hsl(48 96% 53%)",  pct: 0.52 },
  bajo:    { color: "hsl(0 84% 60%)",   stroke: "hsl(0 84% 60%)",   pct: 0.22 },
};
const CIRC = 2 * Math.PI * 36; // r=36 → ≈ 226.2

function CalCircle({ cal, size = 80 }: { cal: Calificacion | null; size?: number }) {
  const meta = cal ? CAL_META[cal] : null;
  const dash = meta ? meta.pct * CIRC : 0;
  const labels: Record<Calificacion, string> = { bueno: "Bueno", promedio: "Prom.", bajo: "Bajo" };
  return (
    <div className="relative" style={{ width: size, height: size }}>
      <svg viewBox="0 0 100 100" className="w-full h-full -rotate-90">
        <circle cx="50" cy="50" r="36" fill="none" stroke="hsl(220 14% 18%)" strokeWidth="8" />
        {meta && (
          <circle
            cx="50" cy="50" r="36" fill="none"
            stroke={meta.stroke} strokeWidth="8" strokeLinecap="round"
            strokeDasharray={`${dash} ${CIRC}`}
            className="transition-all duration-700"
          />
        )}
      </svg>
      <div className="absolute inset-0 flex items-center justify-center">
        {cal ? (
          <span className="text-[11px] font-bold leading-none text-center" style={{ color: meta!.color }}>
            {labels[cal]}
          </span>
        ) : (
          <span className="text-[10px] text-muted-foreground">—</span>
        )}
      </div>
    </div>
  );
}


// ── Evolution bar for 40m ─────────────────────────────────────────────────────

function EvoBars({ history, getValue, label }: {
  history: { date: string }[];
  getValue: (r: unknown) => number;
  label: string;
}) {
  const values = history.map(getValue);
  const min = Math.min(...values), max = Math.max(...values), range = max - min || 0.1;
  return (
    <div className="flex items-end gap-2 h-20 mt-3">
      {history.map((rec, i) => {
        const v = getValue(rec);
        const isLast = i === history.length - 1;
        const h = Math.max(18, ((max - v) / range) * 75 + 18);
        const delta = i > 0 ? v - getValue(history[i - 1]) : null;
        return (
          <div key={rec.date} className="flex flex-col items-center gap-1 flex-1">
            <span className="text-[10px] font-bold tabular-nums" style={{ color: isLast ? "hsl(22 100% 52%)" : "hsl(0 0% 55%)" }}>
              {fmt(v)}{label}
            </span>
            {delta !== null && (
              <span className={`text-[9px] font-semibold ${delta < 0 ? "text-green-400" : "text-red-400"}`}>
                {delta < 0 ? "↓" : "↑"}{Math.abs(delta).toFixed(2)}
              </span>
            )}
            <div className="w-full rounded-t-md" style={{
              height: `${h}%`,
              background: isLast
                ? "linear-gradient(180deg, hsl(22 100% 55%), hsl(22 100% 38%))"
                : "hsl(0 0% 22%)",
            }} />
            <span className="text-[9px] text-muted-foreground">{fmtDate(rec.date).slice(0, 5)}</span>
          </div>
        );
      })}
    </div>
  );
}

// ── Empty state ───────────────────────────────────────────────────────────────

function EmptyTab({ label }: { label: string }) {
  return (
    <div className="flex flex-col items-center justify-center py-16 text-center">
      <div className="h-12 w-12 rounded-2xl bg-surface flex items-center justify-center mb-3">
        <Activity className="h-5 w-5 text-muted-foreground" />
      </div>
      <p className="text-sm font-medium text-foreground">Sin registros de {label}</p>
      <p className="text-xs text-muted-foreground mt-1">Los resultados del análisis aparecerán aquí</p>
    </div>
  );
}

// ── Tab: Potencia Explosiva Inicial ───────────────────────────────────────────

function TabPotencia({ history }: { history?: PotenciaExpRecord[] }) {
  if (!history?.length) return <EmptyTab label="Potencia Explosiva" />;
  const latest = history[history.length - 1];
  return (
    <div className="space-y-5">
      <div className="grid grid-cols-3 gap-3">
        <div className="rounded-xl bg-surface p-4 text-center">
          <p className="text-xs text-muted-foreground uppercase tracking-wider mb-1">10m</p>
          <p className="font-display font-bold text-2xl text-foreground tabular-nums">{fmt(latest.t10)}s</p>
        </div>
        <div className="rounded-xl bg-surface p-4 text-center">
          <p className="text-xs text-muted-foreground uppercase tracking-wider mb-1">20m</p>
          <p className="font-display font-bold text-2xl text-foreground tabular-nums">{fmt(latest.t20)}s</p>
        </div>
        <div className="rounded-xl bg-surface p-4 text-center flex flex-col items-center justify-center gap-2">
          <p className="text-xs text-muted-foreground uppercase tracking-wider">Calificación</p>
          <CalBadge cal={latest.calificacion} />
        </div>
      </div>
      {history.length > 1 && (
        <div className="rounded-xl border border-border bg-card p-4">
          <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-1">Evolución 10m</p>
          <EvoBars history={history} getValue={r => (r as PotenciaExpRecord).t10} label="s" />
        </div>
      )}
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border">
            {["Fecha", "10m", "20m", "Calificación", "Notas"].map(h => (
              <th key={h} className="text-left text-xs font-medium text-muted-foreground uppercase tracking-wider py-2.5 px-2 first:pl-0">{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {[...history].reverse().map((rec, i) => (
            <tr key={rec.date} className={`border-b border-border/50 ${i === 0 ? "bg-primary/4" : ""}`}>
              <td className="py-3 pl-0 px-2 font-medium whitespace-nowrap text-foreground">
                {fmtDate(rec.date)}{i === 0 && <span className="ml-1 text-[10px] text-primary font-semibold">último</span>}
              </td>
              <td className="py-3 px-2 tabular-nums text-foreground">{fmt(rec.t10)}s</td>
              <td className="py-3 px-2 tabular-nums text-foreground">{fmt(rec.t20)}s</td>
              <td className="py-3 px-2"><CalBadge cal={rec.calificacion} /></td>
              <td className="py-3 px-2 text-muted-foreground text-xs">{rec.notes ?? "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── Tab: Agilidad ─────────────────────────────────────────────────────────────

function TabAgilidad({ history }: { history?: AgilidadRecord[] }) {
  if (!history?.length) return <EmptyTab label="Agilidad" />;
  const latest = history[history.length - 1];
  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3">
        <div className="rounded-xl bg-surface p-4 text-center">
          <p className="text-xs text-muted-foreground uppercase tracking-wider mb-1">Tiempo Test</p>
          <p className="font-display font-bold text-2xl text-foreground tabular-nums">{fmt(latest.tiempo)}s</p>
        </div>
        <div className="rounded-xl bg-surface p-4 text-center flex flex-col items-center justify-center gap-2">
          <p className="text-xs text-muted-foreground uppercase tracking-wider">Calificación</p>
          <CalBadge cal={latest.calificacion} />
        </div>
      </div>
      {history.length > 1 && (
        <div className="rounded-xl border border-border bg-card p-4">
          <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-1">Evolución Agilidad</p>
          <EvoBars history={history} getValue={r => (r as AgilidadRecord).tiempo} label="s" />
        </div>
      )}
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border">
            {["Fecha", "Tiempo", "Calificación", "Notas"].map(h => (
              <th key={h} className="text-left text-xs font-medium text-muted-foreground uppercase tracking-wider py-2.5 px-2 first:pl-0">{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {[...history].reverse().map((rec, i) => (
            <tr key={rec.date} className={`border-b border-border/50 ${i === 0 ? "bg-primary/4" : ""}`}>
              <td className="py-3 pl-0 px-2 font-medium whitespace-nowrap text-foreground">
                {fmtDate(rec.date)}{i === 0 && <span className="ml-1 text-[10px] text-primary font-semibold">último</span>}
              </td>
              <td className="py-3 px-2 tabular-nums text-foreground">{fmt(rec.tiempo)}s</td>
              <td className="py-3 px-2"><CalBadge cal={rec.calificacion} /></td>
              <td className="py-3 px-2 text-muted-foreground text-xs">{rec.notes ?? "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── Tab: Velocidad 40m ────────────────────────────────────────────────────────

function TabVelocidad({ history }: { history?: SprintRecord[] }) {
  if (!history?.length) return <EmptyTab label="Velocidad 40m" />;
  const latest = history[history.length - 1];
  return (
    <div className="space-y-5">
      <div className="grid grid-cols-4 gap-3">
        {(["t10","t20","t30","t40"] as const).map((k, i) => (
          <div key={k} className="rounded-xl bg-surface p-4 text-center">
            <p className="text-xs text-muted-foreground uppercase tracking-wider mb-1">{["10m","20m","30m","40m"][i]}</p>
            <p className="font-display font-bold text-xl text-foreground tabular-nums">{fmt(latest[k])}s</p>
          </div>
        ))}
      </div>
      {history.length > 1 && (
        <div className="rounded-xl border border-border bg-card p-4">
          <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-1">Evolución 40m</p>
          <EvoBars history={history} getValue={r => (r as SprintRecord).t40} label="s" />
        </div>
      )}
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border">
            {["Fecha","10m","20m","30m","40m"].map(h => (
              <th key={h} className="text-left text-xs font-medium text-muted-foreground uppercase tracking-wider py-2.5 px-2 first:pl-0">{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {[...history].reverse().map((rec, i) => (
            <tr key={rec.date} className={`border-b border-border/50 ${i === 0 ? "bg-primary/4" : ""}`}>
              <td className="py-3 pl-0 px-2 font-medium whitespace-nowrap text-foreground">
                {fmtDate(rec.date)}{i === 0 && <span className="ml-1 text-[10px] text-primary font-semibold">último</span>}
              </td>
              <td className="py-3 px-2 tabular-nums">{fmt(rec.t10)}s</td>
              <td className="py-3 px-2 tabular-nums">{fmt(rec.t20)}s</td>
              <td className="py-3 px-2 tabular-nums">{fmt(rec.t30)}s</td>
              <td className="py-3 px-2 tabular-nums font-bold text-primary">{fmt(rec.t40)}s</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── Tab: Biomecánica de Carrera ───────────────────────────────────────────────

function TabBiomecanica({ history }: { history?: BiomecanicaRecord[] }) {
  if (!history?.length) return <EmptyTab label="Biomecánica" />;
  const latest = history[history.length - 1];
  return (
    <div className="space-y-5">
      <div className="grid grid-cols-4 gap-3">
        {([
          ["Cadera",  latest.hipAngle,   "#eab308"],
          ["Rodilla", latest.kneeAngle,  "#22c55e"],
          ["Tobillo", latest.ankleAngle, "#3b82f6"],
        ] as [string, number, string][]).map(([label, val, color]) => (
          <div key={label} className="rounded-xl bg-surface p-4 text-center">
            <p className="text-xs text-muted-foreground uppercase tracking-wider mb-1">{label}</p>
            <p className="font-display font-bold text-2xl tabular-nums" style={{ color }}>{val}°</p>
          </div>
        ))}
        <div className="rounded-xl bg-surface p-4 text-center flex flex-col items-center justify-center gap-2">
          <p className="text-xs text-muted-foreground uppercase tracking-wider">Calificación</p>
          <CalBadge cal={latest.calificacion} />
        </div>
      </div>
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border">
            {["Fecha","Cadera°","Rodilla°","Tobillo°","Calificación"].map(h => (
              <th key={h} className="text-left text-xs font-medium text-muted-foreground uppercase tracking-wider py-2.5 px-2 first:pl-0">{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {[...history].reverse().map((rec, i) => (
            <tr key={rec.date} className={`border-b border-border/50 ${i === 0 ? "bg-primary/4" : ""}`}>
              <td className="py-3 pl-0 px-2 font-medium whitespace-nowrap text-foreground">
                {fmtDate(rec.date)}{i === 0 && <span className="ml-1 text-[10px] text-primary font-semibold">último</span>}
              </td>
              <td className="py-3 px-2 tabular-nums text-yellow-400">{rec.hipAngle}°</td>
              <td className="py-3 px-2 tabular-nums text-green-400">{rec.kneeAngle}°</td>
              <td className="py-3 px-2 tabular-nums text-blue-400">{rec.ankleAngle}°</td>
              <td className="py-3 px-2"><CalBadge cal={rec.calificacion} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── Tab: Resistencia Intermitente ─────────────────────────────────────────────

function TabResistenciaInter({ history }: { history?: ResistenciaInterRecord[] }) {
  if (!history?.length) return <EmptyTab label="Resistencia Intermitente" />;
  const latest = history[history.length - 1];
  return (
    <div className="space-y-5">
      <div className="grid grid-cols-3 gap-3">
        <div className="rounded-xl bg-surface p-4 text-center">
          <p className="text-xs text-muted-foreground uppercase tracking-wider mb-1">Nivel</p>
          <p className="font-display font-bold text-2xl text-foreground tabular-nums">{latest.nivel}</p>
        </div>
        <div className="rounded-xl bg-surface p-4 text-center">
          <p className="text-xs text-muted-foreground uppercase tracking-wider mb-1">Distancia</p>
          <p className="font-display font-bold text-2xl text-foreground tabular-nums">{latest.distancia}m</p>
        </div>
        <div className="rounded-xl bg-surface p-4 text-center flex flex-col items-center justify-center gap-2">
          <p className="text-xs text-muted-foreground uppercase tracking-wider">Calificación</p>
          <CalBadge cal={latest.calificacion} />
        </div>
      </div>
      {history.length > 1 && (
        <div className="rounded-xl border border-border bg-card p-4">
          <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-1">Evolución Distancia</p>
          <EvoBars history={history} getValue={r => (r as ResistenciaInterRecord).distancia} label="m" />
        </div>
      )}
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border">
            {["Fecha","Nivel","Distancia","Calificación"].map(h => (
              <th key={h} className="text-left text-xs font-medium text-muted-foreground uppercase tracking-wider py-2.5 px-2 first:pl-0">{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {[...history].reverse().map((rec, i) => (
            <tr key={rec.date} className={`border-b border-border/50 ${i === 0 ? "bg-primary/4" : ""}`}>
              <td className="py-3 pl-0 px-2 font-medium whitespace-nowrap text-foreground">
                {fmtDate(rec.date)}{i === 0 && <span className="ml-1 text-[10px] text-primary font-semibold">último</span>}
              </td>
              <td className="py-3 px-2 tabular-nums text-foreground">{rec.nivel}</td>
              <td className="py-3 px-2 tabular-nums text-foreground">{rec.distancia}m</td>
              <td className="py-3 px-2"><CalBadge cal={rec.calificacion} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── Tab: VO2 / Potencia Aeróbica ──────────────────────────────────────────────

function TabVO2({ history }: { history?: VO2Record[] }) {
  if (!history?.length) return <EmptyTab label="VO2" />;
  const latest = history[history.length - 1];
  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3">
        <div className="rounded-xl bg-surface p-4 text-center">
          <p className="text-xs text-muted-foreground uppercase tracking-wider mb-1">VO2 máx</p>
          <p className="font-display font-bold text-3xl text-foreground tabular-nums">{latest.vo2max.toFixed(1)}</p>
          <p className="text-xs text-muted-foreground mt-0.5">ml·kg⁻¹·min⁻¹</p>
        </div>
        <div className="rounded-xl bg-surface p-4 text-center flex flex-col items-center justify-center gap-2">
          <p className="text-xs text-muted-foreground uppercase tracking-wider">Calificación</p>
          <CalBadge cal={latest.calificacion} />
        </div>
      </div>
      {history.length > 1 && (
        <div className="rounded-xl border border-border bg-card p-4">
          <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-1">Evolución VO2 máx</p>
          <EvoBars history={history} getValue={r => (r as VO2Record).vo2max} label="" />
        </div>
      )}
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border">
            {["Fecha","VO2 máx","Calificación"].map(h => (
              <th key={h} className="text-left text-xs font-medium text-muted-foreground uppercase tracking-wider py-2.5 px-2 first:pl-0">{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {[...history].reverse().map((rec, i) => (
            <tr key={rec.date} className={`border-b border-border/50 ${i === 0 ? "bg-primary/4" : ""}`}>
              <td className="py-3 pl-0 px-2 font-medium whitespace-nowrap text-foreground">
                {fmtDate(rec.date)}{i === 0 && <span className="ml-1 text-[10px] text-primary font-semibold">último</span>}
              </td>
              <td className="py-3 px-2 tabular-nums text-foreground font-bold">{rec.vo2max.toFixed(1)} ml·kg⁻¹·min⁻¹</td>
              <td className="py-3 px-2"><CalBadge cal={rec.calificacion} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── Characterization tabs config ──────────────────────────────────────────────

type TabKey = "potencia" | "agilidad" | "velocidad" | "biomecanica" | "resistencia" | "vo2";

const TABS: { key: TabKey; label: string; short: string; icon: React.ReactNode }[] = [
  { key: "potencia",    label: "Potencia Explosiva Inicial",                  short: "Potencia",    icon: <Zap className="h-3.5 w-3.5" /> },
  { key: "agilidad",   label: "Agilidad",                                     short: "Agilidad",    icon: <Wind className="h-3.5 w-3.5" /> },
  { key: "velocidad",  label: "Velocidad 40m",                                short: "Velocidad",   icon: <TrendingDown className="h-3.5 w-3.5" /> },
  { key: "biomecanica",label: "Biomecánica de Carrera",                       short: "Biomecánica", icon: <Activity className="h-3.5 w-3.5" /> },
  { key: "resistencia",label: "Resistencia Intermitente Alta Intensidad",     short: "Resist. Int.",icon: <Heart className="h-3.5 w-3.5" /> },
  { key: "vo2",        label: "Resistencia / Potencia Aeróbica (VO2)",        short: "VO2",         icon: <Gauge className="h-3.5 w-3.5" /> },
];

// ── Team rank badge ───────────────────────────────────────────────────────────

function RankBadge({ rank, total }: { rank: number; total: number }) {
  const color = rank === 1 ? "text-yellow-400 border-yellow-400/30 bg-yellow-400/8"
              : rank <= 3  ? "text-primary border-primary/30 bg-primary/8"
              :              "text-muted-foreground border-border bg-surface";
  return (
    <div className={`rounded-xl border px-4 py-3 text-center ${color}`}>
      <div className="flex items-center justify-center gap-1 mb-0.5">
        {rank === 1 && <Trophy className="h-3.5 w-3.5 text-yellow-400" />}
        <span className="font-display font-bold text-2xl">#{rank}</span>
      </div>
      <p className="text-xs text-muted-foreground">de {total} jugadores</p>
      <p className="text-xs font-medium mt-0.5">40m ranking</p>
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

const JugadorDetalle = () => {
  const { id } = useParams<{ id: string }>();
  const [activeTab, setActiveTab] = useState<TabKey>("potencia");
  const player = getPlayers().find(p => p.id === id);

  if (!player) {
    return (
      <DashboardLayout>
        <div className="text-center py-20">
          <p className="text-muted-foreground text-lg">Jugador no encontrado.</p>
          <Link to="/jugadores" className="text-primary hover:underline text-sm mt-2 inline-block">
            ← Volver a jugadores
          </Link>
        </div>
      </DashboardLayout>
    );
  }

  const velocidadHistory = (player.velocidad40History ?? []).slice().sort((a, b) => a.date.localeCompare(b.date));
  const allPlayers  = getPlayers();
  const withSprint  = allPlayers.filter(p => p.sprint.t40 > 0);
  const teamSorted  = [...withSprint].sort((a, b) => a.sprint.t40 - b.sprint.t40);
  const rank        = teamSorted.findIndex(p => p.id === id) + 1;
  const teamAvg     = withSprint.length > 0 ? withSprint.reduce((s, p) => s + p.sprint.t40, 0) / withSprint.length : 0;
  const vsAvg       = parseFloat((player.sprint.t40 - teamAvg).toFixed(2));
  const latestSprint = velocidadHistory.at(-1);
  const firstSprint  = velocidadHistory.at(0);
  const improvement  = latestSprint && firstSprint && latestSprint !== firstSprint
    ? parseFloat((firstSprint.t40 - latestSprint.t40).toFixed(2))
    : null;

  return (
    <DashboardLayout>

      {/* Back nav */}
      <Link
        to="/jugadores"
        className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors mb-6"
      >
        <ArrowLeft className="h-4 w-4" />
        Volver a jugadores
      </Link>

      {/* ── Player header ── */}
      <div className="rounded-xl border border-border bg-card p-6 card-elevated mb-6">
        <div className="flex items-start gap-5 flex-wrap">

          {/* Avatar */}
          <div className="flex h-20 w-20 items-center justify-center rounded-2xl bg-primary/15 text-primary font-display font-bold text-2xl shrink-0">
            {player.avatar}
          </div>

          {/* Info */}
          <div className="flex-1 min-w-0">
            <h1 className="font-display text-2xl font-bold text-foreground">{player.name}</h1>
            <p className="text-muted-foreground mt-0.5">{player.position} · {player.age} años</p>

            <div className="flex flex-wrap gap-2 mt-3">
              <span className="inline-flex items-center gap-1.5 text-xs font-medium bg-surface border border-border rounded-full px-3 py-1">
                <Video className="h-3 w-3 text-primary" />
                {player.videosCount} videos
              </span>
              <span className="inline-flex items-center gap-1.5 text-xs font-medium bg-surface border border-border rounded-full px-3 py-1">
                <Timer className="h-3 w-3 text-primary" />
                {velocidadHistory.length} tests registrados
              </span>
              {improvement !== null && improvement > 0 && (
                <span className="inline-flex items-center gap-1.5 text-xs font-semibold bg-green-500/10 border border-green-500/30 text-green-400 rounded-full px-3 py-1">
                  <TrendingDown className="h-3 w-3" />
                  -{fmt(improvement)}s desde inicio
                </span>
              )}
            </div>
          </div>

          {withSprint.length > 0 && <RankBadge rank={rank} total={withSprint.length} />}
        </div>

        {/* vs team average — only shown when both player and team have sprint data */}
        {withSprint.length > 1 && player.sprint.t40 > 0 && (
          <div className="mt-5 rounded-lg bg-surface border border-border p-3 flex items-center justify-between">
            <span className="text-xs text-muted-foreground">Promedio del equipo 40m</span>
            <div className="flex items-center gap-3">
              <span className="text-xs text-muted-foreground tabular-nums">{fmt(teamAvg)}s promedio</span>
              <span className={`text-xs font-semibold flex items-center gap-0.5 ${vsAvg < 0 ? "text-green-400" : "text-red-400"}`}>
                {vsAvg < 0 ? <TrendingDown className="h-3 w-3" /> : <TrendingUp className="h-3 w-3" />}
                {vsAvg < 0 ? "" : "+"}{fmt(vsAvg)}s vs promedio
              </span>
            </div>
          </div>
        )}
      </div>

      {/* ── Métricas de Caracterización ── */}
      {(() => {
        const fisicaVal: Calificacion | null =
          player.caracterizacion?.fisica ??
          (player.sprint.t40 > 0 ? computeFisica(player.sprint.t40) : null);
        const psicologicaVal: Calificacion | null = player.caracterizacion?.psicologica ?? null;

        const metrics: { key: string; label: string; sub: string; val: Calificacion | null }[] = [
          { key: "fisica",      label: "Física",       sub: "Condición física",      val: fisicaVal },
          { key: "psicologica", label: "Psicológica",  sub: "Perfil mental",          val: psicologicaVal },
          { key: "tbd1",        label: "Próximamente", sub: "—",                      val: null },
          { key: "tbd2",        label: "Próximamente", sub: "—",                      val: null },
        ];

        return (
          <div className="rounded-xl border border-border bg-card p-6 card-elevated mb-6">
            <h3 className="font-display font-semibold text-foreground mb-5">Métricas de Caracterización</h3>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
              {metrics.map(({ key, label, sub, val }) => {
                const isPlaceholder = key.startsWith("tbd");
                return (
                  <div
                    key={key}
                    className={`flex flex-col items-center gap-3 rounded-xl border p-4 transition-all ${
                      isPlaceholder
                        ? "border-dashed border-border/50 bg-surface/30"
                        : "border-border bg-surface"
                    }`}
                  >
                    <CalCircle cal={val} size={76} />
                    <div className="text-center">
                      <p className={`text-xs font-semibold ${isPlaceholder ? "text-muted-foreground/50" : "text-foreground"}`}>
                        {label}
                      </p>
                      {!isPlaceholder && val && (
                        <div className="mt-1.5">
                          <CalBadge cal={val} />
                        </div>
                      )}
                      {!isPlaceholder && !val && (
                        <p className="text-[10px] text-muted-foreground mt-1">Sin datos</p>
                      )}
                      {isPlaceholder && (
                        <p className="text-[10px] text-muted-foreground/40 mt-0.5">{sub}</p>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        );
      })()}

      {/* ── Caracterización deportiva — Tabs ── */}
      <div className="rounded-xl border border-border bg-card card-elevated mb-6">

        {/* Tab bar */}
        <div className="border-b border-border px-4 pt-4">
          <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-3">
            Caracterización Deportiva
          </p>
          <div className="flex gap-1 overflow-x-auto pb-0 scrollbar-none">
            {TABS.map(tab => (
              <button
                key={tab.key}
                onClick={() => setActiveTab(tab.key)}
                className={`flex items-center gap-1.5 px-3 py-2 text-xs font-medium rounded-t-lg border-b-2 whitespace-nowrap transition-colors ${
                  activeTab === tab.key
                    ? "border-primary text-primary bg-primary/5"
                    : "border-transparent text-muted-foreground hover:text-foreground hover:bg-surface"
                }`}
              >
                {tab.icon}
                {tab.short}
              </button>
            ))}
          </div>
        </div>

        {/* Tab header */}
        <div className="px-6 pt-4 pb-2">
          <p className="text-sm font-semibold text-foreground">
            {TABS.find(t => t.key === activeTab)?.label}
          </p>
        </div>

        {/* Tab content */}
        <div className="px-6 pb-6 overflow-x-auto">
          {activeTab === "potencia"    && <TabPotencia    history={player.potenciaExpHistory} />}
          {activeTab === "agilidad"   && <TabAgilidad    history={player.agilidadHistory} />}
          {activeTab === "velocidad"  && <TabVelocidad   history={velocidadHistory} />}
          {activeTab === "biomecanica"&& <TabBiomecanica history={player.biomecanicaHistory} />}
          {activeTab === "resistencia"&& <TabResistenciaInter history={player.resistenciaInterHistory} />}
          {activeTab === "vo2"        && <TabVO2         history={player.vo2History} />}
        </div>
      </div>

    </DashboardLayout>
  );
};

export default JugadorDetalle;
