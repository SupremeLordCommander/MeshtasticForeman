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
