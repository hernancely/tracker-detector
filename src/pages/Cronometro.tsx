import { useState, useCallback } from "react";
import DashboardLayout from "@/components/DashboardLayout";
import { VideoAnalyzer } from "@/components/VideoAnalyzer";
import { getPlayers, addSprintRecord } from "@/lib/playerStore";
import { Player, SprintData, SprintRecord } from "@/types/player";
import { CheckCircle, UserCheck, UserPlus } from "lucide-react";
import { Link } from "react-router-dom";
import { useAuth } from "@/context/AuthContext";

export default function AnalizadorSprint() {
  const { can } = useAuth();
  const [players, setPlayers]           = useState<Player[]>(getPlayers);
  const [selectedPlayerId, setSelectedPlayerId] = useState(players[0]?.id ?? "");
  const [sprintResult, setSprintResult] = useState<SprintData | null>(null);
  const [resultSaved, setResultSaved]   = useState(false);

  const selectedPlayer = players.find(p => p.id === selectedPlayerId);

  const handleSave = useCallback(() => {
    if (!sprintResult || !selectedPlayerId) return;
    const record: SprintRecord = {
      date:       new Date().toISOString().slice(0, 10),
      t10:        sprintResult.t10,
      t20:        sprintResult.t20,
      t30:        sprintResult.t30,
      t40:        sprintResult.t40,
      hipAngle:   sprintResult.hipAngle,
      kneeAngle:  sprintResult.kneeAngle,
      ankleAngle: sprintResult.ankleAngle,
    };
    addSprintRecord(selectedPlayerId, record);
    setPlayers(getPlayers());
    setResultSaved(true);
  }, [sprintResult, selectedPlayerId]);

  return (
    <DashboardLayout>
      <div className="mb-6">
        <h1 className="font-display text-3xl font-bold text-foreground">Analizador de Sprint 40m</h1>
        <p className="text-muted-foreground mt-1">Carga un video y la IA detectará los tiempos automáticamente</p>
      </div>

      {/* Player selector */}
      <div className="mb-6 rounded-xl border border-border bg-card p-4 card-elevated">
        <div className="flex items-center gap-2 mb-3">
          <UserCheck className="h-4 w-4 text-primary" />
          <p className="text-sm font-medium text-foreground">Selecciona el jugador</p>
        </div>
        {players.length === 0 ? (
          <div className="flex items-center gap-3 py-2">
            <p className="text-sm text-muted-foreground">No hay jugadores registrados.</p>
            <Link to="/jugadores" className="flex items-center gap-1.5 text-sm font-medium text-primary hover:underline">
              <UserPlus className="h-3.5 w-3.5" /> Crear jugador
            </Link>
          </div>
        ) : (
          <div className="flex gap-2 flex-wrap">
            {players.map(p => (
              <button
                key={p.id}
                onClick={() => { setSelectedPlayerId(p.id); setSprintResult(null); setResultSaved(false); }}
                className={`flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium transition-all border ${
                  selectedPlayerId === p.id
                    ? "border-primary bg-primary/10 text-primary"
                    : "border-border bg-surface text-muted-foreground hover:border-primary/30"
                }`}
              >
                <span className="flex h-6 w-6 items-center justify-center rounded-full bg-primary/15 text-primary text-xs font-bold">
                  {p.avatar}
                </span>
                {p.name}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Video Analyzer */}
      <div className="max-w-2xl">
        <VideoAnalyzer
          onResult={(result) => {
            setSprintResult(result);
            setResultSaved(false);
          }}
        />

        {/* Save panel */}
        {sprintResult && selectedPlayer && can("guardar_sprint") && (
          <div className="mt-4 rounded-xl border border-border bg-card p-4 card-elevated">
            <div className="flex items-center gap-4">
              <div className="flex-1">
                <p className="text-xs text-muted-foreground mb-0.5">Guardar en el perfil de</p>
                <p className="text-sm font-semibold text-foreground">{selectedPlayer.name}</p>
              </div>
              {resultSaved ? (
                <div className="flex items-center gap-2 text-green-400 text-sm font-semibold">
                  <CheckCircle className="h-4 w-4" />
                  Guardado correctamente
                </div>
              ) : (
                <button
                  onClick={handleSave}
                  className="flex items-center gap-2 rounded-lg bg-primary px-5 py-2.5 text-sm font-semibold text-primary-foreground hover:bg-primary/90 transition-colors"
                >
                  <CheckCircle className="h-4 w-4" />
                  Guardar en perfil
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    </DashboardLayout>
  );
}
