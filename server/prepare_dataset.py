"""
prepare_dataset.py — Auto-annotate sprint cone images for YOLOv8 training.

Usage:
    python prepare_dataset.py video1.mp4 video2.mp4 [--fps 2] [--out dataset]

Requires:
    pip install anthropic opencv-python

Steps it performs:
  1. Extract frames from each video at --fps rate
  2. Call Claude Vision to detect cone bounding boxes in each frame
  3. Save images + YOLO label files
  4. Split 80/20 train/val
  5. Write dataset.yaml ready for ultralytics training
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import random
import shutil
import sys
import time
from pathlib import Path

import cv2


SYSTEM_PROMPT = """\
You are annotating images for training a YOLO cone detection model.

The cones are FLAT DISC-SHAPED objects (about 20-40 cm diameter) placed on the ground
for sprint timing. They look like flat circular discs — NOT tall traffic cones.
Colors: white, yellow, orange, or other solid colors.

For EVERY cone clearly visible return its bounding box.
Rules:
- Coordinates normalized: x1/y1 = top-left corner, x2/y2 = bottom-right corner, all in [0,1]
- Include partially visible cones at frame edges if at least 30% is visible
- DO NOT include: field lines, player shoes/clothing, shadows, measuring tape
- Be precise — tight boxes, no excess background

Return ONLY valid JSON, no markdown:
{"cones": [{"x1": 0.45, "y1": 0.72, "x2": 0.52, "y2": 0.78}]}

If no cones are visible: {"cones": []}
"""


def extract_frames(video_path: str, fps: float, out_dir: Path) -> list[Path]:
    cap = cv2.VideoCapture(video_path)
    if not cap.isOpened():
        raise RuntimeError(f"Cannot open video: {video_path}")

    src_fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    interval = max(1, round(src_fps / fps))
    total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    out_dir.mkdir(parents=True, exist_ok=True)

    saved: list[Path] = []
    f = 0
    print(f"  Extracting from {Path(video_path).name}  ({total} frames @ {src_fps:.0f}fps → every {interval} frames)")
    while True:
        ok, frame = cap.read()
        if not ok:
            break
        if f % interval == 0:
            stem = f"{Path(video_path).stem}_f{f:05d}"
            dest = out_dir / f"{stem}.jpg"
            cv2.imwrite(str(dest), frame, [cv2.IMWRITE_JPEG_QUALITY, 88])
            saved.append(dest)
        f += 1
    cap.release()
    print(f"  → {len(saved)} frames saved")
    return saved


def annotate_frame(img_path: Path, client) -> list[dict]:
    """Call Claude Vision and return list of {x1,y1,x2,y2} normalized boxes."""
    with open(img_path, "rb") as fh:
        b64 = base64.b64encode(fh.read()).decode()

    for attempt in range(3):
        try:
            resp = client.messages.create(
                model="claude-opus-4-7",
                max_tokens=512,
                system=SYSTEM_PROMPT,
                messages=[{
                    "role": "user",
                    "content": [
                        {
                            "type": "image",
                            "source": {"type": "base64", "media_type": "image/jpeg", "data": b64},
                        },
                        {"type": "text", "text": "Detect all flat disc cones. Return JSON only."},
                    ],
                }],
            )
            text = next((b.text for b in resp.content if b.type == "text"), "").strip()
            # Strip markdown fences if present
            if text.startswith("```"):
                text = text.split("\n", 1)[1] if "\n" in text else text[3:]
                text = text.rsplit("```", 1)[0]
            data = json.loads(text)
            return data.get("cones", [])
        except json.JSONDecodeError as e:
            print(f"    JSON parse error (attempt {attempt+1}): {e}")
            time.sleep(1)
        except Exception as e:
            print(f"    API error (attempt {attempt+1}): {e}")
            time.sleep(2)
    return []


def boxes_to_yolo(boxes: list[dict], img_w: int, img_h: int) -> list[str]:
    """Convert [{x1,y1,x2,y2}] to YOLO format lines (class cx cy w h)."""
    lines = []
    for b in boxes:
        x1, y1, x2, y2 = b["x1"], b["y1"], b["x2"], b["y2"]
        # Clamp to [0,1]
        x1, y1 = max(0.0, x1), max(0.0, y1)
        x2, y2 = min(1.0, x2), min(1.0, y2)
        if x2 <= x1 or y2 <= y1:
            continue
        cx = (x1 + x2) / 2
        cy = (y1 + y2) / 2
        w  = x2 - x1
        h  = y2 - y1
        lines.append(f"0 {cx:.6f} {cy:.6f} {w:.6f} {h:.6f}")
    return lines


def main():
    parser = argparse.ArgumentParser(description="Auto-annotate sprint cone dataset")
    parser.add_argument("videos", nargs="+", help="Video files to process")
    parser.add_argument("--fps",  type=float, default=2.0,  help="Frames per second to extract (default: 2)")
    parser.add_argument("--out",  default="dataset",        help="Output directory (default: dataset)")
    parser.add_argument("--skip-annotated", action="store_true",
                        help="Skip frames that already have a .txt label file")
    args = parser.parse_args()

    try:
        import anthropic
    except ImportError:
        sys.exit("anthropic not installed — run: pip install anthropic")

    api_key = os.environ.get("ANTHROPIC_API_KEY")
    if not api_key:
        sys.exit("ANTHROPIC_API_KEY env var not set")

    client = anthropic.Anthropic(api_key=api_key)
    out_root = Path(args.out)

    # ── 1. Extract frames ──────────────────────────────────────────────────────
    raw_dir = out_root / "raw"
    all_frames: list[Path] = []
    for video in args.videos:
        all_frames.extend(extract_frames(video, args.fps, raw_dir))

    print(f"\nTotal frames: {len(all_frames)}")

    # ── 2. Annotate ────────────────────────────────────────────────────────────
    print("\nAnnotating with Claude Vision...")
    annotated: list[tuple[Path, list[str]]] = []
    skipped = 0

    for i, img_path in enumerate(all_frames):
        lbl_path = img_path.with_suffix(".txt")

        if args.skip_annotated and lbl_path.exists():
            lines = lbl_path.read_text().strip().splitlines()
            annotated.append((img_path, lines))
            skipped += 1
            continue

        print(f"  [{i+1}/{len(all_frames)}] {img_path.name}", end=" ... ", flush=True)

        img = cv2.imread(str(img_path))
        H, W = img.shape[:2] if img is not None else (720, 1280)

        boxes = annotate_frame(img_path, client)
        lines = boxes_to_yolo(boxes, W, H)

        # Save label alongside image for review
        lbl_path.write_text("\n".join(lines))

        status = f"{len(boxes)} cone(s)" if boxes else "no cones"
        print(status)
        annotated.append((img_path, lines))

        time.sleep(0.3)  # gentle rate limiting

    if skipped:
        print(f"  (skipped {skipped} already-annotated frames)")

    # Keep only frames with at least one cone annotation
    with_cones = [(p, l) for p, l in annotated if l]
    empty = len(annotated) - len(with_cones)
    print(f"\nFrames with cones: {len(with_cones)}  |  Empty (no cones): {empty}")

    if len(with_cones) < 10:
        print("WARNING: fewer than 10 annotated frames — consider adding more videos or lowering --fps")

    # ── 3. Train / val split ───────────────────────────────────────────────────
    random.seed(42)
    random.shuffle(with_cones)
    split = max(1, int(len(with_cones) * 0.8))
    train_set = with_cones[:split]
    val_set   = with_cones[split:]

    for subset, items in [("train", train_set), ("val", val_set)]:
        img_dir = out_root / "images" / subset
        lbl_dir = out_root / "labels" / subset
        img_dir.mkdir(parents=True, exist_ok=True)
        lbl_dir.mkdir(parents=True, exist_ok=True)

        for img_path, lines in items:
            shutil.copy(img_path, img_dir / img_path.name)
            (lbl_dir / img_path.with_suffix(".txt").name).write_text("\n".join(lines))

    # ── 4. dataset.yaml ───────────────────────────────────────────────────────
    yaml_path = out_root / "dataset.yaml"
    abs_out = str(out_root.resolve())
    yaml_path.write_text(
        f"path: {abs_out}\n"
        f"train: images/train\n"
        f"val:   images/val\n"
        f"\nnc: 1\n"
        f"names: ['cone']\n"
    )

    print(f"\n✅ Dataset ready:")
    print(f"   Train : {len(train_set)} images")
    print(f"   Val   : {len(val_set)} images")
    print(f"   YAML  : {yaml_path}")
    print(f"\nNext step — train on Google Colab:")
    print(f"   See server/train_colab.py  (copy to Colab and run)")


if __name__ == "__main__":
    main()
