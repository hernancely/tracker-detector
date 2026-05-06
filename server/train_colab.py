"""
train_colab.py — Fine-tune YOLOv8-nano on the sprint cone dataset.

Run this on Google Colab (free T4 GPU):
  1. Upload your dataset/ folder to Colab (or mount Google Drive)
  2. Copy this file to Colab
  3. Run: python train_colab.py --data /path/to/dataset/dataset.yaml

After training, download runs/detect/cone_model/weights/best.pt
and copy it to  Dashboard/server/cone_model.pt
"""

import argparse
import subprocess
import sys
from pathlib import Path


def install():
    subprocess.check_call([sys.executable, "-m", "pip", "install", "-q", "ultralytics"])


def train(data_yaml: str, epochs: int, imgsz: int, batch: int, device: str):
    from ultralytics import YOLO

    model = YOLO("yolov8n.pt")   # nano — fast, small, enough for simple cone detection

    results = model.train(
        data       = data_yaml,
        epochs     = epochs,
        imgsz      = imgsz,
        batch      = batch,
        device     = device,
        project    = "runs/detect",
        name       = "cone_model",
        exist_ok   = True,
        patience   = 15,           # early stop if no improvement for 15 epochs
        cache      = True,
        workers    = 2,
        # Augmentation — helps with varied lighting and cone sizes
        hsv_h      = 0.02,
        hsv_s      = 0.5,
        hsv_v      = 0.4,
        flipud     = 0.0,          # cones are always right-side up
        fliplr     = 0.5,
        scale      = 0.5,
        translate  = 0.1,
        mosaic     = 0.5,
    )

    best = Path("runs/detect/cone_model/weights/best.pt")
    if best.exists():
        print(f"\n✅ Training complete!")
        print(f"   Best model  : {best}")
        print(f"   mAP50       : {results.results_dict.get('metrics/mAP50(B)', 'n/a'):.3f}")
        print(f"\nDownload {best} and copy to  Dashboard/server/cone_model.pt")
    else:
        print("Training finished but best.pt not found — check runs/detect/cone_model/weights/")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--data",   required=True,         help="Path to dataset.yaml")
    parser.add_argument("--epochs", type=int, default=60,  help="Training epochs (default: 60)")
    parser.add_argument("--imgsz",  type=int, default=640, help="Image size (default: 640)")
    parser.add_argument("--batch",  type=int, default=16,  help="Batch size (default: 16)")
    parser.add_argument("--device", default="0",           help="Device: 0=GPU, cpu (default: 0)")
    args = parser.parse_args()

    print("Installing ultralytics...")
    install()
    print(f"Training YOLOv8-nano on {args.data}  ({args.epochs} epochs)...\n")
    train(args.data, args.epochs, args.imgsz, args.batch, args.device)


if __name__ == "__main__":
    main()
