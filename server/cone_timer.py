"""
cone_timer.py — Medidor de tiempos de cruce de conos blancos

Uso:
    python cone_timer.py video.mp4
    python cone_timer.py video.mp4 --player yolo --output-csv tiempos.csv
    python cone_timer.py video.mp4 --player yolo --output-video resultado.mp4 --no-display

Requiere:
    pip install opencv-python numpy
    pip install ultralytics        # solo para --player yolo
"""

from __future__ import annotations

import argparse
import csv
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

import cv2
import numpy as np


# ══════════════════════════════════════════════════════════════════════════════
# Configuración
# ══════════════════════════════════════════════════════════════════════════════

@dataclass
class Config:
    # HSV: blanco (escala OpenCV: H 0-179, S 0-255, V 0-255)
    hsv_lower: tuple[int, int, int] = (0,   0,   200)
    hsv_upper: tuple[int, int, int] = (180, 50,  255)

    # Pre-procesamiento
    blur_kernel: int = 5       # Gaussian Blur (debe ser impar)
    close_kernel: int = 5      # Morphological Close (rellena huecos)
    open_kernel: int = 3       # Morphological Open  (elimina ruido)

    # Filtro de contornos
    min_area: int = 200
    max_area: int = 5000

    # Estabilización de conos (frames iniciales para calibrar posiciones)
    stabilize_frames: int = 60   # analizar los primeros N frames
    min_detections: int = 5      # un cono debe aparecer ≥ N veces para considerarse real
    merge_dist_px: int = 40      # distancia para fusionar detecciones del mismo cono

    # Detección del jugador
    player_mode: str = "diff"    # "diff" | "yolo"
    yolo_model: str = "yolov8n.pt"
    yolo_conf: float = 0.4

    # Lógica de cruce
    debounce_s: float = 0.3      # segundos mínimos entre cruces del mismo cono


# ══════════════════════════════════════════════════════════════════════════════
# Detección de conos
# ══════════════════════════════════════════════════════════════════════════════

def _preprocess(frame: np.ndarray, cfg: Config) -> np.ndarray:
    """Devuelve máscara binaria de píxeles blancos."""
    blurred = cv2.GaussianBlur(frame, (cfg.blur_kernel, cfg.blur_kernel), 0)
    hsv = cv2.cvtColor(blurred, cv2.COLOR_BGR2HSV)

    mask = cv2.inRange(hsv,
                       np.array(cfg.hsv_lower, np.uint8),
                       np.array(cfg.hsv_upper, np.uint8))

    k_close = cv2.getStructuringElement(cv2.MORPH_ELLIPSE,
                                        (cfg.close_kernel, cfg.close_kernel))
    k_open  = cv2.getStructuringElement(cv2.MORPH_ELLIPSE,
                                        (cfg.open_kernel,  cfg.open_kernel))
    mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, k_close)
    mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN,  k_open)
    return mask


def detect_cones(frame: np.ndarray, cfg: Config) -> list[float]:
    """
    Detecta posiciones X de conos blancos en el frame.
    Retorna lista ordenada de derecha a izquierda.
    """
    mask = _preprocess(frame, cfg)
    contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)

    xs: list[float] = []
    for cnt in contours:
        area = cv2.contourArea(cnt)
        if cfg.min_area <= area <= cfg.max_area:
            M = cv2.moments(cnt)
            if M["m00"] > 0:
                xs.append(M["m10"] / M["m00"])

    xs.sort(reverse=True)  # derecha → izquierda
    return xs


def _cluster_1d(points: list[float], merge_dist: float) -> list[float]:
    """
    Agrupa puntos 1D que estén a menos de `merge_dist` entre sí.
    Retorna el centroide de cada cluster, de derecha a izquierda.
    """
    if not points:
        return []

    pts = sorted(points, reverse=True)
    clusters: list[list[float]] = [[pts[0]]]

    for p in pts[1:]:
        if abs(p - np.mean(clusters[-1])) <= merge_dist:
            clusters[-1].append(p)
        else:
            clusters.append([p])

    return [float(np.mean(c)) for c in clusters]


def stabilize_cones(cap: cv2.VideoCapture, cfg: Config) -> list[float]:
    """
    Analiza los primeros `cfg.stabilize_frames` frames para determinar
    posiciones estables de conos. Retorna X de cada cono, derecha → izquierda.
    """
    print(f"  Calibrando conos ({cfg.stabilize_frames} frames)…")
    raw_detections: list[float] = []

    for _ in range(cfg.stabilize_frames):
        ret, frame = cap.read()
        if not ret:
            break
        raw_detections.extend(detect_cones(frame, cfg))

    if not raw_detections:
        print("  ⚠ No se detectaron conos en la calibración.")
        return []

    # Cluster global de todas las detecciones → posiciones estables
    all_clusters = _cluster_1d(raw_detections, cfg.merge_dist_px)

    # Filtrar clusters con pocas detecciones (ruido)
    stable: list[float] = []
    for cx in all_clusters:
        count = sum(
            1 for p in raw_detections
            if abs(p - cx) <= cfg.merge_dist_px
        )
        if count >= cfg.min_detections:
            stable.append(cx)

    stable.sort(reverse=True)
    return stable


# ══════════════════════════════════════════════════════════════════════════════
# Detección del jugador
# ══════════════════════════════════════════════════════════════════════════════

class PlayerDetector:
    """Detecta la posición X del jugador en cada frame."""

    def __init__(self, cfg: Config):
        self.cfg = cfg
        self._prev_gray: Optional[np.ndarray] = None
        self._yolo = None
        self._tracker_active = False

        if cfg.player_mode == "yolo":
            self._init_yolo()

    # ── YOLOv8 ────────────────────────────────────────────────────────────────

    def _init_yolo(self) -> None:
        try:
            from ultralytics import YOLO          # type: ignore
            self._yolo = YOLO(self.cfg.yolo_model)
            print(f"  YOLOv8 cargado: {self.cfg.yolo_model}")
        except ImportError:
            print("  ⚠ ultralytics no instalado → usando frame differencing.")
            self.cfg.player_mode = "diff"

    def _detect_yolo(self, frame: np.ndarray) -> Optional[tuple[float, tuple[int, int, int, int]]]:
        """
        Devuelve (player_x, bbox) usando YOLOv8 + ByteTrack.
        Selecciona la persona con bounding box más grande (el jugador en primer plano).
        """
        results = self._yolo.track(
            frame,
            classes=[0],           # 0 = person
            conf=self.cfg.yolo_conf,
            persist=True,          # ByteTrack / BoTSORT
            verbose=False,
        )

        best_area, best_box = 0.0, None
        if results and results[0].boxes:
            for box in results[0].boxes:
                x1, y1, x2, y2 = map(int, box.xyxy[0].tolist())
                area = (x2 - x1) * (y2 - y1)
                if area > best_area:
                    best_area = area
                    best_box = (x1, y1, x2, y2)

        if best_box:
            x1, y1, x2, y2 = best_box
            return float((x1 + x2) / 2), best_box
        return None

    # ── Frame differencing ────────────────────────────────────────────────────

    def _detect_diff(self, frame: np.ndarray) -> Optional[tuple[float, tuple[int, int, int, int]]]:
        """
        Detecta al jugador como la región de mayor movimiento en el frame.
        Retorna (player_x, bbox).
        """
        gray = cv2.GaussianBlur(cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY), (21, 21), 0)

        if self._prev_gray is None:
            self._prev_gray = gray
            return None

        delta = cv2.absdiff(self._prev_gray, gray)
        self._prev_gray = gray

        _, thresh = cv2.threshold(delta, 25, 255, cv2.THRESH_BINARY)
        thresh = cv2.dilate(thresh, None, iterations=3)

        contours, _ = cv2.findContours(thresh, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        if not contours:
            return None

        # Región más grande = jugador
        largest = max(contours, key=cv2.contourArea)
        if cv2.contourArea(largest) < 500:   # filtro de ruido mínimo
            return None

        x, y, w, h = cv2.boundingRect(largest)
        player_x = float(x + w / 2)
        return player_x, (x, y, x + w, y + h)

    # ── Interfaz pública ──────────────────────────────────────────────────────

    def detect(self, frame: np.ndarray) -> Optional[tuple[float, tuple[int, int, int, int]]]:
        """
        Retorna (player_x, (x1,y1,x2,y2)) o None si no se detecta jugador.
        """
        if self.cfg.player_mode == "yolo" and self._yolo:
            return self._detect_yolo(frame)
        return self._detect_diff(frame)


# ══════════════════════════════════════════════════════════════════════════════
# Lógica de cruce
# ══════════════════════════════════════════════════════════════════════════════

@dataclass
class CrossingEvent:
    cone_index: int    # 0-based, derecha → izquierda
    time_s: float


@dataclass
class TimingState:
    cone_xs: list[float]

    crossed: list[bool]          = field(default_factory=list)
    events:  list[CrossingEvent] = field(default_factory=list)
    _last_t: list[float]         = field(default_factory=list)

    def __post_init__(self) -> None:
        n = len(self.cone_xs)
        self.crossed = [False] * n
        self._last_t  = [-999.0] * n

    def update(self, player_x: float, t: float, debounce: float) -> Optional[CrossingEvent]:
        """
        Comprueba si el jugador cruzó algún cono nuevo.
        El jugador corre de derecha a izquierda → cruce cuando player_x <= cone_x.
        Retorna el evento si hubo cruce, None en caso contrario.
        """
        for i, cone_x in enumerate(self.cone_xs):
            if self.crossed[i]:
                continue
            if player_x <= cone_x and (t - self._last_t[i]) > debounce:
                self.crossed[i] = True
                self._last_t[i] = t
                ev = CrossingEvent(cone_index=i, time_s=round(t, 3))
                self.events.append(ev)
                return ev
        return None

    @property
    def all_crossed(self) -> bool:
        return all(self.crossed)


# ══════════════════════════════════════════════════════════════════════════════
# Resultados
# ══════════════════════════════════════════════════════════════════════════════

@dataclass
class AnalysisResult:
    cone_times:  list[float]   # tiempo de cruce por cono (absoluto)
    split_times: list[float]   # tiempo entre conos consecutivos
    total_time:  float         # tiempo total (último − primero)

    # ── Consola ───────────────────────────────────────────────────────────────

    def print_summary(self) -> None:
        sep = "─" * 44
        print(f"\n{sep}")
        print("  RESULTADOS")
        print(sep)
        print(f"  {'Cono':<10} {'Tiempo (s)':<14} {'Parcial (s)'}")
        print(sep)
        for i, t in enumerate(self.cone_times):
            split_str = f"{self.split_times[i-1]:.3f}" if i > 0 else "—"
            print(f"  {i+1:<10} {t:<14.3f} {split_str}")
        print(sep)
        print(f"  Total:    {self.total_time:.3f} s")
        print(sep)

    # ── CSV ───────────────────────────────────────────────────────────────────

    def to_csv(self, path: str) -> None:
        with open(path, "w", newline="", encoding="utf-8") as f:
            writer = csv.writer(f)
            writer.writerow(["cono", "tiempo_s", "parcial_s"])
            for i, t in enumerate(self.cone_times):
                split = f"{self.split_times[i-1]:.3f}" if i > 0 else ""
                writer.writerow([i + 1, f"{t:.3f}", split])
            writer.writerow(["", "TOTAL", f"{self.total_time:.3f}"])
        print(f"  Exportado → {path}")


def build_result(events: list[CrossingEvent]) -> AnalysisResult:
    evs = sorted(events, key=lambda e: e.cone_index)
    times  = [e.time_s for e in evs]
    splits = [round(times[i] - times[i-1], 3) for i in range(1, len(times))]
    total  = round(times[-1] - times[0], 3) if len(times) >= 2 else 0.0
    return AnalysisResult(cone_times=times, split_times=splits, total_time=total)


# ══════════════════════════════════════════════════════════════════════════════
# Overlay visual
# ══════════════════════════════════════════════════════════════════════════════

_GREEN  = (0, 220, 60)
_ORANGE = (0, 160, 255)
_BLUE   = (255, 80, 0)
_WHITE  = (255, 255, 255)
_BLACK  = (0, 0, 0)
_FONT   = cv2.FONT_HERSHEY_SIMPLEX


def draw_overlay(
    frame: np.ndarray,
    cone_xs: list[float],
    crossed: list[bool],
    player_detection: Optional[tuple[float, tuple[int, int, int, int]]],
    events: list[CrossingEvent],
    t: float,
) -> np.ndarray:
    out = frame.copy()
    H, W = out.shape[:2]

    # ── Conos ─────────────────────────────────────────────────────────────────
    for i, cx in enumerate(cone_xs):
        color = _ORANGE if crossed[i] else _GREEN
        xi = int(cx)
        cv2.line(out, (xi, H // 2), (xi, H), color, 2)
        cv2.circle(out, (xi, H - 20), 8, color, -1)
        cv2.putText(out, f"C{i+1}", (xi + 6, H - 12), _FONT, 0.55, color, 2)

    # ── Jugador ───────────────────────────────────────────────────────────────
    if player_detection:
        px, (x1, y1, x2, y2) = player_detection
        cv2.rectangle(out, (x1, y1), (x2, y2), _BLUE, 2)
        cv2.line(out, (int(px), 0), (int(px), H), _BLUE, 1)

    # ── HUD tiempo ────────────────────────────────────────────────────────────
    _hud_text(out, f"t = {t:.3f}s", (10, H - 10), scale=0.7)

    # ── Cruces registrados ────────────────────────────────────────────────────
    for j, ev in enumerate(events):
        _hud_text(out, f"C{ev.cone_index+1}: {ev.time_s:.3f}s", (10, 28 + j * 24), scale=0.55)

    return out


def _hud_text(img: np.ndarray, text: str, org: tuple[int, int], scale: float = 0.6) -> None:
    (tw, th), _ = cv2.getTextSize(text, _FONT, scale, 2)
    x, y = org
    cv2.rectangle(img, (x - 3, y - th - 4), (x + tw + 3, y + 4), _BLACK, -1)
    cv2.putText(img, text, (x, y), _FONT, scale, _WHITE, 2)


# ══════════════════════════════════════════════════════════════════════════════
# Análisis principal
# ══════════════════════════════════════════════════════════════════════════════

def analyze_video(
    video_path: str,
    cfg: Config | None = None,
    show_video: bool = True,
    output_video: str | None = None,
    output_csv: str | None = None,
) -> Optional[AnalysisResult]:

    cfg = cfg or Config()

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

    # ── 1. Calibrar conos ──────────────────────────────────────────────────────
    cone_xs = stabilize_cones(cap, cfg)
    if not cone_xs:
        print("Error: no se detectaron conos. Ajusta --min-area / --max-area.")
        cap.release()
        return None
    print(f"  {len(cone_xs)} conos detectados: {[f'{x:.0f}px' for x in cone_xs]}")

    # ── 2. Inicializar detector de jugador y estado ────────────────────────────
    detector = PlayerDetector(cfg)
    state    = TimingState(cone_xs=cone_xs)

    # ── 3. Writer de video de salida ───────────────────────────────────────────
    writer: Optional[cv2.VideoWriter] = None
    if output_video:
        fourcc = cv2.VideoWriter_fourcc(*"mp4v")
        writer = cv2.VideoWriter(output_video, fourcc, fps, (frame_w, frame_h))

    # ── 4. Bucle de análisis ───────────────────────────────────────────────────
    frame_idx = 0
    print("\n  Analizando…  (presiona 'q' para salir)\n")

    while True:
        ret, frame = cap.read()
        if not ret:
            break

        t = frame_idx / fps

        # Detectar jugador
        detection = detector.detect(frame) if not state.all_crossed else None

        # Comprobar cruce
        if detection:
            player_x, _ = detection
            ev = state.update(player_x, t, cfg.debounce_s)
            if ev:
                print(f"  ✓ Cono {ev.cone_index+1} cruzado  t={ev.time_s:.3f}s")

        # Dibujar overlay
        if show_video or writer:
            overlay = draw_overlay(
                frame, cone_xs, state.crossed, detection, state.events, t
            )
            if show_video:
                cv2.imshow("Cone Timer", overlay)
                if cv2.waitKey(1) & 0xFF == ord("q"):
                    print("  Detenido por el usuario.")
                    break
            if writer:
                writer.write(overlay)

        frame_idx += 1
        if frame_idx % int(fps * 5) == 0:           # progreso cada 5 s de video
            pct = 100 * frame_idx / max(tot_frames, 1)
            print(f"  [{pct:5.1f}%]  frame {frame_idx}/{tot_frames}")

    # ── 5. Liberar recursos ────────────────────────────────────────────────────
    cap.release()
    if writer:
        writer.release()
    cv2.destroyAllWindows()

    # ── 6. Resultados ──────────────────────────────────────────────────────────
    if not state.events:
        print("\n  ⚠ No se registraron cruces.")
        return None

    result = build_result(state.events)
    result.print_summary()

    if output_csv:
        result.to_csv(output_csv)

    return result


# ══════════════════════════════════════════════════════════════════════════════
# CLI
# ══════════════════════════════════════════════════════════════════════════════

def _build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        description="Cone Timer — mide tiempos de cruce de conos blancos en video",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    p.add_argument("video",  help="Ruta al video de entrada")

    # Detección de conos
    g = p.add_argument_group("Detección de conos")
    g.add_argument("--min-area",  type=int, default=200,  help="Área mínima de contorno")
    g.add_argument("--max-area",  type=int, default=5000, help="Área máxima de contorno")
    g.add_argument("--stabilize", type=int, default=60,   help="Frames para calibrar conos")
    g.add_argument("--min-det",   type=int, default=5,    help="Detecciones mínimas para validar un cono")

    # Detección del jugador
    g2 = p.add_argument_group("Detección del jugador")
    g2.add_argument("--player", choices=["diff", "yolo"], default="diff",
                    help="Método de detección")
    g2.add_argument("--yolo-model", default="yolov8n.pt", help="Modelo YOLOv8")
    g2.add_argument("--yolo-conf",  type=float, default=0.4)

    # Salida
    g3 = p.add_argument_group("Salida")
    g3.add_argument("--no-display",    action="store_true", help="No mostrar ventana de video")
    g3.add_argument("--output-video",  default=None, metavar="FILE", help="Guardar video con overlay")
    g3.add_argument("--output-csv",    default=None, metavar="FILE", help="Exportar resultados a CSV")
    g3.add_argument("--debounce",      type=float, default=0.3, help="Segundos mínimos entre cruces")

    return p


def main() -> None:
    args = _build_parser().parse_args()

    cfg = Config(
        min_area         = args.min_area,
        max_area         = args.max_area,
        stabilize_frames = args.stabilize,
        min_detections   = args.min_det,
        player_mode      = args.player,
        yolo_model       = args.yolo_model,
        yolo_conf        = args.yolo_conf,
        debounce_s       = args.debounce,
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
