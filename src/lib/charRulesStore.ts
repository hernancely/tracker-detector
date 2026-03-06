import { Calificacion } from "@/types/player";

const RULES_KEY = "sprintlab_char_rules";

export interface ThresholdRule {
  label: string;        // display name
  unit: string;         // e.g. "s", "m", "ml/kg/min"
  lowerIsBetter: boolean;
  bueno: number;        // threshold: ≤ (lower) or ≥ (higher) = Bueno
  promedio: number;     // threshold: ≤ (lower) or ≥ (higher) = Promedio, else Bajo
}

export interface CharRules {
  sprint40m:   ThresholdRule;
  sprint10m:   ThresholdRule;
  agilidad:    ThresholdRule;
  vo2max:      ThresholdRule;
  resistencia: ThresholdRule;
}

export const DEFAULT_RULES: CharRules = {
  sprint40m:   { label: "Sprint 40m (t40)",         unit: "s",          lowerIsBetter: true,  bueno: 5.0,   promedio: 5.8  },
  sprint10m:   { label: "Potencia Explosiva (t10)",  unit: "s",          lowerIsBetter: true,  bueno: 1.8,   promedio: 2.2  },
  agilidad:    { label: "Agilidad",                  unit: "s",          lowerIsBetter: true,  bueno: 9.5,   promedio: 11.0 },
  vo2max:      { label: "VO2 máx",                   unit: "ml/kg/min",  lowerIsBetter: false, bueno: 55.0,  promedio: 45.0 },
  resistencia: { label: "Resistencia Intermitente",  unit: "m",          lowerIsBetter: false, bueno: 1200,  promedio: 800  },
};

export function getRules(): CharRules {
  try {
    const raw = localStorage.getItem(RULES_KEY);
    if (!raw) return DEFAULT_RULES;
    return { ...DEFAULT_RULES, ...JSON.parse(raw) };
  } catch {
    return DEFAULT_RULES;
  }
}

export function saveRules(rules: CharRules): void {
  localStorage.setItem(RULES_KEY, JSON.stringify(rules));
}

export function classify(value: number, rule: ThresholdRule): Calificacion {
  if (rule.lowerIsBetter) {
    if (value <= rule.bueno)    return "bueno";
    if (value <= rule.promedio) return "promedio";
    return "bajo";
  } else {
    if (value >= rule.bueno)    return "bueno";
    if (value >= rule.promedio) return "promedio";
    return "bajo";
  }
}

/** Computes fisica calificacion from sprint t40, using current rules */
export function computeFisica(t40: number): Calificacion | null {
  if (!t40 || t40 <= 0) return null;
  return classify(t40, getRules().sprint40m);
}
