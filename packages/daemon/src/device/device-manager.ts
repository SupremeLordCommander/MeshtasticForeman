import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import type { ServerEvent } from "@foreman/shared";

// Placeholder imports — these will resolve once @meshtastic packages are installed
// import { MeshDevice } from "@meshtastic/core";
// import { SerialConnection } from "@meshtastic/transport-node-serial";

export interface ConnectedDevice {
  id: string;
  port: string;
  name: string;
  // device: MeshDevice;  // uncomment once transport packages installed
}

/**
 * DeviceManager owns all physical device connections.
 * It runs for the lifetime of the daemon process — connections persist
 * regardless of frontend client activity.
 *
 * Responsibilities:
 * - Open/close serial connections to Meshtastic devices
 * - Reconnect automatically on disconnect
 * - Persist device config and state to PGlite
 * - Emit events that the WebSocket broadcaster listens to
 */
export class DeviceManager extends EventEmitter {
  private devices = new Map<string, ConnectedDevice>();

  constructor(private readonly db: PGlite) {
    super();
  }

  /** Reconnect all devices that were saved in the DB from a previous run. */
  async reconnectSaved() {
    const { rows } = await this.db.query<{ id: string; name: string; port: string }>(
      "SELECT id, name, port FROM devices ORDER BY created_at"
    );
    for (const row of rows) {
      await this.connect(row.port, row.name, row.id).catch((err) => {
        console.warn(`[devices] failed to reconnect ${row.port}:`, err.message);
      });
    }
  }

  async listDevices() {
    const { rows } = await this.db.query<{
      id: string;
      name: string;
      port: string;
      hw_model: string | null;
      firmware: string | null;
      last_seen: string | null;
    }>("SELECT id, name, port, hw_model, firmware, last_seen FROM devices ORDER BY created_at");
    return rows;
  }

  async connect(port: string, name: string, existingId?: string): Promise<ConnectedDevice> {
    // Check for existing live connection on this port
    for (const [, dev] of this.devices) {
      if (dev.port === port) return dev;
    }

    const id = existingId ?? randomUUID();

    // Upsert device record
    await this.db.query(
      `INSERT INTO devices(id, name, port)
       VALUES ($1, $2, $3)
       ON CONFLICT(id) DO UPDATE SET name = EXCLUDED.name, port = EXCLUDED.port`,
      [id, name, port]
    );

    // TODO: instantiate real MeshDevice + SerialConnection here once
    // transport packages are confirmed compatible with Node ESM.
    // The pattern will be:
    //
    //   const connection = new SerialConnection(id);
    //   await connection.connect({ portPath: port, baudRate: 115200 });
    //   connection.device.events.onMeshPacket.subscribe((packet) => {
    //     this.handlePacket(id, packet);
    //   });

    const device: ConnectedDevice = { id, port, name };
    this.devices.set(id, device);

    const event: ServerEvent = {
      type: "device:status",
      payload: {
        id,
        name,
        port,
        status: "connected",
        connectedAt: new Date().toISOString(),
        lastSeenAt: null,
        hardwareModel: null,
        firmwareVersion: null,
      },
    };
    this.emit("event", event);
    console.log(`[devices] connected ${name} on ${port} (id=${id})`);

    return device;
  }

  async disconnect(deviceId: string) {
    const device = this.devices.get(deviceId);
    if (!device) return;

    // TODO: close MeshDevice connection

    this.devices.delete(deviceId);

    const event: ServerEvent = {
      type: "device:status",
      payload: {
        id: deviceId,
        name: device.name,
        port: device.port,
        status: "disconnected",
        connectedAt: null,
        lastSeenAt: null,
        hardwareModel: null,
        firmwareVersion: null,
      },
    };
    this.emit("event", event);
    console.log(`[devices] disconnected ${device.name}`);
  }

  getDevice(id: string) {
    return this.devices.get(id);
  }

  /** Called for every decoded packet received from a device. Logs to DB and emits. */
  private async handlePacket(_deviceId: string, _packet: unknown) {
    // Will be implemented when MeshDevice integration is wired up.
    // Pattern: decode portnum, store in packets table, emit "packet:raw" event,
    // and if portnum === TEXT_MESSAGE_APP, also store in messages table and emit "message:received"
  }
}
