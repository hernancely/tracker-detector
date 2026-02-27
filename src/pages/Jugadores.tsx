import DashboardLayout from "@/components/DashboardLayout";
import PlayerCard from "@/components/PlayerCard";
import { mockPlayers } from "@/data/mockPlayers";
import { Search } from "lucide-react";
import { useState } from "react";

const Jugadores = () => {
  const [search, setSearch] = useState("");
  const filtered = mockPlayers.filter((p) =>
    p.name.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <DashboardLayout>
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="font-display text-3xl font-bold text-foreground">Jugadores</h1>
          <p className="text-muted-foreground mt-1">{mockPlayers.length} jugadores registrados</p>
        </div>
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <input
            type="text"
            placeholder="Buscar jugador..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-10 pr-4 py-2.5 rounded-lg bg-surface border border-border text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/50 transition-all"
          />
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-5">
        {filtered.map((player) => (
          <PlayerCard key={player.id} player={player} />
        ))}
      </div>
    </DashboardLayout>
  );
};

export default Jugadores;
