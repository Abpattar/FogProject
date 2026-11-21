const { spawn } = require('child_process');
const http = require('http');
const mqtt = require('mqtt');
const express = require('express');

const FOG_URL = process.env.FOG_INFERENCE_URL || 'http://fog-inference:3000/infer';
const CAM_ID = process.env.CAMERA_ID || 'cam-real';
const FPS = parseInt(process.env.FPS || '5', 10);
const RES = process.env.RESOLUTION || '640x480';
const VIDEO_DEVICE = process.env.VIDEO_DEVICE || '/dev/video0';

const CONF_THRESHOLD = process.env.CONF_THRESHOLD || '0.52';

let latestFrame = null;
let frameCount = 0;
let inferenceCount = 0;
let isInferring = false;
let isPaused = false;
let lastInferenceResult = null;

// --- Express App for Health, Snapshot & MJPEG Live Video Stream ---
const app = express();

// Universal CORS Middleware
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    camera: CAM_ID,
    isPaused: isPaused,
    frames: frameCount,
    inferences: inferenceCount,
    hasFrame: !!latestFrame,
    lastInference: lastInferenceResult
  });
});

// Single JPEG snapshot endpoint
app.get('/snapshot', (req, res) => {
  if (latestFrame) {
    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.send(latestFrame);
  } else {
    res.status(503).send('No frame captured yet');
  }
});

// Continuous MJPEG stream endpoint
app.get('/stream', (req, res) => {
  res.setHeader('Content-Type', 'multipart/x-mixed-replace; boundary=frame');
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Pragma', 'no-cache');

  const intervalMs = Math.max(60, Math.floor(1000 / FPS));
  const timer = setInterval(() => {
    if (latestFrame) {
      try {
        res.write(`--frame\r\n`);
        res.write(`Content-Type: image/jpeg\r\n`);
        res.write(`Content-Length: ${latestFrame.length}\r\n\r\n`);
        res.write(latestFrame);
        res.write('\r\n');
      } catch (e) {
        clearInterval(timer);
      }
    }
  }, intervalMs);

  req.on('close', () => {
    clearInterval(timer);
    console.log(`[${CAM_ID}] MJPEG client disconnected`);
  });
});

app.listen(8082, '0.0.0.0', () => {
  console.log(`[${CAM_ID}] Camera HTTP server listening on port 8082`);
});

// --- MQTT Client Setup ---
const client = mqtt.connect('mqtt://broker:1883', {
  reconnectPeriod: 2000,
  connectTimeout: 10000
});

client.on('connect', () => {
  console.log(`[${CAM_ID}] MQTT connected to broker:1883`);
  client.subscribe('fog/control');

  client.publish(`node/${CAM_ID}/status`, JSON.stringify({
    node: CAM_ID,
    role: 'camera',
    status: 'ONLINE',
    time: Date.now(),
    fps: FPS,
    resolution: RES
  }));
});

// Listen for Start / Pause commands from Control Plane
client.on('message', (topic, payload) => {
  if (topic === 'fog/control') {
    try {
      const data = JSON.parse(payload.toString());
      if (data.action === 'pause' || data.action === 'stop') {
        isPaused = true;
        console.log(`[${CAM_ID}] ⏸ STREAM PAUSED by control plane`);
      } else if (data.action === 'resume' || data.action === 'start') {
        isPaused = false;
        console.log(`[${CAM_ID}] ▶ STREAM RESUMED by control plane`);
      }
    } catch (e) {
      console.error(`[${CAM_ID}] Control parse error:`, e.message);
    }
  }
});

client.on('error', (err) => {
  console.error(`[${CAM_ID}] MQTT error:`, err.message);
});

client.on('close', () => {
  console.log(`[${CAM_ID}] MQTT disconnected`);
});

// Periodic heartbeat
setInterval(() => {
  if (client.connected) {
    client.publish(`node/${CAM_ID}/status`, JSON.stringify({
      node: CAM_ID,
      role: 'camera',
      status: isPaused ? 'PAUSED' : 'ONLINE',
      time: Date.now(),
      fps: FPS,
      resolution: RES,
      frames: frameCount,
      inferences: inferenceCount
    }));
  }
}, 5000);

// --- Send Frame to Fog AI Inference Microservice ---
function sendFrameToInference(frame) {
  return new Promise((resolve) => {
    const startTime = Date.now();
    inferenceCount++;

    const options = {
      hostname: 'fog-inference',
      port: 3000,
      path: '/infer',
      method: 'POST',
      headers: {
        'Content-Type': 'image/jpeg',
        'X-Camera-ID': CAM_ID,
        'X-Conf-Threshold': CONF_THRESHOLD,
        'Content-Length': frame.length,
        'Connection': 'close'
      },
      timeout: 10000
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => {
        data += chunk;
      });
      res.on('end', () => {
        const fetchTime = Date.now() - startTime;
        if (res.statusCode !== 200) {
          console.error(`[${CAM_ID}] Inference HTTP ${res.statusCode}: ${data}`);
          return resolve();
        }

        try {
          const result = JSON.parse(data);
          lastInferenceResult = result;

          if (client.connected && !isPaused) {
            client.publish(`camera/${CAM_ID}/detections`, JSON.stringify({
              camera: CAM_ID,
              sequence: frameCount,
              timestamp: Date.now(),
              ...result
            }));
          }

          if (inferenceCount % 5 === 0) {
            console.log(`[${CAM_ID}] Inference #${inferenceCount} | dets: ${result.detections?.length || 0} | yolo: ${result.inference_ms}ms | rtt: ${fetchTime}ms`);
          }
        } catch (e) {
          console.error(`[${CAM_ID}] JSON parse error:`, e.message);
        }
        resolve();
      });
    });

    req.on('error', (e) => {
      console.error(`[${CAM_ID}] Inference request error:`, e.message);
      resolve();
    });

    req.on('timeout', () => {
      req.destroy();
      console.error(`[${CAM_ID}] Inference timeout`);
      resolve();
    });

    req.write(frame);
    req.end();
  });
}

// --- Spawn FFmpeg for Video Capture & Robust JPEG Extraction ---
const ffmpegArgs = [
  '-f', 'v4l2',
  '-framerate', String(FPS),
  '-video_size', RES,
  '-i', VIDEO_DEVICE,
  '-f', 'image2pipe',
  '-vcodec', 'mjpeg',
  '-q:v', '5',
  '-'
];

console.log(`[${CAM_ID}] Starting FFmpeg: ffmpeg ${ffmpegArgs.join(' ')}`);
const ffmpeg = spawn('ffmpeg', ffmpegArgs);

let jpegBuffer = Buffer.alloc(0);

ffmpeg.stdout.on('data', async (chunk) => {
  jpegBuffer = Buffer.concat([jpegBuffer, chunk]);

  while (true) {
    const startIndex = jpegBuffer.indexOf(Buffer.from([0xFF, 0xD8]));
    if (startIndex === -1) {
      jpegBuffer = Buffer.alloc(0);
      break;
    }
    const endIndex = jpegBuffer.indexOf(Buffer.from([0xFF, 0xD9]), startIndex + 2);
    if (endIndex === -1) {
      if (startIndex > 0) {
        jpegBuffer = jpegBuffer.slice(startIndex);
      }
      break;
    }

    const frame = jpegBuffer.slice(startIndex, endIndex + 2);
    jpegBuffer = jpegBuffer.slice(endIndex + 2);

    frameCount++;
    latestFrame = frame;

    // If paused, skip inference to save compute
    if (isPaused) {
      continue;
    }

    // Concurrency guard: Only run inference if previous one has completed
    if (!isInferring) {
      isInferring = true;
      sendFrameToInference(frame).finally(() => {
        isInferring = false;
      });
    }
  }
});

ffmpeg.stderr.on('data', (data) => {
  const msg = data.toString().trim();
  if (msg && !msg.includes('frame=') && !msg.includes('fps=') && !msg.includes('speed=')) {
    console.log(`[${CAM_ID}] FFmpeg: ${msg}`);
  }
});

ffmpeg.on('error', (err) => {
  console.error(`[${CAM_ID}] FFmpeg spawn error:`, err.message);
});

ffmpeg.on('close', (code) => {
  console.log(`[${CAM_ID}] FFmpeg exited with code ${code}`);
  setTimeout(() => {
    console.log(`[${CAM_ID}] Exiting to allow container restart...`);
    process.exit(1);
  }, 3000);
});

process.on('SIGTERM', () => {
  console.log(`[${CAM_ID}] Shutting down...`);
  ffmpeg.kill('SIGTERM');
  client.end();
  process.exit(0);
});
