"""
cone_timer_llm.py — Medidor de tiempos de cruce con Claude Vision

Fase 1: Claude (claude-opus-4-7) detecta posiciones de conos blancos (calibración).
Fase 2: OpenCV frame-differencing rastrea al jugador (rápido, sin coste API).
Opcional: --llm-tracking usa Claude para rastrear al jugador también.

Ventaja sobre cone_timer.py: Claude comprende el contexto visual y distingue
conos reales de líneas de campo, ropa blanca u otros artefactos.

Uso:
    python cone_timer_llm.py video.mp4
    python cone_timer_llm.py video.mp4 --calib-samples 12 --output-csv tiempos.csv
    python cone_timer_llm.py video.mp4 --llm-tracking --sample-rate 5
    python cone_timer_llm.py video.mp4 --no-display --output-video resultado.mp4

Requiere:
    pip install anthropic opencv-python numpy
    export ANTHROPIC_API_KEY=sk-ant-...
"""

from __future__ import annotations

import argparse
import base64
import csv
import json
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

import anthropic
import cv2
import numpy as np


# ══════════════════════════════════════════════════════════════════════════════
# System prompts (se cachean automáticamente con cache_control=ephemeral)
# ══════════════════════════════════════════════════════════════════════════════

_CALIB_SYSTEM = """\
You are a sports video analyst. Your task is to detect white cone markers or white
flat discs placed on a grass field for sprint timing purposes.

WHAT TO LOOK FOR:
- Small white or light-colored objects lying FLAT on the grass
- Roughly circular shape, ~20-40 cm diameter (small in the frame)
- Placed in a roughly horizontal row at ground level
- IGNORE: narrow field lines, player clothing, sky, advertisements, shadows

RESPONSE — return ONLY valid JSON, no explanation, no markdown:
{
  "cones_found": true,
  "cone_x_normalized": [0.82, 0.55, 0.28],
  "confidence": 0.9,
  "notes": "3 white discs on grass"
}

Rules:
- cone_x_normalized: list of X positions normalized to [0, 1] (0=left, 1=right),
  sorted right-to-left
- confidence: 0.0–1.0 overall confidence
- If no cones visible: "cones_found": false, "cone_x_normalized": []
"""

_TRACK_SYSTEM = """\
You are tracking a player in a sports video. The player runs from right to left.

RESPONSE — return ONLY valid JSON, no explanation, no markdown:
{
  "player_found": true,
  "player_x_normalized": 0.73,
  "confidence": 0.85
}

Rules:
- player_x_normalized: horizontal center of the player body, normalized [0, 1]
  (0=left edge, 1=right edge)
- If no player visible: "player_found": false, "player_x_normalized": null
"""


# ══════════════════════════════════════════════════════════════════════════════
# Configuración
# ══════════════════════════════════════════════════════════════════════════════

@dataclass
class LLMConfig:
    # ── Modelo ────────────────────────────────────────────────────────────────
    model: str = "claude-opus-4-7"
    max_tokens: int = 512

    # ── Codificación de frames ─────────────────────────────────────────────
    max_dim: int = 1280        # resize si el lado más largo supera esto
    jpeg_quality: int = 75

    # ── Calibración ────────────────────────────────────────────────────────
    stabilize_frames: int = 60   # ventana inicial (frames) para calibrar
    calib_samples: int = 10      # cuántos frames enviar a Claude
    min_detections: int = 3      # apariciones mínimas para validar un cono
    merge_dist: float = 0.04     # distancia normalizada para fusionar conos

    # ── Tracking ────────────────────────────────────────────────────────────
    llm_tracking: bool = False   # False → OpenCV frame-diff (más rápido)
    sample_rate: int = 3         # solo relevante con --llm-tracking

    # ── Cruce ─────────────────────────────────────────────────────────────
    debounce_s: float = 0.3

    # ── API ────────────────────────────────────────────────────────────────
    api_delay_s: float = 0.05    # pausa entre llamadas para evitar rate-limit
    max_retries: int = 3


# ══════════════════════════════════════════════════════════════════════════════
# Helpers de imagen y API
# ══════════════════════════════════════════════════════════════════════════════

def _encode_frame(frame: np.ndarray, max_dim: int, quality: int) -> str:
    """Redimensiona si es necesario y codifica en base64 JPEG."""
    h, w = frame.shape[:2]
    scale = min(max_dim / max(h, w), 1.0)
    if scale < 1.0:
        frame = cv2.resize(frame, (int(w * scale), int(h * scale)),
                           interpolation=cv2.INTER_AREA)
    ok, buf = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, quality])
    if not ok:
        raise ValueError("cv2.imencode failed")
    return base64.b64encode(buf.tobytes()).decode()


def _call_claude(
    client: anthropic.Anthropic,
    system: str,
    b64: str,
    user_text: str,
    model: str,
    max_tokens: int,
) -> dict:
    """Envía un frame a Claude y devuelve el JSON parseado."""
    response = client.messages.create(
        model=model,
        max_tokens=max_tokens,
        system=[
            {
                "type": "text",
                "text": system,
                "cache_control": {"type": "ephemeral"},
            }
        ],
        messages=[
            {
                "role": "user",
                "content": [
                    {
                        "type": "image",
                        "source": {
                            "type": "base64",
                            "media_type": "image/jpeg",
                            "data": b64,
                        },
                    },
                    {"type": "text", "text": user_text},
                ],
            }
        ],
    )
    text = next((b.text for b in response.content if b.type == "text"), "").strip()
    # Strip markdown fences if model adds them
    if text.startswith("```"):
        lines = text.split("\n")
        text = "\n".join(lines[1:])
        if text.endswith("```"):
            text = text[:-3]
    return json.loads(text)


def _call_claude_retry(
    client: anthropic.Anthropic,
    system: str,
    b64: str,
    user_text: str,
    cfg: LLMConfig,
) -> dict:
    """Wrapper con retry exponencial para errores de rate-limit."""
    for attempt in range(cfg.max_retries):
        try:
            return _call_claude(client, system, b64, user_text, cfg.model, cfg.max_tokens)
        except anthropic.RateLimitError:
            wait = 2 ** attempt
            print(f"    [rate limit] reintento en {wait}s…")
            time.sleep(wait)
        except (json.JSONDecodeError, ValueError) as exc:
            if attempt == cfg.max_retries - 1:
                raise
            print(f"    [parse error] intento {attempt+1}/{cfg.max_retries}: {exc}")
            time.sleep(0.5)
    raise RuntimeError("Máximo de reintentos agotado")


# ══════════════════════════════════════════════════════════════════════════════
# Calibración con Claude
# ══════════════════════════════════════════════════════════════════════════════

def _cluster_1d(points: list[float], merge_dist: float) -> list[float]:
    if not points:
        return []
    pts = sorted(points, reverse=True)
    clusters: list[list[float]] = [[pts[0]]]
    for p in pts[1:]:
        if abs(p - float(np.mean(clusters[-1]))) <= merge_dist:
            clusters[-1].append(p)
        else:
            clusters.append([p])
    return [float(np.mean(c)) for c in clusters]


def calibrate_cones(
    cap: cv2.VideoCapture,
    cfg: LLMConfig,
    client: anthropic.Anthropic,
) -> list[float]:
    """
    Muestrea `calib_samples` frames de la ventana inicial (`stabilize_frames`),
    los envía a Claude y agrega las posiciones normalizadas de los conos.
    Retorna lista de X normalizadas [0,1], de derecha a izquierda.
    """
    print(f"  Calibrando conos con Claude Vision ({cfg.calib_samples} frames)…")

    total = cfg.stabilize_frames
    step = max(1, total // cfg.calib_samples)
    raw_xs: list[float] = []
    frames_queried = 0

    for i in range(0, total, step):
        cap.set(cv2.CAP_PROP_POS_FRAMES, float(i))
        ret, frame = cap.read()
        if not ret:
            break

        b64 = _encode_frame(frame, cfg.max_dim, cfg.jpeg_quality)
        try:
            result = _call_claude_retry(
                client, _CALIB_SYSTEM, b64,
                "Find all white cones or discs on the grass. Respond with JSON only.",
                cfg,
            )
            found = result.get("cones_found", False)
            xs    = result.get("cone_x_normalized", [])
            conf  = float(result.get("confidence", 1.0))
            notes = result.get("notes", "")

            if found and xs and conf >= 0.4:
                raw_xs.extend(xs)
                print(f"    frame {i:4d}: {len(xs)} conos  conf={conf:.2f}  {notes}")
            else:
                reason = "baja confianza" if conf < 0.4 else "no detectados"
                print(f"    frame {i:4d}: [{reason}]  {notes}")

            frames_queried += 1

        except Exception as exc:
            print(f"    frame {i:4d}: error → {exc}")

        if cfg.api_delay_s > 0:
            time.sleep(cfg.api_delay_s)

    if not raw_xs:
        return []

    clusters = _cluster_1d(raw_xs, cfg.merge_dist)

    stable: list[float] = []
    for cx in clusters:
        count = sum(1 for x in raw_xs if abs(x - cx) <= cfg.merge_dist)
        if count >= cfg.min_detections:
            stable.append(cx)

    stable.sort(reverse=True)
    print(f"  → {len(stable)} conos estables: {[f'{x:.3f}' for x in stable]}")
    return stable


# ══════════════════════════════════════════════════════════════════════════════
# Tracker de jugador (OpenCV frame-diff)
# ══════════════════════════════════════════════════════════════════════════════

class _DiffTracker:
    def __init__(self) -> None:
        self._prev: Optional[np.ndarray] = None

    def detect(self, frame: np.ndarray) -> Optional[float]:
        """Retorna X normalizada del jugador, o None."""
        gray = cv2.GaussianBlur(
            cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY), (21, 21), 0
        )
        if self._prev is None:
            self._prev = gray
            return None

        delta = cv2.absdiff(self._prev, gray)
        self._prev = gray

        _, thresh = cv2.threshold(delta, 25, 255, cv2.THRESH_BINARY)
        thresh = cv2.dilate(thresh, None, iterations=3)

        contours, _ = cv2.findContours(
            thresh, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE
        )
        if not contours:
            return None

        largest = max(contours, key=cv2.contourArea)
        if cv2.contourArea(largest) < 500:
            return None

        x, y, w, h = cv2.boundingRect(largest)
        W = frame.shape[1]
        return float(x + w / 2) / W


# ══════════════════════════════════════════════════════════════════════════════
# Lógica de cruce y resultados
# ══════════════════════════════════════════════════════════════════════════════

@dataclass
class CrossingEvent:
    cone_index: int
    time_s: float


@dataclass
class TimingState:
    cone_xs: list[float]          # normalizadas [0,1], derecha → izquierda
    crossed: list[bool]           = field(default_factory=list)
    events:  list[CrossingEvent]  = field(default_factory=list)
    _last_t: list[float]          = field(default_factory=list)

    def __post_init__(self) -> None:
        n = len(self.cone_xs)
        self.crossed = [False] * n
        self._last_t  = [-999.0] * n

    def update(
        self, player_x: float, t: float, debounce: float
    ) -> Optional[CrossingEvent]:
        """Jugador corre de derecha a izquierda → cruce cuando player_x <= cone_x."""
        for i, cx in enumerate(self.cone_xs):
            if self.crossed[i]:
                continue
            if player_x <= cx and (t - self._last_t[i]) > debounce:
                self.crossed[i] = True
                self._last_t[i] = t
                ev = CrossingEvent(cone_index=i, time_s=round(t, 3))
                self.events.append(ev)
                return ev
        return None

    @property
    def all_crossed(self) -> bool:
        return all(self.crossed)


@dataclass
class AnalysisResult:
    cone_times:  list[float]
    split_times: list[float]
    total_time:  float

    def print_summary(self) -> None:
        sep = "─" * 44
        print(f"\n{sep}")
        print("  RESULTADOS (Claude Vision + OpenCV)")
        print(sep)
        print(f"  {'Cono':<10} {'Tiempo (s)':<14} {'Parcial (s)'}")
        print(sep)
        for i, t in enumerate(self.cone_times):
            split_str = f"{self.split_times[i-1]:.3f}" if i > 0 else "—"
            print(f"  {i+1:<10} {t:<14.3f} {split_str}")
        print(sep)
        print(f"  Total:    {self.total_time:.3f} s")
        print(sep)

    def to_csv(self, path: str) -> None:
        with open(path, "w", newline="", encoding="utf-8") as f:
            writer = csv.writer(f)
            writer.writerow(["cono", "tiempo_s", "parcial_s"])
            for i, t in enumerate(self.cone_times):
                split = f"{self.split_times[i-1]:.3f}" if i > 0 else ""
                writer.writerow([i + 1, f"{t:.3f}", split])
            writer.writerow(["", "TOTAL", f"{self.total_time:.3f}"])
        print(f"  Exportado → {path}")


def _build_result(events: list[CrossingEvent]) -> AnalysisResult:
    evs    = sorted(events, key=lambda e: e.cone_index)
    times  = [e.time_s for e in evs]
    splits = [round(times[i] - times[i - 1], 3) for i in range(1, len(times))]
    total  = round(times[-1] - times[0], 3) if len(times) >= 2 else 0.0
    return AnalysisResult(cone_times=times, split_times=splits, total_time=total)


# ══════════════════════════════════════════════════════════════════════════════
# Overlay visual
# ══════════════════════════════════════════════════════════════════════════════

_GREEN  = (0, 220, 60)
_ORANGE = (0, 160, 255)
_BLUE   = (255, 80, 0)
_WHITE  = (255, 255, 255)
_BLACK  = (0,   0,   0)
_FONT   = cv2.FONT_HERSHEY_SIMPLEX


def _draw_overlay(
    frame: np.ndarray,
    cone_xs: list[float],
    crossed: list[bool],
    player_x: Optional[float],
    events: list[CrossingEvent],
    t: float,
    llm_mode: bool,
) -> np.ndarray:
    out  = frame.copy()
    H, W = out.shape[:2]

    for i, cx in enumerate(cone_xs):
        color = _ORANGE if crossed[i] else _GREEN
        xi = int(cx * W)
        cv2.line(out, (xi, H // 2), (xi, H), color, 2)
        cv2.circle(out, (xi, H - 20), 8, color, -1)
        cv2.putText(out, f"C{i+1}", (xi + 6, H - 12), _FONT, 0.55, color, 2)

    if player_x is not None:
        pxi = int(player_x * W)
        cv2.line(out, (pxi, 0), (pxi, H), _BLUE, 1)

    label = "LLM+CV" if not llm_mode else "LLM full"
    _hud_text(out, f"t={t:.3f}s  [{label}]", (10, H - 10), 0.6)

    for j, ev in enumerate(events):
        _hud_text(out, f"C{ev.cone_index+1}: {ev.time_s:.3f}s", (10, 28 + j * 24), 0.52)

    return out


def _hud_text(
    img: np.ndarray, text: str, org: tuple[int, int], scale: float = 0.6
) -> None:
    (tw, th), _ = cv2.getTextSize(text, _FONT, scale, 2)
    x, y = org
    cv2.rectangle(img, (x - 3, y - th - 4), (x + tw + 3, y + 4), _BLACK, -1)
    cv2.putText(img, text, (x, y), _FONT, scale, _WHITE, 2)


# ══════════════════════════════════════════════════════════════════════════════
# Análisis principal
# ══════════════════════════════════════════════════════════════════════════════

def analyze_video(
    video_path: str,
    cfg: LLMConfig | None = None,
    show_video: bool = True,
    output_video: str | None = None,
    output_csv: str | None = None,
) -> Optional[AnalysisResult]:

    cfg    = cfg or LLMConfig()
    client = anthropic.Anthropic()

    cap = cv2.VideoCapture(video_path)
    if not cap.isOpened():
        print(f"Error: no se puede abrir '{video_path}'")
        return None

    fps        = cap.get(cv2.CAP_PROP_FPS) or 30.0
    frame_w    = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    frame_h    = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    tot_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))

    print(f"\nVideo:  {Path(video_path).name}")
    print(f"  {frame_w}×{frame_h}  {fps:.2f} fps  {tot_frames} frames  ({tot_frames/fps:.1f}s)")
    print(f"  Modelo: {cfg.model}")
    print(f"  Modo:   {'LLM completo' if cfg.llm_tracking else 'LLM calibración + OpenCV tracking'}")

    # ── 1. Calibración con Claude ──────────────────────────────────────────────
    cone_xs = calibrate_cones(cap, cfg, client)
    if not cone_xs:
        print("Error: no se detectaron conos. Prueba --calib-samples más alto o --min-det más bajo.")
        cap.release()
        return None

    cone_xs_px = [f"{x * frame_w:.0f}px" for x in cone_xs]
    print(f"  Conos (px): {cone_xs_px}")

    # ── 2. Inicializar ─────────────────────────────────────────────────────────
    tracker = _DiffTracker()
    state   = TimingState(cone_xs=cone_xs)

    writer: Optional[cv2.VideoWriter] = None
    if output_video:
        fourcc = cv2.VideoWriter_fourcc(*"mp4v")
        writer = cv2.VideoWriter(output_video, fourcc, fps, (frame_w, frame_h))

    # ── 3. Bucle de análisis ───────────────────────────────────────────────────
    cap.set(cv2.CAP_PROP_POS_FRAMES, 0.0)
    frame_idx = 0
    print(f"\n  Analizando…  (presiona 'q' para salir)\n")

    while True:
        ret, frame = cap.read()
        if not ret:
            break

        t = frame_idx / fps
        player_x: Optional[float] = None

        if not state.all_crossed:
            if cfg.llm_tracking and frame_idx % cfg.sample_rate == 0:
                b64 = _encode_frame(frame, cfg.max_dim, cfg.jpeg_quality)
                try:
                    result = _call_claude_retry(
                        client, _TRACK_SYSTEM, b64,
                        "Where is the player? Respond with JSON only.",
                        cfg,
                    )
                    if result.get("player_found") and result.get("player_x_normalized") is not None:
                        player_x = float(result["player_x_normalized"])
                except Exception as exc:
                    print(f"  [tracking] frame {frame_idx}: {exc}")
                if cfg.api_delay_s > 0:
                    time.sleep(cfg.api_delay_s)
            else:
                player_x = tracker.detect(frame)

            if player_x is not None:
                ev = state.update(player_x, t, cfg.debounce_s)
                if ev:
                    print(f"  ✓ Cono {ev.cone_index + 1} cruzado  t={ev.time_s:.3f}s")

        # ── Display ────────────────────────────────────────────────────────────
        if show_video or writer:
            overlay = _draw_overlay(
                frame, cone_xs, state.crossed, player_x,
                state.events, t, cfg.llm_tracking,
            )
            if show_video:
                cv2.imshow("Cone Timer LLM", overlay)
                if cv2.waitKey(1) & 0xFF == ord("q"):
                    print("  Detenido por el usuario.")
                    break
            if writer:
                writer.write(overlay)

        frame_idx += 1
        if frame_idx % int(fps * 5) == 0:
            pct = 100 * frame_idx / max(tot_frames, 1)
            print(f"  [{pct:5.1f}%]  frame {frame_idx}/{tot_frames}")

    # ── 4. Liberar recursos ────────────────────────────────────────────────────
    cap.release()
    if writer:
        writer.release()
    cv2.destroyAllWindows()

    if not state.events:
        print("\n  ⚠ No se registraron cruces.")
        return None

    result = _build_result(state.events)
    result.print_summary()
    if output_csv:
        result.to_csv(output_csv)
    return result


# ══════════════════════════════════════════════════════════════════════════════
# CLI
# ══════════════════════════════════════════════════════════════════════════════

def _build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        description="Cone Timer LLM — detecta conos con Claude Vision",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    p.add_argument("video", help="Ruta al video de entrada")

    g = p.add_argument_group("Calibración (Claude Vision)")
    g.add_argument("--stabilize",     type=int,   default=60,
                   help="Frames iniciales para la ventana de calibración")
    g.add_argument("--calib-samples", type=int,   default=10,
                   help="Frames a enviar a Claude para calibrar")
    g.add_argument("--min-det",       type=int,   default=3,
                   help="Detecciones mínimas para validar un cono")
    g.add_argument("--merge-dist",    type=float, default=0.04,
                   help="Distancia normalizada para fusionar conos (0-1)")
    g.add_argument("--model",                     default="claude-opus-4-7",
                   help="Modelo Claude a usar")

    g2 = p.add_argument_group("Tracking del jugador")
    g2.add_argument("--llm-tracking", action="store_true",
                    help="Usar Claude para rastrear al jugador (más preciso, más lento)")
    g2.add_argument("--sample-rate",  type=int, default=3,
                    help="Con --llm-tracking: analizar 1 de cada N frames")
    g2.add_argument("--debounce",     type=float, default=0.3,
                    help="Segundos mínimos entre cruces del mismo cono")

    g3 = p.add_argument_group("Salida")
    g3.add_argument("--no-display",   action="store_true", help="No mostrar ventana")
    g3.add_argument("--output-video", default=None, metavar="FILE",
                    help="Guardar video con overlay (MP4)")
    g3.add_argument("--output-csv",   default=None, metavar="FILE",
                    help="Exportar tiempos a CSV")

    g4 = p.add_argument_group("API")
    g4.add_argument("--api-delay",    type=float, default=0.05,
                    help="Pausa entre llamadas API (segundos)")
    g4.add_argument("--max-retries",  type=int,   default=3)
    g4.add_argument("--max-dim",      type=int,   default=1280,
                    help="Dimensión máxima del frame antes de enviar")
    g4.add_argument("--jpeg-quality", type=int,   default=75)

    return p


def main() -> None:
    args = _build_parser().parse_args()

    cfg = LLMConfig(
        model            = args.model,
        stabilize_frames = args.stabilize,
        calib_samples    = args.calib_samples,
        min_detections   = args.min_det,
        merge_dist       = args.merge_dist,
        llm_tracking     = args.llm_tracking,
        sample_rate      = args.sample_rate,
        debounce_s       = args.debounce,
        api_delay_s      = args.api_delay,
        max_retries      = args.max_retries,
        max_dim          = args.max_dim,
        jpeg_quality     = args.jpeg_quality,
    )

    result = analyze_video(
        video_path   = args.video,
        cfg          = cfg,
        show_video   = not args.no_display,
        output_video = args.output_video,
        output_csv   = args.output_csv,
    )

    sys.exit(0 if result else 1)


if __name__ == "__main__":
    main()
