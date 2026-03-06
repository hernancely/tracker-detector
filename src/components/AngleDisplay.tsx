import { Player } from "@/types/player";

interface AngleDisplayProps {
  player: Player;
}

const AngleDisplay = ({ player }: AngleDisplayProps) => {
  const latest = player.biomecanicaHistory?.[player.biomecanicaHistory.length - 1];

  if (!latest) {
    return (
      <div className="rounded-xl border border-border bg-card p-6 card-elevated flex flex-col items-center justify-center gap-2 min-h-[180px]">
        <p className="text-sm font-medium text-foreground">Biomecánica de Carrera</p>
        <p className="text-xs text-muted-foreground">{player.name} · Sin registros aún</p>
      </div>
    );
  }

  const angles = [
    { label: "Cadera",  value: latest.hipAngle,   color: "hsl(48 96% 53%)"  },
    { label: "Rodilla", value: latest.kneeAngle,  color: "hsl(142 71% 45%)" },
    { label: "Tobillo", value: latest.ankleAngle, color: "hsl(213 94% 68%)"  },
  ];

  return (
    <div className="rounded-xl border border-border bg-card p-6 card-elevated">
      <h3 className="font-display font-bold text-foreground mb-1">Biomecánica de Carrera</h3>
      <p className="text-xs text-muted-foreground mb-5">{player.name}</p>

      <div className="flex justify-around items-end">
        {angles.map((angle) => (
          <div key={angle.label} className="flex flex-col items-center gap-3">
            <div className="relative w-20 h-20">
              <svg viewBox="0 0 100 100" className="w-full h-full -rotate-90">
                <circle cx="50" cy="50" r="40" fill="none" stroke="hsl(220 14% 18%)" strokeWidth="8" />
                <circle
                  cx="50" cy="50" r="40" fill="none"
                  stroke={angle.color} strokeWidth="8" strokeLinecap="round"
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

      <div className="mt-6 pt-4 border-t border-border">
        <p className="text-xs text-muted-foreground text-center">
          Ángulos articulares promedio · análisis de video
        </p>
      </div>
    </div>
  );
};

export default AngleDisplay;
