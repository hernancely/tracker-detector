import { useState } from "react";
import DashboardLayout from "@/components/DashboardLayout";
import StatCard from "@/components/StatCard";
import PlayerCard from "@/components/PlayerCard";
import { getPlayers } from "@/lib/playerStore";
import { Users, Timer, TrendingUp, Scan } from "lucide-react";
import { Link } from "react-router-dom";

const Index = () => {
  const [players] = useState(getPlayers);

  const withSprint = players.filter(p => p.sprint.t40 > 0);
  const totalVideos = players.reduce((s, p) => s + (p.videosCount ?? 0), 0);
  const bestSprinter = withSprint.length > 0 ? withSprint.reduce((a, b) => a.sprint.t40 < b.sprint.t40 ? a : b) : null;
  const avgT40 = withSprint.length > 0 ? withSprint.reduce((s, p) => s + p.sprint.t40, 0) / withSprint.length : null;

  return (
    <DashboardLayout>
      <div className="mb-8">
        <h1 className="font-display text-3xl font-bold text-foreground">Dashboard</h1>
        <p className="text-muted-foreground mt-1">Resumen de rendimiento de la academia</p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
        <StatCard icon={Users}     label="Jugadores"   value={players.length}          subtitle="Registrados" />
        <StatCard icon={Scan}      label="Videos"      value={totalVideos}              subtitle="Analizados con IA" />
        <StatCard icon={Timer}     label="Mejor 40m"   value={bestSprinter ? `${bestSprinter.sprint.t40}s` : "—"} subtitle={bestSprinter?.name ?? "Sin datos"} />
        <StatCard icon={TrendingUp} label="Promedio 40m" value={avgT40 ? `${avgT40.toFixed(2)}s` : "—"} subtitle="Todos los jugadores" />
      </div>

      {players.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-24 rounded-xl border border-dashed border-border text-center">
          <Users className="h-12 w-12 text-muted-foreground/40 mb-4" />
          <h3 className="font-display font-semibold text-foreground mb-1">Sin datos aún</h3>
          <p className="text-sm text-muted-foreground mb-5">Registra jugadores y analiza sus sprints para ver el dashboard</p>
          <div className="flex gap-3">
            <Link to="/jugadores" className="flex items-center gap-2 rounded-lg bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground hover:bg-primary/90 transition-colors">
              <Users className="h-4 w-4" /> Crear jugadores
            </Link>
            <Link to="/sprint" className="flex items-center gap-2 rounded-lg border border-border bg-surface px-4 py-2.5 text-sm font-semibold text-foreground hover:border-primary/30 transition-colors">
              <Scan className="h-4 w-4" /> Analizar sprint
            </Link>
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <div className="lg:col-span-2 space-y-5">
            <div className="rounded-xl border border-border bg-card p-5 card-elevated">
              <h3 className="font-display font-bold text-foreground mb-4">Ranking Sprint 40m</h3>
              {withSprint.length === 0 ? (
                <p className="text-sm text-muted-foreground py-4 text-center">Sin registros de sprint. Ve a <Link to="/sprint" className="text-primary hover:underline">Analizador</Link> para empezar.</p>
              ) : (
                <div className="space-y-2">
                  {[...withSprint].sort((a, b) => a.sprint.t40 - b.sprint.t40).map((p, i) => (
                    <Link key={p.id} to={`/jugadores/${p.id}`} className="flex items-center gap-4 rounded-lg bg-surface px-4 py-3 hover:border-primary/20 border border-transparent transition-all">
                      <span className={`text-sm font-bold w-6 text-center ${i === 0 ? "text-yellow-400" : "text-muted-foreground"}`}>#{i + 1}</span>
                      <div className="flex h-8 w-8 items-center justify-center rounded-full bg-primary/15 text-primary text-xs font-bold">{p.avatar}</div>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-foreground truncate">{p.name}</p>
                        <p className="text-xs text-muted-foreground">{p.position}</p>
                      </div>
                      <span className="font-display font-bold text-primary tabular-nums">{p.sprint.t40}s</span>
                    </Link>
                  ))}
                </div>
              )}
            </div>
          </div>

          <div className="space-y-4">
            <h3 className="font-display font-bold text-foreground">Jugadores recientes</h3>
            {players.slice(-3).reverse().map(player => (
              <PlayerCard key={player.id} player={player} />
            ))}
          </div>
        </div>
      )}
    </DashboardLayout>
  );
};

export default Index;
