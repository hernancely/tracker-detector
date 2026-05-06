/**
 * VideoAnalyzer — sprint biomechanics analyzer
 *
 * Detection is handled by a local Python server (localhost:8000).
 * The server supports OpenPose (primary) or MediaPipe Python (fallback).
 *
 * Algorithm (moving camera compatible):
 * - Per-frame pose from server → player foot X coordinate
 * - Per-frame cone detection (purple HSV thresholding, runs in browser)
 * - Split timing via directional cone-crossing (seenLeft + seenRight required)
 */
import { useState, useRef, useCallback, useEffect } from "react";
import { SprintData } from "@/types/player";
import {
  Loader2, Upload, X, AlertCircle, CheckCircle, Eye, WifiOff, Server,
} from "lucide-react";

const POSE_SERVER = import.meta.env.VITE_POSE_SERVER_URL ?? "http://localhost:8000";
const CONE_STORAGE_KEY = "fa_cone";
const LLM_CONE_KEY    = "fa_llm_cones";

// ─── Types ────────────────────────────────────────────────────────────────────
interface PoseLandmark { x: number; y: number; z?: number; visibility?: number; }
interface PoseResult   { landmarks: PoseLandmark[][]; engine?: string; }

type Phase = "server_check" | "ready" | "analyzing" | "complete" | "error";
interface FrameCone { x: number; y: number; topY?: number; color: string; w?: number; h?: number; conf?: number; }

interface ConeConfig {
  id: string;
  label: string;
  color: string;
  hMin: number;
  hMax: number;
  sMin: number;
  sMax?: number;
  vMin: number;
}

const CONE_CONFIGS: ConeConfig[] = [
  { id: "rosa",     label: "Rosa",     color: "#ec4899", hMin: 290, hMax: 348, sMin: 0.55, vMin: 0.40 },
  { id: "naranja",  label: "Naranja",  color: "#f97316", hMin:  12, hMax:  38, sMin: 0.65, vMin: 0.50 },
  { id: "verde",    label: "Verde",    color: "#4ade80", hMin: 105, hMax: 150, sMin: 0.70, vMin: 0.45 },
  { id: "amarillo", label: "Amarillo", color: "#facc15", hMin:  50, hMax:  88, sMin: 0.60, vMin: 0.55 },
  { id: "azul",     label: "Azul",     color: "#38bdf8", hMin: 182, hMax: 218, sMin: 0.50, vMin: 0.40 },
  { id: "blanco",   label: "Blanco",   color: "#e2e8f0", hMin:   0, hMax: 360, sMin: 0.00, sMax: 0.15, vMin: 0.82 },
];

function matchesCone(h: number, s: number, v: number, cfg: ConeConfig): boolean {
  if (v < cfg.vMin) return false;
  if (cfg.sMax !== undefined) return s <= cfg.sMax;
  if (s < cfg.sMin) return false;
  return h >= cfg.hMin && h <= cfg.hMax;
}

export interface VideoAnalyzerProps {
  onResult?: (result: SprintData) => void;
}

// ─── BlazePose / MediaPipe 33-keypoint skeleton definition ────────────────────
const SKELETON: [number, number][] = [
  [0,1],[0,4],[1,2],[2,3],[3,7],[4,5],[5,6],[6,8],[9,10],  // head
  [11,12],                                                   // shoulders
  [11,13],[13,15],[15,21],                                   // left arm
  [12,14],[14,16],[16,22],                                   // right arm
  [11,23],[12,24],[23,24],                                   // torso
  [23,25],[25,27],[27,29],[27,31],                           // left leg
  [24,26],[26,28],[28,30],[28,32],                           // right leg
];

function keypointColor(idx: number): string {
  if (idx <= 10) return "#22c55e";   // head     → green
  if (idx <= 12) return "#eab308";   // shoulders → yellow
  if (idx <= 22) return "#ef4444";   // arms     → red
  if (idx <= 24) return "#eab308";   // hips     → yellow
  return                 "#3b82f6";  // legs/feet → blue
}

// ─── Color detection helpers (browser-side, no server needed) ─────────────────
function rgbToHsv(r: number, g: number, b: number) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  let h = 0;
  if (d) switch (max) {
    case r: h = ((g - b) / d + (g < b ? 6 : 0)) / 6; break;
    case g: h = ((b - r) / d + 2) / 6; break;
    case b: h = ((r - g) / d + 4) / 6; break;
  }
  return { h: h * 360, s: max ? d / max : 0, v: max };
}

function clusterPoints(pts: { x: number; y: number }[], r: number) {
  const cls: {
    x: number; y: number; n: number; sx: number; sy: number;
    x0: number; x1: number; y0: number; y1: number;
  }[] = [];
  for (const pt of pts) {
    let hit = false;
    for (const c of cls) {
      if (Math.hypot(pt.x - c.x, pt.y - c.y) < r) {
        c.sx += pt.x; c.sy += pt.y; c.n++;
        c.x = c.sx / c.n; c.y = c.sy / c.n;
        if (pt.x < c.x0) c.x0 = pt.x; if (pt.x > c.x1) c.x1 = pt.x;
        if (pt.y < c.y0) c.y0 = pt.y; if (pt.y > c.y1) c.y1 = pt.y;
        hit = true; break;
      }
    }
    if (!hit) cls.push({ x: pt.x, y: pt.y, n: 1, sx: pt.x, sy: pt.y, x0: pt.x, x1: pt.x, y0: pt.y, y1: pt.y });
  }
  return cls.filter(c => c.n >= 2).sort((a, b) => a.x - b.x);
}

// Returns the ratio of average pixel-width in the bottom half vs top half of a cluster.
// A cone (wide base → narrow top) gives ratio > 1. A horizontal rope gives ratio ≈ 1.
function conicScore(
  data: Uint8ClampedArray,
  W: number,
  cl: { x0: number; x1: number; y0: number; y1: number },
  cone: ConeConfig,
): number {
  const rows: number[] = [];
  for (let y = cl.y0; y <= cl.y1; y += 2) {
    let cnt = 0;
    for (let x = cl.x0; x <= cl.x1; x += 2) {
      const i = (y * W + x) * 4;
      const { h, s, v } = rgbToHsv(data[i], data[i + 1], data[i + 2]);
      if (matchesCone(h, s, v, cone)) cnt++;
    }
    rows.push(cnt);
  }
  if (rows.length < 4) return 0;
  const half        = Math.floor(rows.length / 2);
  const topAvg      = (rows.slice(0, half).reduce((a, b) => a + b, 0) / half)      || 0.01;
  const bottomAvg   = (rows.slice(half).reduce((a, b) => a + b, 0) / (rows.length - half)) || 0.01;
  return bottomAvg / topAvg; // >1 means wider at bottom → cone shape
}

type PlayerBox = { x0: number; y0: number; x1: number; y1: number };

function playerBoxFromPose(
  landmarks: { x: number; y: number; visibility?: number }[],
  W: number, H: number,
  minVis = 0.05,
): PlayerBox | null {
  const vis = landmarks.filter(lm => (lm.visibility ?? 0) >= minVis);
  if (vis.length < 3) return null;
  return {
    x0: Math.min(...vis.map(lm => lm.x)) * W,
    x1: Math.max(...vis.map(lm => lm.x)) * W,
    y0: Math.min(...vis.map(lm => lm.y)) * H,
    y1: Math.max(...vis.map(lm => lm.y)) * H,
  };
}

function detectConesInFrame(
  data: Uint8ClampedArray,
  W: number,
  H: number,
  cone: ConeConfig,
  kneeY: number | null,     // pixel Y of player's knees — cones only searched below this line
  aspectMax  = 2.8,         // max width/height ratio for a valid cone cluster
  minHPct    = 0.008,       // min cluster height as fraction of frame height
  conicMin   = 1.2,         // min bottom/top width ratio (0 = disabled, >1 = cone-shaped)
  playerBox: PlayerBox | null = null, // pixel-space bounding box of the player — excluded
): FrameCone[] {
  // Search only below the knees: cones are flat discs on the ground,
  // always below knee level. Fall back to the lower 45 % when knees aren't detected.
  const y0 = kneeY != null ? Math.floor(kneeY) : Math.floor(H * 0.55);
  const y1 = H;

  // Expand player box by 3 % of frame to cover shoe edges / loose clothing
  const pad = W * 0.03;
  const px0 = playerBox ? playerBox.x0 - pad : -1;
  const px1 = playerBox ? playerBox.x1 + pad :  0;
  const py0 = playerBox ? playerBox.y0 - pad : -1;
  const py1 = playerBox ? playerBox.y1 + pad :  0;

  const pts: { x: number; y: number }[] = [];
  for (let y = y0; y < y1; y += 2)
    for (let x = 0; x < W; x += 2) {
      if (playerBox && x >= px0 && x <= px1 && y >= py0 && y <= py1) continue;
      const i = (y * W + x) * 4;
      const { h, s, v } = rgbToHsv(data[i], data[i + 1], data[i + 2]);
      if (matchesCone(h, s, v, cone)) pts.push({ x, y });
    }

  // Larger radius → nearby patches merge into one cluster instead of fragmenting.
  const r = Math.max(30, Math.floor(W * 0.045));

  // ── Size constraints based on the physical cone (~35 cm disc) ─────────────────
  // At typical sprint-test distances a cone spans ≈1.5 %–10 % of frame width.
  // Smaller = noise pixel; larger = clothing patch or grass area, not a cone.
  const minW = W * 0.015;
  const maxW = W * 0.12;
  const minH = H * minHPct;
  const maxH = H * 0.10;

  // Scale minimum point count with expected cone area at this resolution (step-2 sampling).
  const minPts = Math.max(6, Math.floor(minW * minH / 8));

  const isCone = (c: ReturnType<typeof clusterPoints>[0]) => {
    const cw = c.x1 - c.x0 + 1;
    const ch = c.y1 - c.y0 + 1;
    return (
      c.n  >= minPts &&
      cw   >= minW  &&
      cw   <= maxW  &&
      ch   >= minH  &&
      ch   <= maxH  &&
      cw / ch >= 0.45 &&
      cw / ch <= aspectMax
    );
  };

  const candidates = clusterPoints(pts, r).filter(isCone).sort((a, b) => b.n - a.n).slice(0, 6);

  // Suppress horizontal line patterns (measuring ropes, field lines):
  // if ≥3 clusters share the same Y band AND collectively span >30% of frame width → line, not cones.
  const isPartOfHLine = (c: typeof candidates[0]) => {
    const band = candidates.filter(o => Math.abs(o.y - c.y) <= H * 0.04);
    if (band.length < 3) return false;
    const xSpan = Math.max(...band.map(o => o.x1)) - Math.min(...band.map(o => o.x0));
    return xSpan > W * 0.30;
  };

  return candidates
    .filter(c => !isPartOfHLine(c))
    .filter(c => conicMin <= 0 || conicScore(data, W, c, cone) >= conicMin)
    .map(cl => ({ x: cl.x, y: cl.y, color: cone.color }));
}

function detectPlayerColorInFrame(
  data: Uint8ClampedArray,
  W: number,
  H: number,
): { x: number; y: number } | null {
  let sumX = 0, sumY = 0, count = 0;
  for (let y = 0; y < H; y += 3) {
    for (let x = 0; x < W; x += 3) {
      const i = (y * W + x) * 4;
      const { h, s, v } = rgbToHsv(data[i], data[i + 1], data[i + 2]);
      if (h >= 65 && h <= 165 && s > 0.18 && v > 0.15) continue; // grass
      if (h >= 250 && h <= 330 && s > 0.28) continue;             // cones
      if (v < 0.18) continue;                                      // shadows
      if (s < 0.08 && v > 0.85) continue;                         // white lines
      sumX += x; sumY += y; count++;
    }
  }
  if (count < 20) return null;
  return { x: sumX / count / W, y: sumY / count / H };
}

function angleDeg(
  ax: number, ay: number,
  bx: number, by: number,
  cx: number, cy: number,
): number {
  const ux = ax - bx, uy = ay - by;
  const vx = cx - bx, vy = cy - by;
  const dot = ux * vx + uy * vy;
  const mag = Math.hypot(ux, uy) * Math.hypot(vx, vy);
  if (mag === 0) return 0;
  return (Math.acos(Math.max(-1, Math.min(1, dot / mag))) * 180) / Math.PI;
}

function seekTo(v: HTMLVideoElement, t: number): Promise<void> {
  return new Promise(res => {
    const timer = setTimeout(res, 4000);
    const fn = () => { clearTimeout(timer); v.removeEventListener("seeked", fn); res(); };
    v.addEventListener("seeked", fn);
    v.currentTime = t;
  });
}

// ─── Server API ────────────────────────────────────────────────────────────────
async function checkServer(): Promise<{ ok: boolean; engine: string; available: string[]; yoloCones: boolean }> {
  try {
    const res = await fetch(`${POSE_SERVER}/health`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return { ok: false, engine: "none", available: [], yoloCones: false };
    const data = await res.json();
    return {
      ok:        true,
      engine:    data.engine     ?? "unknown",
      available: data.available  ?? [data.engine].filter(Boolean),
      yoloCones: data.yolo_cones ?? false,
    };
  } catch {
    return { ok: false, engine: "none", available: [], yoloCones: false };
  }
}

async function fetchConesYOLO(
  canvas: HTMLCanvasElement,
  conf = 0.35,
): Promise<{ x: number; y: number; color: string }[]> {
  try {
    const base64 = canvas.toDataURL("image/jpeg", 0.80).split(",")[1];
    const res = await fetch(`${POSE_SERVER}/detect-cones`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ image: base64, conf }),
      signal: AbortSignal.timeout(6000),
    });
    if (!res.ok) return [];
    const data = await res.json();
    if (!data.available) return [];
    return (data.cones as { x: number; y: number; w: number; h: number; conf: number; label: string }[]).map(c => ({
      x:     c.x,
      y:     c.y,
      w:     c.w,
      h:     c.h,
      conf:  c.conf,
      color: "#facc15",
    }));
  } catch {
    return [];
  }
}

async function fetchPose(canvas: HTMLCanvasElement, engine?: string): Promise<PoseResult | null> {
  try {
    const base64 = canvas.toDataURL("image/jpeg", 0.85).split(",")[1];
    const body: Record<string, string> = { image: base64 };
    if (engine) body.engine = engine;
    const res = await fetch(`${POSE_SERVER}/detect`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return {
      landmarks: data.landmarks && data.landmarks.length > 0 ? [data.landmarks] : [],
      engine: data.engine,
    };
  } catch {
    return null;
  }
}

// ─── Canvas HUD drawing (analysis mode) ───────────────────────────────────────
function drawDetection(
  ctx: CanvasRenderingContext2D,
  src: HTMLCanvasElement,
  pose: PoseResult | null,
  cones: FrameCone[],
  W: number,
  H: number,
  currentTime: number,
  splitsRecorded: number,
  footX: number | null,
  footY: number | null,
  isCrossing: boolean,
  kneeY: number | null,
  coneTracks: { x: number; y: number; seenCount: number; fired: boolean; firstSeen: number }[],
  sampleFps: number,
  currentFrame: number,
  playerBox: PlayerBox | null = null,
  angles?: { hip: number | null; knee: number | null; ankle: number | null },
) {
  ctx.drawImage(src, 0, 0, W, H);
  ctx.fillStyle = "rgba(0,0,0,0.15)";
  ctx.fillRect(0, 0, W, H);

  // ── Cone search zone rectangle ────────────────────────────────────────────────
  const zoneY = kneeY != null ? Math.floor(kneeY) : Math.floor(H * 0.55);
  // Semi-transparent fill inside the search box
  ctx.fillStyle = "rgba(250,204,21,0.10)";
  ctx.fillRect(2, zoneY, W - 4, H - zoneY - 2);
  // Bold rectangle border
  ctx.strokeStyle = "rgba(250,204,21,0.90)";
  ctx.lineWidth = 3;
  ctx.setLineDash([]);
  ctx.strokeRect(2, zoneY, W - 4, H - zoneY - 2);
  // Label badge pinned to top-left corner of the box
  const label = kneeY != null ? "🔍 zona conos (bajo rodilla)" : "🔍 zona conos (fallback)";
  const lw = ctx.measureText(label).width + 20;
  ctx.fillStyle = "rgba(250,204,21,0.92)";
  roundRect(ctx, 2, zoneY, lw, 22, 0);
  ctx.fill();
  ctx.fillStyle = "#000";
  ctx.font = "bold 11px Inter,sans-serif";
  ctx.textAlign = "left";
  ctx.fillText(label, 10, zoneY + 15);

  // ── Player bounding box ───────────────────────────────────────────────────────
  if (playerBox) {
    const pad = W * 0.01;
    const bx = playerBox.x0 - pad, by = playerBox.y0 - pad;
    const bw = (playerBox.x1 - playerBox.x0) + pad * 2;
    const bh = (playerBox.y1 - playerBox.y0) + pad * 2;
    // Solid cyan box
    ctx.strokeStyle = "rgba(6,182,212,0.95)";
    ctx.lineWidth = 2.5;
    ctx.setLineDash([]);
    ctx.strokeRect(bx, by, bw, bh);
    // Corner brackets for sporty look
    const cs = Math.min(bw, bh) * 0.15;
    ctx.strokeStyle = "#06b6d4";
    ctx.lineWidth = 3.5;
    for (const [ox, oy, dx, dy] of [
      [bx, by, 1, 1], [bx + bw, by, -1, 1],
      [bx, by + bh, 1, -1], [bx + bw, by + bh, -1, -1],
    ] as [number,number,number,number][]) {
      ctx.beginPath();
      ctx.moveTo(ox + dx * cs, oy);
      ctx.lineTo(ox, oy);
      ctx.lineTo(ox, oy + dy * cs);
      ctx.stroke();
    }
    // Label badge
    ctx.font = "bold 11px Inter,sans-serif";
    const lbl = "Jugador";
    const lw = ctx.measureText(lbl).width + 14;
    ctx.fillStyle = "rgba(6,182,212,0.92)";
    roundRect(ctx, bx, by - 20, lw, 20, 4);
    ctx.fill();
    ctx.fillStyle = "#fff";
    ctx.textAlign = "left";
    ctx.fillText(lbl, bx + 7, by - 5);
  }

  // ── Cone track tick marks ─────────────────────────────────────────────────────
  const CONFIRM_FRAMES = 4;
  for (const tr of coneTracks) {
    const px = tr.x * W;
    const confirmed = tr.seenCount >= CONFIRM_FRAMES;
    const aged      = (currentFrame - tr.firstSeen) >= sampleFps;
    const color = tr.fired        ? "rgba(34,197,94,0.8)"   // green = fired/used
                : (confirmed && aged) ? "rgba(251,191,36,0.9)"  // amber = ready to fire
                : confirmed       ? "rgba(148,163,184,0.7)"  // grey = confirmed, too young
                                  : "rgba(100,100,100,0.5)"; // dim = not yet confirmed
    ctx.strokeStyle = color;
    ctx.lineWidth   = confirmed ? 2.5 : 1.5;
    ctx.beginPath();
    ctx.moveTo(px, H - 28);
    ctx.lineTo(px, H - 4);
    ctx.stroke();
    // Small dot at top of tick
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(px, H - 28, 4, 0, Math.PI * 2);
    ctx.fill();
  }


  if (isCrossing) {
    ctx.strokeStyle = "#22c55e";
    ctx.lineWidth = 6;
    ctx.strokeRect(3, 3, W - 6, H - 6);
  }

  // ── Detected cone markers ─────────────────────────────────────────────────────
  for (const cone of cones) {
    if (cone.w && cone.h && cone.w > 0 && cone.h > 0) {
      // YOLO detection — draw bounding rectangle
      const rx = cone.x - cone.w / 2, ry = cone.y - cone.h / 2;
      ctx.strokeStyle = cone.color;
      ctx.lineWidth = 2.5;
      ctx.setLineDash([]);
      ctx.strokeRect(rx, ry, cone.w, cone.h);
      // Corner accents
      const cs = Math.min(cone.w, cone.h) * 0.25;
      ctx.lineWidth = 3.5;
      for (const [ox, oy, dx, dy] of [
        [rx, ry, 1, 1], [rx + cone.w, ry, -1, 1],
        [rx, ry + cone.h, 1, -1], [rx + cone.w, ry + cone.h, -1, -1],
      ] as [number,number,number,number][]) {
        ctx.beginPath();
        ctx.moveTo(ox + dx * cs, oy);
        ctx.lineTo(ox, oy);
        ctx.lineTo(ox, oy + dy * cs);
        ctx.stroke();
      }
      // Center dot
      ctx.beginPath();
      ctx.arc(cone.x, cone.y, 3, 0, Math.PI * 2);
      ctx.fillStyle = cone.color;
      ctx.fill();
      // Label badge
      ctx.font = "bold 9px Inter,sans-serif";
      const confStr = cone.conf != null ? ` ${Math.round(cone.conf * 100)}%` : "";
      const lbl = `Cono${confStr}`;
      const lw = ctx.measureText(lbl).width + 10;
      ctx.fillStyle = cone.color;
      ctx.globalAlpha = 0.85;
      roundRect(ctx, rx, ry - 17, lw, 17, 3);
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.fillStyle = "#000";
      ctx.textAlign = "left";
      ctx.fillText(lbl, rx + 5, ry - 4);
    } else {
      // HSV detection — circle marker with label
      const r = Math.max(18, W * 0.022);
      ctx.beginPath();
      ctx.arc(cone.x, cone.y, r, 0, Math.PI * 2);
      ctx.strokeStyle = cone.color;
      ctx.lineWidth = 3;
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(cone.x, cone.y, 4, 0, Math.PI * 2);
      ctx.fillStyle = cone.color;
      ctx.fill();
      ctx.font = "bold 9px Inter,sans-serif";
      ctx.fillStyle = cone.color;
      ctx.textAlign = "center";
      ctx.fillText("Cono", cone.x, cone.y - r - 4);
    }
  }

  // ── Foot → cone proximity line ────────────────────────────────────────────────
  const CONFIRM_FRAMES_VIZ = 4;
  const PROX_VIZ = 0.16, PROX_Y_VIZ = 0.25;
  if (footX !== null && footY !== null) {
    const fx = footX * W, fy = footY * H;
    let closestTr: typeof coneTracks[0] | null = null;
    let closestD = Infinity;
    for (const tr of coneTracks) {
      if (tr.fired || tr.seenCount < CONFIRM_FRAMES_VIZ) continue;
      const dx = Math.abs(footX - tr.x), dy = Math.abs(footY - tr.y);
      if (dx < PROX_VIZ && dy < PROX_Y_VIZ) {
        const d = Math.hypot(dx, dy);
        if (d < closestD) { closestD = d; closestTr = tr; }
      }
    }
    if (closestTr) {
      const cx = closestTr.x * W, cy = closestTr.y * H;
      const alpha = isCrossing ? 1.0 : 0.65;
      ctx.strokeStyle = isCrossing ? `rgba(34,197,94,${alpha})` : `rgba(250,204,21,${alpha})`;
      ctx.lineWidth = isCrossing ? 3 : 1.5;
      ctx.setLineDash(isCrossing ? [] : [6, 4]);
      ctx.beginPath();
      ctx.moveTo(fx, fy);
      ctx.lineTo(cx, cy);
      ctx.stroke();
      ctx.setLineDash([]);
      // Pulse ring on the cone
      ctx.beginPath();
      ctx.arc(cx, cy, Math.max(26, W * 0.032), 0, Math.PI * 2);
      ctx.strokeStyle = isCrossing ? "rgba(34,197,94,0.9)" : "rgba(250,204,21,0.7)";
      ctx.lineWidth = isCrossing ? 4 : 2;
      ctx.stroke();
    }
  }

  _drawSkeleton(ctx, pose, W, H, footX, isCrossing, angles);

  ctx.fillStyle = "rgba(0,0,0,0.60)";
  roundRect(ctx, 10, 10, 160, 48, 8);
  ctx.fill();
  ctx.fillStyle = "#22c55e";
  ctx.font = "bold 11px Inter,sans-serif";
  ctx.textAlign = "left";
  ctx.shadowColor = "transparent";
  ctx.fillText("● IA TRACKING", 20, 28);
  ctx.fillStyle = "#ffffffaa";
  ctx.font = "11px Inter,sans-serif";
  ctx.fillText(`t = ${currentTime.toFixed(2)}s`, 20, 44);

  ctx.fillStyle = "rgba(0,0,0,0.60)";
  const badge = `Splits ${splitsRecorded}/4`;
  const bw = ctx.measureText(badge).width + 24;
  roundRect(ctx, W - bw - 10, 10, bw, 32, 8);
  ctx.fill();
  ctx.fillStyle = splitsRecorded > 0 ? "#22c55e" : "#ffffffaa";
  ctx.font = "bold 11px Inter,sans-serif";
  ctx.textAlign = "right";
  ctx.fillText(badge, W - 22, 31);

  if (isCrossing) {
    ctx.fillStyle = "rgba(34,197,94,0.85)";
    roundRect(ctx, W / 2 - 80, H - 52, 160, 36, 10);
    ctx.fill();
    ctx.fillStyle = "#fff";
    ctx.font = "bold 14px Inter,sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(`✓ Split ${splitsRecorded} registrado`, W / 2, H - 28);
  }
}

// ─── Live overlay drawing (transparent on top of native video) ────────────────
function drawOverlay(
  ctx: CanvasRenderingContext2D,
  pose: PoseResult | null,
  cones: FrameCone[],
  W: number,
  H: number,
  kneeY: number | null = null,
  playerBox: PlayerBox | null = null,
) {
  ctx.clearRect(0, 0, W, H);

  // Player bounding box
  if (playerBox) {
    const pad = W * 0.01;
    const bx = playerBox.x0 - pad, by = playerBox.y0 - pad;
    const bw = (playerBox.x1 - playerBox.x0) + pad * 2;
    const bh = (playerBox.y1 - playerBox.y0) + pad * 2;
    ctx.strokeStyle = "rgba(6,182,212,0.90)";
    ctx.lineWidth = 2;
    ctx.setLineDash([]);
    ctx.strokeRect(bx, by, bw, bh);
    const cs = Math.min(bw, bh) * 0.15;
    ctx.strokeStyle = "#06b6d4";
    ctx.lineWidth = 3;
    for (const [ox, oy, dx, dy] of [
      [bx, by, 1, 1], [bx + bw, by, -1, 1],
      [bx, by + bh, 1, -1], [bx + bw, by + bh, -1, -1],
    ] as [number,number,number,number][]) {
      ctx.beginPath();
      ctx.moveTo(ox + dx * cs, oy);
      ctx.lineTo(ox, oy);
      ctx.lineTo(ox, oy + dy * cs);
      ctx.stroke();
    }
    ctx.font = "bold 10px Inter,sans-serif";
    const lbl = "Jugador";
    const lw = ctx.measureText(lbl).width + 12;
    ctx.fillStyle = "rgba(6,182,212,0.90)";
    roundRect(ctx, bx, by - 18, lw, 18, 4);
    ctx.fill();
    ctx.fillStyle = "#fff";
    ctx.textAlign = "left";
    ctx.fillText(lbl, bx + 6, by - 4);
  }

  // Search zone rectangle
  const zoneY = kneeY != null ? Math.floor(kneeY) : Math.floor(H * 0.55);
  ctx.fillStyle = "rgba(250,204,21,0.08)";
  ctx.fillRect(2, zoneY, W - 4, H - zoneY - 2);
  ctx.strokeStyle = "rgba(250,204,21,0.85)";
  ctx.lineWidth = 2;
  ctx.setLineDash([]);
  ctx.strokeRect(2, zoneY, W - 4, H - zoneY - 2);
  const lbl = kneeY != null ? "🔍 zona conos (bajo rodilla)" : "🔍 zona conos (fallback)";
  const lw = ctx.measureText(lbl).width + 16;
  ctx.fillStyle = "rgba(250,204,21,0.88)";
  roundRect(ctx, 2, zoneY, lw, 20, 0);
  ctx.fill();
  ctx.fillStyle = "#000";
  ctx.font = "bold 10px Inter,sans-serif";
  ctx.textAlign = "left";
  ctx.fillText(lbl, 8, zoneY + 14);

  // Cone markers
  for (const cone of cones) {
    if (cone.w && cone.h && cone.w > 0 && cone.h > 0) {
      const rx = cone.x - cone.w / 2, ry = cone.y - cone.h / 2;
      ctx.strokeStyle = cone.color;
      ctx.lineWidth = 2;
      ctx.setLineDash([]);
      ctx.strokeRect(rx, ry, cone.w, cone.h);
      const cs = Math.min(cone.w, cone.h) * 0.25;
      ctx.lineWidth = 3;
      for (const [ox, oy, dx, dy] of [
        [rx, ry, 1, 1], [rx + cone.w, ry, -1, 1],
        [rx, ry + cone.h, 1, -1], [rx + cone.w, ry + cone.h, -1, -1],
      ] as [number,number,number,number][]) {
        ctx.beginPath();
        ctx.moveTo(ox + dx * cs, oy);
        ctx.lineTo(ox, oy);
        ctx.lineTo(ox, oy + dy * cs);
        ctx.stroke();
      }
      ctx.beginPath();
      ctx.arc(cone.x, cone.y, 3, 0, Math.PI * 2);
      ctx.fillStyle = cone.color;
      ctx.fill();
      ctx.font = "bold 9px Inter,sans-serif";
      ctx.fillStyle = cone.color;
      ctx.textAlign = "center";
      ctx.fillText("Cono", cone.x, ry - 4);
    } else {
      const r = Math.max(18, W * 0.022);
      ctx.beginPath();
      ctx.arc(cone.x, cone.y, r, 0, Math.PI * 2);
      ctx.strokeStyle = cone.color;
      ctx.lineWidth = 3;
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(cone.x, cone.y, 4, 0, Math.PI * 2);
      ctx.fillStyle = cone.color;
      ctx.fill();
      ctx.font = "bold 9px Inter,sans-serif";
      ctx.fillStyle = cone.color;
      ctx.textAlign = "center";
      ctx.fillText("Cono", cone.x, cone.y - Math.max(18, W * 0.022) - 4);
    }
  }

  _drawSkeleton(ctx, pose, W, H, null, false);

  ctx.fillStyle = "rgba(0,0,0,0.55)";
  roundRect(ctx, 10, 10, 80, 26, 6);
  ctx.fill();
  ctx.fillStyle = "#22c55e";
  ctx.font = "bold 10px Inter,sans-serif";
  ctx.textAlign = "left";
  ctx.fillText("● EN VIVO", 18, 27);
}

// ─── Shared drawing helpers ───────────────────────────────────────────────────
function _angleBadge(
  ctx: CanvasRenderingContext2D,
  x: number, y: number,
  label: string,
  value: number,
) {
  const text = `${label} ${Math.round(value)}°`;
  ctx.font = "bold 10px Inter,sans-serif";
  const tw = ctx.measureText(text).width + 10;
  ctx.fillStyle = "rgba(0,0,0,0.72)";
  roundRect(ctx, x - tw / 2, y - 9, tw, 17, 4);
  ctx.fill();
  ctx.fillStyle = "#fde68a";
  ctx.textAlign = "center";
  ctx.fillText(text, x, y + 5);
}

function _drawSkeleton(
  ctx: CanvasRenderingContext2D,
  pose: PoseResult | null,
  W: number,
  H: number,
  footX: number | null,
  isCrossing: boolean,
  angles?: { hip: number | null; knee: number | null; ankle: number | null },
) {
  if (!pose || pose.landmarks.length === 0) return;
  const lms = pose.landmarks[0];

  // Bones
  ctx.lineWidth = 2.5;
  for (const [a, b] of SKELETON) {
    const la = lms[a], lb = lms[b];
    if (!la || !lb) continue;
    const vis = Math.min(la.visibility ?? 0, lb.visibility ?? 0);
    if (vis < 0.05) continue;
    ctx.beginPath();
    ctx.strokeStyle = `rgba(255,255,255,${0.35 + vis * 0.55})`;
    ctx.moveTo(la.x * W, la.y * H);
    ctx.lineTo(lb.x * W, lb.y * H);
    ctx.stroke();
  }

  // Keypoints
  for (let i = 0; i < lms.length; i++) {
    const lm = lms[i];
    if ((lm.visibility ?? 0) < 0.05) continue;
    const r = i >= 25 ? 7 : 5;
    ctx.beginPath();
    ctx.arc(lm.x * W, lm.y * H, r, 0, Math.PI * 2);
    ctx.fillStyle = keypointColor(i);
    ctx.fill();
    ctx.strokeStyle = "rgba(0,0,0,0.5)";
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  // Foot tracking rings (ankles + foot indices)
  for (const idx of [27, 28, 31, 32]) {
    const lm = lms[idx];
    if (!lm || (lm.visibility ?? 0) < 0.05) continue;
    ctx.beginPath();
    ctx.arc(lm.x * W, lm.y * H, 13, 0, Math.PI * 2);
    ctx.strokeStyle = isCrossing ? "#22c55e" : "#00ffcc";
    ctx.lineWidth = 2.5;
    ctx.stroke();
  }

  // Foot proximity zone
  if (footX !== null) {
    const cx = footX * W;
    const ZONE = W * 0.10;
    ctx.fillStyle = "rgba(0,255,204,0.07)";
    ctx.fillRect(cx - ZONE, 0, ZONE * 2, H);
    ctx.strokeStyle = "rgba(0,255,204,0.20)";
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(cx, 0); ctx.lineTo(cx, H);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // Joint angle badges
  if (angles) {
    // Hip: midpoint of lm[23] and lm[24]
    if (angles.hip != null) {
      const lh = [lms[23], lms[24]].filter(l => l && (l.visibility ?? 0) > 0.10);
      if (lh.length > 0) {
        const mx = (lh.reduce((s, l) => s + l.x, 0) / lh.length) * W;
        const my = (lh.reduce((s, l) => s + l.y, 0) / lh.length) * H - 16;
        _angleBadge(ctx, mx, my, "Cadera", angles.hip);
      }
    }
    // Knee: midpoint of lm[25] and lm[26]
    if (angles.knee != null) {
      const lk = [lms[25], lms[26]].filter(l => l && (l.visibility ?? 0) > 0.10);
      if (lk.length > 0) {
        const mx = (lk.reduce((s, l) => s + l.x, 0) / lk.length) * W;
        const my = (lk.reduce((s, l) => s + l.y, 0) / lk.length) * H;
        _angleBadge(ctx, mx + 28, my, "Rodilla", angles.knee);
      }
    }
    // Ankle: midpoint of lm[27] and lm[28]
    if (angles.ankle != null) {
      const la = [lms[27], lms[28]].filter(l => l && (l.visibility ?? 0) > 0.10);
      if (la.length > 0) {
        const mx = (la.reduce((s, l) => s + l.x, 0) / la.length) * W;
        const my = (la.reduce((s, l) => s + l.y, 0) / la.length) * H + 16;
        _angleBadge(ctx, mx + 28, my, "Tobillo", angles.ankle);
      }
    }
  }
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

// ─── Component ────────────────────────────────────────────────────────────────
export function VideoAnalyzer({ onResult }: VideoAnalyzerProps) {
  const [phase, setPhase]           = useState<Phase>("server_check");
  const [statusMsg, setStatusMsg]   = useState("Conectando con servidor...");
  const [progress, setProgress]     = useState(0);
  const [serverEngine, setServerEngine] = useState("");
  const [availableEngines, setAvailableEngines] = useState<string[]>([]);
  const [selectedEngine, setSelectedEngine] = useState("");
  const [yoloCones, setYoloCones] = useState(false);
  const yoloConesRef = useRef(false);
  const [result, setResult]         = useState<SprintData | null>(null);
  const [error, setError]           = useState<string | null>(null);
  const [videoFile, setVideoFile]   = useState<File | null>(null);
  const [videoUrl, setVideoUrl]     = useState<string | null>(null);
  const [liveInfo, setLiveInfo]     = useState({ cones: 0, player: false, splits: 0 });
  const [liveSplits, setLiveSplits] = useState<number[]>([]);
  const [selectedCone, setSelectedCone] = useState<string>(
    () => localStorage.getItem(CONE_STORAGE_KEY) ?? "rosa"
  );
  const [useLLMCones, setUseLLMCones] = useState(
    () => localStorage.getItem(LLM_CONE_KEY) === "1"
  );
  const [llmCalibStatus, setLlmCalibStatus] = useState<"idle"|"calibrating"|"ready"|"error">("idle");
  const [llmConeCount, setLlmConeCount]     = useState(0);

  const canvasRef         = useRef<HTMLCanvasElement>(null);
  const videoRef          = useRef<HTMLVideoElement>(null);
  const hiddenRef         = useRef<HTMLVideoElement>(null);
  const hiddenCvRef       = useRef<HTMLCanvasElement>(null);
  const liveCvRef         = useRef<HTMLCanvasElement>(null);
  const liveRafRef        = useRef(0);
  const liveLastMs        = useRef(0);
  const liveDetecting     = useRef(false);   // prevent concurrent live requests
  const shouldAutoAnalyze = useRef(false);
  const selectedEngineRef = useRef("");      // stable ref for callbacks
  const selectedConeRef   = useRef<ConeConfig>(
    CONE_CONFIGS.find(c => c.id === (localStorage.getItem(CONE_STORAGE_KEY) ?? "rosa")) ?? CONE_CONFIGS[0]
  );
  const liveFootYRef       = useRef<number | null>(null);
  const liveKneeYRef       = useRef<number | null>(null);
  const livePlayerBoxRef   = useRef<PlayerBox | null>(null);
  const useLLMConesRef    = useRef(localStorage.getItem(LLM_CONE_KEY) === "1");

  // ── Tunable analysis parameters (live refs so analyze() reads latest) ─────────
  const [paramProx,      setParamProx]      = useState(0.16);
  const [paramMinAge,    setParamMinAge]     = useState(1.0);   // seconds
  const [paramAspect,    setParamAspect]     = useState(2.8);
  const [paramPoseConf,  setParamPoseConf]   = useState(0.10);
  const [paramMinH,      setParamMinH]       = useState(0.008); // % of H
  const [paramConic,     setParamConic]      = useState(1.2);   // bottom/top ratio
  const [showParams,     setShowParams]      = useState(false);
  const proxRef      = useRef(0.16);
  const minAgeRef    = useRef(1.0);
  const aspectRef    = useRef(2.8);
  const poseConfRef  = useRef(0.10);
  const minHRef      = useRef(0.008);
  const conicRef     = useRef(1.2);

  // ── Server health check ────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setPhase("server_check");
      setStatusMsg("Conectando con servidor...");
      const { ok, engine, available, yoloCones: yc } = await checkServer();
      if (cancelled) return;
      if (ok) {
        setServerEngine(engine);
        setAvailableEngines(available);
        setSelectedEngine(engine);
        selectedEngineRef.current = engine;
        setYoloCones(yc);
        yoloConesRef.current = yc;
        setPhase("ready");
        setStatusMsg(`Servidor listo · ${engine}${yc ? " · YOLO conos ✓" : ""}`);
      } else {
        setPhase("error");
        setError("No se puede conectar con el servidor.");
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // ── File handling ──────────────────────────────────────────────────────────
  const handleFile = useCallback((file: File) => {
    if (!file.type.startsWith("video/")) return;
    if (videoUrl) URL.revokeObjectURL(videoUrl);
    setVideoUrl(URL.createObjectURL(file));
    setVideoFile(file);
    setResult(null); setError(null);
    setProgress(0); setLiveInfo({ cones: 0, player: false, splits: 0 });
    shouldAutoAnalyze.current = false; // user must press Analizar explicitly
    if (phase === "complete" || phase === "error") setPhase("ready");
  }, [videoUrl, phase]);

  const clearVideo = useCallback(() => {
    if (videoUrl) URL.revokeObjectURL(videoUrl);
    setVideoUrl(null); setVideoFile(null); setResult(null);
    setError(null); setProgress(0); setLiveInfo({ cones: 0, player: false, splits: 0 });
    if (phase === "complete" || phase === "analyzing") setPhase("ready");
  }, [videoUrl, phase]);

  const handleLLMToggle = useCallback(() => {
    const next = !useLLMConesRef.current;
    useLLMConesRef.current = next;
    setUseLLMCones(next);
    localStorage.setItem(LLM_CONE_KEY, next ? "1" : "0");
    setLlmCalibStatus("idle");
    setLlmConeCount(0);
  }, []);

  const handleConeSelect = useCallback((id: string) => {
    const cfg = CONE_CONFIGS.find(c => c.id === id) ?? CONE_CONFIGS[0];
    setSelectedCone(id);
    selectedConeRef.current = cfg;
    localStorage.setItem(CONE_STORAGE_KEY, id);
  }, []);

  // ── Live detection loop ────────────────────────────────────────────────────
  const stopLiveLoop = useCallback(() => {
    cancelAnimationFrame(liveRafRef.current);
    liveRafRef.current = 0;
  }, []);

  const startLiveLoop = useCallback(() => {
    cancelAnimationFrame(liveRafRef.current);

    const loop = () => {
      const video  = videoRef.current;
      const liveCv = liveCvRef.current;
      const outCv  = canvasRef.current;

      if (!video || !liveCv || !outCv) {
        liveRafRef.current = requestAnimationFrame(loop);
        return;
      }

      const now = performance.now();
      // ~3 detections/sec — accounts for server round-trip latency
      if (now - liveLastMs.current > 300 && !liveDetecting.current) {
        liveLastMs.current = now;
        const W = video.videoWidth, H = video.videoHeight;

        if (W && H) {
          if (liveCv.width !== W || liveCv.height !== H) { liveCv.width = W; liveCv.height = H; }
          if (outCv.width  !== W || outCv.height  !== H) { outCv.width  = W; outCv.height  = H; }

          const cvCtx = liveCv.getContext("2d")!;
          cvCtx.drawImage(video, 0, 0, W, H);

          // Snapshot the frame so the canvas doesn't change during the async fetch
          const snap = document.createElement("canvas");
          snap.width = W; snap.height = H;
          snap.getContext("2d")!.drawImage(liveCv, 0, 0);

          const imageData = cvCtx.getImageData(0, 0, W, H);
          // Use previous frame's pose data to exclude player body from cone search
          const cones = detectConesInFrame(
            imageData.data, W, H, selectedConeRef.current,
            liveKneeYRef.current, aspectRef.current, minHRef.current, conicRef.current,
            livePlayerBoxRef.current,
          );

          liveDetecting.current = true;
          fetchPose(snap, selectedEngineRef.current || undefined).then(pose => {
            if (pose?.landmarks?.length) {
              const lm = pose.landmarks[0];
              const feet = [lm[27], lm[28], lm[31], lm[32]].filter(k => k && (k.visibility ?? 0) > 0.05);
              if (feet.length > 0)
                liveFootYRef.current = (feet.reduce((s, k) => s + k.y, 0) / feet.length) * H;
              const knees = [lm[25], lm[26]].filter(k => k && (k.visibility ?? 0) > 0.05);
              if (knees.length > 0)
                liveKneeYRef.current = (knees.reduce((s, k) => s + k.y, 0) / knees.length) * H;
              livePlayerBoxRef.current = playerBoxFromPose(lm, W, H);
            } else {
              livePlayerBoxRef.current = null;
            }
            const outCtxNow = canvasRef.current?.getContext("2d");
            if (outCtxNow) drawOverlay(outCtxNow, pose, cones, W, H, liveKneeYRef.current, livePlayerBoxRef.current);
            liveDetecting.current = false;
          }).catch(() => {
            liveDetecting.current = false;
          });
        }
      }

      liveRafRef.current = requestAnimationFrame(loop);
    };

    liveRafRef.current = requestAnimationFrame(loop);
  }, []);

  // Start/stop live loop
  useEffect(() => {
    const active = !!videoUrl &&
      (phase === "ready" || phase === "complete") &&
      !!serverEngine;
    if (active) startLiveLoop();
    else stopLiveLoop();
    return () => stopLiveLoop();
  }, [videoUrl, phase, serverEngine, startLiveLoop, stopLiveLoop]);

  // ── Main analysis ──────────────────────────────────────────────────────────
  const analyze = useCallback(async () => {
    const hidden   = hiddenRef.current;
    const hiddenCv = hiddenCvRef.current;
    const outCv    = canvasRef.current;
    if (!hidden || !hiddenCv || !outCv || !videoUrl) return;

    cancelAnimationFrame(liveRafRef.current);
    liveRafRef.current = 0;

    setPhase("analyzing");
    setProgress(0);
    setError(null);
    setResult(null);
    setLiveSplits([]);

    const DEBOUNCE = 0.50;
    const PROX     = proxRef.current;
    const ASPECT   = aspectRef.current;
    const MIN_H_PCT = minHRef.current;
    const POSE_CONF = poseConfRef.current;

    try {
      hidden.src = videoUrl;
      await new Promise<void>((res, rej) => {
        hidden.onloadedmetadata = () => res();
        hidden.onerror = () => rej(new Error("No se pudo cargar el video."));
      });

      // Many codecs (VBR MP4/H.264) report a preliminary duration at loadedmetadata.
      // Seeking to a very large time forces the browser to buffer and resolve the real duration.
      await new Promise<void>(res => {
        const fn = () => { hidden.removeEventListener("seeked", fn); res(); };
        hidden.addEventListener("seeked", fn);
        hidden.currentTime = 1e101;
      });
      const trueDuration = isFinite(hidden.duration) ? hidden.duration : 0;
      hidden.currentTime = 0;

      const W = hidden.videoWidth, H = hidden.videoHeight;
      hiddenCv.width = W; hiddenCv.height = H;
      outCv.width    = W; outCv.height    = H;
      const hiddenCtx = hiddenCv.getContext("2d")!;
      const outCtx    = outCv.getContext("2d")!;

      const sampleFps   = 10;
      const totalFrames = Math.floor(trueDuration * sampleFps);

      const crossings: number[] = [];
      let lastCrossingTime  = -999;
      let startTime: number | null = null;
      let showCrossing      = false;
      let showCrossingUntil = -1;
      let motionFrames      = 0; // consecutive frames where ankles differ in height (= running)
      let poseFrames        = 0; // consecutive frames with valid pose (fallback start counter)
      let prevFootX: number | null = null; // foot X from previous frame for directional crossing

      // A track must be seen in this many consecutive frames before it can trigger a split.
      // This eliminates false positives that appear briefly at the start of the scan.
      const CONFIRM_FRAMES = 4;
      type ConeTrack = { x: number; y: number; lastSeen: number; firstSeen: number; seenCount: number; fired: boolean };
      const coneTracks: ConeTrack[] = [];

      let angleSum    = { hip: 0, knee: 0, ankle: 0 };
      let angleSamples = 0;

      // ── LLM cone tracking (populated dynamically as cones appear in frame) ──
      const llmCones: { x: number; fired: boolean }[] = [];
      let startLLMConeMarked = false;
      const LLM_SAMPLE_EVERY = 10; // call Claude every 10 analysis frames
      if (useLLMConesRef.current) setLlmCalibStatus("calibrating");

      setStatusMsg("Analizando con IA...");

      for (let f = 0; f < totalFrames; f++) {
        const t = f / sampleFps;
        await seekTo(hidden, t);
        hiddenCtx.drawImage(hidden, 0, 0, W, H);

        const imageData = hiddenCtx.getImageData(0, 0, W, H);

        // Get pose first so foot Y can center the cone search band
        const poseResult = await fetchPose(hiddenCv, selectedEngineRef.current || undefined);

        let footX: number | null = null;
        let footY: number | null = null;
        let kneeY:  number | null = null;
        let playerBox: PlayerBox | null = null;
        let playerDetected = poseResult != null && poseResult.landmarks.length > 0;

        if (playerDetected) {
          const kps = poseResult!.landmarks[0];
          const feet = [kps[27], kps[28], kps[31], kps[32]]
            .filter(k => k && (k.visibility ?? 0) > POSE_CONF);
          if (feet.length > 0) {
            footX = feet.reduce((s, k) => s + k.x, 0) / feet.length;
            footY = feet.reduce((s, k) => s + k.y, 0) / feet.length;
          }
          const knees = [kps[25], kps[26]].filter(k => k && (k.visibility ?? 0) > POSE_CONF);
          if (knees.length > 0)
            kneeY = (knees.reduce((s, k) => s + k.y, 0) / knees.length) * H;
          playerBox = playerBoxFromPose(kps, W, H, POSE_CONF);
        }

        // ── LLM cone detection (periodic) ────────────────────────────────────
        if (useLLMConesRef.current && f % LLM_SAMPLE_EVERY === 0 && crossings.length < 5) {
          const b64 = hiddenCv.toDataURL("image/jpeg", 0.75).split(",")[1];
          try {
            const res = await fetch(`${POSE_SERVER}/calibrate-cones`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ frames: [b64] }),
              signal: AbortSignal.timeout(15000),
            });
            if (res.ok) {
              const data = await res.json();
              for (const nx of (data.cones ?? []) as number[]) {
                if (!llmCones.some(c => Math.abs(c.x - nx) < 0.05)) {
                  llmCones.push({ x: nx, fired: false });
                  llmCones.sort((a, b) => b.x - a.x); // right-to-left
                }
              }
              if (llmCones.length > 0) {
                setLlmConeCount(llmCones.length);
                setLlmCalibStatus("ready");
              }
            }
          } catch { /* keep going with current positions */ }
        }

        // Cone detection priority: YOLO (server) > LLM (periodic) > HSV (browser)
        let cones: FrameCone[];
        if (yoloConesRef.current) {
          const yoloDets = await fetchConesYOLO(hiddenCv);
          cones = yoloDets.map(c => ({ x: c.x * W, y: c.y * H, w: (c.w ?? 0) * W, h: (c.h ?? 0) * H, conf: c.conf, color: selectedConeRef.current.color }));
        } else if (llmCones.length > 0) {
          cones = llmCones.map(c => ({
            x: c.x * W, y: H * 0.82,
            color: c.fired ? "#22c55e" : selectedConeRef.current.color,
          }));
        } else {
          cones = detectConesInFrame(imageData.data, W, H, selectedConeRef.current, kneeY, ASPECT, MIN_H_PCT, conicRef.current, playerBox);
        }

        // Color fallback: only marks player as detected (no footX, no startTime)
        if (!playerDetected) {
          const colorPos = detectPlayerColorInFrame(imageData.data, W, H);
          if (colorPos) playerDetected = true;
        }

        // Motion-based start: one ankle raised significantly above the other = player is running.
        // Y goes 0 (top) → 1 (bottom), so a lifted foot has smaller Y than the grounded foot.
        // Camera-agnostic: works for both fixed and tracking cameras.
        if (startTime === null && poseResult?.landmarks?.length) {
          const lm = poseResult.landmarks[0];
          poseFrames++;
          const la = lm[27], ra = lm[28]; // left ankle, right ankle
          const visOk = la && ra && (la.visibility ?? 0) > 0.10 && (ra.visibility ?? 0) > 0.10;
          if (visOk && Math.abs(la.y - ra.y) > 0.06) {
            motionFrames++;
            if (motionFrames >= 2) startTime = t - (2 / sampleFps);
          } else {
            motionFrames = 0;
            // Fallback: if player has been detected for 2 s without motion trigger, start anyway.
            // This covers cases where the player is already running from frame 1.
            if (poseFrames >= sampleFps * 2) startTime = t;
          }
        }

        // Compute per-frame joint angles (for live overlay) and accumulate for final average
        let frameAngles: { hip: number | null; knee: number | null; ankle: number | null } = { hip: null, knee: null, ankle: null };
        if (poseResult?.landmarks?.length) {
          const lm = poseResult.landmarks[0];
          const v = (i: number) => (lm[i]?.visibility ?? 0) > 0.10;
          let ha = 0, hc = 0, ka = 0, kc = 0, aa = 0, ac = 0;
          if (v(11)&&v(23)&&v(25)) { ha += angleDeg(lm[11].x,lm[11].y,lm[23].x,lm[23].y,lm[25].x,lm[25].y); hc++; }
          if (v(12)&&v(24)&&v(26)) { ha += angleDeg(lm[12].x,lm[12].y,lm[24].x,lm[24].y,lm[26].x,lm[26].y); hc++; }
          if (v(23)&&v(25)&&v(27)) { ka += angleDeg(lm[23].x,lm[23].y,lm[25].x,lm[25].y,lm[27].x,lm[27].y); kc++; }
          if (v(24)&&v(26)&&v(28)) { ka += angleDeg(lm[24].x,lm[24].y,lm[26].x,lm[26].y,lm[28].x,lm[28].y); kc++; }
          if (v(25)&&v(27)&&v(31)) { aa += angleDeg(lm[25].x,lm[25].y,lm[27].x,lm[27].y,lm[31].x,lm[31].y); ac++; }
          if (v(26)&&v(28)&&v(32)) { aa += angleDeg(lm[26].x,lm[26].y,lm[28].x,lm[28].y,lm[32].x,lm[32].y); ac++; }
          if (hc) { frameAngles.hip   = ha / hc; angleSum.hip   += ha / hc; }
          if (kc) { frameAngles.knee  = ka / kc; angleSum.knee  += ka / kc; }
          if (ac) { frameAngles.ankle = aa / ac; angleSum.ankle += aa / ac; }
          if (hc || kc || ac) angleSamples++;
        }

        // Cone tracker — nearest-neighbour match across frames
        const detNorms = cones.map(c => ({ x: c.x / W, y: c.y / H }));
        const matched  = new Set<number>();
        for (const tr of coneTracks) {
          let bestD = 0.18, bestI = -1;
          for (let i = 0; i < detNorms.length; i++) {
            if (matched.has(i)) continue;
            const d = Math.abs(detNorms[i].x - tr.x);
            if (d < bestD) { bestD = d; bestI = i; }
          }
          if (bestI >= 0) { tr.x = detNorms[bestI].x; tr.y = detNorms[bestI].y; tr.lastSeen = f; tr.seenCount++; matched.add(bestI); }
        }
        for (let i = 0; i < detNorms.length; i++) {
          if (!matched.has(i)) coneTracks.push({ x: detNorms[i].x, y: detNorms[i].y, lastSeen: f, firstSeen: f, seenCount: 1, fired: false });
        }
        // Age out stale tracks (cone not seen for >8 s) — avoids phantom positions.
        // Use a long window: the last cone is often occluded by the player's body as they cross it.
        for (const tr of coneTracks) {
          if (!matched.has(coneTracks.indexOf(tr)) && f - tr.lastSeen > sampleFps * 8) tr.fired = true;
        }

        showCrossing = t < showCrossingUntil;

        if (llmCones.length > 0) {
          // ── LLM cone crossing ─────────────────────────────────────────────
          // Mark cone 0 (rightmost = start) as fired when timer begins
          if (!startLLMConeMarked && startTime !== null) {
            llmCones[0].fired = true;
            startLLMConeMarked = true;
          }
          if (footX !== null && startTime !== null && crossings.length < 5) {
            // Sequential: only check the next unfired cone (R→L order)
            const nextCone = llmCones.find(c => !c.fired);
            if (nextCone && footX <= nextCone.x + PROX && (t - lastCrossingTime) > DEBOUNCE) {
              crossings.push(parseFloat((t - startTime).toFixed(2)));
              lastCrossingTime  = t;
              showCrossingUntil = t + 0.5;
              showCrossing      = true;
              nextCone.fired    = true;
            }
          }
        } else {
          // ── HSV / YOLO track-based crossing ───────────────────────────────
          // Directional sweep: fire when foot X sweeps through a cone's X.
          // First crossing is only valid after 1 s of running — this skips any
          // cone at the start position without needing to identify which one it is.
          if (footX !== null && startTime !== null && crossings.length < 5
              && (t - startTime) >= 1.0) {
            const lo = prevFootX !== null ? Math.min(prevFootX, footX) - 0.04
                                          : footX - PROX;
            const hi = prevFootX !== null ? Math.max(prevFootX, footX) + 0.04
                                          : footX + PROX;
            for (const tr of coneTracks) {
              if (tr.fired || tr.seenCount < CONFIRM_FRAMES) continue;
              if (tr.x >= lo && tr.x <= hi && (t - lastCrossingTime) > DEBOUNCE) {
                crossings.push(parseFloat((t - startTime).toFixed(2)));
                lastCrossingTime  = t;
                showCrossingUntil = t + 0.5;
                showCrossing      = true;
                tr.fired          = true;
                break;
              }
            }
          }
          prevFootX = footX ?? prevFootX;
        }

        drawDetection(
          outCtx, hiddenCv, poseResult, cones,
          W, H, t - (startTime ?? t),
          crossings.length, footX, footY, showCrossing,
          kneeY, coneTracks, sampleFps, f, playerBox, frameAngles,
        );

        if (f % 3 === 0) {
          setLiveInfo({ cones: cones.length, player: playerDetected, splits: crossings.length });
          setLiveSplits([...crossings]);
          setProgress(Math.floor((f / totalFrames) * 95));
          await new Promise(r => setTimeout(r, 0));
        }
      }

      setProgress(98);
      setStatusMsg("Calculando tiempos finales...");

      if (crossings.length < 4) {
        throw new Error(
          `Solo se detectaron ${crossings.length} cruce(s) de conos. ` +
          `Verifica que el jugador pase cerca de los conos y que sean visibles (morados).`
        );
      }

      const base = crossings.length >= 5 ? crossings.slice(1, 5) : crossings.slice(0, 4);
      const sprintResult: SprintData = {
        t10: base[0], t20: base[1], t30: base[2], t40: base[3],
        reaction:   startTime != null ? parseFloat(startTime.toFixed(2)) : undefined,
        hipAngle:   angleSamples > 0 ? Math.round(angleSum.hip   / angleSamples) : undefined,
        kneeAngle:  angleSamples > 0 ? Math.round(angleSum.knee  / angleSamples) : undefined,
        ankleAngle: angleSamples > 0 ? Math.round(angleSum.ankle / angleSamples) : undefined,
      };

      setResult(sprintResult);
      setPhase("complete");
      setProgress(100);
      setStatusMsg("Análisis completado");
      onResult?.(sprintResult);

    } catch (err) {
      setError(err instanceof Error ? err.message : "Error inesperado al analizar el video.");
      setPhase("error");
    }
  }, [videoUrl, onResult]);

  useEffect(() => () => { if (videoUrl) URL.revokeObjectURL(videoUrl); }, [videoUrl]);

  useEffect(() => {
    if (shouldAutoAnalyze.current && videoUrl && phase === "ready") {
      shouldAutoAnalyze.current = false;
      analyze();
    }
  }, [videoUrl, phase, analyze]);

  const isAnalyzing = phase === "analyzing";
  const selectedConeConfig = CONE_CONFIGS.find(c => c.id === selectedCone) ?? CONE_CONFIGS[0];

  return (
    <div className="space-y-5">

      {/* ── Server checking ── */}
      {phase === "server_check" && (
        <div className="rounded-xl border border-border bg-card p-4">
          <div className="flex items-center gap-3 mb-2">
            <Loader2 className="h-4 w-4 text-primary animate-spin" />
            <p className="text-sm font-medium text-foreground">Conectando con servidor de IA...</p>
          </div>
          <p className="text-xs text-muted-foreground">localhost:8000 · OpenPose / MediaPipe Python</p>
        </div>
      )}

      {/* ── Server offline (no video loaded) ── */}
      {phase === "error" && !videoUrl && (
        <div className="rounded-xl border border-destructive/30 bg-destructive/5 p-5 space-y-3">
          <div className="flex items-center gap-2">
            <WifiOff className="h-5 w-5 text-destructive" />
            <p className="text-sm font-semibold text-foreground">Servidor no disponible</p>
          </div>
          <p className="text-xs text-muted-foreground">
            Inicia el servidor Python en la carpeta{" "}
            <code className="bg-surface px-1.5 py-0.5 rounded text-xs font-mono">server/</code>:
          </p>
          <pre className="text-xs bg-surface rounded-lg p-3 text-foreground font-mono overflow-x-auto whitespace-pre">{`cd server
pip install -r requirements.txt
python main.py`}</pre>
          <button
            onClick={async () => {
              setPhase("server_check");
              setError(null);
              const { ok, engine, available, yoloCones: yc } = await checkServer();
              if (ok) {
                setServerEngine(engine);
                setAvailableEngines(available);
                setSelectedEngine(engine);
                selectedEngineRef.current = engine;
                setYoloCones(yc);
                yoloConesRef.current = yc;
                setPhase("ready");
                setStatusMsg(`Servidor listo · ${engine}${yc ? " · YOLO conos ✓" : ""}`);
              } else {
                setPhase("error");
                setError("Servidor aún no disponible.");
              }
            }}
            className="flex items-center gap-2 text-xs font-medium text-primary hover:underline"
          >
            <Server className="h-3.5 w-3.5" /> Reintentar conexión
          </button>
        </div>
      )}

      {/* ── Upload zone (server ready, no video) ── */}
      {phase === "ready" && !videoUrl && (
        <div
          onDragOver={e => e.preventDefault()}
          onDrop={e => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f) handleFile(f); }}
          onClick={() => document.getElementById("va-input")?.click()}
          className="rounded-xl border-2 border-dashed border-border hover:border-primary/50 bg-card p-12 text-center transition-colors cursor-pointer"
        >
          <input id="va-input" type="file" accept="video/*" className="hidden"
            onChange={e => e.target.files?.[0] && handleFile(e.target.files[0])} />
          <Upload className="h-10 w-10 text-muted-foreground mx-auto mb-4" />
          <p className="text-foreground font-medium mb-1">Arrastra el video aquí</p>
          <p className="text-sm text-muted-foreground mb-4">
            La IA detectará al jugador y los conos automáticamente
          </p>
          <div className="flex items-center justify-center gap-2 text-xs text-muted-foreground mb-3">
            <span className="h-2 w-2 rounded-full bg-green-400" />
            <span>
              Servidor activo ·{" "}
              <strong className="text-foreground capitalize">{serverEngine}</strong>
            </span>
          </div>

          {/* Engine selector — shown when >1 engine available */}
          {availableEngines.length > 1 && (
            <div
              className="flex items-center justify-center gap-2 mb-4"
              onClick={e => e.stopPropagation()}
            >
              <span className="text-xs text-muted-foreground">Motor IA:</span>
              {availableEngines.map(eng => (
                <button
                  key={eng}
                  onClick={() => { setSelectedEngine(eng); selectedEngineRef.current = eng; }}
                  className={`px-3 py-1.5 rounded-full text-xs font-medium border capitalize transition-colors ${
                    selectedEngine === eng
                      ? "bg-primary/15 text-primary border-primary/50"
                      : "bg-surface text-muted-foreground border-border hover:border-primary/30"
                  }`}
                >
                  {eng}
                </button>
              ))}
            </div>
          )}
          {/* Cone color selector */}
          <div
            className="flex items-center justify-center gap-3 mb-3"
            onClick={e => e.stopPropagation()}
          >
            <span className="text-xs text-muted-foreground shrink-0">Cono:</span>
            {CONE_CONFIGS.map(cfg => (
              <button
                key={cfg.id}
                title={cfg.label}
                onClick={() => handleConeSelect(cfg.id)}
                className="flex flex-col items-center gap-0.5"
              >
                <span
                  className={`block h-6 w-6 rounded-full border-2 transition-all ${
                    selectedCone === cfg.id
                      ? "border-foreground scale-110 shadow"
                      : "border-border hover:border-foreground/50"
                  }`}
                  style={{ background: cfg.color }}
                />
                <span className={`text-[9px] leading-none ${selectedCone === cfg.id ? "text-foreground font-medium" : "text-muted-foreground"}`}>
                  {cfg.label}
                </span>
              </button>
            ))}
          </div>

          {/* LLM cone detection toggle */}
          <div className="flex items-center justify-center gap-2 mb-4" onClick={e => e.stopPropagation()}>
            <button
              onClick={handleLLMToggle}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium border transition-colors ${
                useLLMCones
                  ? "bg-primary/15 text-primary border-primary/50"
                  : "bg-surface text-muted-foreground border-border hover:border-primary/30"
              }`}
            >
              <span>🤖</span>
              <span>Detección IA (Claude)</span>
              {useLLMCones && <span className="h-1.5 w-1.5 rounded-full bg-primary animate-pulse" />}
            </button>
            {useLLMCones && (
              <span className="text-[10px] text-muted-foreground">Claude calibra los conos al inicio</span>
            )}
          </div>
          <div className="inline-flex flex-col gap-1 text-xs text-muted-foreground bg-surface rounded-lg px-4 py-2.5 text-left">
            <span>• Conos <strong className="text-foreground">{selectedConeConfig.label.toLowerCase()}</strong> en 0m, 10m, 20m, 30m, 40m</span>
            <span>• Funciona con cámara <strong className="text-foreground">fija o móvil</strong></span>
            <span>• Jugador como <strong className="text-foreground">único objeto en movimiento</strong></span>
          </div>
        </div>
      )}

      {/* ── Video + analysis area ── */}
      {videoUrl && (
        <div className="rounded-xl border border-border bg-card p-4 space-y-4">

          <div className="relative rounded-lg overflow-hidden bg-black aspect-video">
            <video
              ref={videoRef}
              src={videoUrl}
              className={`w-full h-full object-contain ${isAnalyzing ? "hidden" : ""}`}
              controls={!isAnalyzing}
            />
            <canvas
              ref={canvasRef}
              className="absolute inset-0 w-full h-full pointer-events-none"
            />
            {isAnalyzing && (
              <div className="absolute top-3 right-3 flex items-center gap-1.5 bg-black/60 backdrop-blur-sm rounded-full px-3 py-1.5 z-10">
                <span className="h-2 w-2 rounded-full bg-primary animate-pulse" />
                <span className="text-xs font-medium text-white">Procesando</span>
              </div>
            )}
          </div>

          {/* Detection status + live splits table during analysis */}
          {isAnalyzing && (
            <div className="flex gap-3 items-start">
              {/* Status cards */}
              <div className="flex flex-col gap-2 text-xs w-28 shrink-0">
                <div className={`rounded-lg border p-2.5 text-center transition-colors ${liveInfo.player ? "border-green-500/40 bg-green-500/10" : "border-border bg-surface/40"}`}>
                  <div className={`font-bold mb-0.5 ${liveInfo.player ? "text-green-400" : "text-muted-foreground"}`}>
                    {liveInfo.player ? "● Detectado" : "○ Buscando"}
                  </div>
                  <div className="text-muted-foreground">Jugador</div>
                </div>
                <div className={`rounded-lg border p-2.5 text-center transition-colors ${
                  llmCalibStatus === "calibrating" ? "border-primary/40 bg-primary/10" :
                  llmCalibStatus === "ready"       ? "border-green-500/40 bg-green-500/10" :
                  liveInfo.cones > 0               ? "border-purple-500/40 bg-purple-500/10"
                                                   : "border-border bg-surface/40"}`}>
                  <div className={`font-bold mb-0.5 text-xs ${
                    llmCalibStatus === "calibrating" ? "text-primary animate-pulse" :
                    llmCalibStatus === "ready"       ? "text-green-400" :
                    liveInfo.cones > 0               ? "text-purple-400"
                                                     : "text-muted-foreground"}`}>
                    {llmCalibStatus === "calibrating" ? "IA..." :
                     llmCalibStatus === "ready"       ? `${llmConeCount} IA` :
                     liveInfo.cones}
                  </div>
                  <div className="text-muted-foreground">Conos</div>
                </div>
                <div className={`rounded-lg border p-2.5 text-center transition-colors ${liveInfo.splits > 0 ? "border-primary/40 bg-primary/10" : "border-border bg-surface/40"}`}>
                  <div className={`font-bold mb-0.5 ${liveInfo.splits > 0 ? "text-primary" : "text-muted-foreground"}`}>
                    {liveInfo.splits}/4
                  </div>
                  <div className="text-muted-foreground">Splits</div>
                </div>
              </div>

              {/* Live splits table */}
              <div className="flex-1 rounded-lg border border-border bg-surface/60 p-3">
                <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider mb-2">Tiempos en vivo</p>
                <table className="w-full">
                  <thead>
                    <tr className="border-b border-border/50">
                      <th className="text-left text-[10px] font-medium text-muted-foreground pb-1.5">Segmento</th>
                      <th className="text-right text-[10px] font-medium text-muted-foreground pb-1.5">Acumulado</th>
                      <th className="text-right text-[10px] font-medium text-muted-foreground pb-1.5">Parcial</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[
                      { label: "0 → 10m",  idx: 0 },
                      { label: "10 → 20m", idx: 1 },
                      { label: "20 → 30m", idx: 2 },
                      { label: "30 → 40m", idx: 3 },
                    ].map(({ label, idx }) => {
                      const t       = liveSplits[idx];
                      const prev    = idx > 0 ? liveSplits[idx - 1] : 0;
                      const partial = t !== undefined && prev !== undefined ? t - prev : undefined;
                      const recorded = t !== undefined;
                      return (
                        <tr key={label} className={`border-b border-border/30 last:border-0 transition-opacity ${recorded ? "opacity-100" : "opacity-35"}`}>
                          <td className="py-1.5 text-xs text-muted-foreground">{label}</td>
                          <td className="py-1.5 text-right text-xs font-display font-bold tabular-nums">
                            {recorded
                              ? <span className="text-primary">{t!.toFixed(2)}s</span>
                              : <span className="text-muted-foreground">—</span>}
                          </td>
                          <td className="py-1.5 text-right text-[10px] tabular-nums text-muted-foreground">
                            {partial !== undefined ? `+${partial.toFixed(2)}s` : "—"}
                          </td>
                        </tr>
                      );
                    })}
                    {liveSplits.length === 4 && (
                      <tr className="border-t border-border/50">
                        <td className="pt-1.5 text-[10px] font-medium text-muted-foreground uppercase">Total</td>
                        <td className="pt-1.5 text-right text-xs font-display font-bold text-foreground tabular-nums">
                          {liveSplits[3].toFixed(2)}s
                        </td>
                        <td />
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Cone color selector + LLM toggle (compact) */}
          {!isAnalyzing && (
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-xs text-muted-foreground shrink-0">Cono:</span>
              {CONE_CONFIGS.map(cfg => (
                <button
                  key={cfg.id}
                  title={cfg.label}
                  onClick={() => handleConeSelect(cfg.id)}
                  className={`h-5 w-5 rounded-full border-2 shrink-0 transition-all ${
                    selectedCone === cfg.id
                      ? "border-foreground scale-110"
                      : "border-border hover:border-foreground/50"
                  }`}
                  style={{ background: cfg.color }}
                />
              ))}
              <div className="h-4 w-px bg-border mx-1" />
              <button
                onClick={handleLLMToggle}
                title="Usar Claude Vision para detectar conos"
                className={`flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium border transition-colors ${
                  useLLMCones
                    ? "bg-primary/15 text-primary border-primary/50"
                    : "bg-surface text-muted-foreground border-border hover:border-primary/30"
                }`}
              >
                <span>🤖</span>
                <span>IA</span>
                {useLLMCones && llmCalibStatus === "ready" && (
                  <span className="text-[9px] text-green-400">{llmConeCount} conos</span>
                )}
              </button>
            </div>
          )}

          {/* File info + engine selector + clear */}
          <div className="flex items-center gap-3">
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-foreground truncate">{videoFile?.name}</p>
              <p className="text-xs text-muted-foreground">
                {videoFile && `${(videoFile.size / 1024 / 1024).toFixed(1)} MB`}
              </p>
            </div>
            {availableEngines.length > 1 && !isAnalyzing && (
              <div className="flex items-center gap-1.5">
                {availableEngines.map(eng => (
                  <button
                    key={eng}
                    onClick={() => { setSelectedEngine(eng); selectedEngineRef.current = eng; }}
                    className={`px-2.5 py-1 rounded-full text-xs font-medium border capitalize transition-colors ${
                      selectedEngine === eng
                        ? "bg-primary/15 text-primary border-primary/50"
                        : "bg-surface text-muted-foreground border-border hover:border-primary/30"
                    }`}
                  >
                    {eng}
                  </button>
                ))}
              </div>
            )}
            {!isAnalyzing && (
              <button onClick={clearVideo}
                className="rounded-lg border border-border bg-surface p-2 text-muted-foreground hover:text-foreground transition-colors">
                <X className="h-4 w-4" />
              </button>
            )}
          </div>

          {/* Progress bar */}
          {isAnalyzing && (
            <div>
              <div className="flex justify-between text-xs text-muted-foreground mb-1.5">
                <span className="flex items-center gap-1.5"><Eye className="h-3 w-3" />{statusMsg}</span>
                <span>{progress}%</span>
              </div>
              <div className="h-1.5 rounded-full bg-surface overflow-hidden">
                <div className="h-full bg-primary rounded-full transition-all duration-200"
                  style={{ width: `${progress}%` }} />
              </div>
            </div>
          )}

          {/* ── Parameter sliders + Analizar button (shown when not analyzing) ── */}
          {!isAnalyzing && (
            <div className="space-y-3">

              {/* Collapsible params panel */}
              <div className="rounded-lg border border-border bg-surface/60">
                <button
                  onClick={() => setShowParams(v => !v)}
                  className="w-full flex items-center justify-between px-3 py-2 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors"
                >
                  <span>⚙ Parámetros de detección</span>
                  <span className="text-[10px]">{showParams ? "▲" : "▼"}</span>
                </button>

                {showParams && (
                  <div className="px-3 pb-3 space-y-3 border-t border-border/50 pt-3">
                    {(
                      [
                        { label: "Proximidad cruce",      key: "prox",     val: paramProx,     set: setParamProx,     ref: proxRef,     min: 0.04, max: 0.40, step: 0.01, fmt: (v: number) => `${Math.round(v*100)}%` },
                        { label: "Edad mín. de track",    key: "minAge",   val: paramMinAge,   set: setParamMinAge,   ref: minAgeRef,   min: 0,    max: 3.0,  step: 0.25, fmt: (v: number) => `${v.toFixed(2)}s` },
                        { label: "Ratio forma (anti-cuerda)", key: "aspect", val: paramAspect, set: setParamAspect,   ref: aspectRef,   min: 1.5,  max: 5.0,  step: 0.1,  fmt: (v: number) => `${v.toFixed(1)}` },
                        { label: "Confianza pose",        key: "poseConf", val: paramPoseConf, set: setParamPoseConf, ref: poseConfRef, min: 0.01, max: 0.50, step: 0.01, fmt: (v: number) => `${v.toFixed(2)}` },
                        { label: "Altura mín. cluster",   key: "minH",     val: paramMinH,     set: setParamMinH,     ref: minHRef,     min: 0.003,max: 0.03, step: 0.001,fmt: (v: number) => `${(v*100).toFixed(1)}%` },
                        { label: "Forma cónica (ancho↓/↑)", key: "conic", val: paramConic,   set: setParamConic,   ref: conicRef,    min: 0,    max: 3.0,  step: 0.1,  fmt: (v: number) => v <= 0 ? "off" : `${v.toFixed(1)}x` },
                      ] as const
                    ).map(p => (
                      <div key={p.key} className="space-y-1">
                        <div className="flex justify-between text-[11px]">
                          <span className="text-muted-foreground">{p.label}</span>
                          <span className="font-mono text-foreground tabular-nums">{p.fmt(p.val)}</span>
                        </div>
                        <input
                          type="range"
                          min={p.min} max={p.max} step={p.step}
                          value={p.val}
                          onChange={e => {
                            const v = parseFloat(e.target.value);
                            p.set(v as never);
                            (p.ref as React.MutableRefObject<number>).current = v;
                          }}
                          className="w-full h-1.5 accent-primary cursor-pointer"
                        />
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Primary action button */}
              <button
                onClick={() => {
                  if (phase === "complete" || phase === "error") {
                    setResult(null); setError(null); setProgress(0); setPhase("ready");
                    setTimeout(() => analyze(), 0);
                  } else {
                    analyze();
                  }
                }}
                className="w-full flex items-center justify-center gap-2 rounded-lg bg-primary py-3 text-sm font-semibold text-primary-foreground hover:bg-primary/90 transition-colors shadow-sm"
              >
                ▶ Analizar video
              </button>
            </div>
          )}

          {/* Analysis error */}
          {phase === "error" && error && videoUrl && (
            <div className="rounded-lg bg-destructive/10 border border-destructive/30 p-3 flex gap-2.5">
              <AlertCircle className="h-4 w-4 text-destructive shrink-0 mt-0.5" />
              <p className="text-sm text-destructive">{error}</p>
            </div>
          )}
        </div>
      )}

      {/* ── Results ── */}
      {result && phase === "complete" && (
        <div className="rounded-xl border border-primary/30 bg-primary/5 p-5 space-y-4">
          <div className="flex items-center gap-2">
            <CheckCircle className="h-5 w-5 text-green-400" />
            <h3 className="font-display font-bold text-foreground">Resultado del sprint</h3>
            <span className="ml-auto text-xs text-muted-foreground bg-surface rounded-full px-2 py-0.5">
              {serverEngine} · {liveInfo.splits} cruces
            </span>
          </div>

          {/* Reaction / explosive start */}
          {result.reaction !== undefined && (
            <div className="rounded-lg bg-amber-500/10 border border-amber-500/30 px-4 py-3 flex items-center justify-between">
              <div>
                <p className="text-xs font-medium text-amber-400 uppercase tracking-wider">Explosividad de arranque</p>
                <p className="text-[10px] text-muted-foreground mt-0.5">Tiempo de reacción hasta primer movimiento</p>
              </div>
              <span className="font-display font-bold text-2xl tabular-nums text-amber-400">
                {result.reaction.toFixed(2)}s
              </span>
            </div>
          )}

          {/* 4 splits */}
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border">
                <th className="text-left text-xs font-medium text-muted-foreground uppercase tracking-wider py-2 pl-0">Segmento</th>
                <th className="text-right text-xs font-medium text-muted-foreground uppercase tracking-wider py-2 px-3">Acumulado</th>
                <th className="text-right text-xs font-medium text-muted-foreground uppercase tracking-wider py-2 pr-0">Parcial</th>
              </tr>
            </thead>
            <tbody>
              {([
                { label: "0 → 10m",  key: "t10" as const, prev: 0 },
                { label: "10 → 20m", key: "t20" as const, prev: result.t10 },
                { label: "20 → 30m", key: "t30" as const, prev: result.t20 },
                { label: "30 → 40m", key: "t40" as const, prev: result.t30 },
              ]).map(({ label, key, prev }) => {
                const partial = result[key] - prev;
                return (
                  <tr key={key} className="border-b border-border/50 last:border-0">
                    <td className="py-2.5 pl-0 text-muted-foreground">{label}</td>
                    <td className="py-2.5 px-3 text-right font-display font-bold text-primary tabular-nums">{result[key].toFixed(2)}s</td>
                    <td className="py-2.5 pr-0 text-right tabular-nums text-muted-foreground text-xs">+{partial.toFixed(2)}s</td>
                  </tr>
                );
              })}
              <tr className="border-t border-border">
                <td className="pt-2.5 pl-0 text-xs font-medium text-muted-foreground uppercase">Total 40m</td>
                <td className="pt-2.5 px-3 text-right font-display font-bold text-foreground tabular-nums">{result.t40.toFixed(2)}s</td>
                <td />
              </tr>
            </tbody>
          </table>

          {(result.hipAngle !== undefined || result.kneeAngle !== undefined || result.ankleAngle !== undefined) && (
            <div>
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-2">
                Ángulos articulares promedio
              </p>
              <div className="grid grid-cols-3 gap-3">
                {([
                  ["Cadera",  result.hipAngle,   "#eab308"],
                  ["Rodilla", result.kneeAngle,  "#22c55e"],
                  ["Tobillo", result.ankleAngle, "#3b82f6"],
                ] as [string, number | undefined, string][]).map(([label, val, color]) => (
                  <div key={label} className="text-center rounded-lg bg-card border border-border p-3">
                    <div className="text-xs text-muted-foreground mb-1 uppercase tracking-wider">{label}</div>
                    <div className="font-display font-bold text-2xl tabular-nums" style={{ color }}>
                      {val !== undefined ? `${val}°` : "—"}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── Legend ── */}
      {videoUrl && (
        <div className="rounded-xl border border-border/40 bg-card/50 p-4">
          <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-3">Leyenda</p>
          <div className="flex flex-wrap gap-3 text-xs">
            {[
              ["#22c55e", "Cabeza"],
              ["#eab308", "Tronco / Caderas"],
              ["#ef4444", "Brazos"],
              ["#3b82f6", "Piernas / Pies"],
              ["#00ffcc", "Zona de tracking (pies)"],
              [selectedConeConfig.color, `Cono ${selectedConeConfig.label.toLowerCase()}`],
            ].map(([c, l]) => (
              <span key={l} className="flex items-center gap-1.5">
                <span className="h-2.5 w-2.5 rounded-full shrink-0" style={{ background: c }} />
                <span className="text-muted-foreground">{l}</span>
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Hidden processing elements */}
      <video ref={hiddenRef} className="hidden" />
      <canvas ref={hiddenCvRef} className="hidden" />
      <canvas ref={liveCvRef} className="hidden" />
    </div>
  );
}
