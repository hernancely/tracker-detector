/**
 * VideoAnalyzer — sports-biomechanics-analyzer agent integration
 *
 * Algorithm (moving camera compatible):
 * - MediaPipe PoseLandmarker LITE (33 keypoints, CPU) per frame
 * - Per-frame cone detection (purple HSV thresholding only)
 * - Split timing via player-foot ↔ cone proximity in the same frame
 *   → works regardless of camera movement
 */
import { useState, useRef, useCallback, useEffect } from "react";
import {
  PoseLandmarker,
  FilesetResolver,
  type PoseLandmarkerResult,
  type NormalizedLandmark,
} from "@mediapipe/tasks-vision";
import { SprintData } from "@/types/player";
import { Loader2, Upload, X, AlertCircle, CheckCircle, Eye } from "lucide-react";

// ─── MediaPipe BlazePose 33-keypoint skeleton ─────────────────────────────────
const SKELETON: [number, number][] = [
  [0,1],[0,4],[1,2],[2,3],[3,7],[4,5],[5,6],[6,8],[9,10], // head
  [11,12],                                                  // shoulders
  [11,13],[13,15],[15,21],                                  // left arm
  [12,14],[14,16],[16,22],                                  // right arm
  [11,23],[12,24],[23,24],                                  // torso
  [23,25],[25,27],[27,29],[27,31],                          // left leg
  [24,26],[26,28],[28,30],[28,32],                          // right leg
];

function keypointColor(idx: number): string {
  if (idx <= 10)  return "#22c55e"; // head  → green
  if (idx <= 12)  return "#eab308"; // shoulder → yellow
  if (idx <= 22)  return "#ef4444"; // arms  → red
  if (idx <= 24)  return "#eab308"; // hips  → yellow
  return                  "#3b82f6"; // legs/feet → blue
}

// ─── Color detection (per-frame) ──────────────────────────────────────────────
function rgbToHsv(r: number, g: number, b: number) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r,g,b), min = Math.min(r,g,b), d = max - min;
  let h = 0;
  if (d) switch (max) {
    case r: h = ((g-b)/d + (g<b?6:0)) / 6; break;
    case g: h = ((b-r)/d + 2) / 6; break;
    case b: h = ((r-g)/d + 4) / 6; break;
  }
  return { h: h*360, s: max ? d/max : 0, v: max };
}

function clusterPoints(pts: {x:number;y:number}[], r: number) {
  const cls: {x:number;y:number;n:number;sx:number;sy:number}[] = [];
  for (const pt of pts) {
    let hit = false;
    for (const c of cls) {
      if (Math.hypot(pt.x - c.x, pt.y - c.y) < r) {
        c.sx += pt.x; c.sy += pt.y; c.n++;
        c.x = c.sx/c.n; c.y = c.sy/c.n;
        hit = true; break;
      }
    }
    if (!hit) cls.push({ x: pt.x, y: pt.y, n: 1, sx: pt.x, sy: pt.y });
  }
  return cls.filter(c => c.n >= 4).sort((a, b) => a.x - b.x);
}

/** Detect purple cone clusters in a given canvas frame */
function detectConesInFrame(
  data: Uint8ClampedArray,
  W: number,
  H: number,
): { x: number; y: number; color: string }[] {
  const pts: {x:number;y:number}[] = [];
  const startY = Math.floor(H * 0.40); // cones are on the ground (lower part)

  for (let y = startY; y < H; y += 2) {
    for (let x = 0; x < W; x += 2) {
      const i = (y * W + x) * 4;
      const { h, s, v } = rgbToHsv(data[i], data[i+1], data[i+2]);
      if (h>=255 && h<=325 && s>0.30 && v>0.18) { // purple / magenta only
        pts.push({ x, y });
      }
    }
  }

  const clusters = clusterPoints(pts, Math.max(20, Math.floor(W * 0.02)));
  return clusters.map(cl => ({ x: cl.x, y: cl.y, color: "#a855f7" }));
}

/** Color-based player fallback for aerial footage.
 *  Returns normalized (0–1) centroid of non-grass/non-cone pixels, or null. */
function detectPlayerColorInFrame(
  data: Uint8ClampedArray,
  W: number,
  H: number,
): { x: number; y: number } | null {
  let sumX = 0, sumY = 0, count = 0;
  for (let y = 0; y < H; y += 3) {
    for (let x = 0; x < W; x += 3) {
      const i = (y * W + x) * 4;
      const { h, s, v } = rgbToHsv(data[i], data[i+1], data[i+2]);
      if (h >= 65 && h <= 165 && s > 0.18 && v > 0.15) continue; // grass green
      if (h >= 250 && h <= 330 && s > 0.28) continue;             // purple cones
      if (v < 0.18) continue;                                      // shadows
      if (s < 0.08 && v > 0.85) continue;                         // white lines
      sumX += x; sumY += y; count++;
    }
  }
  if (count < 20) return null;
  return { x: sumX / count / W, y: sumY / count / H };
}

/** Angle (degrees) at joint B given three 2-D normalized points A-B-C */
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

// ─── Types ────────────────────────────────────────────────────────────────────
type Phase = "idle"|"model_loading"|"model_ready"|"analyzing"|"complete"|"error";
interface FrameCone { x: number; y: number; color: string; }

export interface VideoAnalyzerProps {
  onResult?: (result: SprintData) => void;
}

// ─── Canvas HUD drawing (analysis mode — draws video frame as background) ─────
function drawDetection(
  ctx: CanvasRenderingContext2D,
  src: HTMLCanvasElement,
  pose: PoseLandmarkerResult | null,
  cones: FrameCone[],
  W: number,
  H: number,
  currentTime: number,
  splitsRecorded: number,
  footX: number | null,
  isCrossing: boolean,
) {
  // 1. Video frame
  ctx.drawImage(src, 0, 0, W, H);

  // 2. Subtle overlay
  ctx.fillStyle = "rgba(0,0,0,0.15)";
  ctx.fillRect(0, 0, W, H);

  // 3. Crossing flash
  if (isCrossing) {
    ctx.strokeStyle = "#22c55e";
    ctx.lineWidth = 6;
    ctx.strokeRect(3, 3, W-6, H-6);
  }

  // 4. Cones in this frame
  _drawCones(ctx, cones, W);

  // 5. Pose skeleton
  _drawSkeleton(ctx, pose, cones, W, H, footX, isCrossing);

  // 6. HUD — top-left badge
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

  // 7. HUD — top-right splits counter
  ctx.fillStyle = "rgba(0,0,0,0.60)";
  const badge = `Splits ${splitsRecorded}/4`;
  const bw = ctx.measureText(badge).width + 24;
  roundRect(ctx, W - bw - 10, 10, bw, 32, 8);
  ctx.fill();
  ctx.fillStyle = splitsRecorded > 0 ? "#22c55e" : "#ffffffaa";
  ctx.font = "bold 11px Inter,sans-serif";
  ctx.textAlign = "right";
  ctx.fillText(badge, W - 22, 31);

  // 8. Crossing banner
  if (isCrossing) {
    ctx.fillStyle = "rgba(34,197,94,0.85)";
    roundRect(ctx, W/2 - 80, H - 52, 160, 36, 10);
    ctx.fill();
    ctx.fillStyle = "#fff";
    ctx.font = "bold 14px Inter,sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(`✓ Split ${splitsRecorded} registrado`, W/2, H - 28);
  }
}

// ─── Live overlay drawing (no background — transparent on top of native video) ─
function drawOverlay(
  ctx: CanvasRenderingContext2D,
  pose: PoseLandmarkerResult | null,
  cones: FrameCone[],
  W: number,
  H: number,
) {
  ctx.clearRect(0, 0, W, H);
  _drawCones(ctx, cones, W);
  _drawSkeleton(ctx, pose, [], W, H, null, false);

  // "EN VIVO" badge
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
    ctx.arc(cone.x, cone.y, Math.max(14, W * 0.015), 0, Math.PI*2);
    ctx.strokeStyle = cone.color;
    ctx.lineWidth = 3;
    ctx.stroke();
    ctx.fillStyle = `${cone.color}33`;
    ctx.fill();
  }
}

function _drawSkeleton(
  ctx: CanvasRenderingContext2D,
  pose: PoseLandmarkerResult | null,
  _cones: FrameCone[],
  W: number,
  H: number,
  footX: number | null,
  isCrossing: boolean,
) {
  if (!pose || pose.landmarks.length === 0) return;
  const lms: NormalizedLandmark[] = pose.landmarks[0];

  // Lines
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
    ctx.arc(lm.x * W, lm.y * H, r, 0, Math.PI*2);
    ctx.fillStyle = keypointColor(i);
    ctx.fill();
    ctx.strokeStyle = "rgba(0,0,0,0.5)";
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  // Foot tracking circles (ankles + foot index)
  for (const idx of [27, 28, 31, 32]) {
    const lm = lms[idx];
    if (!lm || (lm.visibility ?? 0) < 0.05) continue;
    ctx.beginPath();
    ctx.arc(lm.x * W, lm.y * H, 13, 0, Math.PI*2);
    ctx.strokeStyle = isCrossing ? "#22c55e" : "#00ffcc";
    ctx.lineWidth = 2.5;
    ctx.stroke();
  }

  // Foot proximity zone (vertical band)
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
  const [phase, setPhase]         = useState<Phase>("idle");
  const [statusMsg, setStatusMsg] = useState("");
  const [progress, setProgress]   = useState(0);
  const [modelPct, setModelPct]   = useState(0);
  const [result, setResult]       = useState<SprintData | null>(null);
  const [error, setError]         = useState<string | null>(null);
  const [videoFile, setVideoFile] = useState<File | null>(null);
  const [videoUrl, setVideoUrl]   = useState<string | null>(null);
  const [liveInfo, setLiveInfo]   = useState({ cones: 0, player: false, splits: 0 });

  // Visible canvas (absolute overlay on top of the video element)
  const canvasRef         = useRef<HTMLCanvasElement>(null);
  // Visible video element (always shown except during analysis)
  const videoRef          = useRef<HTMLVideoElement>(null);
  // Hidden video for frame-seeking during analysis
  const hiddenRef         = useRef<HTMLVideoElement>(null);
  // Hidden canvas for analysis frame extraction
  const hiddenCvRef       = useRef<HTMLCanvasElement>(null);
  // Hidden canvas for live loop frame extraction
  const liveCvRef         = useRef<HTMLCanvasElement>(null);
  // RAF ID for the live detection loop
  const liveRafRef        = useRef(0);
  // Throttle timestamp for live loop
  const liveLastMs        = useRef(0);

  const scaledCvRef       = useRef<HTMLCanvasElement | null>(null);
  const landmarker        = useRef<PoseLandmarker | null>(null);
  const shouldAutoAnalyze = useRef(false);

  // ── Load MediaPipe on mount ────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setPhase("model_loading");
      setStatusMsg("Cargando modelo MediaPipe...");
      setModelPct(10);
      try {
        const vision = await FilesetResolver.forVisionTasks(
          "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.18/wasm"
        );
        setModelPct(55);
        const lm = await PoseLandmarker.createFromOptions(vision, {
          baseOptions: {
            modelAssetPath:
              "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task",
            delegate: "CPU",
          },
          runningMode: "IMAGE",
          numPoses: 2,
          minPoseDetectionConfidence: 0.1,
          minPosePresenceConfidence: 0.1,
          minTrackingConfidence: 0.1,
        });
        if (!cancelled) {
          landmarker.current = lm;
          setModelPct(100);
          setPhase("model_ready");
          setStatusMsg("Modelo listo");
        }
      } catch (e) {
        if (!cancelled) {
          setPhase("error");
          setError(`No se pudo cargar el modelo de IA. Verifica tu conexión. (${e})`);
        }
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
    if (phase !== "model_loading") setPhase("model_ready");
  }, [videoUrl, phase]);

  const clearVideo = useCallback(() => {
    if (videoUrl) URL.revokeObjectURL(videoUrl);
    setVideoUrl(null); setVideoFile(null); setResult(null);
    setError(null); setProgress(0); setLiveInfo({ cones: 0, player: false, splits: 0 });
    if (phase !== "model_loading") setPhase("model_ready");
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
      const lm     = landmarker.current;

      if (!video || !liveCv || !outCv || !lm) {
        liveRafRef.current = requestAnimationFrame(loop);
        return;
      }

      const now = performance.now();
      if (now - liveLastMs.current > 150) { // ~6 detections per second
        liveLastMs.current = now;
        const W = video.videoWidth, H = video.videoHeight;
        if (W && H) {
          if (liveCv.width !== W || liveCv.height !== H) { liveCv.width = W; liveCv.height = H; }
          if (outCv.width  !== W || outCv.height  !== H) { outCv.width  = W; outCv.height  = H; }

          const cvCtx  = liveCv.getContext("2d")!;
          const outCtx = outCv.getContext("2d")!;

          cvCtx.drawImage(video, 0, 0, W, H);

          // 2× upscale before detection → catches small players in aerial footage
          if (!scaledCvRef.current) scaledCvRef.current = document.createElement("canvas");
          const scaledCv = scaledCvRef.current;
          if (scaledCv.width !== W * 3 || scaledCv.height !== H * 3) {
            scaledCv.width = W * 3; scaledCv.height = H * 3;
          }
          scaledCv.getContext("2d")!.drawImage(liveCv, 0, 0, W * 3, H * 3);

          let pose: PoseLandmarkerResult | null = null;
          try { pose = lm.detect(scaledCv); } catch { /* skip frame */ }

          const imageData = cvCtx.getImageData(0, 0, W, H);
          const cones = detectConesInFrame(imageData.data, W, H);

          drawOverlay(outCtx, pose, cones, W, H);
        }
      }

      liveRafRef.current = requestAnimationFrame(loop);
    };

    liveRafRef.current = requestAnimationFrame(loop);
  }, []); // all refs — no reactive deps

  // Start/stop live loop based on phase
  useEffect(() => {
    const active = !!videoUrl &&
      (phase === "model_ready" || phase === "complete" || phase === "error") &&
      !!landmarker.current;
    if (active) startLiveLoop();
    else stopLiveLoop();
    return () => stopLiveLoop();
  }, [videoUrl, phase, startLiveLoop, stopLiveLoop]);

  // ── Main analysis ──────────────────────────────────────────────────────────
  const analyze = useCallback(async () => {
    const hidden   = hiddenRef.current;
    const hiddenCv = hiddenCvRef.current;
    const outCv    = canvasRef.current;
    const lm       = landmarker.current;
    if (!hidden || !hiddenCv || !outCv || !lm || !videoUrl) return;

    // Stop live overlay while analysis runs
    cancelAnimationFrame(liveRafRef.current);
    liveRafRef.current = 0;

    setPhase("analyzing");
    setProgress(0);
    setError(null);
    setResult(null);

    const DEBOUNCE   = 0.35;
    // Player must be this far past the cone on EACH side before a crossing counts.
    // Prevents false positives from foot oscillation during running stride (~±0.06).
    const DIR_MARGIN = 0.08;

    try {
      hidden.src = videoUrl;
      await new Promise<void>((res, rej) => {
        hidden.onloadedmetadata = () => res();
        hidden.onerror = () => rej(new Error("No se pudo cargar el video."));
      });

      const W = hidden.videoWidth, H = hidden.videoHeight;
      hiddenCv.width = W; hiddenCv.height = H;
      outCv.width = W; outCv.height = H;
      const hiddenCtx = hiddenCv.getContext("2d")!;
      const outCtx    = outCv.getContext("2d")!;

      const sampleFps   = 10;
      const totalFrames = Math.floor(hidden.duration * sampleFps);

      const crossings: number[] = [];
      let lastCrossingTime = -999;
      let startTime: number | null = null;
      let showCrossing = false;
      let showCrossingUntil = -1;

      // Cone tracker: follow each physical cone across frames (moving camera compatible).
      // A crossing is registered only when the player moves from one side of the cone
      // to the other by at least DIR_MARGIN — eliminates stride-oscillation false positives.
      type ConeTrack = { x: number; seenLeft: boolean; seenRight: boolean; fired: boolean };
      const coneTracks: ConeTrack[] = [];

      // Joint angle accumulators (averaged across all frames with a detected skeleton)
      let angleSum = { hip: 0, knee: 0, ankle: 0 };
      let angleSamples = 0;

      setStatusMsg("Analizando con IA...");

      for (let f = 0; f < totalFrames; f++) {
        const t = f / sampleFps;
        await seekTo(hidden, t);
        hiddenCtx.drawImage(hidden, 0, 0, W, H);

        const imageData = hiddenCtx.getImageData(0, 0, W, H);
        const cones = detectConesInFrame(imageData.data, W, H);

        // 2× upscale before detection → catches small players in aerial footage
        if (!scaledCvRef.current) scaledCvRef.current = document.createElement("canvas");
        const scaledCv = scaledCvRef.current;
        if (scaledCv.width !== W * 3 || scaledCv.height !== H * 3) {
          scaledCv.width = W * 2; scaledCv.height = H * 2;
        }
        scaledCv.getContext("2d")!.drawImage(hiddenCv, 0, 0, W * 3, H * 3);

        let poseResult: PoseLandmarkerResult | null = null;
        try { poseResult = lm.detect(scaledCv); } catch { /* skip frame */ }

        let footX: number | null = null;
        let playerDetected = poseResult != null && poseResult.landmarks.length > 0;

        if (playerDetected) {
          const kps = poseResult!.landmarks[0];
          const lowerBody = [kps[23], kps[24], kps[25], kps[26], kps[27], kps[28], kps[31], kps[32]]
            .filter(k => k && (k.visibility ?? 0) > 0.05);
          if (lowerBody.length > 0) {
            footX = lowerBody.reduce((s, k) => s + k.x, 0) / lowerBody.length;
            if (startTime === null) startTime = t;
          }
        }

        // Color fallback: only marks player as "present" to start the clock,
        // but does NOT set footX — the centroid is too imprecise for cone crossing.
        if (!playerDetected) {
          const colorPos = detectPlayerColorInFrame(imageData.data, W, H);
          if (colorPos) {
            playerDetected = true;
            if (startTime === null) startTime = t;
            // footX stays null → no false cone crossings from color noise
          }
        }

        // Accumulate joint angles from detected skeleton
        if (poseResult?.landmarks?.length) {
          const lm = poseResult.landmarks[0];
          const v = (i: number) => (lm[i]?.visibility ?? 0) > 0.10;
          let ha = 0, hc = 0, ka = 0, kc = 0, aa = 0, ac = 0;
          if (v(11)&&v(23)&&v(25)) { ha+=angleDeg(lm[11].x,lm[11].y,lm[23].x,lm[23].y,lm[25].x,lm[25].y); hc++; }
          if (v(12)&&v(24)&&v(26)) { ha+=angleDeg(lm[12].x,lm[12].y,lm[24].x,lm[24].y,lm[26].x,lm[26].y); hc++; }
          if (v(23)&&v(25)&&v(27)) { ka+=angleDeg(lm[23].x,lm[23].y,lm[25].x,lm[25].y,lm[27].x,lm[27].y); kc++; }
          if (v(24)&&v(26)&&v(28)) { ka+=angleDeg(lm[24].x,lm[24].y,lm[26].x,lm[26].y,lm[28].x,lm[28].y); kc++; }
          if (v(25)&&v(27)&&v(31)) { aa+=angleDeg(lm[25].x,lm[25].y,lm[27].x,lm[27].y,lm[31].x,lm[31].y); ac++; }
          if (v(26)&&v(28)&&v(32)) { aa+=angleDeg(lm[26].x,lm[26].y,lm[28].x,lm[28].y,lm[32].x,lm[32].y); ac++; }
          if (hc) angleSum.hip   += ha / hc;
          if (kc) angleSum.knee  += ka / kc;
          if (ac) angleSum.ankle += aa / ac;
          if (hc || kc || ac) angleSamples++;
        }

        // Update cone tracker (nearest-neighbour match across frames)
        const detNorms = cones.map(c => c.x / W);
        const matched = new Set<number>();
        for (const tr of coneTracks) {
          let bestD = 0.18, bestI = -1;
          for (let i = 0; i < detNorms.length; i++) {
            if (matched.has(i)) continue;
            const d = Math.abs(detNorms[i] - tr.x);
            if (d < bestD) { bestD = d; bestI = i; }
          }
          if (bestI >= 0) { tr.x = detNorms[bestI]; matched.add(bestI); }
        }
        for (let i = 0; i < detNorms.length; i++) {
          if (!matched.has(i)) coneTracks.push({ x: detNorms[i], seenLeft: false, seenRight: false, fired: false });
        }

        showCrossing = t < showCrossingUntil;

        if (footX !== null && startTime !== null && crossings.length < 5) {
          for (const tr of coneTracks) {
            if (tr.fired) continue;
            if (footX < tr.x - DIR_MARGIN) tr.seenLeft = true;
            else if (footX > tr.x + DIR_MARGIN) tr.seenRight = true;
            if (tr.seenLeft && tr.seenRight && (t - lastCrossingTime) > DEBOUNCE) {
              crossings.push(parseFloat((t - startTime).toFixed(2)));
              lastCrossingTime = t;
              showCrossingUntil = t + 0.5;
              showCrossing = true;
              tr.fired = true;
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

  // Auto-trigger analysis when video loads and model is ready
  useEffect(() => {
    if (shouldAutoAnalyze.current && videoUrl && phase === "model_ready") {
      shouldAutoAnalyze.current = false;
      analyze();
    }
  }, [videoUrl, phase, analyze]);

  const isAnalyzing = phase === "analyzing";

  return (
    <div className="space-y-5">

      {/* Model loading */}
      {phase === "model_loading" && (
        <div className="rounded-xl border border-border bg-card p-4">
          <div className="flex items-center gap-3 mb-2">
            <Loader2 className="h-4 w-4 text-primary animate-spin" />
            <p className="text-sm font-medium text-foreground">Cargando modelo MediaPipe...</p>
            <span className="ml-auto text-xs text-muted-foreground">{modelPct}%</span>
          </div>
          <div className="h-1.5 rounded-full bg-surface overflow-hidden">
            <div className="h-full bg-primary rounded-full transition-all duration-500" style={{ width: `${modelPct}%` }} />
          </div>
          <p className="text-xs text-muted-foreground mt-2">pose_landmarker_lite (~7 MB) · solo la primera vez</p>
        </div>
      )}

      {/* Upload zone */}
      {!videoUrl ? (
        <div
          onDragOver={e => e.preventDefault()}
          onDrop={e => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f) handleFile(f); }}
          onClick={() => document.getElementById("va-input")?.click()}
          className={`rounded-xl border-2 border-dashed bg-card p-12 text-center transition-colors cursor-pointer ${
            phase === "model_loading" ? "border-border opacity-50 pointer-events-none" : "border-border hover:border-primary/50"
          }`}
        >
          <input id="va-input" type="file" accept="video/*" className="hidden"
            onChange={e => e.target.files?.[0] && handleFile(e.target.files[0])} />
          <Upload className="h-10 w-10 text-muted-foreground mx-auto mb-4" />
          <p className="text-foreground font-medium mb-1">Arrastra el video aquí</p>
          <p className="text-sm text-muted-foreground mb-4">La IA detectará al jugador y los conos automáticamente</p>
          <div className="inline-flex flex-col gap-1 text-xs text-muted-foreground bg-surface rounded-lg px-4 py-2.5 text-left">
            <span>• Conos <strong className="text-foreground">morados</strong> en 0m, 10m, 20m, 30m, 40m</span>
            <span>• Funciona con cámara <strong className="text-foreground">fija o móvil</strong></span>
            <span>• Jugador como <strong className="text-foreground">único objeto en movimiento</strong></span>
          </div>
        </div>
      ) : (
        <div className="rounded-xl border border-border bg-card p-4 space-y-4">

          {/* Video + canvas overlay — always in DOM so refs are available */}
          <div className="relative rounded-lg overflow-hidden bg-black aspect-video">
            {/* Native video — always visible except during analysis */}
            <video
              ref={videoRef}
              src={videoUrl}
              className={`w-full h-full object-contain ${isAnalyzing ? "hidden" : ""}`}
              controls={!isAnalyzing}
            />
            {/* Canvas — transparent overlay during live mode, full render during analysis */}
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

          {/* Live detection info (only during analysis) */}
          {isAnalyzing && (
            <div className="grid grid-cols-3 gap-2 text-xs">
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
                <div className="text-muted-foreground">Conos en frame</div>
              </div>
              <div className={`rounded-lg border p-2.5 text-center transition-colors ${liveInfo.splits > 0 ? "border-primary/40 bg-primary/10" : "border-border bg-surface/40"}`}>
                <div className={`font-bold mb-0.5 ${liveInfo.splits > 0 ? "text-primary" : "text-muted-foreground"}`}>
                  {liveInfo.splits}/4
                </div>
                <div className="text-muted-foreground">Splits</div>
              </div>
            </div>
          )}

          {/* File info + clear */}
          <div className="flex items-center gap-3">
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-foreground truncate">{videoFile?.name}</p>
              <p className="text-xs text-muted-foreground">
                {videoFile && `${(videoFile.size / 1024 / 1024).toFixed(1)} MB`}
              </p>
            </div>
            {!isAnalyzing && (
              <button onClick={clearVideo}
                className="rounded-lg border border-border bg-surface p-2 text-muted-foreground hover:text-foreground transition-colors">
                <X className="h-4 w-4" />
              </button>
            )}
          </div>

          {/* Progress */}
          {isAnalyzing && (
            <div>
              <div className="flex justify-between text-xs text-muted-foreground mb-1.5">
                <span className="flex items-center gap-1.5"><Eye className="h-3 w-3" />{statusMsg}</span>
                <span>{progress}%</span>
              </div>
              <div className="h-1.5 rounded-full bg-surface overflow-hidden">
                <div className="h-full bg-primary rounded-full transition-all duration-200" style={{ width: `${progress}%` }} />
              </div>
            </div>
          )}

          {/* Re-analyze */}
          {!isAnalyzing && (phase === "complete" || phase === "error") && (
            <button onClick={() => { setPhase("model_ready"); setResult(null); setError(null); setProgress(0); }}
              className="w-full flex items-center justify-center gap-2 rounded-lg border border-border bg-surface py-2.5 text-sm font-medium text-muted-foreground hover:text-foreground transition-colors">
              Volver a analizar
            </button>
          )}

          {/* Error */}
          {phase === "error" && error && (
            <div className="rounded-lg bg-destructive/10 border border-destructive/30 p-3 flex gap-2.5">
              <AlertCircle className="h-4 w-4 text-destructive shrink-0 mt-0.5" />
              <p className="text-sm text-destructive">{error}</p>
            </div>
          )}
        </div>
      )}

      {/* Results */}
      {result && phase === "complete" && (
        <div className="rounded-xl border border-primary/30 bg-primary/5 p-5 space-y-4">
          <div className="flex items-center gap-2">
            <CheckCircle className="h-5 w-5 text-green-400" />
            <h3 className="font-display font-bold text-foreground">Resultado del sprint</h3>
            <span className="ml-auto text-xs text-muted-foreground bg-surface rounded-full px-2 py-0.5">
              MediaPipe · {liveInfo.splits} cruces
            </span>
          </div>

          {/* Sprint times */}
          <div className="grid grid-cols-4 gap-3">
            {(["t10","t20","t30","t40"] as const).map((k, i) => (
              <div key={k} className="text-center rounded-lg bg-card border border-border p-3">
                <div className="text-xs text-muted-foreground mb-1 uppercase tracking-wider">
                  {["10m","20m","30m","40m"][i]}
                </div>
                <div className="font-display font-bold text-2xl text-primary tabular-nums">
                  {result[k].toFixed(2)}s
                </div>
              </div>
            ))}
          </div>

          {/* Joint angles (only when skeleton was detected) */}
          {(result.hipAngle !== undefined || result.kneeAngle !== undefined || result.ankleAngle !== undefined) && (
            <div>
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-2">
                Ángulos articulares promedio
              </p>
              <div className="grid grid-cols-3 gap-3">
                {([
                  ["Cadera", result.hipAngle,   "#eab308"],
                  ["Rodilla", result.kneeAngle, "#22c55e"],
                  ["Tobillo", result.ankleAngle,"#3b82f6"],
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

      {/* Legend */}
      {videoUrl && (
        <div className="rounded-xl border border-border/40 bg-card/50 p-4">
          <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-3">Leyenda</p>
          <div className="flex flex-wrap gap-3 text-xs">
            {[
              ["#22c55e","Cabeza"],
              ["#eab308","Tronco / Caderas"],
              ["#ef4444","Brazos"],
              ["#3b82f6","Piernas / Pies"],
              ["#00ffcc","Zona de tracking (pies)"],
              ["#a855f7","Cono morado"],
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
