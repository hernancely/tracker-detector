import { useState } from "react";
import DashboardLayout from "@/components/DashboardLayout";
import PlayerCard from "@/components/PlayerCard";
import { getPlayers, createPlayer, addPlayer, deletePlayer } from "@/lib/playerStore";
import { Player } from "@/types/player";
import { Search, UserPlus, X, Trash2 } from "lucide-react";
import { useAuth } from "@/context/AuthContext";

const POSITIONS = ["Delantero", "Mediocampista", "Defensa", "Portero", "Extremo"];

function CreatePlayerModal({ onClose, onCreate }: { onClose: () => void; onCreate: () => void }) {
  const [name, setName] = useState("");
  const [age, setAge] = useState("");
  const [position, setPosition] = useState(POSITIONS[0]);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim() || !age) return;
    addPlayer(createPlayer(name, position, parseInt(age, 10)));
    onCreate();
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div className="relative w-full max-w-md rounded-2xl border border-border bg-card p-6 shadow-2xl animate-slide-in">
        <div className="flex items-center justify-between mb-6">
          <h2 className="font-display text-xl font-bold text-foreground">Nuevo Jugador</h2>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground transition-colors">
            <X className="h-5 w-5" />
          </button>
        </div>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider block mb-1.5">Nombre completo</label>
            <input type="text" required placeholder="Ej. Carlos Mendoza" value={name} onChange={e => setName(e.target.value)}
              className="w-full px-3 py-2.5 rounded-lg bg-surface border border-border text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/40 transition-all" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider block mb-1.5">Edad</label>
              <input type="number" required min={10} max={50} placeholder="22" value={age} onChange={e => setAge(e.target.value)}
                className="w-full px-3 py-2.5 rounded-lg bg-surface border border-border text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/40 transition-all" />
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider block mb-1.5">Posición</label>
              <select value={position} onChange={e => setPosition(e.target.value)}
                className="w-full px-3 py-2.5 rounded-lg bg-surface border border-border text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/40 transition-all">
                {POSITIONS.map(p => <option key={p} value={p}>{p}</option>)}
              </select>
            </div>
          </div>
          <button type="submit" className="w-full mt-2 rounded-lg bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground hover:bg-primary/90 transition-colors">
            Crear jugador
          </button>
        </form>
      </div>
    </div>
  );
}

const Jugadores = () => {
  const { can } = useAuth();
  const canCreate = can("crear_jugador");
  const canDelete = can("eliminar_jugador");
  const [players, setPlayers] = useState<Player[]>(getPlayers);
  const [search, setSearch] = useState("");
  const [modal, setModal] = useState(false);

  const filtered = players.filter(p => p.name.toLowerCase().includes(search.toLowerCase()));
  function refresh() { setPlayers(getPlayers()); setModal(false); }
  function handleDelete(id: string) { deletePlayer(id); setPlayers(getPlayers()); }

  return (
    <DashboardLayout>
      {modal && <CreatePlayerModal onClose={() => setModal(false)} onCreate={refresh} />}
      <div className="flex items-center justify-between mb-8 flex-wrap gap-4">
        <div>
          <h1 className="font-display text-3xl font-bold text-foreground">Jugadores</h1>
          <p className="text-muted-foreground mt-1">
            {players.length === 0 ? "Sin jugadores registrados" : `${players.length} jugador${players.length !== 1 ? "es" : ""} registrado${players.length !== 1 ? "s" : ""}`}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <input type="text" placeholder="Buscar jugador..." value={search} onChange={e => setSearch(e.target.value)}
              className="pl-10 pr-4 py-2.5 rounded-lg bg-surface border border-border text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/50 transition-all" />
          </div>
          {canCreate && (
            <button onClick={() => setModal(true)} className="flex items-center gap-2 rounded-lg bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground hover:bg-primary/90 transition-colors">
              <UserPlus className="h-4 w-4" /> Nuevo jugador
            </button>
          )}
        </div>
      </div>
      {players.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-24 text-center">
          <div className="h-16 w-16 rounded-2xl bg-surface border border-border flex items-center justify-center mb-4">
            <UserPlus className="h-7 w-7 text-muted-foreground" />
          </div>
          <h3 className="font-display font-semibold text-foreground mb-1">Sin jugadores</h3>
          <p className="text-sm text-muted-foreground mb-5">Crea el primer jugador para comenzar</p>
          {canCreate && (
            <button onClick={() => setModal(true)} className="flex items-center gap-2 rounded-lg bg-primary px-5 py-2.5 text-sm font-semibold text-primary-foreground hover:bg-primary/90 transition-colors">
              <UserPlus className="h-4 w-4" /> Crear jugador
            </button>
          )}
        </div>
      ) : filtered.length === 0 ? (
        <div className="text-center py-16 text-muted-foreground text-sm">Sin resultados para "{search}"</div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-5">
          {filtered.map(player => (
            <div key={player.id} className="relative group">
              <PlayerCard player={player} />
              {canDelete && (
                <button onClick={() => handleDelete(player.id)}
                  className="absolute top-3 right-3 opacity-0 group-hover:opacity-100 transition-opacity p-1.5 rounded-lg bg-destructive/10 hover:bg-destructive/20 text-destructive" title="Eliminar">
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </DashboardLayout>
  );
};

export default Jugadores;
