from fastapi import FastAPI, HTTPException, Request
from ultralytics import YOLO
import cv2
import numpy as np
import time
import logging
import sys
import traceback

logging.basicConfig(level=logging.INFO, stream=sys.stdout, force=True)
logger = logging.getLogger(__name__)

app = FastAPI(title="FogVision Inference", version="1.0.0")

model = YOLO('yolov8n.pt')

# Common indoor, office, and surveillance objects
TARGET_CLASS_NAMES = {
    'person', 'bicycle', 'car', 'motorcycle', 'bus', 'truck',
    'backpack', 'umbrella', 'handbag', 'suitcase', 'bottle', 'cup',
    'chair', 'couch', 'potted plant', 'bed', 'dining table', 'tv',
    'laptop', 'mouse', 'remote', 'keyboard', 'cell phone', 'book',
    'clock', 'vase', 'scissors', 'teddy bear', 'toothbrush'
}

TARGET_CLASS_INDICES = [i for i, name in model.names.items() if name in TARGET_CLASS_NAMES]

# Production per-class confidence thresholds:
# 'person' requires >= 0.68 to reject bunched blankets, coats, and pillows
CLASS_THRESHOLDS = {
    'person': 0.68,
    'chair': 0.50,
    'bed': 0.50,
    'couch': 0.50,
    'cell phone': 0.45,
    'laptop': 0.45,
    'bottle': 0.45,
    'cup': 0.45
}
DEFAULT_CONF_THRESHOLD = 0.50

@app.get("/health")
async def health():
    return {
        "status": "ok",
        "model": "yolov8n",
        "classes": len(model.names),
        "target_classes": list(TARGET_CLASS_NAMES),
        "class_thresholds": CLASS_THRESHOLDS,
        "default_conf_threshold": DEFAULT_CONF_THRESHOLD
    }

async def process_image(contents: bytes, camera_id: str, conf_threshold: float = DEFAULT_CONF_THRESHOLD):
    """Process image bytes and return YOLO detections"""
    start = time.time()

    if not contents or len(contents) < 100:
        raise HTTPException(status_code=400, detail="Empty or truncated frame")

    nparr = np.frombuffer(contents, np.uint8)
    frame = cv2.imdecode(nparr, cv2.IMREAD_COLOR)

    if frame is None:
        logger.error(f"[{camera_id}] cv2.imdecode returned None for buffer size {len(contents)}")
        raise HTTPException(status_code=400, detail="Invalid image data")

    # Run inference with target class filter
    results = model(frame, verbose=False, classes=TARGET_CLASS_INDICES)[0]

    detections = []
    counts = {}

    for box in results.boxes:
        conf = float(box.conf[0])
        cls_id = int(box.cls[0])
        name = model.names[cls_id]

        # Use strict threshold for person (0.68) to reject folded blankets/clothes
        effective_thresh = max(conf_threshold, CLASS_THRESHOLDS.get(name, DEFAULT_CONF_THRESHOLD))
        if conf < effective_thresh:
            continue

        x1, y1, x2, y2 = map(int, box.xyxy[0])

        detections.append({
            "class": name,
            "confidence": round(conf, 2),
            "bbox": [x1, y1, x2 - x1, y2 - y1]
        })

        counts[name] = counts.get(name, 0) + 1

    inference_ms = int((time.time() - start) * 1000)

    return {
        "camera": camera_id,
        "timestamp": int(time.time() * 1000),
        "inference_ms": inference_ms,
        "conf_threshold": conf_threshold,
        "detections": detections,
        "counts": counts
    }

@app.post("/infer")
async def infer(request: Request):
    """Accept raw JPEG in request body"""
    camera_id = request.headers.get("X-Camera-ID", "cam-real")
    conf_header = request.headers.get("X-Conf-Threshold")
    try:
        conf_threshold = float(conf_header) if conf_header else DEFAULT_CONF_THRESHOLD
    except ValueError:
        conf_threshold = DEFAULT_CONF_THRESHOLD

    try:
        contents = await request.body()
        return await process_image(contents, camera_id, conf_threshold)
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"[{camera_id}] Inference error: {e}")
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=3000)
