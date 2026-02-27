import { Player } from "@/types/player";
import { Timer, MoveUp } from "lucide-react";
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
            <MoveUp className="h-3.5 w-3.5 text-primary" />
            <span className="text-xs font-medium text-muted-foreground">Salto</span>
          </div>
          <p className="text-lg font-display font-bold text-foreground">{player.jump.knee}°</p>
          <div className="flex gap-2 mt-1.5 text-xs text-muted-foreground">
            <span>Cad {player.jump.hip}°</span>
            <span>·</span>
            <span>Tob {player.jump.ankle}°</span>
          </div>
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
