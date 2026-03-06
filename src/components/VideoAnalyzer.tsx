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

// ─── Types ────────────────────────────────────────────────────────────────────
interface PoseLandmark { x: number; y: number; z?: number; visibility?: number; }
interface PoseResult   { landmarks: PoseLandmark[][]; engine?: string; }

type Phase = "server_check" | "ready" | "analyzing" | "complete" | "error";
interface FrameCone { x: number; y: number; color: string; }

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
  const cls: { x: number; y: number; n: number; sx: number; sy: number }[] = [];
  for (const pt of pts) {
    let hit = false;
    for (const c of cls) {
      if (Math.hypot(pt.x - c.x, pt.y - c.y) < r) {
        c.sx += pt.x; c.sy += pt.y; c.n++;
        c.x = c.sx / c.n; c.y = c.sy / c.n;
        hit = true; break;
      }
    }
    if (!hit) cls.push({ x: pt.x, y: pt.y, n: 1, sx: pt.x, sy: pt.y });
  }
  return cls.filter(c => c.n >= 2).sort((a, b) => a.x - b.x);
}

function detectConesInFrame(
  data: Uint8ClampedArray,
  W: number,
  H: number,
): FrameCone[] {
  const pts: { x: number; y: number }[] = [];
  const startY = Math.floor(H * 0.75); // cones are on the ground, below the player's feet
  for (let y = startY; y < H; y += 2) {
    for (let x = 0; x < W; x += 2) {
      const i = (y * W + x) * 4;
      const { h, s, v } = rgbToHsv(data[i], data[i + 1], data[i + 2]);
      // Purple/magenta OR orange cones
      const isPurple = h >= 240 && h <= 345 && s > 0.25 && v > 0.15;
      const isOrange = (h <= 35 || h >= 345) && s > 0.45 && v > 0.35;
      if (isPurple || isOrange) pts.push({ x, y });
    }
  }
  const clusters = clusterPoints(pts, Math.max(20, Math.floor(W * 0.02)));
  return clusters.map(cl => ({ x: cl.x, y: cl.y, color: "#a855f7" }));
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
async function checkServer(): Promise<{ ok: boolean; engine: string; available: string[] }> {
  try {
    const res = await fetch(`${POSE_SERVER}/health`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return { ok: false, engine: "none", available: [] };
    const data = await res.json();
    return {
      ok: true,
      engine:    data.engine    ?? "unknown",
      available: data.available ?? [data.engine].filter(Boolean),
    };
  } catch {
    return { ok: false, engine: "none", available: [] };
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
  isCrossing: boolean,
) {
  ctx.drawImage(src, 0, 0, W, H);
  ctx.fillStyle = "rgba(0,0,0,0.15)";
  ctx.fillRect(0, 0, W, H);

  if (isCrossing) {
    ctx.strokeStyle = "#22c55e";
    ctx.lineWidth = 6;
    ctx.strokeRect(3, 3, W - 6, H - 6);
  }

  _drawCones(ctx, cones, W);
  _drawSkeleton(ctx, pose, W, H, footX, isCrossing);

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
) {
  ctx.clearRect(0, 0, W, H);
  _drawCones(ctx, cones, W);
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
function _drawCones(ctx: CanvasRenderingContext2D, cones: FrameCone[], W: number) {
  for (const cone of cones) {
    ctx.save();
    ctx.setLineDash([5, 5]);
    ctx.strokeStyle = `${cone.color}66`;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(cone.x, 0);
    ctx.lineTo(cone.x, cone.y - 24);
    ctx.stroke();
    ctx.restore();

    ctx.beginPath();
    ctx.arc(cone.x, cone.y, Math.max(14, W * 0.015), 0, Math.PI * 2);
    ctx.strokeStyle = cone.color;
    ctx.lineWidth = 3;
    ctx.stroke();
    ctx.fillStyle = `${cone.color}33`;
    ctx.fill();
  }
}

function _drawSkeleton(
  ctx: CanvasRenderingContext2D,
  pose: PoseResult | null,
  W: number,
  H: number,
  footX: number | null,
  isCrossing: boolean,
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
  const [result, setResult]         = useState<SprintData | null>(null);
  const [error, setError]           = useState<string | null>(null);
  const [videoFile, setVideoFile]   = useState<File | null>(null);
  const [videoUrl, setVideoUrl]     = useState<string | null>(null);
  const [liveInfo, setLiveInfo]     = useState({ cones: 0, player: false, splits: 0 });
  const [liveSplits, setLiveSplits] = useState<number[]>([]);

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

  // ── Server health check ────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setPhase("server_check");
      setStatusMsg("Conectando con servidor...");
      const { ok, engine, available } = await checkServer();
      if (cancelled) return;
      if (ok) {
        setServerEngine(engine);
        setAvailableEngines(available);
        setSelectedEngine(engine);
        selectedEngineRef.current = engine;
        setPhase("ready");
        setStatusMsg(`Servidor listo · ${engine}`);
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
    shouldAutoAnalyze.current = true;
    if (phase === "complete" || phase === "error") setPhase("ready");
  }, [videoUrl, phase]);

  const clearVideo = useCallback(() => {
    if (videoUrl) URL.revokeObjectURL(videoUrl);
    setVideoUrl(null); setVideoFile(null); setResult(null);
    setError(null); setProgress(0); setLiveInfo({ cones: 0, player: false, splits: 0 });
    if (phase === "complete" || phase === "analyzing") setPhase("ready");
  }, [videoUrl, phase]);

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
          const cones = detectConesInFrame(imageData.data, W, H);

          liveDetecting.current = true;
          fetchPose(snap, selectedEngineRef.current || undefined).then(pose => {
            const outCtxNow = canvasRef.current?.getContext("2d");
            if (outCtxNow) drawOverlay(outCtxNow, pose, cones, W, H);
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

    const DEBOUNCE = 0.50; // min seconds between consecutive crossings
    const PROX     = 0.16; // foot must be within 16% of frame width from cone center

    try {
      hidden.src = videoUrl;
      await new Promise<void>((res, rej) => {
        hidden.onloadedmetadata = () => res();
        hidden.onerror = () => rej(new Error("No se pudo cargar el video."));
      });

      const W = hidden.videoWidth, H = hidden.videoHeight;
      hiddenCv.width = W; hiddenCv.height = H;
      outCv.width    = W; outCv.height    = H;
      const hiddenCtx = hiddenCv.getContext("2d")!;
      const outCtx    = outCv.getContext("2d")!;

      const sampleFps   = 10;
      const totalFrames = Math.floor(hidden.duration * sampleFps);

      const crossings: number[] = [];
      let lastCrossingTime  = -999;
      let startTime: number | null = null;
      let showCrossing      = false;
      let showCrossingUntil = -1;
      let motionFrames      = 0; // consecutive frames where ankles differ in height (= running)
      let poseFrames        = 0; // consecutive frames with valid pose (fallback start counter)
      let startConeMarked   = false; // whether the starting cone has been ignored

      type ConeTrack = { x: number; lastSeen: number; fired: boolean };
      const coneTracks: ConeTrack[] = [];

      let angleSum    = { hip: 0, knee: 0, ankle: 0 };
      let angleSamples = 0;

      setStatusMsg("Analizando con IA...");

      for (let f = 0; f < totalFrames; f++) {
        const t = f / sampleFps;
        await seekTo(hidden, t);
        hiddenCtx.drawImage(hidden, 0, 0, W, H);

        const imageData = hiddenCtx.getImageData(0, 0, W, H);
        const cones     = detectConesInFrame(imageData.data, W, H);

        // Send original frame to server — server can scale internally
        const poseResult = await fetchPose(hiddenCv, selectedEngineRef.current || undefined);

        let footX: number | null = null;
        let playerDetected = poseResult != null && poseResult.landmarks.length > 0;

        if (playerDetected) {
          const kps = poseResult!.landmarks[0];
          // Use only ankles + toes: these are closest to the ground where the cone is
          const feet = [kps[27], kps[28], kps[31], kps[32]]
            .filter(k => k && (k.visibility ?? 0) > 0.05);
          if (feet.length > 0) {
            footX = feet.reduce((s, k) => s + k.x, 0) / feet.length;
          }
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

        // Accumulate joint angles
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
          if (hc) angleSum.hip   += ha / hc;
          if (kc) angleSum.knee  += ka / kc;
          if (ac) angleSum.ankle += aa / ac;
          if (hc || kc || ac) angleSamples++;
        }

        // Cone tracker — nearest-neighbour match across frames
        const detNorms = cones.map(c => c.x / W);
        const matched  = new Set<number>();
        for (const tr of coneTracks) {
          let bestD = 0.18, bestI = -1;
          for (let i = 0; i < detNorms.length; i++) {
            if (matched.has(i)) continue;
            const d = Math.abs(detNorms[i] - tr.x);
            if (d < bestD) { bestD = d; bestI = i; }
          }
          if (bestI >= 0) { tr.x = detNorms[bestI]; tr.lastSeen = f; matched.add(bestI); }
        }
        for (let i = 0; i < detNorms.length; i++) {
          if (!matched.has(i)) coneTracks.push({ x: detNorms[i], lastSeen: f, fired: false });
        }
        // Age out stale tracks (cone not seen for >8 s) — avoids phantom positions.
        // Use a long window: the last cone is often occluded by the player's body as they cross it.
        for (const tr of coneTracks) {
          if (!matched.has(coneTracks.indexOf(tr)) && f - tr.lastSeen > sampleFps * 8) tr.fired = true;
        }

        showCrossing = t < showCrossingUntil;

        // On the first frame after the timer starts, mark the starting cone as fired so it
        // doesn't count as a split. Use only PROX (not 1.5x) to avoid accidentally excluding
        // the 10m cone if motion detection triggers a bit late.
        if (!startConeMarked && startTime !== null && footX !== null) {
          // Exclude only the single nearest cone to the player's foot at start
          let nearestTr: typeof coneTracks[0] | null = null;
          let nearestD = PROX;
          for (const tr of coneTracks) {
            if (tr.fired) continue;
            const d = Math.abs(footX - tr.x);
            if (d < nearestD) { nearestD = d; nearestTr = tr; }
          }
          if (nearestTr) nearestTr.fired = true;
          startConeMarked = true;
        }

        // Proximity crossing: foot within PROX of cone X, respects DEBOUNCE between events.
        // No stale-visibility check here: the player's body often blocks the cone at the moment
        // of crossing, so we rely on the last known position and DEBOUNCE to avoid double-counts.
        if (footX !== null && startTime !== null && crossings.length < 5) {
          for (const tr of coneTracks) {
            if (tr.fired) continue;
            if (Math.abs(footX - tr.x) < PROX && (t - lastCrossingTime) > DEBOUNCE) {
              crossings.push(parseFloat((t - startTime).toFixed(2)));
              lastCrossingTime  = t;
              showCrossingUntil = t + 0.5;
              showCrossing      = true;
              tr.fired          = true;
              break;
            }
          }
        }

        drawDetection(
          outCtx, hiddenCv, poseResult, cones,
          W, H, t - (startTime ?? t),
          crossings.length, footX, showCrossing,
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
              const { ok, engine, available } = await checkServer();
              if (ok) {
                setServerEngine(engine);
                setAvailableEngines(available);
                setSelectedEngine(engine);
                selectedEngineRef.current = engine;
                setPhase("ready");
                setStatusMsg(`Servidor listo · ${engine}`);
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
          <div className="inline-flex flex-col gap-1 text-xs text-muted-foreground bg-surface rounded-lg px-4 py-2.5 text-left">
            <span>• Conos <strong className="text-foreground">morados</strong> en 0m, 10m, 20m, 30m, 40m</span>
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
                <div className={`rounded-lg border p-2.5 text-center transition-colors ${liveInfo.cones > 0 ? "border-purple-500/40 bg-purple-500/10" : "border-border bg-surface/40"}`}>
                  <div className={`font-bold mb-0.5 ${liveInfo.cones > 0 ? "text-purple-400" : "text-muted-foreground"}`}>
                    {liveInfo.cones}
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
                      const t    = liveSplits[idx];
                      const prev = idx > 0 ? liveSplits[idx - 1] : 0;
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
                  </tbody>
                </table>
              </div>
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

          {/* Re-analyze */}
          {!isAnalyzing && (phase === "complete" || phase === "error") && (
            <button
              onClick={() => { setPhase("ready"); setResult(null); setError(null); setProgress(0); }}
              className="w-full flex items-center justify-center gap-2 rounded-lg border border-border bg-surface py-2.5 text-sm font-medium text-muted-foreground hover:text-foreground transition-colors"
            >
              Volver a analizar
            </button>
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
              ["#a855f7", "Cono morado"],
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
