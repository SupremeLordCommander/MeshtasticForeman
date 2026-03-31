import type { FastifyInstance } from "fastify";
import type { WebSocket } from "ws";
import type { ServerEvent, ClientCommand } from "@foreman/shared";
import { clientCommandSchema } from "@foreman/shared";
import type { DeviceManager } from "../device/device-manager.js";

/**
 * Single WebSocket endpoint at /ws
 * - On connect: sends current device list and node snapshot
 * - Forwards all DeviceManager events to connected clients
 * - Receives ClientCommands from the frontend
 */
export async function registerWsRoute(
  app: FastifyInstance,
  deviceManager: DeviceManager
) {
  // Broadcast to all connected clients
  const clients = new Set<WebSocket>();

  const broadcast = (event: ServerEvent) => {
    const json = JSON.stringify(event);
    for (const client of clients) {
      if (client.readyState === 1 /* OPEN */) {
        client.send(json);
      }
    }
  };

  // Forward device events to all WebSocket clients
  deviceManager.on("event", broadcast);

  app.get("/ws", { websocket: true }, (socket) => {
    clients.add(socket);
    console.log(`[ws] client connected (total=${clients.size})`);

    // Send current state snapshot on connect
    deviceManager.listDevices().then((devices) => {
      const event: ServerEvent = {
        type: "device:list",
        payload: devices.map((d) => ({
          id: d.id,
          name: d.name,
          port: d.port,
          status: "connected" as const,
          connectedAt: null,
          lastSeenAt: d.last_seen ?? null,
          hardwareModel: d.hw_model ?? null,
          firmwareVersion: d.firmware ?? null,
        })),
      };
      socket.send(JSON.stringify(event));
    });

    socket.on("message", (raw) => {
      let parsed: ClientCommand;
      try {
        parsed = clientCommandSchema.parse(JSON.parse(raw.toString()));
      } catch {
        socket.send(
          JSON.stringify({
            type: "error",
            payload: { code: "INVALID_COMMAND", message: "Unrecognized command" },
          })
        );
        return;
      }

      handleClientCommand(parsed, socket, deviceManager).catch((err) => {
        console.error("[ws] command error:", err);
        socket.send(
          JSON.stringify({
            type: "error",
            payload: { code: "COMMAND_ERROR", message: String(err.message) },
          })
        );
      });
    });

    socket.on("close", () => {
      clients.delete(socket);
      console.log(`[ws] client disconnected (total=${clients.size})`);
    });
  });
}

async function handleClientCommand(
  command: ClientCommand,
  _socket: WebSocket,
  _deviceManager: DeviceManager
) {
  switch (command.type) {
    case "message:send": {
      const device = _deviceManager.getDevice(command.payload.deviceId);
      if (!device) {
        _socket.send(JSON.stringify({
          type: "error",
          payload: { code: "DEVICE_NOT_FOUND", message: `No device with id ${command.payload.deviceId}` },
        }));
        return;
      }
      // TODO: call device.meshDevice.sendText(text, toNodeId, channelIndex, wantAck)
      console.log("[ws] message:send →", device.name, command.payload);
      break;
    }

    case "packets:subscribe": {
      const device = _deviceManager.getDevice(command.payload.deviceId);
      if (!device) {
        _socket.send(JSON.stringify({
          type: "error",
          payload: { code: "DEVICE_NOT_FOUND", message: `No device with id ${command.payload.deviceId}` },
        }));
        return;
      }
      // TODO: toggle raw packet streaming for this client+device pair
      console.log("[ws] packets:subscribe →", device.name, command.payload.enabled);
      break;
    }

    case "messages:request-history": {
      const device = _deviceManager.getDevice(command.payload.deviceId);
      if (!device) {
        _socket.send(JSON.stringify({
          type: "error",
          payload: { code: "DEVICE_NOT_FOUND", message: `No device with id ${command.payload.deviceId}` },
        }));
        return;
      }
      // TODO: query messages table and send back history
      console.log("[ws] messages:request-history →", device.name, command.payload);
      break;
    }
  }
}
