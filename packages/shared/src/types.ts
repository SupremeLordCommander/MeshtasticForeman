// Core domain types shared between daemon and web

export type ConnectionStatus =
  | "disconnected"
  | "connecting"
  | "connected"
  | "error";

export interface DeviceInfo {
  id: string;
  name: string;
  port: string;
  status: ConnectionStatus;
  connectedAt: string | null;
  lastSeenAt: string | null;
  hardwareModel: string | null;
  firmwareVersion: string | null;
}

export interface NodeInfo {
  nodeId: number;
  longName: string | null;
  shortName: string | null;
  macAddress: string | null;
  hwModel: number | null;
  publicKey: string | null;
  lastHeard: string | null;
  snr: number | null;
  hopsAway: number | null;
  latitude: number | null;
  longitude: number | null;
  altitude: number | null;
}

export interface Message {
  id: string;
  packetId: number;
  fromNodeId: number;
  toNodeId: number;
  channelIndex: number;
  text: string;
  rxTime: string;
  rxSnr: number | null;
  rxRssi: number | null;
  hopLimit: number | null;
  wantAck: boolean;
  viaMqtt: boolean;
}

export interface Packet {
  id: string;
  packetId: number;
  fromNodeId: number;
  toNodeId: number;
  channel: number;
  portnum: number;
  portnumName: string;
  rxTime: string;
  rxSnr: number | null;
  rxRssi: number | null;
  hopLimit: number | null;
  hopStart: number | null;
  wantAck: boolean;
  viaMqtt: boolean;
  payloadRaw: string | null; // base64 encoded
  decodedJson: string | null; // JSON string of decoded payload
}

export interface Channel {
  index: number;
  name: string | null;
  role: number;
  psk: string | null; // base64
}

export interface MqttNode {
  nodeId: number;
  longName: string | null;
  shortName: string | null;
  hwModel: number | null;
  publicKey: string | null;
  lastHeard: string | null;
  latitude: number | null;
  longitude: number | null;
  altitude: number | null;
  lastGateway: string | null;
  regionPath: string | null;
  snr: number | null;
  hopsAway: number | null;
  distanceM: number | null;
}

export interface Waypoint {
  id: number;
  name: string;
  description: string | null;
  latitude: number;
  longitude: number;
  icon: number | null;
  lockedTo: number | null;
  expire: string | null;
}

export interface ActivityEntry {
  id: number;           // monotonic sequence number
  ts: string;           // ISO timestamp
  source: "mesh" | "mqtt";
  portnum: string;      // e.g. "POSITION_APP", "TELEMETRY_APP"
  fromHex: string;      // "!43577e14"
  region: string | null;   // MQTT only
  gateway: string | null;  // MQTT only
  viaMqtt: boolean;        // mesh: was packet a downlink echo
}

export interface LogEntry {
  id: number;
  ts: string;
  level: "log" | "warn" | "error";
  tag: string;   // "devices", "mqtt", "ws", etc. — empty string for untagged
  text: string;
}

export interface NodeOverride {
  nodeId: number;
  aliasName: string | null;
  latitude: number | null;
  longitude: number | null;
  altitude: number | null;
  notes: string | null;
}
