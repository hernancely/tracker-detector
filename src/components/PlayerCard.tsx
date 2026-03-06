import { Player } from "@/types/player";
import { Timer, Activity } from "lucide-react";
import { Link } from "react-router-dom";

interface PlayerCardProps {
  player: Player;
}

const PlayerCard = ({ player }: PlayerCardProps) => {
  return (
    <div className="rounded-xl border border-border bg-card p-5 card-elevated hover:border-primary/30 transition-all duration-300 animate-slide-in">
      <div className="flex items-center gap-4 mb-4">
        <div className="flex h-12 w-12 items-center justify-center rounded-full bg-primary/15 text-primary font-display font-bold text-sm">
          {player.avatar}
        </div>
        <div>
          <h3 className="font-display font-semibold text-foreground">{player.name}</h3>
          <p className="text-xs text-muted-foreground">{player.position} · {player.age} años</p>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="rounded-lg bg-surface p-3">
          <div className="flex items-center gap-1.5 mb-2">
            <Timer className="h-3.5 w-3.5 text-primary" />
            <span className="text-xs font-medium text-muted-foreground">Sprint 40m</span>
          </div>
          <p className="text-lg font-display font-bold text-foreground">{player.sprint.t40}s</p>
          <div className="flex gap-2 mt-1.5 text-xs text-muted-foreground">
            <span>{player.sprint.t10}s</span>
            <span>·</span>
            <span>{player.sprint.t20}s</span>
            <span>·</span>
            <span>{player.sprint.t30}s</span>
          </div>
        </div>

        <div className="rounded-lg bg-surface p-3">
          <div className="flex items-center gap-1.5 mb-2">
            <Activity className="h-3.5 w-3.5 text-primary" />
            <span className="text-xs font-medium text-muted-foreground">Caracterización</span>
          </div>
          {player.caracterizacion ? (
            <div className="space-y-2 mt-1">
              {(["fisica", "psicologica"] as const).map(key => {
                const val = player.caracterizacion![key];
                const fill = val === "bueno" ? 100 : val === "promedio" ? 55 : 20;
                const barColor = val === "bueno" ? "bg-green-500" : val === "promedio" ? "bg-yellow-500" : "bg-red-500";
                const txtColor = val === "bueno" ? "text-green-400" : val === "promedio" ? "text-yellow-400" : "text-red-400";
                return (
                  <div key={key}>
                    <div className="flex items-center justify-between">
                      <span className="text-[10px] text-muted-foreground">{key === "fisica" ? "Física" : "Psicológica"}</span>
                      <span className={`text-[10px] font-semibold capitalize ${txtColor}`}>{val}</span>
                    </div>
                    <div className="h-1.5 w-full rounded-full bg-border mt-0.5">
                      <div className={`h-1.5 rounded-full ${barColor} transition-all`} style={{ width: `${fill}%` }} />
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <p className="text-xs text-muted-foreground mt-1">Sin datos</p>
          )}
        </div>
      </div>

      <div className="mt-3 flex items-center justify-between">
        <span className="text-xs text-muted-foreground">{player.videosCount} videos analizados</span>
        <Link to={`/jugadores/${player.id}`} className="text-xs font-medium text-primary hover:underline">Ver detalle →</Link>
      </div>
    </div>
  );
};

export default PlayerCard;
