export interface SprintData {
  t10: number;
  t20: number;
  t30: number;
  t40: number;
  reaction?: number;   // tiempo desde arranque hasta detección de primer movimiento (s)
  hipAngle?: number;
  kneeAngle?: number;
  ankleAngle?: number;
}

export interface SprintRecord extends SprintData {
  date: string; // "YYYY-MM-DD"
  notes?: string;
}

// ─── Caracterización ──────────────────────────────────────────────────────────

export type Calificacion = "bueno" | "promedio" | "bajo";

export interface CaracterizacionData {
  fisica: Calificacion;
  psicologica: Calificacion;
  // 2 más categorías próximamente
}

// ─── Records por categoría de test ───────────────────────────────────────────

export interface PotenciaExpRecord {
  date: string;
  t10: number;   // tiempo 10m (explosividad inicial)
  t20: number;   // tiempo 20m
  calificacion: Calificacion;
  notes?: string;
}

export interface AgilidadRecord {
  date: string;
  tiempo: number;       // segundos test de agilidad (T-test, conos, etc.)
  calificacion: Calificacion;
  notes?: string;
}

// Velocidad 40m reutiliza SprintRecord completo

export interface BiomecanicaRecord {
  date: string;
  hipAngle: number;
  kneeAngle: number;
  ankleAngle: number;
  calificacion: Calificacion;
  notes?: string;
}

export interface ResistenciaInterRecord {
  date: string;
  nivel: number;         // nivel alcanzado (Yo-Yo / HIIT)
  distancia: number;     // metros recorridos
  calificacion: Calificacion;
  notes?: string;
}

export interface VO2Record {
  date: string;
  vo2max: number;        // ml/kg/min
  calificacion: Calificacion;
  notes?: string;
}

// ─── Player ───────────────────────────────────────────────────────────────────

export interface Player {
  id: string;
  name: string;
  age: number;
  position: string;
  avatar: string;
  sprint: SprintData;
  videosCount: number;
  caracterizacion?: CaracterizacionData;
  sprintHistory?: SprintRecord[];
  potenciaExpHistory?: PotenciaExpRecord[];
  agilidadHistory?: AgilidadRecord[];
  velocidad40History?: SprintRecord[];
  biomecanicaHistory?: BiomecanicaRecord[];
  resistenciaInterHistory?: ResistenciaInterRecord[];
  vo2History?: VO2Record[];
}
