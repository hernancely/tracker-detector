"""
SprintLab Pose Detection Server

Engines (all are initialized at startup if available):
  - openpose  : pyopenpose (manual build, optional)
  - mediapipe : pip install mediapipe  (fallback, auto-downloads model)

The client can request a specific engine via the `engine` field in /detect.
If not specified, the first available engine is used.

Run:
  cd server
  pip install -r requirements.txt
  python main.py
"""

from __future__ import annotations

import base64
import json
import logging
import os
import urllib.request
from typing import Any, Dict, List, Optional

import cv2
import numpy as np
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
import uvicorn

logging.basicConfig(level=logging.INFO, format="%(levelname)s  %(message)s")
logger = logging.getLogger(__name__)

# ── Model paths ────────────────────────────────────────────────────────────────
_DIR = os.path.dirname(os.path.abspath(__file__))

_MODEL_URL  = (
    "https://storage.googleapis.com/mediapipe-models/"
    "pose_landmarker/pose_landmarker_full/float16/1/pose_landmarker_full.task"
)
_MODEL_PATH = os.path.join(_DIR, "pose_landmarker_full.task")


def _download_model_if_needed() -> None:
    if os.path.exists(_MODEL_PATH):
        return
    logger.info("Downloading MediaPipe pose model (~5 MB)...")
    urllib.request.urlretrieve(_MODEL_URL, _MODEL_PATH)
    logger.info("Model downloaded.")


# ── Engine registry ────────────────────────────────────────────────────────────
# All successfully initialized engines are stored here.
# Key → engine name, Value → opaque handle used by the detect functions.
_engines: Dict[str, Any] = {}
_default_engine: str = "none"


def _init_openpose() -> bool:
    try:
        import pyopenpose as op  # type: ignore

        params = {
            "model_folder": os.path.join(_DIR, "models"),
            "face": False,
            "hand": False,
            "net_resolution": "-1x368",
            "number_people_max": 1,
        }
        wrapper = op.WrapperPython()
        wrapper.configure(params)
        wrapper.start()
        _engines["openpose"] = wrapper
        logger.info("✅ OpenPose initialized")
        return True
    except Exception as exc:
        logger.warning(f"OpenPose not available → {exc}")
        return False


def _init_mediapipe() -> bool:
    try:
        import mediapipe as mp
        from mediapipe.tasks.python         import vision as mp_vision
        from mediapipe.tasks.python.vision  import PoseLandmarker, PoseLandmarkerOptions, RunningMode

        _download_model_if_needed()

        base_opts = mp.tasks.BaseOptions(model_asset_path=_MODEL_PATH)
        opts = PoseLandmarkerOptions(
            base_options=base_opts,
            running_mode=RunningMode.IMAGE,
            num_poses=2,
            min_pose_detection_confidence=0.1,
            min_pose_presence_confidence=0.1,
            min_tracking_confidence=0.1,
        )
        _engines["mediapipe"] = PoseLandmarker.create_from_options(opts)
        logger.info("✅ MediaPipe PoseLandmarker (FULL model) initialized")
        return True
    except Exception as exc:
        logger.error(f"MediaPipe not available → {exc}")
        return False


# Initialize ALL available engines
_init_openpose()
_init_mediapipe()
_default_engine = next(iter(_engines), "none")
logger.info(f"Default engine: {_default_engine}  |  Available: {list(_engines.keys())}")

# ── YOLO Cone Detection ────────────────────────────────────────────────────────
_yolo_model = None

def _init_yolo() -> bool:
    global _yolo_model
    model_path = os.path.join(_DIR, "cone_model.pt")
    if not os.path.exists(model_path):
        logger.info("cone_model.pt not found — place your trained model at server/cone_model.pt to enable YOLO cone detection")
        return False
    try:
        from ultralytics import YOLO  # type: ignore
        _yolo_model = YOLO(model_path)
        logger.info("✅ YOLO cone model loaded from cone_model.pt")
        return True
    except ImportError:
        logger.warning("ultralytics not installed — run: pip install ultralytics")
        return False
    except Exception as exc:
        logger.warning(f"YOLO model load failed → {exc}")
        return False

_init_yolo()

# ── FastAPI app ────────────────────────────────────────────────────────────────
app = FastAPI(title="SprintLab Pose Server", version="3.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── OpenPose BODY_25 → MediaPipe 33 mapping ────────────────────────────────────
_OP_TO_MP: dict[int, int] = {
    0:  0,   # Nose
    16: 1,   # LEye
    15: 4,   # REye
    18: 7,   # LEar
    17: 8,   # REar
    5:  11,  # LShoulder
    2:  12,  # RShoulder
    6:  13,  # LElbow
    3:  14,  # RElbow
    7:  15,  # LWrist
    4:  16,  # RWrist
    12: 23,  # LHip
    9:  24,  # RHip
    13: 25,  # LKnee
    10: 26,  # RKnee
    14: 27,  # LAnkle
    11: 28,  # RAnkle
    19: 31,  # LBigToe
    22: 32,  # RBigToe
}

# ── Pydantic models ────────────────────────────────────────────────────────────
class LandmarkItem(BaseModel):
    x: float
    y: float
    z: float = 0.0
    visibility: float = 1.0

class DetectRequest(BaseModel):
    image: str                   # base64-encoded JPEG
    engine: Optional[str] = None # if None, uses default engine

class DetectResponse(BaseModel):
    landmarks: List[LandmarkItem]
    engine: str

# ── Decode helper ──────────────────────────────────────────────────────────────
def _decode_image(b64: str) -> np.ndarray:
    data = base64.b64decode(b64)
    arr  = np.frombuffer(data, np.uint8)
    img  = cv2.imdecode(arr, cv2.IMREAD_COLOR)
    if img is None:
        raise ValueError("Could not decode image")
    return img

# ── Per-engine detection ───────────────────────────────────────────────────────
def _run_openpose(img: np.ndarray, wrapper: Any) -> List[LandmarkItem]:
    import pyopenpose as op  # type: ignore

    H, W = img.shape[:2]
    datum = op.Datum()
    datum.cvInputData = img
    wrapper.emplaceAndPop(op.VectorDatum([datum]))
    kps = datum.poseKeypoints
    if kps is None or len(kps) == 0:
        return []

    result: List[LandmarkItem] = [LandmarkItem(x=0.0, y=0.0, visibility=0.0) for _ in range(33)]
    for op_i, mp_i in _OP_TO_MP.items():
        if op_i < len(kps[0]):
            x, y, score = float(kps[0][op_i][0]), float(kps[0][op_i][1]), float(kps[0][op_i][2])
            if score > 0.05:
                result[mp_i] = LandmarkItem(x=x / W, y=y / H, z=0.0, visibility=score)
    return result


def _run_mediapipe(img: np.ndarray, landmarker: Any) -> List[LandmarkItem]:
    import mediapipe as mp

    rgb      = cv2.cvtColor(img, cv2.COLOR_BGR2RGB)
    mp_image = mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb)
    result   = landmarker.detect(mp_image)

    if not result.pose_landmarks:
        return []
    return [
        LandmarkItem(x=lm.x, y=lm.y, z=lm.z, visibility=lm.visibility)
        for lm in result.pose_landmarks[0]
    ]

# ── Endpoints ──────────────────────────────────────────────────────────────────
@app.get("/health")
def health():
    return {
        "status": "ok",
        "engine":    _default_engine,
        "available": list(_engines.keys()),
        "yolo_cones": _yolo_model is not None,
    }


# ── YOLO cone detection models ─────────────────────────────────────────────────
class ConeDetectRequest(BaseModel):
    image: str        # base64 JPEG
    conf: float = 0.35

class ConeDetection(BaseModel):
    x: float    # center X normalized [0,1]
    y: float    # center Y normalized [0,1]
    w: float    # width normalized [0,1]
    h: float    # height normalized [0,1]
    conf: float
    label: str

class ConeDetectResponse(BaseModel):
    cones:     List[ConeDetection]
    available: bool


@app.post("/detect-cones", response_model=ConeDetectResponse)
def detect_cones(req: ConeDetectRequest):
    """YOLO cone detection. Returns empty list with available=False if model not loaded."""
    if _yolo_model is None:
        return ConeDetectResponse(cones=[], available=False)
    try:
        img = _decode_image(req.image)
        H, W = img.shape[:2]
        results = _yolo_model.predict(img, conf=req.conf, verbose=False)[0]
        cones = []
        for box in results.boxes:
            x1, y1, x2, y2 = box.xyxy[0].tolist()
            cx   = (x1 + x2) / 2 / W
            cy   = (y1 + y2) / 2 / H
            bw   = (x2 - x1) / W
            bh   = (y2 - y1) / H
            conf = float(box.conf[0])
            label = results.names[int(box.cls[0])]
            cones.append(ConeDetection(x=cx, y=cy, w=bw, h=bh, conf=conf, label=label))
        return ConeDetectResponse(cones=cones, available=True)
    except Exception as exc:
        logger.error(f"YOLO detection error: {exc}")
        return ConeDetectResponse(cones=[], available=False)

@app.get("/engines")
def get_engines():
    return {
        "available": list(_engines.keys()),
        "default":   _default_engine,
    }

@app.post("/detect", response_model=DetectResponse)
def detect(req: DetectRequest):
    # Choose engine
    engine_name = req.engine if req.engine and req.engine in _engines else _default_engine
    if engine_name == "none" or engine_name not in _engines:
        raise HTTPException(503, detail="No pose detection engine available")

    try:
        img = _decode_image(req.image)
    except Exception:
        raise HTTPException(400, detail="Invalid image data")

    try:
        handle = _engines[engine_name]
        if engine_name == "openpose":
            lms = _run_openpose(img, handle)
        else:
            lms = _run_mediapipe(img, handle)
    except Exception as exc:
        logger.error(f"Detection error ({engine_name}): {exc}")
        lms = []

    return DetectResponse(landmarks=lms, engine=engine_name)


# ── LLM Cone Calibration ───────────────────────────────────────────────────────

_CALIB_SYSTEM = """\
You are a sports video analyst for a sprint timing system.

CONTEXT: A player runs from right to left on a grass field. Sprint cones (flat white
discs, ~20-40 cm diameter) are placed on the ground. As the player advances, cones
enter the frame one by one from the right. The player may be partially visible.

WHAT TO FIND — white/light flat discs on the GRASS:
- Small circular objects lying flat on the ground
- Usually in the lower third of the frame (ground level)
- IGNORE: field lines (thin/long), player clothing/shoes, sky, fences, shadows

REPORT only cones that are CLEARLY VISIBLE in this frame.

RESPOND with ONLY valid JSON (no markdown, no explanation):
{
  "cones_found": true,
  "cone_x_normalized": [0.75, 0.42],
  "confidence": 0.9
}

Rules:
- cone_x_normalized: X positions normalized [0=left, 1=right], sorted right-to-left
- Only include cones you can clearly see — do not guess occluded ones
- confidence: 0.0-1.0
- If none visible: cones_found=false, cone_x_normalized=[]
"""


def _cluster_1d(points: list, merge_dist: float) -> list:
    if not points:
        return []
    pts = sorted(points, reverse=True)
    clusters: list = [[pts[0]]]
    for p in pts[1:]:
        mean = sum(clusters[-1]) / len(clusters[-1])
        if abs(p - mean) <= merge_dist:
            clusters[-1].append(p)
        else:
            clusters.append([p])
    return [sum(c) / len(c) for c in clusters]


class CalibrateRequest(BaseModel):
    frames: List[str]   # base64 JPEG images, max 15


class CalibrateResponse(BaseModel):
    cones:           List[float]       # normalized X [0,1], right-to-left
    confidence:      float
    frames_analyzed: int
    error:           Optional[str] = None


@app.post("/calibrate-cones", response_model=CalibrateResponse)
def calibrate_cones(req: CalibrateRequest):
    """Use Claude Vision to detect stable cone positions from calibration frames."""
    try:
        import anthropic as ant  # type: ignore
    except ImportError:
        raise HTTPException(503, detail="anthropic package not installed — run: pip install anthropic")

    if not req.frames:
        raise HTTPException(400, detail="No frames provided")

    client = ant.Anthropic()   # reads ANTHROPIC_API_KEY from env
    raw_xs: List[float] = []
    analyzed = 0

    for b64 in req.frames[:15]:
        try:
            response = client.messages.create(
                model="claude-opus-4-7",
                max_tokens=256,
                system=[{
                    "type": "text",
                    "text": _CALIB_SYSTEM,
                    "cache_control": {"type": "ephemeral"},
                }],
                messages=[{
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
                        {"type": "text", "text": "Find white cones/discs on the grass. Return JSON only."},
                    ],
                }],
            )
            text = next((b.text for b in response.content if b.type == "text"), "").strip()
            # Strip markdown fences if model adds them
            if text.startswith("```"):
                text = text.split("\n", 1)[1] if "\n" in text else text[3:]
                text = text.rsplit("```", 1)[0]
            data = json.loads(text)
            if data.get("cones_found") and data.get("cone_x_normalized"):
                conf = float(data.get("confidence", 1.0))
                if conf >= 0.4:
                    raw_xs.extend(data["cone_x_normalized"])
            analyzed += 1
        except Exception as exc:
            logger.warning(f"LLM frame analysis failed: {exc}")

    if not raw_xs:
        return CalibrateResponse(
            cones=[], confidence=0.0, frames_analyzed=analyzed,
            error="No cones detected in any frame"
        )

    clusters = _cluster_1d(raw_xs, 0.05)
    min_count = max(2, analyzed // 4)
    stable = [
        cx for cx in clusters
        if sum(1 for x in raw_xs if abs(x - cx) <= 0.05) >= min_count
    ]
    stable.sort(reverse=True)

    logger.info(f"Cone calibration: {len(stable)} stable cones from {analyzed} frames")
    return CalibrateResponse(
        cones=stable,
        confidence=0.85 if stable else 0.0,
        frames_analyzed=analyzed,
    )


if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8000, log_level="info")
