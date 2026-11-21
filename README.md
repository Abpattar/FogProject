# FogVision — Distributed Edge-Fog-Cloud Surveillance System

> **A real-time, distributed Fog Computing surveillance and object detection system.**  
> Real Camera (`/dev/video0`) → Local MJPEG Streaming + Local YOLOv8 AI Inference → MQTT Message Bus → Fog Processing Node → Edge Gateway → Cloud Ingestion API + Real-Time Live Monitoring Dashboard.

---

## 🎯 Executive Summary & Academic Context

**FogVision** is built to demonstrate the foundational concepts of **Fog Computing** in an end-to-end, containerized microservice architecture. 

In conventional cloud-only video surveillance, raw high-bandwidth video streams from numerous cameras are sent directly to centralized cloud data centers. This causes severe network bottlenecks, unpredictable latency (200–500ms), high WAN bandwidth costs, and privacy risks. 

**FogVision solves this by implementing the 3-Tier Edge–Fog–Cloud continuum:**
1. **Edge Tier (IoT / Sensor):** Accesses physical hardware camera frames via FFmpeg (`/dev/video0`), hosting an internal low-latency MJPEG video feed.
2. **Fog Computing Tier (Intermediate Local Compute):**
   - **AI Inference Engine:** Runs localized deep learning (**YOLOv8**) to extract object bounding boxes, confidence scores, and class labels right at the local network boundary.
   - **Fog Processing Node (`fog-1`):** Enriches metadata, calculates transit latency (**2–6 ms**), and performs localized event filtering.
   - **Local Message Bus:** An internal Eclipse Mosquitto MQTT broker routes messages privately without touching the public internet.
3. **Gateway Tier (Edge Aggregator):** Aggregates localized events and dispatches lightweight structured JSON summaries (~200 bytes) upstream to an external Cloud API (`https://api.apinex.bond/v1/events`).
4. **Monitoring Tier (Real-Time Dashboard):** Serves an interactive monitoring console with live webcam video, canvas-drawn bounding boxes, category-specific color-coding, latency breakdown meters, active class counts, and an animated physical network topology with bidirectional start/pause actuation.

---

## 💡 Why Fog Computing? (Core Principles Demonstrated)

| Fog Computing Principle | How FogVision Proves It |
| :--- | :--- |
| **Bandwidth Conservation (Data Reduction)** | Raw video frames (15–30 MB/min) **never leave the local fog boundary**. Only compact JSON event payloads (~200 bytes) traverse the WAN to the cloud, achieving **>99% bandwidth reduction**. |
| **Ultra-Low Latency** | Local fog processing and metadata enrichment complete in **sub-second / single-digit milliseconds** (2–6 ms) vs. hundreds of ms for cloud round-trip times. |
| **Local Autonomy & Fault Tolerance** | If the internet connection or the cloud API drops, the local fog nodes, AI model, and dashboard continue operating and alerting without interruption. |
| **Edge Privacy & Security** | Sensitive raw camera footage of private premises stays strictly on-site; external cloud systems only receive anonymized detection metadata. |
| **Bidirectional Actuation (Control Plane)** | The dashboard can issue top-down control plane commands (`fog/control`) to pause and resume edge inference dynamically. |

---

## 🏗 System Architecture & Topology

```
                   ┌────────────────────────────────────────────────────────┐
                   │               PHYSICAL WEBCAM SENSOR                   │
                   │               Hardware: /dev/video0                    │
                   └───────────────────────────┬────────────────────────────┘
                                               │ (5 FPS @ 640x480 via FFmpeg)
                                               ▼
┌───────────────────────────────────────────────────────────────────────────────────────────────────┐
│                                       LOCAL FOG NETWORK                                           │
│                                                                                                   │
│   ┌────────────────────────────────┐                 ┌────────────────────────────────────────┐   │
│   │     fogvision-camera-real      │ ──(HTTP POST)──►│        fogvision-fog-inference        │   │
│   │   • FFmpeg MJPEG capture       │                 │   • YOLOv8 Deep Learning Model         │   │
│   │   • Local stream server (:8082)│◄──(JSON Dets)───│   • Localized bounding box & conf      │   │
│   └───────────────┬────────────────┘                 └────────────────────────────────────────┘   │
│                   │                                                                               │
│                   │ MQTT: camera/cam-real/detections                                              │
│                   ▼                                                                               │
│   ┌───────────────────────────────────────────────────────────────────────────────────────────┐   │
│   │                            MOSQUITTO MQTT BROKER (Port 1883)                              │   │
│   │                              Local High-Speed Message Bus                                 │   │
│   └───────────────────────┬───────────────────────────────────────────┬───────────────────────┘   │
│                           │ Sub: camera/+/detections                  │ Sub: all topics           │
│                           ▼                                           ▼                           │
│   ┌────────────────────────────────────────┐                 ┌────────────────────────────────┐   │
│   │           fogvision-fog-node           │                 │      fogvision-dashboard       │   │
│   │   • Node ID: "fog-1"                   │                 │   • Web Dashboard (:8081)      │   │
│   │   • Computes transit latency (2-6 ms)  │                 │   • Internal reverse proxy     │   │
│   │   • Enriches event metadata            │                 │   • WebSocket real-time push   │   │
│   └───────────────────────┬────────────────┘                 └────────────────────────────────┘   │
│                           │ MQTT: fog/fog-1/processed                                             │
│                           ▼                                                                       │
│   ┌────────────────────────────────────────┐                                                      │
│   │           fogvision-gateway            │                                                      │
│   │   • Ingests processed fog events       │                                                      │
│   │   • Emits: cloud/received              │                                                      │
│   └───────────────────────┬────────────────┘                                                      │
│                           │                                                                       │
└───────────────────────────┼───────────────────────────────────────────────────────────────────────┘
                            │ HTTPS POST (JSON metadata only)
                            ▼
              ┌───────────────────────────┐
              │     CENTRALIZED CLOUD     │
              │   https://api.apinex.bond │
              └───────────────────────────┘
```

---

## 📦 Container Microservices Inventory

| Container Name | Service Role | Technology Stack | Ports / Network | Purpose |
| :--- | :--- | :--- | :--- | :--- |
| `fogvision-camera-real` | **Edge Sensor** | Node.js, FFmpeg, V4L2 | `8082:8082` (internal) | Ingests frames from `/dev/video0`, hosts local MJPEG stream, sends frames to AI inference, publishes detections. |
| `fogvision-fog-inference` | **Fog AI Engine** | Python, FastAPI, YOLOv8 (`ultralytics`), OpenCV | Port `3000` (Docker internal) | Runs computer vision object detection locally on raw JPEG buffers. |
| `fogvision-fog-node` | **Fog Processor** | Node.js, MQTT | Internal network | Subscribes to detections, calculates transit/enrichment latency (2–6ms), tags node metadata. |
| `fogvision-gateway` | **Cloud Gateway** | Node.js, node-fetch, MQTT | Internal network | Aggregates edge events and dispatches lightweight JSON telemetry upstream to the Cloud API. |
| `fogvision-broker` | **Fog Message Bus** | Eclipse Mosquitto 2.0 | `1883:1883` | Central MQTT broker routing messages between local fog services. |
| `fogvision-dashboard` | **Monitoring UI** | Express, WebSockets, HTML5 Canvas, SVG | `8081:8080` (host mapped) | Reverse-proxies video stream, renders canvas bounding boxes, displays latency cards and animated SVG topology. |

---

## 🎨 Object Detection & UI Features

* **Category-Specific Color-Coding:** Bounding boxes are styled dynamically to distinguish object categories:
  * 👤 **Person:** Neon Cyan (`#00e5ff`) with subtle backdrop fill
  * 📱 **Electronics (Phone, Laptop, Keyboard):** Electric Amber / Orange (`#ff9100`)
  * ☕ **Containers (Bottle, Cup):** Emerald Green (`#10b981`)
  * 🪑 **Furniture (Chair, Bed, Couch):** Soft Indigo (`#818cf8`)
  * 🎒 **Accessories (Backpack, Bag):** Coral / Rose (`#f43f5e`)
* **Per-Class Confidence Thresholding:** Uses strict thresholds (`person ≥ 0.68`) to eliminate false positives on background clutter or blanket folds.
* **Interactive AI Filter Selector:** Switch between `45%`, `52% (Accurate)`, and `65% (Strict)` directly on the dashboard.
* **Bidirectional Start / Pause Control:** Toggle edge inference and data transmission dynamically from the header button.

---

## 🚀 Quick Start Guide

### Prerequisites
* Docker Engine & Docker Compose (v2)
* Linux / macOS / WSL2 with webcam access (`/dev/video0`)

### 1. Launch the System
```bash
# Clone the repository
git clone https://github.com/Abpattar/FogProject.git
cd FogProject

# Start all microservices in the background
docker compose up -d --build

# Verify all containers are running
docker compose ps
```

### 2. Access the Dashboard
Open your browser and navigate to:
```
http://localhost:8081
```

* You will see the live webcam video with colored bounding boxes and confidence scores.
* Watch the **Inference (ms)**, **Fog Enrich (ms)**, and **Total Edge Latency (ms)** meters update live.
* Observe the pulsing green lines on the **Distributed Topology** as MQTT packets flow across the Edge ➔ Fog ➔ Gateway ➔ Cloud pipeline.

### 3. Pause / Resume Edge Processing
* **From the UI:** Click the **`⏸ PAUSE SYSTEM`** button in the dashboard header.
* **From the CLI:**
  ```bash
  # Pause inference:
  curl "http://localhost:8081/api/control?action=pause"

  # Resume inference:
  curl "http://localhost:8081/api/control?action=resume"
  ```

### 4. Shut Down the System
To stop all containers, release ports, and free all CPU/RAM:
```bash
docker compose down
```

---

## 🔍 Live Verification & Inspection Commands

```bash
# 1. Watch real-time MQTT message traffic across all topics:
docker exec fogvision-broker mosquitto_sub -t '#' -v

# 2. Inspect Fog Node metadata enrichment & latency logs:
docker compose logs -f fog-node

# 3. Check Camera & AI Inference performance:
docker compose logs -f camera-real fog-inference

# 4. Check camera container health endpoint:
curl -s http://localhost:8082/health | jq .
```

---

## 📄 License

MIT License — Developed for academic demonstration and evaluation of Fog Computing architectures.
