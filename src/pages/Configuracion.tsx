import { useState } from "react";
import DashboardLayout from "@/components/DashboardLayout";
import { useAuth } from "@/context/AuthContext";
import { getRules, saveRules, DEFAULT_RULES, CharRules, ThresholdRule } from "@/lib/charRulesStore";
import { useNavigate } from "react-router-dom";
import { Settings, RotateCcw, Save, CheckCircle } from "lucide-react";

type RuleKey = keyof CharRules;

const RULE_DESCRIPTIONS: Record<RuleKey, string> = {
  sprint40m:   "Determina la calificación física basada en el tiempo del sprint de 40m",
  sprint10m:   "Califica la potencia explosiva inicial según el tiempo de 10m",
  agilidad:    "Evalúa la agilidad según el tiempo del test de conos/T-test",
  vo2max:      "Califica la potencia aeróbica según el VO2 máximo",
  resistencia: "Evalúa la resistencia intermitente según la distancia total recorrida",
};

function RuleEditor({
  ruleKey,
  rule,
  onChange,
}: {
  ruleKey: RuleKey;
  rule: ThresholdRule;
  onChange: (r: ThresholdRule) => void;
}) {
  const inputClass = "w-full px-3 py-2 rounded-lg bg-surface border border-border text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/40 transition-all tabular-nums";

  return (
    <div className="rounded-xl border border-border bg-card p-5">
      <div className="mb-4">
        <h3 className="text-sm font-semibold text-foreground">{rule.label}</h3>
        <p className="text-xs text-muted-foreground mt-0.5">{RULE_DESCRIPTIONS[ruleKey]}</p>
        <span className="mt-2 inline-flex items-center rounded-full bg-surface border border-border px-2.5 py-0.5 text-[10px] font-medium text-muted-foreground">
          Unidad: {rule.unit} · {rule.lowerIsBetter ? "Menor es mejor" : "Mayor es mejor"}
        </span>
      </div>

      <div className="grid grid-cols-3 gap-3">
        <div>
          <label className="text-[10px] font-semibold text-green-400 uppercase tracking-wider block mb-1.5">
            Bueno {rule.lowerIsBetter ? `≤` : `≥`} ({rule.unit})
          </label>
          <input
            type="number"
            step="0.1"
            value={rule.bueno}
            onChange={e => onChange({ ...rule, bueno: parseFloat(e.target.value) || 0 })}
            className={inputClass}
          />
          <p className="text-[10px] text-muted-foreground mt-1">
            {rule.lowerIsBetter ? `Si tiempo ≤ ${rule.bueno}${rule.unit}` : `Si valor ≥ ${rule.bueno}${rule.unit}`}
          </p>
        </div>
        <div>
          <label className="text-[10px] font-semibold text-yellow-400 uppercase tracking-wider block mb-1.5">
            Promedio {rule.lowerIsBetter ? `≤` : `≥`} ({rule.unit})
          </label>
          <input
            type="number"
            step="0.1"
            value={rule.promedio}
            onChange={e => onChange({ ...rule, promedio: parseFloat(e.target.value) || 0 })}
            className={inputClass}
          />
          <p className="text-[10px] text-muted-foreground mt-1">
            {rule.lowerIsBetter ? `Si tiempo ≤ ${rule.promedio}${rule.unit}` : `Si valor ≥ ${rule.promedio}${rule.unit}`}
          </p>
        </div>
        <div>
          <label className="text-[10px] font-semibold text-red-400 uppercase tracking-wider block mb-1.5">
            Bajo (resto)
          </label>
          <div className={`${inputClass} flex items-center text-muted-foreground bg-surface/50`}>
            {rule.lowerIsBetter ? `> ${rule.promedio}${rule.unit}` : `< ${rule.promedio}${rule.unit}`}
          </div>
          <p className="text-[10px] text-muted-foreground mt-1">Calculado automáticamente</p>
        </div>
      </div>

      {/* Visual preview */}
      <div className="mt-4 rounded-lg bg-surface border border-border p-3">
        <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider mb-2">Ejemplo visual</p>
        <div className="flex items-center gap-2">
          <div className="flex-1 h-3 rounded-full bg-border overflow-hidden flex">
            <div className="bg-red-500 h-full" style={{ width: rule.lowerIsBetter ? "20%" : "20%" }} />
            <div className="bg-yellow-500 h-full" style={{ width: "35%" }} />
            <div className="bg-green-500 h-full" style={{ width: "45%" }} />
          </div>
          <div className="flex gap-3 text-[10px]">
            <span className="text-red-400">Bajo</span>
            <span className="text-yellow-400">Promedio</span>
            <span className="text-green-400">Bueno</span>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function Configuracion() {
  const { can } = useAuth();
  const navigate = useNavigate();

  if (!can("gestionar_usuarios")) {
    navigate("/", { replace: true });
    return null;
  }

  const [rules, setRules] = useState<CharRules>(getRules);
  const [saved, setSaved] = useState(false);

  function handleSave() {
    saveRules(rules);
    setSaved(true);
    setTimeout(() => setSaved(false), 2500);
  }

  function handleReset() {
    setRules(DEFAULT_RULES);
  }

  function updateRule(key: RuleKey, rule: ThresholdRule) {
    setRules(prev => ({ ...prev, [key]: rule }));
    setSaved(false);
  }

  return (
    <DashboardLayout>
      <div className="flex items-center justify-between mb-8 flex-wrap gap-4">
        <div>
          <h1 className="font-display text-3xl font-bold text-foreground flex items-center gap-3">
            <Settings className="h-7 w-7 text-primary" />
            Configuración
          </h1>
          <p className="text-muted-foreground mt-1">
            Define los umbrales que determinan la calificación (Bueno / Promedio / Bajo) de cada jugador
          </p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={handleReset}
            className="flex items-center gap-2 rounded-lg border border-border bg-surface px-4 py-2.5 text-sm font-semibold text-foreground hover:border-primary/30 transition-colors"
          >
            <RotateCcw className="h-4 w-4" /> Restaurar valores
          </button>
          <button
            onClick={handleSave}
            className="flex items-center gap-2 rounded-lg bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground hover:bg-primary/90 transition-colors"
          >
            {saved ? <CheckCircle className="h-4 w-4" /> : <Save className="h-4 w-4" />}
            {saved ? "Guardado" : "Guardar reglas"}
          </button>
        </div>
      </div>

      <div className="rounded-xl border border-border bg-card p-4 mb-6 card-elevated">
        <p className="text-sm text-muted-foreground">
          Estas reglas se aplican <span className="font-medium text-foreground">automáticamente</span> al guardar resultados de análisis.
          La caracterización física de cada jugador se recalcula con cada nuevo sprint registrado.
        </p>
      </div>

      <div className="space-y-4">
        {(Object.keys(rules) as RuleKey[]).map(key => (
          <RuleEditor
            key={key}
            ruleKey={key}
            rule={rules[key]}
            onChange={r => updateRule(key, r)}
          />
        ))}
      </div>
    </DashboardLayout>
  );
}
