import { Player } from "@/types/player";

interface SprintChartProps {
  player: Player;
}

const SprintChart = ({ player }: SprintChartProps) => {
  const splits = [
    { label: "10m", time: player.sprint.t10, max: 2.5 },
    { label: "20m", time: player.sprint.t20, max: 4.0 },
    { label: "30m", time: player.sprint.t30, max: 5.5 },
    { label: "40m", time: player.sprint.t40, max: 7.0 },
  ];

  return (
    <div className="rounded-xl border border-border bg-card p-6 card-elevated">
      <h3 className="font-display font-bold text-foreground mb-1">Tiempos de Sprint</h3>
      <p className="text-xs text-muted-foreground mb-5">{player.name}</p>

      <div className="space-y-4">
        {splits.map((split) => {
          const pct = (split.time / split.max) * 100;
          return (
            <div key={split.label}>
              <div className="flex justify-between text-sm mb-1.5">
                <span className="text-muted-foreground font-medium">{split.label}</span>
                <span className="font-display font-bold text-foreground">{split.time}s</span>
              </div>
              <div className="h-3 rounded-full bg-surface overflow-hidden">
                <div
                  className="h-full rounded-full transition-all duration-700 ease-out"
                  style={{
                    width: `${pct}%`,
                    background: "linear-gradient(90deg, hsl(22 100% 38%), hsl(22 100% 55%))",
                  }}
                />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};

export default SprintChart;
