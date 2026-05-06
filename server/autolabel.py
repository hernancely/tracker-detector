"""
autolabel.py — Auto-annotate cone frames using HSV detection (OpenCV).

Ports the same HSV logic from VideoAnalyzer.tsx to Python so the
same algorithm that runs in the browser generates YOLO label files.

Usage:
    python autolabel.py [--raw dataset/raw] [--out dataset] [--review]

Output structure (ready for YOLOv8 training):
    dataset/
      images/train/   images/val/
      labels/train/   labels/val/
      dataset.yaml
"""

from __future__ import annotations

import argparse
import random
import shutil
from pathlib import Path

import cv2
import numpy as np


# ── Cone color ranges (HSV in OpenCV: H 0-180, S 0-255, V 0-255) ─────────────
# Each entry: (name, h_lo, h_hi, s_lo, s_hi, v_lo, v_hi)
CONE_COLORS = [
    ("naranja",   5,  20, 150, 255, 120, 255),
    ("amarillo", 20,  35, 140, 255, 140, 255),
    ("blanco",    0, 180,   0,  35, 210, 255),
    ("rosa",    155, 180, 120, 255, 110, 255),
]

MIN_AREA_PX   = 30     # minimum blob area in pixels (at 1280x720)
MAX_AREA_PX   = 700    # maximum blob area — disc cones are small
MAX_ASPECT    = 2.8    # width/height ratio — disc cones are roughly square
MIN_CIRCULARITY = 0.30 # 4π·area/perimeter² — filters elongated blobs
LOWER_FRAC    = 0.50   # only look below this fraction of frame height


def hsv_mask(hsv: np.ndarray, h_lo, h_hi, s_lo, s_hi, v_lo, v_hi) -> np.ndarray:
    lo = np.array([h_lo, s_lo, v_lo], dtype=np.uint8)
    hi = np.array([h_hi, s_hi, v_hi], dtype=np.uint8)
    if h_lo <= h_hi:
        return cv2.inRange(hsv, lo, hi)
    # Wrap-around hue (e.g. red/pink spanning 170-180 + 0-10)
    lo2 = np.array([0,       s_lo, v_lo], dtype=np.uint8)
    hi2 = np.array([h_hi,    s_hi, v_hi], dtype=np.uint8)
    lo3 = np.array([h_lo,    s_lo, v_lo], dtype=np.uint8)
    hi3 = np.array([180,     s_hi, v_hi], dtype=np.uint8)
    return cv2.bitwise_or(cv2.inRange(hsv, lo2, hi2), cv2.inRange(hsv, lo3, hi3))


def detect_cones(img: np.ndarray) -> list[tuple[float, float, float, float]]:
    """Return list of (cx, cy, w, h) normalized YOLO boxes."""
    H, W = img.shape[:2]
    zone_y = int(H * LOWER_FRAC)

    # Only scan below knee zone
    roi = img[zone_y:, :]
    hsv = cv2.cvtColor(roi, cv2.COLOR_BGR2HSV)

    combined = np.zeros(hsv.shape[:2], dtype=np.uint8)
    for _, h_lo, h_hi, s_lo, s_hi, v_lo, v_hi in CONE_COLORS:
        combined = cv2.bitwise_or(combined, hsv_mask(hsv, h_lo, h_hi, s_lo, s_hi, v_lo, v_hi))

    # Morphological cleanup
    k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3))
    combined = cv2.morphologyEx(combined, cv2.MORPH_OPEN,  k, iterations=1)
    combined = cv2.morphologyEx(combined, cv2.MORPH_CLOSE, k, iterations=2)

    contours, _ = cv2.findContours(combined, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)

    boxes: list[tuple[float, float, float, float]] = []
    for cnt in contours:
        area = cv2.contourArea(cnt)
        if area < MIN_AREA_PX or area > MAX_AREA_PX:
            continue
        x, y, w, h = cv2.boundingRect(cnt)
        if w == 0 or h == 0:
            continue
        aspect = max(w, h) / min(w, h)
        if aspect > MAX_ASPECT:
            continue
        # Circularity: rejects elongated blobs (ropes, lines, clothing stripes)
        perimeter = cv2.arcLength(cnt, True)
        circularity = (4 * np.pi * area / (perimeter ** 2)) if perimeter > 0 else 0
        if circularity < MIN_CIRCULARITY:
            continue

        # Pad bounding box slightly
        pad = 4
        x = max(0, x - pad);  y = max(0, y - pad)
        w = min(W, w + pad * 2); h = min(H - zone_y, h + pad * 2)

        # Convert back to full-image coords, then normalize
        abs_y = y + zone_y
        cx = (x + w / 2) / W
        cy = (abs_y + h / 2) / H
        nw = w / W
        nh = h / H
        boxes.append((cx, cy, nw, nh))

    # Suppress duplicate/overlapping boxes (IoU > 0.4)
    boxes = _nms(boxes)
    return boxes


def _iou(a: tuple, b: tuple) -> float:
    ax1, ay1 = a[0] - a[2]/2, a[1] - a[3]/2
    ax2, ay2 = a[0] + a[2]/2, a[1] + a[3]/2
    bx1, by1 = b[0] - b[2]/2, b[1] - b[3]/2
    bx2, by2 = b[0] + b[2]/2, b[1] + b[3]/2
    ix = max(0, min(ax2, bx2) - max(ax1, bx1))
    iy = max(0, min(ay2, by2) - max(ay1, by1))
    inter = ix * iy
    union = a[2]*a[3] + b[2]*b[3] - inter
    return inter / union if union > 0 else 0.0


def _nms(boxes: list, thresh=0.4) -> list:
    keep = []
    for b in boxes:
        if not any(_iou(b, k) > thresh for k in keep):
            keep.append(b)
    return keep


def annotate_dir(raw_dir: Path, out_dir: Path, val_frac=0.2, seed=42):
    imgs = sorted(raw_dir.glob("*.jpg"))
    if not imgs:
        print(f"No .jpg files in {raw_dir}")
        return

    results: list[tuple[Path, list]] = []
    has_cone = 0

    for img_path in imgs:
        img = cv2.imread(str(img_path))
        if img is None:
            continue
        boxes = detect_cones(img)
        results.append((img_path, boxes))
        if boxes:
            has_cone += 1

    print(f"Processed {len(results)} images  |  {has_cone} with cones  |  {len(results)-has_cone} empty")

    # Keep empty frames too (teach model background)
    # but limit them so they don't dominate
    with_cones = [(p, b) for p, b in results if b]
    empty      = [(p, b) for p, b in results if not b]
    # Keep at most 30% empty frames
    max_empty  = max(10, int(len(with_cones) * 0.3))
    random.seed(seed)
    empty = random.sample(empty, min(len(empty), max_empty))
    all_items = with_cones + empty
    random.shuffle(all_items)

    split = max(1, int(len(all_items) * (1 - val_frac)))
    splits = [("train", all_items[:split]), ("val", all_items[split:])]

    for subset, items in splits:
        img_d = out_dir / "images" / subset
        lbl_d = out_dir / "labels" / subset
        img_d.mkdir(parents=True, exist_ok=True)
        lbl_d.mkdir(parents=True, exist_ok=True)

        for img_path, boxes in items:
            shutil.copy(img_path, img_d / img_path.name)
            lines = [f"0 {cx:.6f} {cy:.6f} {w:.6f} {h:.6f}" for cx, cy, w, h in boxes]
            (lbl_d / img_path.with_suffix(".txt").name).write_text("\n".join(lines))

    print(f"Train: {split}  |  Val: {len(all_items)-split}")

    yaml = out_dir / "dataset.yaml"
    yaml.write_text(
        f"path: {out_dir.resolve()}\n"
        f"train: images/train\n"
        f"val:   images/val\n"
        f"\nnc: 1\n"
        f"names: ['cone']\n"
    )
    print(f"dataset.yaml -> {yaml}")


def preview(raw_dir: Path, n=12):
    """Save n annotated preview images to raw_dir/preview/ for visual QC."""
    imgs = sorted(raw_dir.glob("*.jpg"))[:n]
    prev_dir = raw_dir / "preview"
    prev_dir.mkdir(exist_ok=True)
    for img_path in imgs:
        img = cv2.imread(str(img_path))
        if img is None:
            continue
        H, W = img.shape[:2]
        boxes = detect_cones(img)
        # Draw zone line
        cv2.line(img, (0, int(H*LOWER_FRAC)), (W, int(H*LOWER_FRAC)), (0,255,255), 2)
        for cx, cy, bw, bh in boxes:
            x1 = int((cx - bw/2) * W); y1 = int((cy - bh/2) * H)
            x2 = int((cx + bw/2) * W); y2 = int((cy + bh/2) * H)
            cv2.rectangle(img, (x1,y1), (x2,y2), (0,255,0), 2)
        cv2.imwrite(str(prev_dir / img_path.name), img)
    print(f"Preview images saved to {prev_dir}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--raw",     default="dataset/raw",  help="Directory with extracted frames")
    ap.add_argument("--out",     default="dataset",      help="Output dataset directory")
    ap.add_argument("--preview", action="store_true",    help="Save preview images for QC")
    args = ap.parse_args()

    raw_dir = Path(args.raw)
    out_dir = Path(args.out)

    if args.preview:
        preview(raw_dir)
    else:
        annotate_dir(raw_dir, out_dir)


if __name__ == "__main__":
    main()
