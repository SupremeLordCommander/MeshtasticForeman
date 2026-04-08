import Fastify from "fastify";
import fastifyCors from "@fastify/cors";
import fastifyWebsocket from "@fastify/websocket";
import fastifyStatic from "@fastify/static";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

import { db } from "./db/client.js";
import { runMigrations } from "./db/migrations.js";
import { DeviceManager } from "./device/device-manager.js";
import { MqttGateway } from "./mqtt/gateway.js";
import { registerDeviceRoutes } from "./routes/devices.js";
import { registerWsRoute } from "./routes/websocket.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.PORT ?? 3750);
const HOST = process.env.HOST ?? "0.0.0.0";

async function main() {
  // 1. Database
  await runMigrations(db);
  console.log("[db] migrations complete");

  // 2. HTTP + WebSocket server
  const app = Fastify({ logger: { level: "info" } });

  await app.register(fastifyCors, { origin: "*" });
  await app.register(fastifyWebsocket);

  // Serve built frontend from web package (in production)
  const webDist = join(__dirname, "../../web/dist");
  await app.register(fastifyStatic, {
    root: webDist,
    wildcard: false,
  });

  // 3. Device manager (owns all serial/TCP connections)
  const deviceManager = new DeviceManager(db);

  // 4. MQTT gateway (optional — only starts if MQTT_BROKER is set)
  let mqttGateway: MqttGateway | null = null;
  if (process.env.MQTT_BROKER) {
    mqttGateway = new MqttGateway({
      broker:    process.env.MQTT_BROKER,
      port:      Number(process.env.MQTT_PORT ?? 1883),
      username:  process.env.MQTT_USER ?? "meshdev",
      password:  process.env.MQTT_PASS ?? "large4cats",
      rootTopic: process.env.MQTT_ROOT ?? "msh/US",
    }, db);
    mqttGateway.start();
    deviceManager.setMqttGateway(mqttGateway);
    console.log(`[mqtt] gateway configured → ${process.env.MQTT_BROKER}`);
  }

  // Auto-connect to device specified in env (takes priority over DB-saved devices)
  if (process.env.MESHTASTIC_PORT) {
    const port = process.env.MESHTASTIC_PORT;
    const name = process.env.MESHTASTIC_NAME ?? port;
    console.log(`[foreman] auto-connecting to ${port}`);
    await deviceManager.connect(port, name).catch((err) => {
      console.error(`[foreman] failed to connect to ${port}:`, err.message);
    });
  } else {
    await deviceManager.reconnectSaved();
  }

  // 4. Routes
  await registerDeviceRoutes(app, deviceManager, mqttGateway, db);
  await registerWsRoute(app, deviceManager, mqttGateway, db);

  // Fallback to index.html for SPA routing
  app.setNotFoundHandler((_req, reply) => {
    reply.sendFile("index.html");
  });

  await app.listen({ port: PORT, host: HOST });
  console.log(`[foreman] daemon listening on http://${HOST}:${PORT}`);
}

main().catch((err) => {
  console.error("[foreman] fatal:", err);
  process.exit(1);
});
