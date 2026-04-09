import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { Buffer } from "node:buffer";
import type { PGlite } from "@electric-sql/pglite";
import type { ServerEvent, Message, NodeInfo } from "@foreman/shared";
import { MeshDevice, Types, Protobuf } from "@meshtastic/core";
import { TransportNodeSerial } from "@meshtastic/transport-node-serial";
import type { MqttGateway } from "../mqtt/gateway.js";
import { activityLog } from "../activity/log.js";

export interface ConnectedDevice {
  id: string;
  port: string;
  name: string;
  connectedAt: string;
  meshDevice: MeshDevice;
  transport: TransportNodeSerial;
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
  /** Ports with a pending reconnect timer — prevents stacked reconnect loops */
  private reconnectingPorts = new Set<string>();
  private mqttGateway: MqttGateway | null = null;

  constructor(private readonly db: PGlite) {
    super();
  }

  setMqttGateway(gateway: MqttGateway): void {
    this.mqttGateway = gateway;
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

    // Reuse existing DB row for this port if one exists, to avoid accumulating duplicates
    let id = existingId;
    if (!id) {
      const { rows } = await this.db.query<{ id: string }>(
        "SELECT id FROM devices WHERE port = $1 ORDER BY created_at LIMIT 1",
        [port]
      );
      id = rows[0]?.id ?? randomUUID();
    }

    // Delete any duplicate rows for this port that aren't the canonical id
    await this.db.query(
      "DELETE FROM devices WHERE port = $1 AND id != $2",
      [port, id]
    );

    // Upsert canonical row
    await this.db.query(
      `INSERT INTO devices(id, name, port)
       VALUES ($1, $2, $3)
       ON CONFLICT(id) DO UPDATE SET name = EXCLUDED.name, port = EXCLUDED.port`,
      [id, name, port]
    );

    this._emitStatus(id, name, port, "connecting");

    // Open serial port and create transport
    const transport = await TransportNodeSerial.create(port, 115200);

    // MeshDevice constructor starts piping the fromDevice stream immediately
    const meshDevice = new MeshDevice(transport);

    const connectedAt = new Date().toISOString();
    const device: ConnectedDevice = { id, port, name, connectedAt, meshDevice, transport };
    this.devices.set(id, device);

    // Subscribe to all relevant events
    meshDevice.events.onMessagePacket.subscribe((pkt: Types.PacketMetadata<string>) => {
      this._handleMessage(id, pkt).catch((err) =>
        console.error(`[devices] message error on ${name}:`, err)
      );
    });

    // Protobuf types come from @meshtastic/protobufs which is bundled into core;
    // using `any` here since the package isn't separately resolvable by TypeScript.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    meshDevice.events.onMeshPacket.subscribe((pkt: any) => {
      this._handleRawPacket(id, pkt).catch((err) =>
        console.error(`[devices] raw packet error on ${name}:`, err)
      );
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    meshDevice.events.onNodeInfoPacket.subscribe((nodeInfo: any) => {
      this._handleNodeInfo(id, nodeInfo).catch((err) =>
        console.error(`[devices] node info error on ${name}:`, err)
      );
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    meshDevice.events.onPositionPacket.subscribe((pkt: any) => {
      this._handlePosition(id, pkt).catch((err) =>
        console.error(`[devices] position error on ${name}:`, err)
      );
    });

    meshDevice.events.onDeviceStatus.subscribe((status: Types.DeviceStatusEnum) => {
      this._handleDeviceStatus(id, name, port, status);
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    meshDevice.events.onQueueStatus.subscribe((status: any) => {
      console.log(`[devices] queue status on ${name}: res=${status.res} free=${status.free}/${status.maxlen} packetId=${status.meshPacketId}`);
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    meshDevice.events.onTraceRoutePacket.subscribe((pkt: any) => {
      const route: number[]     = Array.from(pkt.data?.route     ?? []);
      const routeBack: number[] = Array.from(pkt.data?.routeBack ?? []);
      const nodeId: number = pkt.from ?? 0;
      const event: ServerEvent = {
        type: "traceroute:result",
        payload: { nodeId, route, routeBack },
      };
      this.emit("event", event);
      console.log(`[devices] traceroute result from !${nodeId.toString(16).padStart(8,"0")} route=[${route.map((n) => "!"+n.toString(16)).join(",")}]`);
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    meshDevice.events.onDeviceMetadataPacket.subscribe(({ data }: any) => {
      this._handleMetadata(id, data).catch((err) =>
        console.error(`[devices] metadata error on ${name}:`, err)
      );
    });

    // Attach to MQTT gateway BEFORE configure so it catches onMyNodeInfo/onChannelPacket
    this.mqttGateway?.attachDevice(id, meshDevice);

    // Send configure request — device will begin streaming its config back
    await meshDevice.configure();

    this._emitStatus(id, name, port, "connected", connectedAt);
    console.log(`[devices] connected ${name} on ${port} (id=${id})`);

    return device;
  }

  async disconnect(deviceId: string) {
    const device = this.devices.get(deviceId);
    if (!device) return;

    this.devices.delete(deviceId);
    this.mqttGateway?.detachDevice(deviceId);
    await device.transport.disconnect().catch(() => {});

    this._emitStatus(deviceId, device.name, device.port, "disconnected");
    console.log(`[devices] disconnected ${device.name}`);
  }

  getDevice(id: string) {
    return this.devices.get(id);
  }

  async listNodes(deviceId: string): Promise<NodeInfo[]> {
    const { rows } = await this.db.query<{
      node_id: number;
      long_name: string | null;
      short_name: string | null;
      mac_address: string | null;
      hw_model: number | null;
      public_key: string | null;
      last_heard: string | null;
      snr: number | null;
      hops_away: number | null;
      latitude: number | null;
      longitude: number | null;
      altitude: number | null;
    }>(
      `SELECT node_id, long_name, short_name, mac_address, hw_model, public_key,
              last_heard, snr, hops_away, latitude, longitude, altitude
       FROM nodes WHERE device_id = $1 ORDER BY last_heard DESC NULLS LAST`,
      [deviceId]
    );
    return rows.map((r) => ({
      nodeId: r.node_id,
      longName: r.long_name,
      shortName: r.short_name,
      macAddress: r.mac_address,
      hwModel: r.hw_model,
      publicKey: r.public_key,
      lastHeard: r.last_heard,
      snr: r.snr,
      hopsAway: r.hops_away,
      latitude: r.latitude,
      longitude: r.longitude,
      altitude: r.altitude,
    }));
  }

  async getMessageHistory(
    deviceId: string,
    opts: { channelIndex?: number; toNodeId?: number; limit: number; before?: string }
  ): Promise<Message[]> {
    let query = `
      SELECT id, packet_id, from_node_id, to_node_id, channel_index, text,
             rx_time, rx_snr, rx_rssi, hop_limit, want_ack, via_mqtt
      FROM messages
      WHERE device_id = $1`;
    const params: unknown[] = [deviceId];
    let p = 2;

    if (opts.channelIndex !== undefined) {
      query += ` AND channel_index = $${p++}`;
      params.push(opts.channelIndex);
    }
    if (opts.toNodeId !== undefined) {
      query += ` AND to_node_id = $${p++}`;
      params.push(opts.toNodeId);
    }
    if (opts.before) {
      query += ` AND rx_time < $${p++}`;
      params.push(opts.before);
    }
    query += ` ORDER BY rx_time DESC LIMIT $${p}`;
    params.push(opts.limit);

    const { rows } = await this.db.query<{
      id: string;
      packet_id: number;
      from_node_id: number;
      to_node_id: number;
      channel_index: number;
      text: string;
      rx_time: string;
      rx_snr: number | null;
      rx_rssi: number | null;
      hop_limit: number | null;
      want_ack: boolean;
      via_mqtt: boolean;
    }>(query, params);

    return rows.map((r) => ({
      id: r.id,
      packetId: r.packet_id,
      fromNodeId: r.from_node_id,
      toNodeId: r.to_node_id,
      channelIndex: r.channel_index,
      text: r.text,
      rxTime: r.rx_time,
      rxSnr: r.rx_snr,
      rxRssi: r.rx_rssi,
      hopLimit: r.hop_limit,
      wantAck: r.want_ack,
      viaMqtt: r.via_mqtt,
    }));
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private _emitStatus(
    id: string,
    name: string,
    port: string,
    status: "disconnected" | "connecting" | "connected" | "error",
    connectedAt?: string
  ) {
    const event: ServerEvent = {
      type: "device:status",
      payload: {
        id,
        name,
        port,
        status,
        connectedAt: connectedAt ?? null,
        lastSeenAt: null,
        hardwareModel: null,
        firmwareVersion: null,
      },
    };
    this.emit("event", event);
  }

  private _handleDeviceStatus(
    deviceId: string,
    name: string,
    port: string,
    status: Types.DeviceStatusEnum
  ) {
    if (status === Types.DeviceStatusEnum.DeviceDisconnected) {
      this.devices.delete(deviceId);
      this._emitStatus(deviceId, name, port, "disconnected");
      console.log(`[devices] ${name} disconnected — scheduling reconnect in 5s`);
      this._scheduleReconnect(deviceId, port, name);
    }
  }

  private _scheduleReconnect(deviceId: string, port: string, name: string) {
    if (this.reconnectingPorts.has(port)) return;
    this.reconnectingPorts.add(port);
    setTimeout(async () => {
      this.reconnectingPorts.delete(port);
      if (this.devices.has(deviceId)) return; // already reconnected by another path
      console.log(`[devices] attempting reconnect for ${name} on ${port}`);
      await this.connect(port, name, deviceId).catch((err) => {
        console.warn(`[devices] reconnect failed for ${port}:`, err.message);
        // Will retry on next disconnect event if the device comes back
      });
    }, 5000);
  }

  private async _handleMessage(
    deviceId: string,
    packet: Types.PacketMetadata<string>
  ) {
    const id = randomUUID();
    const rxTime = packet.rxTime.toISOString();

    await this.db.query(
      `INSERT INTO messages(id, packet_id, device_id, from_node_id, to_node_id, channel_index, text, rx_time)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT(id) DO NOTHING`,
      [id, packet.id, deviceId, packet.from, packet.to, packet.channel, packet.data, rxTime]
    );
    await this.db.query("UPDATE devices SET last_seen = $1 WHERE id = $2", [rxTime, deviceId]);

    const event: ServerEvent = {
      type: "message:received",
      payload: {
        id,
        packetId: packet.id,
        fromNodeId: packet.from,
        toNodeId: packet.to,
        channelIndex: packet.channel,
        text: packet.data,
        rxTime,
        rxSnr: null,
        rxRssi: null,
        hopLimit: null,
        wantAck: false,
        viaMqtt: false,
      },
    };
    this.emit("event", event);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async _handleRawPacket(deviceId: string, meshPacket: any) {
    // Use type assertion to access protobuf-es generated fields
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const p = meshPacket as any;
    const isDecoded = p.payloadVariant?.case === "decoded";
    const isEncrypted = p.payloadVariant?.case === "encrypted";

    const portnum: number = isDecoded ? (p.payloadVariant.value.portnum ?? 0) : 0;
    const portnumName: string =
      (Protobuf.Portnums.PortNum as Record<number, string>)[portnum] ?? "UNKNOWN_APP";

    const rxTimeSec: number = p.rxTime ?? 0;
    const rxTime = rxTimeSec > 0
      ? new Date(rxTimeSec * 1000).toISOString()
      : new Date().toISOString();

    let payloadRaw: string | null = null;
    if (isDecoded && p.payloadVariant.value.payload instanceof Uint8Array) {
      payloadRaw = Buffer.from(p.payloadVariant.value.payload).toString("base64");
    } else if (isEncrypted && p.payloadVariant.value instanceof Uint8Array) {
      payloadRaw = Buffer.from(p.payloadVariant.value).toString("base64");
    }

    // Keep node last_heard fresh on every received packet, not just nodeinfo
    const fromNodeId: number = p.from ?? 0;
    const isMqttEcho = p.viaMqtt ?? false;
    console.log(`[devices] raw pkt from=!${fromNodeId.toString(16).padStart(8,"0")} portnum=${portnumName} viaMqtt=${isMqttEcho}`);
    if (fromNodeId !== 0) {
      activityLog.add({
        ts: rxTime,
        source: "mesh",
        portnum: portnumName,
        fromHex: `!${fromNodeId.toString(16).padStart(8, "0")}`,
        region: null,
        gateway: null,
        viaMqtt: isMqttEcho,
      });
    }
    if (fromNodeId !== 0) {
      // Upsert so a node we hear packets from is always tracked, even before nodeinfo arrives
      await this.db.query(
        `INSERT INTO nodes(node_id, device_id, last_heard)
         VALUES ($1, $2, $3)
         ON CONFLICT(node_id, device_id) DO UPDATE SET
           last_heard = GREATEST(EXCLUDED.last_heard, nodes.last_heard)`,
        [fromNodeId, deviceId, rxTime]
      );

      const { rows } = await this.db.query<{
        node_id: number; long_name: string | null; short_name: string | null;
        mac_address: string | null; hw_model: number | null; public_key: string | null;
        snr: number | null; hops_away: number | null;
        latitude: number | null; longitude: number | null; altitude: number | null;
      }>(
        `SELECT node_id, long_name, short_name, mac_address, hw_model, public_key,
                snr, hops_away, latitude, longitude, altitude
         FROM nodes WHERE device_id = $1 AND node_id = $2`,
        [deviceId, fromNodeId]
      );
      if (rows[0]) {
        const r = rows[0];
        const nodeEvent: ServerEvent = {
          type: "node:update",
          payload: {
            nodeId: r.node_id, longName: r.long_name, shortName: r.short_name,
            macAddress: r.mac_address, hwModel: r.hw_model, publicKey: r.public_key,
            lastHeard: rxTime, snr: r.snr, hopsAway: r.hops_away,
            latitude: r.latitude, longitude: r.longitude, altitude: r.altitude,
          },
        };
        this.emit("event", nodeEvent);
      }
    }

    const id = randomUUID();
    await this.db.query(
      `INSERT INTO packets(id, packet_id, device_id, from_node_id, to_node_id, channel,
         portnum, portnum_name, rx_time, rx_snr, rx_rssi, hop_limit, hop_start,
         want_ack, via_mqtt, payload_raw)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
      [
        id,
        p.id ?? 0,
        deviceId,
        p.from ?? 0,
        p.to ?? 0,
        p.channel ?? 0,
        portnum,
        portnumName,
        rxTime,
        p.rxSnr || null,
        p.rxRssi || null,
        p.hopLimit || null,
        p.hopStart || null,
        p.wantAck ?? false,
        p.viaMqtt ?? false,
        payloadRaw,
      ]
    );

    const event: ServerEvent = {
      type: "packet:raw",
      payload: {
        id,
        packetId: p.id ?? 0,
        fromNodeId: p.from ?? 0,
        toNodeId: p.to ?? 0,
        channel: p.channel ?? 0,
        portnum,
        portnumName,
        rxTime,
        rxSnr: p.rxSnr || null,
        rxRssi: p.rxRssi || null,
        hopLimit: p.hopLimit || null,
        hopStart: p.hopStart || null,
        wantAck: p.wantAck ?? false,
        viaMqtt: p.viaMqtt ?? false,
        payloadRaw,
        decodedJson: null,
      },
    };
    this.emit("event", event);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async _handleNodeInfo(deviceId: string, nodeInfo: any) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const n = nodeInfo as any;
    const nodeId: number = n.num ?? 0;
    if (nodeId === 0) return;
    console.log(`[devices] nodeInfo !${nodeId.toString(16).padStart(8,"0")} "${n.user?.longName ?? n.user?.shortName ?? "?"}"`);

    const macBytes: Uint8Array | undefined = n.user?.macaddr;
    const macAddress = macBytes && macBytes.length > 0
      ? Array.from(macBytes).map((b: number) => b.toString(16).padStart(2, "0")).join(":")
      : null;

    const pubKeyBytes: Uint8Array | undefined = n.user?.publicKey;
    const publicKey = pubKeyBytes && pubKeyBytes.length > 0
      ? Buffer.from(pubKeyBytes).toString("hex")
      : null;

    const lastHeardSec: number = n.lastHeard ?? 0;
    const lastHeard = lastHeardSec > 0
      ? new Date(lastHeardSec * 1000).toISOString()
      : null;

    await this.db.query(
      `INSERT INTO nodes(node_id, device_id, long_name, short_name, mac_address,
         hw_model, public_key, last_heard, snr, hops_away)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT(node_id, device_id) DO UPDATE SET
         long_name   = COALESCE(EXCLUDED.long_name,   nodes.long_name),
         short_name  = COALESCE(EXCLUDED.short_name,  nodes.short_name),
         mac_address = COALESCE(EXCLUDED.mac_address, nodes.mac_address),
         hw_model    = COALESCE(EXCLUDED.hw_model,    nodes.hw_model),
         public_key  = COALESCE(EXCLUDED.public_key,  nodes.public_key),
         last_heard  = COALESCE(EXCLUDED.last_heard,  nodes.last_heard),
         snr         = COALESCE(EXCLUDED.snr,         nodes.snr),
         hops_away   = COALESCE(EXCLUDED.hops_away,   nodes.hops_away)`,
      [
        nodeId,
        deviceId,
        n.user?.longName ?? null,
        n.user?.shortName ?? null,
        macAddress,
        n.user?.hwModel ?? null,
        publicKey,
        lastHeard,
        n.snr || null,
        n.hopsAway ?? null,
      ]
    );

    // Read back current position so the emitted event reflects what's actually in DB
    const { rows: posRows } = await this.db.query<{
      latitude: number | null; longitude: number | null; altitude: number | null;
    }>(
      `SELECT latitude, longitude, altitude FROM nodes WHERE device_id = $1 AND node_id = $2`,
      [deviceId, nodeId]
    );
    const pos = posRows[0];

    const event: ServerEvent = {
      type: "node:update",
      payload: {
        nodeId,
        longName: n.user?.longName ?? null,
        shortName: n.user?.shortName ?? null,
        macAddress,
        hwModel: n.user?.hwModel ?? null,
        publicKey,
        lastHeard,
        snr: n.snr || null,
        hopsAway: n.hopsAway ?? null,
        latitude:  pos?.latitude  ?? null,
        longitude: pos?.longitude ?? null,
        altitude:  pos?.altitude  ?? null,
      },
    };
    this.emit("event", event);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async _handlePosition(deviceId: string, pkt: any) {
    const fromNodeId: number = pkt.from ?? 0;
    if (fromNodeId === 0) return;

    const pos = pkt.data;
    if (!pos) return;

    const lat = pos.latitudeI  != null ? pos.latitudeI  / 1e7 : null;
    const lon = pos.longitudeI != null ? pos.longitudeI / 1e7 : null;
    if (lat === null || lon === null || (lat === 0 && lon === 0)) return;

    const alt = pos.altitude ?? null;
    const rxTime = pkt.rxTime instanceof Date
      ? pkt.rxTime.toISOString()
      : new Date().toISOString();

    await this.db.query(
      `UPDATE nodes SET latitude = $1, longitude = $2, altitude = $3, last_heard = GREATEST(last_heard, $4)
       WHERE device_id = $5 AND node_id = $6`,
      [lat, lon, alt, rxTime, deviceId, fromNodeId]
    );

    // Emit update so frontend map refreshes immediately
    const { rows } = await this.db.query<{
      node_id: number; long_name: string | null; short_name: string | null;
      mac_address: string | null; hw_model: number | null; public_key: string | null;
      last_heard: string | null; snr: number | null; hops_away: number | null;
    }>(
      `SELECT node_id, long_name, short_name, mac_address, hw_model, public_key,
              last_heard, snr, hops_away FROM nodes WHERE device_id = $1 AND node_id = $2`,
      [deviceId, fromNodeId]
    );
    if (!rows[0]) return;
    const r = rows[0];
    const event: ServerEvent = {
      type: "node:update",
      payload: {
        nodeId: r.node_id, longName: r.long_name, shortName: r.short_name,
        macAddress: r.mac_address, hwModel: r.hw_model, publicKey: r.public_key,
        lastHeard: r.last_heard, snr: r.snr, hopsAway: r.hops_away,
        latitude: lat, longitude: lon, altitude: alt,
      },
    };
    this.emit("event", event);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async _handleMetadata(deviceId: string, meta: any) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const m = meta as any;
    const hwModel: string | null = m.hwModel != null ? String(m.hwModel) : null;
    const firmware: string | null = m.firmwareVersion ?? null;

    await this.db.query(
      "UPDATE devices SET hw_model = $1, firmware = $2 WHERE id = $3",
      [hwModel, firmware, deviceId]
    );

    // Re-emit device status with updated hw/firmware info
    const device = this.devices.get(deviceId);
    if (device) {
      const event: ServerEvent = {
        type: "device:status",
        payload: {
          id: deviceId,
          name: device.name,
          port: device.port,
          status: "connected",
          connectedAt: device.connectedAt,
          lastSeenAt: null,
          hardwareModel: hwModel,
          firmwareVersion: firmware,
        },
      };
      this.emit("event", event);
    }
  }
}
