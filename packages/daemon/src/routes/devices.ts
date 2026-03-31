import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { DeviceManager } from "../device/device-manager.js";

const connectBodySchema = z.object({
  port: z.string().min(1),
  name: z.string().min(1),
});

export async function registerDeviceRoutes(
  app: FastifyInstance,
  deviceManager: DeviceManager
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

  app.delete("/api/devices/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    await deviceManager.disconnect(id);
    return reply.status(204).send();
  });
}
