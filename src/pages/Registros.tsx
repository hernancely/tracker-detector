import { useState, useMemo } from "react";
import DashboardLayout from "@/components/DashboardLayout";
import { getPlayers } from "@/lib/playerStore";
import { Player, SprintRecord } from "@/types/player";
import {
  Search, Timer, TrendingDown, TrendingUp,
  Calendar, ChevronRight, SlidersHorizontal,
  Users,
} from "lucide-react";
import { Link } from "react-router-dom";

// ── helpers ───────────────────────────────────────────────────────────────────

function fmt(v: number) { return v.toFixed(2); }
function fmtDate(d: string) {
  const [y, m, day] = d.split("-");
  return `${day}/${m}/${y}`;
}
function sprintDelta(curr: SprintRecord, prev?: SprintRecord) {
  if (!prev) return null;
  return parseFloat((curr.t40 - prev.t40).toFixed(2));
}

function DeltaBadge({ value }: { value: number | null }) {
  if (value === null || Math.abs(value) < 0.01)
    return <span className="text-muted-foreground text-xs">—</span>;
  const good = value < 0;
  return (
    <span className={`inline-flex items-center gap-0.5 text-xs font-semibold tabular-nums ${good ? "text-green-400" : "text-red-400"}`}>
      {good ? <TrendingDown className="h-3 w-3" /> : <TrendingUp className="h-3 w-3" />}
      {good ? "" : "+"}{fmt(value)}s
    </span>
  );
}

function TrendBar({ history }: { history: SprintRecord[] }) {
  if (history.length < 2) return null;
  const times = history.map(r => r.t40);
  const max = Math.max(...times), min = Math.min(...times);
  const range = max - min || 0.01;
  return (
    <div className="flex items-end gap-0.5 h-5">
      {times.map((t, i) => (
        <div
          key={i}
          className={`w-1.5 rounded-t ${i === times.length - 1 ? "bg-primary" : "bg-muted-foreground/25"}`}
          style={{ height: `${Math.max(20, ((max - t) / range) * 100)}%` }}
        />
      ))}
    </div>
  );
}

// ── Player list row ───────────────────────────────────────────────────────────

const POSITIONS = ["Todos", "Delantero", "Mediocampista", "Defensa", "Portero", "Extremo"];
const SORTS = [
  { key: "t40",        label: "Mejor 40m" },
  { key: "name",       label: "Nombre" },
  { key: "improvement",label: "Mejora" },
] as const;
type SortKey = typeof SORTS[number]["key"];

function improvement(p: Player) {
  const h = p.sprintHistory;
  if (!h || h.length < 2) return 0;
  return h[0].t40 - h[h.length - 1].t40; // positive = improved
}

function PlayerRow({ player, active, onClick }: { player: Player; active: boolean; onClick: () => void }) {
  const latest = player.sprintHistory?.at(-1);
  const prev   = player.sprintHistory?.at(-2);
  const delta  = latest && prev ? parseFloat((latest.t40 - prev.t40).toFixed(2)) : null;

  return (
    <button
      onClick={onClick}
      className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-left transition-all ${
        active
          ? "bg-primary/12 border border-primary/30"
          : "border border-transparent hover:bg-surface hover:border-border"
      }`}
    >
      {/* Avatar */}
      <div className={`flex h-9 w-9 items-center justify-center rounded-full text-xs font-bold shrink-0 transition-colors ${
        active ? "bg-primary text-white" : "bg-surface text-muted-foreground"
      }`}>
        {player.avatar}
      </div>

      {/* Info */}
      <div className="flex-1 min-w-0">
        <p className={`text-sm font-semibold truncate ${active ? "text-foreground" : "text-foreground/80"}`}>
          {player.name}
        </p>
        <p className="text-xs text-muted-foreground truncate">{player.position}</p>
      </div>

      {/* Right side */}
      <div className="flex flex-col items-end gap-0.5 shrink-0">
        <span className={`text-xs font-bold tabular-nums ${active ? "text-primary" : "text-foreground/70"}`}>
          {fmt(player.sprint.t40)}s
        </span>
        <DeltaBadge value={delta} />
      </div>
    </button>
  );
}

// ── Sprint + jump tables ──────────────────────────────────────────────────────

function SprintTable({ history }: { history: SprintRecord[] }) {
  const sorted = [...history].reverse();
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border">
            {["Fecha", "10m", "20m", "30m", "40m", "Cadera°", "Rodilla°", "Tobillo°", "Δ 40m"].map(h => (
              <th key={h} className="text-left text-xs font-medium text-muted-foreground uppercase tracking-wider py-2.5 px-3 first:pl-0 last:pr-0">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sorted.map((rec, i) => {
            const delta = sprintDelta(rec, sorted[i + 1]);
            return (
              <tr key={rec.date} className={`border-b border-border/50 ${i === 0 ? "bg-primary/4" : ""}`}>
                <td className="py-3 px-3 pl-0 text-foreground font-medium whitespace-nowrap">
                  <span className="flex items-center gap-1.5">
                    <Calendar className="h-3 w-3 text-muted-foreground shrink-0" />
                    {fmtDate(rec.date)}
                  </span>
                  {i === 0 && <span className="text-[10px] text-primary font-semibold ml-1">último</span>}
                </td>
                <td className="py-3 px-3 tabular-nums text-foreground">{fmt(rec.t10)}s</td>
                <td className="py-3 px-3 tabular-nums text-foreground">{fmt(rec.t20)}s</td>
                <td className="py-3 px-3 tabular-nums text-foreground">{fmt(rec.t30)}s</td>
                <td className="py-3 px-3 tabular-nums font-bold text-foreground">{fmt(rec.t40)}s</td>
                <td className="py-3 px-3 tabular-nums text-yellow-400">{rec.hipAngle != null ? `${rec.hipAngle}°` : "—"}</td>
                <td className="py-3 px-3 tabular-nums text-green-400">{rec.kneeAngle != null ? `${rec.kneeAngle}°` : "—"}</td>
                <td className="py-3 px-3 tabular-nums text-blue-400">{rec.ankleAngle != null ? `${rec.ankleAngle}°` : "—"}</td>
                <td className="py-3 px-3 pr-0"><DeltaBadge value={delta} /></td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}


// ── Page ──────────────────────────────────────────────────────────────────────

const Registros = () => {
  const [allPlayers]             = useState<Player[]>(getPlayers);
  const [selected, setSelected]  = useState<Player | null>(allPlayers[0] ?? null);
  const [search,   setSearch]    = useState("");
  const [position, setPosition]  = useState("Todos");
  const [sort,     setSort]      = useState<SortKey>("t40");

  const filtered = useMemo(() => {
    let list = allPlayers.filter(p => {
      const matchName = p.name.toLowerCase().includes(search.toLowerCase());
      const matchPos  = position === "Todos" || p.position === position;
      return matchName && matchPos;
    });
    if (sort === "t40")         list = [...list].sort((a, b) => (a.sprint.t40 || 999) - (b.sprint.t40 || 999));
    if (sort === "name")        list = [...list].sort((a, b) => a.name.localeCompare(b.name));
    if (sort === "improvement") list = [...list].sort((a, b) => improvement(b) - improvement(a));
    return list;
  }, [allPlayers, search, position, sort]);

  if (allPlayers.length === 0) {
    return (
      <DashboardLayout>
        <div className="mb-6">
          <h1 className="font-display text-3xl font-bold text-foreground">Registros</h1>
          <p className="text-muted-foreground mt-1">Historial de rendimiento por jugador</p>
        </div>
        <div className="flex flex-col items-center justify-center py-24 rounded-xl border border-dashed border-border text-center">
          <Users className="h-10 w-10 text-muted-foreground/40 mb-3" />
          <p className="text-sm text-muted-foreground mb-4">No hay jugadores registrados</p>
          <Link to="/jugadores" className="rounded-lg bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground hover:bg-primary/90 transition-colors">
            Crear jugadores
          </Link>
        </div>
      </DashboardLayout>
    );
  }

  const sh         = selected?.velocidad40History ?? [];
  const latest     = sh.at(-1);
  const first      = sh.at(0);
  const bestImprov = latest && first ? parseFloat((first.t40 - latest.t40).toFixed(2)) : null;

  return (
    <DashboardLayout>
      {/* Page header */}
      <div className="mb-6">
        <h1 className="font-display text-3xl font-bold text-foreground">Registros</h1>
        <p className="text-muted-foreground mt-1">Historial de rendimiento por jugador</p>
      </div>

      {/* ── Two-column layout ── */}
      <div className="flex gap-5 items-start">

        {/* ── LEFT: player selector panel ── */}
        <div className="w-72 shrink-0 rounded-xl border border-border bg-card card-elevated flex flex-col"
             style={{ maxHeight: "calc(100vh - 180px)", position: "sticky", top: "1.5rem" }}>

          {/* Search */}
          <div className="p-3 border-b border-border">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
              <input
                type="text"
                placeholder="Buscar jugador..."
                value={search}
                onChange={e => setSearch(e.target.value)}
                className="w-full pl-9 pr-3 py-2 rounded-lg bg-surface border border-border text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/40 transition-all"
              />
            </div>
          </div>

          {/* Position filter chips */}
          <div className="px-3 py-2.5 border-b border-border flex flex-wrap gap-1.5">
            {POSITIONS.map(pos => (
              <button
                key={pos}
                onClick={() => setPosition(pos)}
                className={`text-xs px-2.5 py-1 rounded-full font-medium transition-all ${
                  position === pos
                    ? "bg-primary text-white"
                    : "bg-surface text-muted-foreground hover:text-foreground hover:bg-surface/80 border border-border"
                }`}
              >
                {pos === "Todos" ? "Todos" : pos.slice(0, 3)}
              </button>
            ))}
          </div>

          {/* Sort + count row */}
          <div className="px-3 py-2 border-b border-border flex items-center justify-between">
            <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Users className="h-3 w-3" />
              {filtered.length} jugador{filtered.length !== 1 ? "es" : ""}
            </span>
            <div className="flex items-center gap-1">
              <SlidersHorizontal className="h-3 w-3 text-muted-foreground" />
              <select
                value={sort}
                onChange={e => setSort(e.target.value as SortKey)}
                className="text-xs bg-transparent text-muted-foreground hover:text-foreground focus:outline-none cursor-pointer"
              >
                {SORTS.map(s => (
                  <option key={s.key} value={s.key} className="bg-card text-foreground">
                    {s.label}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {/* Scrollable player list */}
          <div className="flex-1 overflow-y-auto p-2 space-y-0.5">
            {filtered.length === 0 ? (
              <div className="py-8 text-center">
                <p className="text-xs text-muted-foreground">Sin resultados</p>
              </div>
            ) : (
              filtered.map(p => (
                <PlayerRow
                  key={p.id}
                  player={p}
                  active={p.id === selected?.id}
                  onClick={() => setSelected(p)}
                />
              ))
            )}
          </div>
        </div>

        {/* ── RIGHT: player detail ── */}
        {selected && <div className="flex-1 min-w-0 space-y-5">

          {/* Player header */}
          <div className="rounded-xl border border-border bg-card p-5 card-elevated">
            <div className="flex items-start justify-between gap-4 flex-wrap">
              <div className="flex items-center gap-4">
                <div className="flex h-14 w-14 items-center justify-center rounded-full bg-primary/15 text-primary font-display font-bold text-lg shrink-0">
                  {selected.avatar}
                </div>
                <div>
                  <h2 className="font-display text-xl font-bold text-foreground">{selected.name}</h2>
                  <p className="text-sm text-muted-foreground">
                    {selected.position} · {selected.age} años · {selected.videosCount} videos
                  </p>
                  {bestImprov !== null && bestImprov > 0 && (
                    <span className="inline-flex items-center gap-1 text-xs text-green-400 font-semibold mt-1">
                      <TrendingDown className="h-3 w-3" />
                      -{fmt(bestImprov)}s mejora total
                    </span>
                  )}
                </div>
              </div>
              {sh.length >= 2 && (
                <div className="flex flex-col items-end gap-1">
                  <span className="text-xs text-muted-foreground">Evolución 40m</span>
                  <TrendBar history={sh} />
                </div>
              )}
            </div>

            {/* Latest sprint */}
            {latest && (
              <div className="grid grid-cols-4 gap-2 mt-5">
                {(["t10", "t20", "t30", "t40"] as const).map((k, i) => (
                  <div key={k} className="rounded-lg bg-surface p-3 text-center">
                    <p className="text-xs text-muted-foreground uppercase tracking-wider mb-1">
                      {["10m", "20m", "30m", "40m"][i]}
                    </p>
                    <p className="font-display font-bold text-xl text-primary tabular-nums">
                      {fmt(latest[k])}s
                    </p>
                  </div>
                ))}
              </div>
            )}

          </div>

          {/* Sprint history */}
          {sh.length > 0 && (
            <div className="rounded-xl border border-border bg-card p-5 card-elevated">
              <div className="flex items-center gap-2 mb-4">
                <Timer className="h-4 w-4 text-primary" />
                <h3 className="font-display font-semibold text-foreground">Historial de Sprint</h3>
                <span className="ml-auto text-xs text-muted-foreground bg-surface rounded-full px-2.5 py-0.5">
                  {sh.length} test{sh.length !== 1 ? "s" : ""}
                </span>
              </div>
              <SprintTable history={sh} />
            </div>
          )}

          {/* Empty state */}
          {sh.length === 0 && (
            <div className="rounded-xl border border-dashed border-border bg-card p-12 text-center">
              <ChevronRight className="h-10 w-10 text-muted-foreground mx-auto mb-3 opacity-30" />
              <p className="text-muted-foreground">Sin registros para este jugador.</p>
              <Link to="/sprint" className="text-primary hover:underline text-sm mt-1 inline-block">Ir al analizador →</Link>
            </div>
          )}

        </div>}
      </div>
    </DashboardLayout>
  );
};

export default Registros;
