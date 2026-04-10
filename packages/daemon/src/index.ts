import Fastify from "fastify";
import fastifyCors from "@fastify/cors";
import fastifyWebsocket from "@fastify/websocket";
import fastifyStatic from "@fastify/static";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

import { db } from "./db/client.js";
import { runMigrations } from "./db/migrations.js";
import { consoleLog } from "./activity/console-log.js";
import { DeviceManager } from "./device/device-manager.js";
import { MqttGateway } from "./mqtt/gateway.js";
import { registerDeviceRoutes } from "./routes/devices.js";
import { registerWsRoute } from "./routes/websocket.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.API_PORT ?? 3750);
const HOST = process.env.API_HOST ?? "0.0.0.0";

/**
 * Pause the terminal, show an error, and wait for any keypress before
 * exiting with code 1. The start scripts loop on exit so this gives the
 * user time to read the error before the window restarts.
 */
async function fatalError(label: string, err: unknown): Promise<never> {
  const msg = err instanceof Error ? err.stack ?? err.message : String(err);
  process.stderr.write(`\n\n${"=".repeat(60)}\n`);
  process.stderr.write(`  FATAL — ${label}\n\n`);
  process.stderr.write(`  ${msg.split("\n").join("\n  ")}\n`);
  process.stderr.write(`${"=".repeat(60)}\n\n`);
  process.stderr.write("  Press any key to restart the service...\n\n");

  // Wait for a single keypress if stdin is a TTY; otherwise just pause 5 s
  // so the log is visible before the loop restarts the process.
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    await new Promise<void>((resolve) => process.stdin.once("data", () => {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      resolve();
    }));
  } else {
    await new Promise<void>((resolve) => setTimeout(resolve, 5000));
  }

  process.exit(1);
}

// The serial transport calls AbortController.abort() on disconnect, which rejects
// any in-flight reads using that signal. Those rejections are unhandled inside the
// transport's own machinery and would otherwise crash the process.
process.on("unhandledRejection", (reason) => {
  if (reason instanceof Error && reason.name === "AbortError") return;
  fatalError("unhandled rejection", reason);
});

// Serial port disconnect sequences can emit 'error' events on the SerialPort
// EventEmitter after the port is already closed (e.g. "Port is not open",
// ERR_STREAM_PREMATURE_CLOSE). These become uncaught exceptions that would
// crash the process. We swallow only the known serial-disconnect error codes
// so the daemon stays up and waits for the device to reconnect.
const SERIAL_DISCONNECT_CODES = new Set([
  "ABORT_ERR",
  "ERR_STREAM_PREMATURE_CLOSE",
]);
process.on("uncaughtException", (err) => {
  const code = (err as NodeJS.ErrnoException).code ?? "";
  const msg = err.message ?? "";
  if (SERIAL_DISCONNECT_CODES.has(code) || msg === "Port is not open") {
    console.warn("[foreman] suppressed serial-disconnect error:", msg || code);
    return;
  }
  fatalError("uncaught exception", err);
});

async function main() {
  // Capture all console.log/warn/error into the in-memory ring buffer
  // before anything else logs, so no lines are missed.
  consoleLog.install();

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

main().catch((err) => fatalError("startup failure", err));
