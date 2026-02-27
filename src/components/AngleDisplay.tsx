import { Player } from "@/types/player";

interface AngleDisplayProps {
  player: Player;
}

const AngleDisplay = ({ player }: AngleDisplayProps) => {
  const angles = [
    { label: "Cadera", value: player.jump.hip, color: "hsl(84 81% 44%)" },
    { label: "Rodilla", value: player.jump.knee, color: "hsl(142 71% 45%)" },
    { label: "Tobillo", value: player.jump.ankle, color: "hsl(168 70% 45%)" },
  ];

  return (
    <div className="rounded-xl border border-border bg-card p-6 card-elevated">
      <h3 className="font-display font-bold text-foreground mb-1">Ángulos de Salto</h3>
      <p className="text-xs text-muted-foreground mb-5">{player.name}</p>

      <div className="flex justify-around items-end">
        {angles.map((angle) => (
          <div key={angle.label} className="flex flex-col items-center gap-3">
            {/* Circular gauge */}
            <div className="relative w-20 h-20">
              <svg viewBox="0 0 100 100" className="w-full h-full -rotate-90">
                <circle
                  cx="50" cy="50" r="40"
                  fill="none"
                  stroke="hsl(220 14% 18%)"
                  strokeWidth="8"
                />
                <circle
                  cx="50" cy="50" r="40"
                  fill="none"
                  stroke={angle.color}
                  strokeWidth="8"
                  strokeLinecap="round"
                  strokeDasharray={`${(angle.value / 180) * 251.2} 251.2`}
                  className="transition-all duration-700"
                />
              </svg>
              <div className="absolute inset-0 flex items-center justify-center">
                <span className="text-lg font-display font-bold text-foreground">{angle.value}°</span>
              </div>
            </div>
            <span className="text-xs font-medium text-muted-foreground">{angle.label}</span>
          </div>
        ))}
      </div>

      {/* Stick figure hint */}
      <div className="mt-6 pt-4 border-t border-border">
        <p className="text-xs text-muted-foreground text-center">
          Ángulos medidos en el punto máximo del salto
        </p>
      </div>
    </div>
  );
};

export default AngleDisplay;
