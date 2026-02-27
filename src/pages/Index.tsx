import DashboardLayout from "@/components/DashboardLayout";
import StatCard from "@/components/StatCard";
import PlayerCard from "@/components/PlayerCard";
import VideoUpload from "@/components/VideoUpload";
import SprintChart from "@/components/SprintChart";
import AngleDisplay from "@/components/AngleDisplay";
import { mockPlayers } from "@/data/mockPlayers";
import { Users, Video, Timer, TrendingUp } from "lucide-react";

const Index = () => {
  const bestSprinter = mockPlayers.reduce((a, b) => a.sprint.t40 < b.sprint.t40 ? a : b);

  return (
    <DashboardLayout>
      <div className="mb-8">
        <h1 className="font-display text-3xl font-bold text-foreground">Dashboard</h1>
        <p className="text-muted-foreground mt-1">Resumen de rendimiento de la academia</p>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
        <StatCard icon={Users} label="Jugadores" value={mockPlayers.length} subtitle="Registrados" />
        <StatCard icon={Video} label="Videos" value={mockPlayers.reduce((s, p) => s + p.videosCount, 0)} subtitle="Analizados" trend="+3 esta semana" />
        <StatCard icon={Timer} label="Mejor 40m" value={`${bestSprinter.sprint.t40}s`} subtitle={bestSprinter.name} />
        <StatCard icon={TrendingUp} label="Promedio 40m" value={`${(mockPlayers.reduce((s, p) => s + p.sprint.t40, 0) / mockPlayers.length).toFixed(2)}s`} subtitle="Todos los jugadores" />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Left column - upload + analysis */}
        <div className="space-y-6">
          <VideoUpload />
        </div>

        {/* Center - sprint chart */}
        <div className="space-y-6">
          <SprintChart player={bestSprinter} />
          <AngleDisplay player={bestSprinter} />
        </div>

        {/* Right - recent players */}
        <div className="space-y-4">
          <h3 className="font-display font-bold text-foreground">Jugadores Recientes</h3>
          {mockPlayers.slice(0, 3).map((player) => (
            <PlayerCard key={player.id} player={player} />
          ))}
        </div>
      </div>
    </DashboardLayout>
  );
};

export default Index;
