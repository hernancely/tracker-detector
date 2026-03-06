import { useState } from "react";
import DashboardLayout from "@/components/DashboardLayout";
import SprintChart from "@/components/SprintChart";
import AngleDisplay from "@/components/AngleDisplay";
import { getPlayers } from "@/lib/playerStore";
import { Link } from "react-router-dom";
import { Users } from "lucide-react";

const Analisis = () => {
  const [players] = useState(getPlayers);
  const [selectedId, setSelectedId] = useState(players[0]?.id ?? "");
  const selected = players.find(p => p.id === selectedId) ?? players[0];

  if (players.length === 0) {
    return (
      <DashboardLayout>
        <div className="mb-8">
          <h1 className="font-display text-3xl font-bold text-foreground">Análisis</h1>
          <p className="text-muted-foreground mt-1">Resultados detallados por jugador</p>
        </div>
        <div className="flex flex-col items-center justify-center py-24 rounded-xl border border-dashed border-border text-center">
          <Users className="h-10 w-10 text-muted-foreground/40 mb-3" />
          <p className="text-sm text-muted-foreground mb-4">No hay jugadores registrados aún</p>
          <Link to="/jugadores" className="rounded-lg bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground hover:bg-primary/90 transition-colors">
            Crear jugadores
          </Link>
        </div>
      </DashboardLayout>
    );
  }

  return (
    <DashboardLayout>
      <div className="mb-8">
        <h1 className="font-display text-3xl font-bold text-foreground">Análisis</h1>
        <p className="text-muted-foreground mt-1">Resultados detallados por jugador</p>
      </div>

      <div className="flex gap-2 mb-8 flex-wrap">
        {players.map(p => (
          <button key={p.id} onClick={() => setSelectedId(p.id)}
            className={`flex items-center gap-2 rounded-lg px-4 py-2.5 text-sm font-medium transition-all border ${
              selectedId === p.id ? "border-primary bg-primary/10 text-primary" : "border-border bg-surface text-muted-foreground hover:border-primary/30"
            }`}>
            <span className="flex h-7 w-7 items-center justify-center rounded-full bg-primary/15 text-primary text-xs font-bold">{p.avatar}</span>
            {p.name}
          </button>
        ))}
      </div>

      {selected && (
        <>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <SprintChart player={selected} />
            <AngleDisplay player={selected} />
          </div>

          <div className="mt-8 rounded-xl border border-border bg-card p-6 card-elevated">
            <h3 className="font-display font-bold text-foreground mb-4">Comparativa General</h3>
            {players.every(p => p.sprint.t40 === 0) ? (
              <p className="text-sm text-muted-foreground text-center py-4">Sin registros de sprint. Analiza un video para ver datos aquí.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border">
                      <th className="text-left py-3 px-4 text-muted-foreground font-medium">Jugador</th>
                      <th className="text-right py-3 px-4 text-muted-foreground font-medium">10m</th>
                      <th className="text-right py-3 px-4 text-muted-foreground font-medium">20m</th>
                      <th className="text-right py-3 px-4 text-muted-foreground font-medium">30m</th>
                      <th className="text-right py-3 px-4 text-muted-foreground font-medium">40m</th>
                      <th className="text-right py-3 px-4 text-muted-foreground font-medium">Cadera°</th>
                      <th className="text-right py-3 px-4 text-muted-foreground font-medium">Rodilla°</th>
                      <th className="text-right py-3 px-4 text-muted-foreground font-medium">Tobillo°</th>
                    </tr>
                  </thead>
                  <tbody>
                    {players.map(p => {
                      const bio = p.biomecanicaHistory?.at(-1);
                      const hasSprint = p.sprint.t40 > 0;
                      return (
                        <tr key={p.id} className={`border-b border-border/50 transition-colors ${p.id === selectedId ? "bg-primary/5" : "hover:bg-surface"}`}>
                          <td className="py-3 px-4 font-medium text-foreground">{p.name}</td>
                          <td className="py-3 px-4 text-right text-foreground">{hasSprint ? `${p.sprint.t10}s` : "—"}</td>
                          <td className="py-3 px-4 text-right text-foreground">{hasSprint ? `${p.sprint.t20}s` : "—"}</td>
                          <td className="py-3 px-4 text-right text-foreground">{hasSprint ? `${p.sprint.t30}s` : "—"}</td>
                          <td className="py-3 px-4 text-right font-display font-bold text-primary">{hasSprint ? `${p.sprint.t40}s` : "—"}</td>
                          <td className="py-3 px-4 text-right text-foreground">{bio ? `${bio.hipAngle}°` : "—"}</td>
                          <td className="py-3 px-4 text-right text-foreground">{bio ? `${bio.kneeAngle}°` : "—"}</td>
                          <td className="py-3 px-4 text-right text-foreground">{bio ? `${bio.ankleAngle}°` : "—"}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}
    </DashboardLayout>
  );
};

export default Analisis;
