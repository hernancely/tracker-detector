import DashboardLayout from "@/components/DashboardLayout";
import SprintChart from "@/components/SprintChart";
import AngleDisplay from "@/components/AngleDisplay";
import { mockPlayers } from "@/data/mockPlayers";
import { useState } from "react";

const Analisis = () => {
  const [selectedId, setSelectedId] = useState(mockPlayers[0].id);
  const selected = mockPlayers.find((p) => p.id === selectedId) || mockPlayers[0];

  return (
    <DashboardLayout>
      <div className="mb-8">
        <h1 className="font-display text-3xl font-bold text-foreground">Análisis</h1>
        <p className="text-muted-foreground mt-1">Resultados detallados por jugador</p>
      </div>

      {/* Player selector */}
      <div className="flex gap-2 mb-8 flex-wrap">
        {mockPlayers.map((p) => (
          <button
            key={p.id}
            onClick={() => setSelectedId(p.id)}
            className={`flex items-center gap-2 rounded-lg px-4 py-2.5 text-sm font-medium transition-all border ${
              selectedId === p.id
                ? "border-primary bg-primary/10 text-primary"
                : "border-border bg-surface text-muted-foreground hover:border-primary/30"
            }`}
          >
            <span className="flex h-7 w-7 items-center justify-center rounded-full bg-primary/15 text-primary text-xs font-bold">
              {p.avatar}
            </span>
            {p.name}
          </button>
        ))}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <SprintChart player={selected} />
        <AngleDisplay player={selected} />
      </div>

      {/* Comparison table */}
      <div className="mt-8 rounded-xl border border-border bg-card p-6 card-elevated">
        <h3 className="font-display font-bold text-foreground mb-4">Comparativa General</h3>
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
              {mockPlayers.map((p) => (
                <tr
                  key={p.id}
                  className={`border-b border-border/50 transition-colors ${
                    p.id === selectedId ? "bg-primary/5" : "hover:bg-surface"
                  }`}
                >
                  <td className="py-3 px-4 font-medium text-foreground">{p.name}</td>
                  <td className="py-3 px-4 text-right text-foreground">{p.sprint.t10}s</td>
                  <td className="py-3 px-4 text-right text-foreground">{p.sprint.t20}s</td>
                  <td className="py-3 px-4 text-right text-foreground">{p.sprint.t30}s</td>
                  <td className="py-3 px-4 text-right font-display font-bold text-primary">{p.sprint.t40}s</td>
                  <td className="py-3 px-4 text-right text-foreground">{p.jump.hip}°</td>
                  <td className="py-3 px-4 text-right text-foreground">{p.jump.knee}°</td>
                  <td className="py-3 px-4 text-right text-foreground">{p.jump.ankle}°</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </DashboardLayout>
  );
};

export default Analisis;
