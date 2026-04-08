import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { DeviceManager } from "../device/device-manager.js";
import type { MqttGateway } from "../mqtt/gateway.js";

const connectBodySchema = z.object({
  port: z.string().min(1),
  name: z.string().min(1),
});

export async function registerDeviceRoutes(
  app: FastifyInstance,
  deviceManager: DeviceManager,
  mqttGateway?: MqttGateway | null,
) {
  app.get("/api/devices", async () => {
    const rows = await deviceManager.listDevices();
    return rows;
  });

  app.post("/api/devices/connect", async (req, reply) => {
    const result = connectBodySchema.safeParse(req.body);
    if (!result.success) {
      return reply.status(400).send({ error: result.error.flatten() });
    }
    const device = await deviceManager.connect(result.data.port, result.data.name);
    return device;
  });

  app.get("/api/devices/:id/nodes", async (req, reply) => {
    const { id } = req.params as { id: string };
    const nodes = await deviceManager.listNodes(id);
    return nodes;
  });

  app.get("/api/mqtt-nodes", async () => {
    if (!mqttGateway) return [];
    return mqttGateway.listMqttNodes();
  });

  app.delete("/api/devices/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    await deviceManager.disconnect(id);
    return reply.status(204).send();
  });
}
