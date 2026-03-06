import { Player, SprintRecord, Calificacion } from "@/types/player";
import { computeFisica } from "./charRulesStore";

const PLAYERS_KEY = "sprintlab_players";

// ── CRUD ──────────────────────────────────────────────────────────────────────

export function getPlayers(): Player[] {
  try {
    const raw = localStorage.getItem(PLAYERS_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function persistPlayers(players: Player[]) {
  localStorage.setItem(PLAYERS_KEY, JSON.stringify(players));
}

export function createPlayer(
  name: string,
  position: string,
  age: number,
  caracterizacion?: { fisica: Calificacion; psicologica: Calificacion }
): Player {
  const words = name.trim().split(/\s+/);
  const avatar = words.map(w => w[0]?.toUpperCase() ?? "").join("").slice(0, 2);
  return {
    id: crypto.randomUUID(),
    name: name.trim(),
    age,
    position,
    avatar: avatar || "?",
    sprint: { t10: 0, t20: 0, t30: 0, t40: 0 },
    videosCount: 0,
    velocidad40History: [],
    ...(caracterizacion ? { caracterizacion } : {}),
  };
}

export function addPlayer(player: Player) {
  persistPlayers([...getPlayers(), player]);
}

export function updatePlayer(id: string, updates: Partial<Player>) {
  persistPlayers(getPlayers().map(p => p.id === id ? { ...p, ...updates } : p));
}

export function deletePlayer(id: string) {
  persistPlayers(getPlayers().filter(p => p.id !== id));
}

// ── Sprint records ─────────────────────────────────────────────────────────────
// Saves sprint record directly into the player object and updates sprint summary.

export function addSprintRecord(playerId: string, record: SprintRecord) {
  const players = getPlayers();
  const player  = players.find(p => p.id === playerId);
  if (!player) return;

  const history = [...(player.velocidad40History ?? []), record];

  // Auto-compute fisica characterization from t40 using admin rules
  const fisicaCal = computeFisica(record.t40);
  const caracterizacion = fisicaCal
    ? { ...(player.caracterizacion ?? { fisica: "promedio" as Calificacion, psicologica: "promedio" as Calificacion }), fisica: fisicaCal }
    : player.caracterizacion;

  updatePlayer(playerId, {
    velocidad40History: history,
    videosCount: (player.videosCount ?? 0) + 1,
    sprint: { t10: record.t10, t20: record.t20, t30: record.t30, t40: record.t40 },
    ...(caracterizacion ? { caracterizacion } : {}),
  });
}
