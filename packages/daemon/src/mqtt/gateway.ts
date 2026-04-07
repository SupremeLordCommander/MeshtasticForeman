/**
 * MqttGateway — publishes Meshtastic mesh traffic to an MQTT broker.
 *
 * Mirrors what a WiFi-capable Meshtastic device would do natively.
 * Necessary because nRF52-based devices (e.g. Seeed Wio Tracker L1) have no
 * WiFi and cannot connect to MQTT on their own.
 *
 * Topic layout:
 *   {root}/2/e/{channel}/{!gatewayId}  — encrypted ServiceEnvelope (all traffic)
 *   {root}/2/map/                       — unencrypted ServiceEnvelope (MapReport)
 */

import { createCipheriv, randomBytes } from "node:crypto";
import { Buffer } from "node:buffer";
import mqtt from "mqtt";
import { create, toBinary, fromBinary } from "@bufbuild/protobuf";
import { MeshDevice, Types, Protobuf } from "@meshtastic/core";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface MqttGatewayConfig {
  broker: string;
  port: number;
  username: string;
  password: string;
  rootTopic: string;
  /** Re-announce our own node on this interval (ms). Default: 15 minutes. */
  selfAnnounceInterval?: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * The well-known default Meshtastic channel key.
 * PSK value 0x01 ("AQ==") on the device expands to this 16-byte key.
 * Public knowledge — documented in every Meshtastic client.
 */
const DEFAULT_KEY = Buffer.from("1PG7OiApB1nwvP+rz05pAQ==", "base64");

const DEFAULT_SELF_ANNOUNCE_INTERVAL = 15 * 60 * 1000; // 15 minutes

// ---------------------------------------------------------------------------
// Per-device state
// ---------------------------------------------------------------------------

interface ChannelInfo {
  name: string;
  key: Buffer;
}

interface DeviceState {
  nodeNum: number;
  gatewayId: string;
  channels: Map<number, ChannelInfo>;      // channel index → name + AES key
  cachedUser: Protobuf.Mesh.User | null;
  cachedPosition: Protobuf.Mesh.Position | null;
  selfAnnounceTimer: NodeJS.Timeout | null;
  announceScheduled: boolean;              // prevents duplicate announce timers
}

// ---------------------------------------------------------------------------
// MqttGateway
// ---------------------------------------------------------------------------

export class MqttGateway {
  private readonly cfg: Required<MqttGatewayConfig>;
  private client: mqtt.MqttClient | null = null;
  private connected = false;
  private readonly devices = new Map<string, DeviceState>();

  constructor(cfg: MqttGatewayConfig) {
    this.cfg = {
      selfAnnounceInterval: DEFAULT_SELF_ANNOUNCE_INTERVAL,
      ...cfg,
    };
  }

  // ---------------------------------------------------------------------------
  // MQTT connection lifecycle
  // ---------------------------------------------------------------------------

  start(): void {
    const url = `mqtt://${this.cfg.broker}:${this.cfg.port}`;
    this.client = mqtt.connect(url, {
      username: this.cfg.username,
      password: this.cfg.password,
      reconnectPeriod: 5000,
      keepalive: 60,
    });

    this.client.on("connect", () => {
      this.connected = true;
      console.log(`[mqtt] connected to ${this.cfg.broker}`);
      // Re-announce all currently attached devices on reconnect
      for (const [deviceId] of this.devices) {
        this._publishSelf(deviceId).catch(console.error);
      }
    });

    this.client.on("disconnect", () => {
      this.connected = false;
      console.log("[mqtt] disconnected");
    });

    this.client.on("error", (err) => {
      console.error("[mqtt] error:", err.message);
    });
  }

  stop(): void {
    for (const [, state] of this.devices) {
      if (state.selfAnnounceTimer) clearInterval(state.selfAnnounceTimer);
    }
    this.client?.end();
  }

  // ---------------------------------------------------------------------------
  // Device attachment
  // ---------------------------------------------------------------------------

  /**
   * Subscribe to a MeshDevice's events so its traffic is forwarded to MQTT.
   * Call this immediately after the device connects and is configured.
   */
  attachDevice(deviceId: string, meshDevice: MeshDevice): void {
    const state: DeviceState = {
      nodeNum: 0,
      gatewayId: "!00000000",
      channels: new Map(),
      cachedUser: null,
      cachedPosition: null,
      selfAnnounceTimer: null,
      announceScheduled: false,
    };
    this.devices.set(deviceId, state);

    // Schedule a single self-announce once we have both nodeNum and channels.
    // Called after every piece of config arrives — safe to call repeatedly.
    const scheduleAnnounceIfReady = () => {
      if (state.announceScheduled) return;
      if (state.nodeNum === 0 || state.channels.size === 0) return;
      state.announceScheduled = true;
      console.log(`[mqtt] device ${deviceId} ready (${state.gatewayId}), announcing in 2s`);
      setTimeout(() => {
        this._publishSelf(deviceId).catch(console.error);
        if (!state.selfAnnounceTimer) {
          state.selfAnnounceTimer = setInterval(() => {
            this._publishSelf(deviceId).catch(console.error);
          }, this.cfg.selfAnnounceInterval);
        }
      }, 2000);
    };

    // Our own node number — arrives early in the configure handshake
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    meshDevice.events.onMyNodeInfo.subscribe((info: any) => {
      state.nodeNum = info.myNodeNum;
      state.gatewayId = `!${info.myNodeNum.toString(16).padStart(8, "0")}`;
      console.log(`[mqtt] device ${deviceId} nodeNum = ${state.gatewayId}`);
      scheduleAnnounceIfReady();
    });

    // Channel config — needed for channel name and PSK
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    meshDevice.events.onChannelPacket.subscribe((ch: any) => {
      const idx = ch.index;
      const name = ch.settings?.name || "LongFast";
      const rawPsk = ch.settings?.psk;
      const key = rawPsk ? this._expandPsk(rawPsk) : DEFAULT_KEY;
      state.channels.set(idx, { name, key });
      console.log(`[mqtt] device ${deviceId} channel ${idx} = "${name}"`);
      scheduleAnnounceIfReady();
    });

    // Cache our own user info for self-announce
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    meshDevice.events.onNodeInfoPacket.subscribe((nodeInfo: any) => {
      if (nodeInfo.num === state.nodeNum && nodeInfo.user) {
        state.cachedUser = nodeInfo.user as Protobuf.Mesh.User;
      }
    });

    // Cache our own position for self-announce
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    meshDevice.events.onPositionPacket.subscribe((pkt: any) => {
      if (pkt.from === state.nodeNum) {
        state.cachedPosition = pkt.data as Protobuf.Mesh.Position;
      }
    });

    // Forward all raw mesh packets to MQTT
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    meshDevice.events.onMeshPacket.subscribe((pkt: any) => {
      this._handleMeshPacket(deviceId, pkt).catch((err) =>
        console.error(`[mqtt] packet error on ${deviceId}:`, err.message)
      );
    });

    // DeviceConfigured is a fallback trigger in case onMyNodeInfo/onChannelPacket
    // fire after this event (ordering varies by firmware version)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    meshDevice.events.onDeviceStatus.subscribe((status: any) => {
      console.log(`[mqtt] device ${deviceId} status = ${Types.DeviceStatusEnum[status] ?? status}`);
      if (status === Types.DeviceStatusEnum.DeviceConfigured) {
        scheduleAnnounceIfReady();
      }
    });
  }

  detachDevice(deviceId: string): void {
    const state = this.devices.get(deviceId);
    if (!state) return;
    if (state.selfAnnounceTimer) clearInterval(state.selfAnnounceTimer);
    this.devices.delete(deviceId);
  }

  // ---------------------------------------------------------------------------
  // Packet handling
  // ---------------------------------------------------------------------------

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async _handleMeshPacket(deviceId: string, pkt: any): Promise<void> {
    if (!this.connected || !this.client) return;

    const state = this.devices.get(deviceId);
    if (!state) return;

    // Don't re-publish packets that arrived via MQTT downlink
    if (pkt.viaMqtt) return;

    const isDecoded   = pkt.payloadVariant?.case === "decoded";
    const isEncrypted = pkt.payloadVariant?.case === "encrypted";
    if (!isDecoded && !isEncrypted) return;

    const fromNum:  number = pkt.from   ?? 0;
    const toNum:    number = pkt.to     ?? 0xFFFFFFFF;
    const packetId: number = pkt.id     ?? 0;
    const chIdx:    number = pkt.channel ?? 0;
    const rxTime:   number = pkt.rxTime  ?? Math.floor(Date.now() / 1000);
    const hopLimit: number = pkt.hopLimit ?? 3;
    const hopStart: number = pkt.hopStart ?? 0;
    const wantAck:  boolean = pkt.wantAck ?? false;

    const ch = state.channels.get(chIdx) ?? { name: "LongFast", key: DEFAULT_KEY };

    let encryptedPayload: Uint8Array;

    if (isEncrypted) {
      // Packet couldn't be decrypted locally — pass encrypted bytes straight through
      encryptedPayload = pkt.payloadVariant.value as Uint8Array;
    } else {
      // Packet was decrypted by the library — re-encrypt for MQTT
      const portnum: number = pkt.payloadVariant.value.portnum ?? 0;
      const innerPayload: Uint8Array = pkt.payloadVariant.value.payload ?? new Uint8Array();

      const dataBytes = toBinary(Protobuf.Mesh.DataSchema, create(Protobuf.Mesh.DataSchema, {
        portnum,
        payload: innerPayload,
      }));

      encryptedPayload = this._encrypt(ch.key, packetId, fromNum, Buffer.from(dataBytes));
    }

    const meshPkt = create(Protobuf.Mesh.MeshPacketSchema, {
      from:    fromNum,
      to:      toNum,
      channel: chIdx,
      id:      packetId,
      rxTime,
      hopLimit,
      hopStart,
      wantAck,
      payloadVariant: { case: "encrypted", value: encryptedPayload },
    });

    const envelope = create(Protobuf.Mqtt.ServiceEnvelopeSchema, {
      packet:    meshPkt,
      channelId: ch.name,
      gatewayId: state.gatewayId,
    });

    const topic = `${this.cfg.rootTopic}/2/e/${ch.name}/${state.gatewayId}`;
    this.client.publish(topic, Buffer.from(toBinary(Protobuf.Mqtt.ServiceEnvelopeSchema, envelope)));

    const portnumName = isDecoded
      ? ((Protobuf.Portnums.PortNum as Record<number, string>)[pkt.payloadVariant.value.portnum] ?? "?")
      : "encrypted";
    console.log(`[mqtt] pub  ${portnumName} from !${fromNum.toString(16).padStart(8,"0")} → ${topic}`);
  }

  // ---------------------------------------------------------------------------
  // Self-announcement
  // ---------------------------------------------------------------------------

  private async _publishSelf(deviceId: string): Promise<void> {
    if (!this.connected || !this.client) return;

    const state = this.devices.get(deviceId);
    if (!state || state.nodeNum === 0) return;

    const ch = state.channels.get(0) ?? { name: "LongFast", key: DEFAULT_KEY };

    // NODEINFO_APP
    if (state.cachedUser) {
      await this._publishOwnPacket(
        state, ch, Protobuf.Portnums.PortNum.NODEINFO_APP,
        toBinary(Protobuf.Mesh.UserSchema, state.cachedUser),
      );
    }

    // POSITION_APP
    const pos = state.cachedPosition;
    if (pos && (pos.latitudeI || pos.longitudeI)) {
      await this._publishOwnPacket(
        state, ch, Protobuf.Portnums.PortNum.POSITION_APP,
        toBinary(Protobuf.Mesh.PositionSchema, pos),
      );
    }

    // MAP_REPORT_APP — unencrypted, goes to 2/map/
    if (state.cachedUser) {
      await this._publishMapReport(state, ch.name);
    }
  }

  private async _publishOwnPacket(
    state: DeviceState,
    ch: ChannelInfo,
    portnum: Protobuf.Portnums.PortNum,
    innerPayload: Uint8Array,
  ): Promise<void> {
    if (!this.client) return;

    const packetId = this._randomPacketId();
    const dataBytes = toBinary(Protobuf.Mesh.DataSchema, create(Protobuf.Mesh.DataSchema, {
      portnum,
      payload: innerPayload,
    }));
    const encrypted = this._encrypt(ch.key, packetId, state.nodeNum, Buffer.from(dataBytes));

    const meshPkt = create(Protobuf.Mesh.MeshPacketSchema, {
      from:    state.nodeNum,
      to:      0xFFFFFFFF,
      channel: 0,
      id:      packetId,
      rxTime:  Math.floor(Date.now() / 1000),
      hopLimit: 3,
      payloadVariant: { case: "encrypted", value: encrypted },
    });

    const envelope = create(Protobuf.Mqtt.ServiceEnvelopeSchema, {
      packet:    meshPkt,
      channelId: ch.name,
      gatewayId: state.gatewayId,
    });

    const topic = `${this.cfg.rootTopic}/2/e/${ch.name}/${state.gatewayId}`;
    this.client.publish(topic, Buffer.from(toBinary(Protobuf.Mqtt.ServiceEnvelopeSchema, envelope)));
    console.log(`[mqtt] self ${Protobuf.Portnums.PortNum[portnum]} → ${topic}`);
  }

  private async _publishMapReport(state: DeviceState, channelName: string): Promise<void> {
    if (!this.client || !state.cachedUser) return;

    const user = state.cachedUser;
    const pos  = state.cachedPosition;
    const packetId = this._randomPacketId();
    const hasDefaultCh = (state.channels.get(0)?.key ?? DEFAULT_KEY).equals(DEFAULT_KEY);

    const report = create(Protobuf.Mqtt.MapReportSchema, {
      longName:          user.longName,
      shortName:         user.shortName,
      hwModel:           user.hwModel,
      hasDefaultChannel: hasDefaultCh,
      numOnlineLocalNodes: state.channels.size,
      ...(pos?.latitudeI ? {
        latitudeI:  pos.latitudeI,
        longitudeI: pos.longitudeI ?? 0,
        altitude:   pos.altitude   ?? 0,
      } : {}),
    });

    const reportBytes = toBinary(Protobuf.Mqtt.MapReportSchema, report);

    // Map reports: unencrypted MeshPacket (decoded variant), topic = 2/map/
    const data = create(Protobuf.Mesh.DataSchema, {
      portnum: Protobuf.Portnums.PortNum.MAP_REPORT_APP,
      payload: reportBytes,
    });

    const meshPkt = create(Protobuf.Mesh.MeshPacketSchema, {
      from:    state.nodeNum,
      to:      0xFFFFFFFF,
      id:      packetId,
      rxTime:  Math.floor(Date.now() / 1000),
      hopLimit: 3,
      payloadVariant: { case: "decoded", value: data },
    });

    const envelope = create(Protobuf.Mqtt.ServiceEnvelopeSchema, {
      packet:    meshPkt,
      channelId: channelName,
      gatewayId: state.gatewayId,
    });

    const topic = `${this.cfg.rootTopic}/2/map/`;
    this.client.publish(topic, Buffer.from(toBinary(Protobuf.Mqtt.ServiceEnvelopeSchema, envelope)));
    console.log(`[mqtt] self MAP_REPORT_APP → ${topic}`);
  }

  // ---------------------------------------------------------------------------
  // Crypto helpers
  // ---------------------------------------------------------------------------

  private _expandPsk(psk: Uint8Array): Buffer {
    if (psk.length === 1 && psk[0] === 0x01) return DEFAULT_KEY;
    if (psk.length === 16 || psk.length === 32) return Buffer.from(psk);
    return Buffer.from(psk).subarray(0, 16).equals(Buffer.alloc(16))
      ? DEFAULT_KEY
      : Buffer.concat([Buffer.from(psk), Buffer.alloc(16)]).subarray(0, 16);
  }

  private _encrypt(key: Buffer, packetId: number, fromNode: number, plaintext: Buffer): Buffer {
    // Nonce: packetId as uint64 LE (upper 4 bytes = 0) + fromNode as uint64 LE
    const nonce = Buffer.alloc(16);
    nonce.writeUInt32LE(packetId >>> 0, 0);
    nonce.writeUInt32LE(fromNode >>> 0, 8);
    const cipher = createCipheriv("aes-128-ctr", key, nonce);
    return Buffer.concat([cipher.update(plaintext), cipher.final()]);
  }

  private _randomPacketId(): number {
    return randomBytes(4).readUInt32LE(0);
  }
}
