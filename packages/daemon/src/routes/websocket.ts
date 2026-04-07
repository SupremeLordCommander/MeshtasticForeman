import type { FastifyInstance } from "fastify";
import type { WebSocket, RawData } from "ws";
import type { ServerEvent, ClientCommand } from "@foreman/shared";
import { clientCommandSchema } from "@foreman/shared";
import { Types } from "@meshtastic/core";
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
  const clients = new Set<WebSocket>();
  /** Sockets that have opted in to raw packet streaming */
  const packetSubscriptions = new Set<WebSocket>();

  const broadcast = (event: ServerEvent) => {
    // packet:raw only goes to subscribed clients
    const targets = event.type === "packet:raw" ? packetSubscriptions : clients;
    const json = JSON.stringify(event);
    for (const client of targets) {
      if (client.readyState === 1 /* OPEN */) {
        client.send(json);
      }
    }
  };

  deviceManager.on("event", broadcast);

  app.get("/ws", { websocket: true }, (socket) => {
    clients.add(socket);
    console.log(`[ws] client connected (total=${clients.size})`);

    // Send current state snapshot on connect
    deviceManager.listDevices().then(async (devices) => {
      const deviceListEvent: ServerEvent = {
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
      socket.send(JSON.stringify(deviceListEvent));

      // Send all known nodes for each connected device
      for (const d of devices) {
        const nodes = await deviceManager.listNodes(d.id);
        if (nodes.length === 0) continue;
        const nodeListEvent: ServerEvent = { type: "node:list", payload: nodes };
        socket.send(JSON.stringify(nodeListEvent));
      }
    });

    socket.on("message", (raw: RawData) => {
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

      handleClientCommand(parsed, socket, deviceManager, packetSubscriptions).catch((err) => {
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
      packetSubscriptions.delete(socket);
      console.log(`[ws] client disconnected (total=${clients.size})`);
    });
  });
}

async function handleClientCommand(
  command: ClientCommand,
  socket: WebSocket,
  deviceManager: DeviceManager,
  packetSubscriptions: Set<WebSocket>
) {
  switch (command.type) {
    case "message:send": {
      const device = deviceManager.getDevice(command.payload.deviceId);
      if (!device) {
        socket.send(JSON.stringify({
          type: "error",
          payload: { code: "DEVICE_NOT_FOUND", message: `No device with id ${command.payload.deviceId}` },
        }));
        return;
      }
      const { text, toNodeId, channelIndex, wantAck } = command.payload;
      await device.meshDevice.sendText(
        text,
        toNodeId,
        wantAck,
        channelIndex as Types.ChannelNumber
      );
      console.log(`[ws] message:send → ${device.name} to node ${toNodeId}`);
      break;
    }

    case "packets:subscribe": {
      const device = deviceManager.getDevice(command.payload.deviceId);
      if (!device) {
        socket.send(JSON.stringify({
          type: "error",
          payload: { code: "DEVICE_NOT_FOUND", message: `No device with id ${command.payload.deviceId}` },
        }));
        return;
      }
      if (command.payload.enabled) {
        packetSubscriptions.add(socket);
      } else {
        packetSubscriptions.delete(socket);
      }
      console.log(`[ws] packets:subscribe → ${device.name}, enabled=${command.payload.enabled}`);
      break;
    }

    case "nodes:request-list": {
      const { deviceId } = command.payload;
      const device = deviceManager.getDevice(deviceId);
      if (!device) {
        socket.send(JSON.stringify({
          type: "error",
          payload: { code: "DEVICE_NOT_FOUND", message: `No device with id ${deviceId}` },
        }));
        return;
      }
      const nodes = await deviceManager.listNodes(deviceId);
      const event: ServerEvent = { type: "node:list", payload: nodes };
      socket.send(JSON.stringify(event));
      console.log(`[ws] nodes:request-list → ${device.name}, returned ${nodes.length} nodes`);
      break;
    }

    case "messages:request-history": {
      const { deviceId, channelIndex, toNodeId, limit, before } = command.payload;
      const device = deviceManager.getDevice(deviceId);
      if (!device) {
        socket.send(JSON.stringify({
          type: "error",
          payload: { code: "DEVICE_NOT_FOUND", message: `No device with id ${deviceId}` },
        }));
        return;
      }
      const messages = await deviceManager.getMessageHistory(deviceId, {
        channelIndex,
        toNodeId,
        limit,
        before,
      });
      const event: ServerEvent = { type: "message:history", payload: messages };
      socket.send(JSON.stringify(event));
      console.log(`[ws] messages:request-history → ${device.name}, returned ${messages.length} messages`);
      break;
    }
  }
}
