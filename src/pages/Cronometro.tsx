import { useState, useRef, useCallback, useEffect } from "react";
import DashboardLayout from "@/components/DashboardLayout";
import { VideoAnalyzer } from "@/components/VideoAnalyzer";
import { mockPlayers } from "@/data/mockPlayers";
import { SprintData } from "@/types/player";
import { Play, RotateCcw, CheckCircle, Zap, Video, Timer } from "lucide-react";

// ─── Types ────────────────────────────────────────────────────────────────────
type TimerStatus = "idle" | "running" | "finished";
type Tab = "video" | "manual";

// ─── Utilities ────────────────────────────────────────────────────────────────
function formatTime(ms: number) {
  const m = Math.floor(ms / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const c = Math.floor((ms % 1000) / 10);
  return `${String(m).padStart(2,"0")}:${String(s).padStart(2,"0")}.${String(c).padStart(2,"0")}`;
}

const SPLIT_LABELS = ["10m", "20m", "30m", "40m"];
const SPLIT_KEYS   = ["t10", "t20", "t30", "t40"] as const;

// ─── Component ────────────────────────────────────────────────────────────────
export default function Cronometro() {
  const [tab, setTab]                     = useState<Tab>("video");
  const [selectedPlayerId, setSelectedPlayerId] = useState(mockPlayers[0]?.id ?? "");
  const [sprintResult, setSprintResult]   = useState<SprintData | null>(null);
  const [resultSaved, setResultSaved]     = useState(false);

  // Manual timer state
  const [timerStatus, setTimerStatus] = useState<TimerStatus>("idle");
  const [elapsed, setElapsed]         = useState(0);
  const [splits, setSplits]           = useState<number[]>([]);

  const startTimeRef = useRef(0);
  const frameRef     = useRef(0);
  const selectedPlayer = mockPlayers.find(p => p.id === selectedPlayerId);

  // ── Manual timer ────────────────────────────────────────────────────────────
  const tick = useCallback(() => {
    setElapsed(Date.now() - startTimeRef.current);
    frameRef.current = requestAnimationFrame(tick);
  }, []);

  const handleStart = useCallback(() => {
    startTimeRef.current = Date.now();
    frameRef.current = requestAnimationFrame(tick);
    setTimerStatus("running");
    setSplits([]); setSprintResult(null); setResultSaved(false); setElapsed(0);
  }, [tick]);

  const handleSplit = useCallback(() => {
    const t = Date.now() - startTimeRef.current;
    setSplits(prev => {
      const next = [...prev, t];
      if (next.length >= 4) {
        cancelAnimationFrame(frameRef.current);
        setElapsed(t);
        setTimerStatus("finished");
        setSprintResult({
          t10: parseFloat((next[0] / 1000).toFixed(2)),
          t20: parseFloat((next[1] / 1000).toFixed(2)),
          t30: parseFloat((next[2] / 1000).toFixed(2)),
          t40: parseFloat((next[3] / 1000).toFixed(2)),
        });
      }
      return next;
    });
  }, []);

  const handleReset = useCallback(() => {
    cancelAnimationFrame(frameRef.current);
    setTimerStatus("idle"); setElapsed(0); setSplits([]);
    setSprintResult(null); setResultSaved(false);
  }, []);

  const handleSave = useCallback(() => {
    setResultSaved(true);
    // TODO: persist sprintResult for selectedPlayerId via Supabase
  }, []);

  // Keyboard shortcuts (manual mode only)
  useEffect(() => {
    if (tab !== "manual") return;
    const fn = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement) return;
      if (e.code === "Space") {
        e.preventDefault();
        if (timerStatus === "idle")    handleStart();
        else if (timerStatus === "running") handleSplit();
      }
      if (e.code === "KeyR"  && timerStatus !== "running") handleReset();
      if (e.code === "Enter" && timerStatus === "finished" && !resultSaved) handleSave();
    };
    window.addEventListener("keydown", fn);
    return () => window.removeEventListener("keydown", fn);
  }, [tab, timerStatus, resultSaved, handleStart, handleSplit, handleReset, handleSave]);

  useEffect(() => () => cancelAnimationFrame(frameRef.current), []);

  // ── Render ──────────────────────────────────────────────────────────────────
  return (
    <DashboardLayout>
      <div className="mb-8">
        <h1 className="font-display text-3xl font-bold text-foreground">Cronómetro</h1>
        <p className="text-muted-foreground mt-1">Medición de tiempos de sprint 40m</p>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 mb-6 p-1 rounded-lg bg-surface w-fit border border-border">
        {([["video", Video, "IA Video"], ["manual", Timer, "Manual"]] as const).map(([id, Icon, label]) => (
          <button key={id} onClick={() => setTab(id)}
            className={`flex items-center gap-2 px-4 py-2 rounded-md text-sm font-medium transition-all ${
              tab === id ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"
            }`}>
            <Icon className="h-4 w-4" />
            {label}
          </button>
        ))}
      </div>

      {/* Player selector (shared) */}
      <div className="mb-6 rounded-xl border border-border bg-card p-4">
        <p className="text-xs text-muted-foreground mb-3 uppercase tracking-wider font-medium">Jugador</p>
        <div className="flex gap-2 flex-wrap">
          {mockPlayers.map(p => (
            <button key={p.id} onClick={() => setSelectedPlayerId(p.id)}
              className={`flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium transition-all border ${
                selectedPlayerId === p.id
                  ? "border-primary bg-primary/10 text-primary"
                  : "border-border bg-surface text-muted-foreground hover:border-primary/30"
              }`}>
              <span className="flex h-6 w-6 items-center justify-center rounded-full bg-primary/15 text-primary text-xs font-bold">
                {p.avatar}
              </span>
              {p.name}
            </button>
          ))}
        </div>
      </div>

      {/* ═══ VIDEO TAB — VideoAnalyzer with MediaPipe ════════════════════════ */}
      {tab === "video" && (
        <div className="max-w-2xl">
          <VideoAnalyzer
            onResult={(result) => {
              setSprintResult(result);
              setResultSaved(false);
            }}
          />

          {/* Save result (shown after AI analysis) */}
          {sprintResult && (
            <div className="mt-5 rounded-xl border border-border bg-card p-5">
              <div className="flex items-center gap-3">
                <div className="flex-1 text-sm text-muted-foreground">
                  Asignar a: <strong className="text-foreground">{selectedPlayer?.name}</strong>
                </div>
                {resultSaved ? (
                  <div className="flex items-center gap-2 text-green-400 text-sm font-medium">
                    <CheckCircle className="h-4 w-4" /> Guardado
                  </div>
                ) : (
                  <button onClick={handleSave}
                    className="flex items-center gap-2 rounded-lg bg-primary px-5 py-2.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 transition-colors">
                    <CheckCircle className="h-4 w-4" /> Guardar resultado
                  </button>
                )}
              </div>
            </div>
          )}
        </div>
      )}

      {/* ═══ MANUAL TAB ══════════════════════════════════════════════════════ */}
      {tab === "manual" && (
        <div className="max-w-2xl space-y-5">
          {/* Timer display */}
          <div className="rounded-xl border border-border bg-card p-8 text-center card-elevated">
            <div className={`font-display text-8xl font-bold tracking-tight tabular-nums mb-3 transition-colors ${
              timerStatus === "running" ? "text-primary"
              : timerStatus === "finished" ? "text-green-400"
              : "text-foreground/30"
            }`}>
              {formatTime(elapsed)}
            </div>

            <div className="h-6 mb-8 flex items-center justify-center text-sm text-muted-foreground">
              {timerStatus === "idle" && (
                <span>Presiona <kbd className="bg-surface rounded px-1.5 py-0.5 text-xs font-mono">Espacio</kbd> o INICIAR</span>
              )}
              {timerStatus === "running" && splits.length < 4 && (
                <span className="flex items-center gap-1.5">
                  <Zap className="h-3.5 w-3.5 text-primary animate-pulse" />
                  Próximo: <strong className="text-primary ml-1">{SPLIT_LABELS[splits.length]}</strong>
                </span>
              )}
              {timerStatus === "finished" && <span className="text-green-400 font-medium">Sprint completado</span>}
            </div>

            {/* Split boxes */}
            <div className="grid grid-cols-4 gap-3 mb-8">
              {SPLIT_LABELS.map((label, i) => {
                const ms   = splits[i];
                const next = timerStatus === "running" && i === splits.length;
                return (
                  <div key={label} className={`rounded-lg p-4 border transition-all ${
                    ms   ? "border-primary/50 bg-primary/10"
                    : next ? "border-primary/40 bg-primary/5 animate-pulse"
                    : "border-border bg-surface/40"
                  }`}>
                    <div className="text-xs text-muted-foreground mb-1.5 font-medium">{label}</div>
                    <div className={`font-display font-bold text-xl tabular-nums ${ms ? "text-primary" : "text-foreground/20"}`}>
                      {ms ? `${(ms / 1000).toFixed(2)}s` : "—"}
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Buttons */}
            <div className="flex gap-3 justify-center">
              {timerStatus === "idle" && (
                <button onClick={handleStart}
                  className="flex items-center gap-2 rounded-lg bg-primary px-10 py-3.5 text-sm font-bold text-primary-foreground hover:bg-primary/90 transition-colors">
                  <Play className="h-4 w-4" /> Iniciar
                </button>
              )}
              {timerStatus === "running" && (
                <button onClick={handleSplit}
                  className="flex items-center gap-2 rounded-lg bg-primary px-10 py-3.5 text-base font-bold text-primary-foreground hover:bg-primary/90 shadow-lg transition-colors">
                  <Zap className="h-5 w-5" /> SPLIT — {SPLIT_LABELS[Math.min(splits.length, 3)]}
                </button>
              )}
              {timerStatus !== "idle" && (
                <button onClick={handleReset}
                  className="flex items-center gap-2 rounded-lg border border-border bg-surface px-5 py-3.5 text-sm font-medium text-muted-foreground hover:text-foreground transition-colors">
                  <RotateCcw className="h-4 w-4" /> Reset
                  <kbd className="bg-background/60 rounded px-1 text-xs font-mono ml-1">R</kbd>
                </button>
              )}
            </div>
          </div>

          {/* Save result panel (manual) */}
          {timerStatus === "finished" && sprintResult && (
            <div className="rounded-xl border border-border bg-card p-6 card-elevated">
              <h3 className="font-display font-bold text-foreground mb-5">Resultado</h3>
              <div className="grid grid-cols-4 gap-3 mb-6">
                {SPLIT_KEYS.map((k, i) => (
                  <div key={k} className="text-center rounded-lg bg-surface/50 p-3">
                    <div className="text-xs text-muted-foreground mb-1 uppercase tracking-wider">{SPLIT_LABELS[i]}</div>
                    <div className="font-display font-bold text-2xl text-primary tabular-nums">
                      {sprintResult[k].toFixed(2)}s
                    </div>
                  </div>
                ))}
              </div>
              <div className="flex items-center gap-3">
                <div className="flex-1 text-sm text-muted-foreground">
                  Para: <strong className="text-foreground">{selectedPlayer?.name}</strong>
                </div>
                {resultSaved ? (
                  <div className="flex items-center gap-2 text-green-400 text-sm font-medium">
                    <CheckCircle className="h-4 w-4" /> Guardado
                  </div>
                ) : (
                  <button onClick={handleSave}
                    className="flex items-center gap-2 rounded-lg bg-primary px-5 py-2.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 transition-colors">
                    <CheckCircle className="h-4 w-4" />
                    Guardar
                    <kbd className="bg-primary/30 rounded px-1 text-xs font-mono ml-1">Enter</kbd>
                  </button>
                )}
              </div>
            </div>
          )}

          {/* Keyboard shortcuts */}
          <div className="rounded-xl border border-border/40 bg-card/50 p-4">
            <p className="text-xs text-muted-foreground mb-2.5 font-medium uppercase tracking-wider">Atajos</p>
            <div className="flex flex-wrap gap-4 text-xs text-muted-foreground">
              {[["Espacio","Iniciar / Split"],["R","Reiniciar"],["Enter","Guardar"]].map(([k,v]) => (
                <span key={k}><kbd className="bg-surface rounded px-1.5 py-0.5 font-mono">{k}</kbd> {v}</span>
              ))}
            </div>
          </div>
        </div>
      )}
    </DashboardLayout>
  );
}
