const mqtt = require("mqtt");
const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const fetch = require("node-fetch");

const API_KEY = "connsk-apx1314609dc963e9c36be031a341b65dfe6569d1b9d453f14";
const API_BASE = "https://api.apinex.bond/v1";

const role = process.env.ROLE;
const id = process.env.NODE_ID || role;
const url = "mqtt://broker:1883";

let isSystemRunning = true;

const client = mqtt.connect(url, {
  reconnectPeriod: 2000,
  connectTimeout: 10000
});

function publish(topic, data) {
  if (client.connected) {
    client.publish(topic, JSON.stringify(data));
  }
}

client.on("connect", () => {
  console.log(`[${id}] MQTT CONNECTED`);

  client.subscribe("fog/control");

  publish(`node/${id}/status`, {
    node: id,
    status: isSystemRunning ? "ONLINE" : "PAUSED",
    time: Date.now(),
    role: role
  });

  if (role === "fog") {
    const cameras = (process.env.CAMERAS || "cam-real").split(",");

    cameras.forEach(camera => {
      client.subscribe(`camera/${camera}/detections`);
      client.subscribe(`camera/${camera}/data`);
    });

    console.log(`[${id}] Handling cameras: ${cameras.join(", ")} (topics: detections + data)`);
  }

  if (role === "gateway") {
    client.subscribe("fog/+/processed");
  }

  if (role === "dashboard") {
    client.subscribe([
      "camera/+/detections",
      "camera/+/data",
      "fog/+/processed",
      "cloud/received",
      "node/+/status",
      "fog/control"
    ]);
  }
});

client.on("message", (topic, payload) => {
  if (topic === "fog/control") {
    try {
      const data = JSON.parse(payload.toString());
      isSystemRunning = data.isRunning !== false && data.action !== "pause";
      console.log(`[${id}] Control signal received: ${isSystemRunning ? "RUNNING" : "PAUSED"}`);
    } catch (e) {}
  }
});

if (role === "camera") {
  let sequence = 0;

  setInterval(() => {
    if (!isSystemRunning) return;
    sequence++;

    publish(`camera/${id}/data`, {
      camera: id,
      sequence,
      motion: sequence % 4 !== 0,
      objects: sequence % 3,
      timestamp: Date.now()
    });
  }, 1000);
}

if (role === "fog") {
  client.on("message", (topic, payload) => {
    if (!topic.startsWith("camera/")) return;

    try {
      const data = JSON.parse(payload.toString());
      const now = Date.now();
      const transitLatency = data.timestamp ? Math.max(1, now - data.timestamp) : 2;
      const processingTime = transitLatency;

      console.log(`[${id}] Processing ${data.camera} #${data.sequence || 'N/A'} | topic: ${topic} | transit: ${transitLatency}ms`);

      if (topic.endsWith("/detections")) {
        publish(`fog/${id}/processed`, {
          ...data,
          fogNode: id,
          processedAt: now,
          processingTime: processingTime,
          inference_ms: data.inference_ms
        });
      } else if (topic.endsWith("/data")) {
        publish(`fog/${id}/processed`, {
          ...data,
          fogNode: id,
          processedAt: now,
          processingTime: processingTime
        });
      }
    } catch (e) {
      console.error(`[${id}] Error handling message:`, e.message);
    }
  });

  setInterval(() => {
    publish(`node/${id}/status`, {
      node: id,
      status: isSystemRunning ? "ONLINE" : "PAUSED",
      time: Date.now(),
      role: "fog"
    });
  }, 5000);
}

async function sendToAPI(data) {
  try {
    const res = await fetch(`${API_BASE}/events`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${API_KEY}`
      },
      body: JSON.stringify(data)
    });
    if (!res.ok) {
      console.log(`[GATEWAY] Cloud API response: ${res.status}`);
    } else {
      console.log(`[GATEWAY] Sent to Cloud API successfully: ${data.fogNode}`);
    }
  } catch (e) {
    console.log(`[GATEWAY] Cloud API network notice: ${e.message}`);
  }
}

if (role === "gateway") {
  client.on("message", (topic, payload) => {
    if (!topic.startsWith("fog/") || !topic.endsWith("/processed")) return;

    try {
      const data = JSON.parse(payload.toString());

      console.log(`[GATEWAY] Ingested from ${data.fogNode} | camera: ${data.camera} | seq: ${data.sequence || 'N/A'}`);

      publish("cloud/received", {
        ...data,
        gatewayReceived: Date.now()
      });

      sendToAPI({
        fogNode: data.fogNode,
        camera: data.camera,
        sequence: data.sequence,
        motion: data.motion,
        objects: data.objects,
        detections: data.detections,
        counts: data.counts,
        inference_ms: data.inference_ms,
        processedAt: data.processedAt,
        processingTime: data.processingTime,
        gatewayReceived: Date.now()
      });
    } catch (e) {
      console.error("[GATEWAY] Error processing message:", e.message);
    }
  });
}

if (role === "dashboard") {
  const app = express();
  const server = http.createServer(app);
  const wss = new WebSocket.Server({ server });

  app.use(express.json());

  // CORS headers
  app.use((req, res, next) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "*");
    if (req.method === "OPTIONS") return res.sendStatus(200);
    next();
  });

  // Proxy camera live stream internally from container
  app.get("/api/stream", (req, res) => {
    res.setHeader("Content-Type", "multipart/x-mixed-replace; boundary=frame");
    res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("Pragma", "no-cache");

    const camReq = http.get("http://camera-real:8082/stream", (camRes) => {
      camRes.pipe(res);
    });

    camReq.on("error", (err) => {
      console.error("[DASHBOARD PROXY] Stream proxy error:", err.message);
      if (!res.headersSent) res.status(502).send("Camera stream offline");
    });

    req.on("close", () => {
      camReq.destroy();
    });
  });

  // Proxy camera snapshot internally from container
  app.get("/api/snapshot", (req, res) => {
    res.setHeader("Content-Type", "image/jpeg");
    res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");

    const camReq = http.get("http://camera-real:8082/snapshot", (camRes) => {
      camRes.pipe(res);
    });

    camReq.on("error", (err) => {
      if (!res.headersSent) res.status(502).send("Camera snapshot offline");
    });
  });

  // Control plane API to start/pause fog system
  app.all("/api/control", (req, res) => {
    const action = req.query.action || (req.body && req.body.action) || "toggle";
    if (action === "pause" || action === "stop") {
      isSystemRunning = false;
    } else if (action === "resume" || action === "start") {
      isSystemRunning = true;
    } else if (action === "toggle") {
      isSystemRunning = !isSystemRunning;
    }

    const payload = {
      action: isSystemRunning ? "resume" : "pause",
      isRunning: isSystemRunning,
      time: Date.now()
    };

    publish("fog/control", payload);

    // Broadcast immediately to all connected dashboard websockets
    wss.clients.forEach(ws => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          topic: "fog/control",
          data: payload,
          timestamp: Date.now()
        }));
      }
    });

    res.json({
      success: true,
      action: payload.action,
      isRunning: isSystemRunning
    });
  });

  app.get("/api/status", (req, res) => {
    res.json({
      isRunning: isSystemRunning,
      time: Date.now()
    });
  });

  app.use(express.static("public"));

  client.on("message", (topic, payload) => {
    try {
      const event = {
        topic,
        data: JSON.parse(payload.toString()),
        timestamp: Date.now()
      };

      wss.clients.forEach(ws => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify(event));
        }
      });
    } catch (e) {
      console.error("[DASHBOARD] Broadcast error:", e.message);
    }
  });

  server.listen(8080, "0.0.0.0", () => {
    console.log("FogVision dashboard & proxy running on port 8080");
  });
}
