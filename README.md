# MeshtasticForeman

A self-hosted daemon that bridges nRF52-based Meshtastic devices (no WiFi) to an external MQTT broker and provides a local HTTP/WebSocket API for monitoring the mesh.

## Architecture

```
Serial device (COM7)
      │
      ▼
┌─────────────────┐
│  daemon         │  Node.js + Fastify
│  - DeviceManager│  Owns serial connections
│  - MqttGateway  │  Forwards mesh traffic to MQTT broker
│  - PGlite (DB)  │  Persists devices, nodes, messages, packets
│  - REST API     │  /api/devices
│  - WebSocket    │  /ws  (live event stream)
└─────────────────┘
      │                    │
      ▼                    ▼
 web frontend         mqtt.meshtastic.org
 (packages/web)       msh/US/CA/Humboldt/Eureka/2/e/...
```

## Packages

| Package | Description |
|---|---|
| `packages/daemon` | Node.js backend — serial, MQTT, API, DB |
| `packages/web` | React frontend (scaffold only) |
| `packages/shared` | Shared TypeScript types |
| `Samples/proxy.py` | Python prototype (superseded by daemon) |

## Setup

1. Copy `.env.example` to `.env` at the repo root and fill in your values
2. Install dependencies: `pnpm install`
3. Start the daemon: `start-daemon.bat` (or `pnpm --filter @foreman/daemon dev`)

## Environment variables

| Variable | Description |
|---|---|
| `PORT` | Daemon HTTP port (default `3750`) |
| `HOST` | Bind address (default `0.0.0.0`) |
| `MESHTASTIC_PORT` | Serial port of the connected device (e.g. `COM7`) |
| `MESHTASTIC_NAME` | Display name for the device (optional, defaults to port) |
| `MQTT_BROKER` | MQTT broker hostname |
| `MQTT_PORT` | MQTT broker port (default `1883`) |
| `MQTT_USER` | MQTT username |
| `MQTT_PASS` | MQTT password |
| `MQTT_ROOT` | Root topic prefix (e.g. `msh/US/CA/Humboldt/Eureka`) |
| `PGLITE_DIR` | Override path for the PGlite data directory |

## MQTT gateway

The daemon acts as a WiFi gateway for nRF52-based Meshtastic devices that have no WiFi. On startup it:

- Connects to the device via serial
- Subscribes to all mesh events
- Re-encrypts decoded packets with the channel PSK (AES-128-CTR)
- Publishes `ServiceEnvelope` protobufs to `{root}/2/e/{channel}/{!gatewayId}`
- Publishes `MAP_REPORT_APP` to `{root}/2/map/`
- Re-announces the node (NODEINFO + POSITION + MAP_REPORT) every 15 minutes

## What is working

- [x] Serial connection to Meshtastic device, auto-reconnect on disconnect
- [x] MQTT gateway — encrypted packet forwarding + MAP_REPORT
- [x] Device auto-connect from `MESHTASTIC_PORT` env var on daemon startup
- [x] PGlite persistence to disk (worker-thread pattern, Windows compatible)
- [x] REST API: `GET /api/devices`, `POST /api/devices/connect`, `DELETE /api/devices/:id`
- [x] WebSocket event stream at `/ws`
- [x] Minimal React frontend scaffold (device list)

## Next phase — Web frontend

Build a proper web UI inside `packages/web` using the existing REST + WebSocket API:

### Phase goals

1. **Device list panel** — live status of all connected devices pulled from `GET /api/devices` and updated via `device:status` WebSocket events. Show port, hardware model, firmware version, last seen.

2. **Node map** — OpenStreetMap-based map (via Leaflet or react-leaflet) showing all mesh nodes heard by the connected device. Nodes sourced from `node:update` WebSocket events. Each pin shows node ID, long name, SNR, hops away, last heard.

3. **Packet feed** — scrolling list of recent `packet:raw` events with portnum, from/to node IDs, channel, RSSI/SNR.

### Suggested stack additions for web

- `leaflet` + `react-leaflet` — map rendering (no API key required)
- `@tanstack/react-query` — REST data fetching and cache
- A CSS framework or utility library (e.g. Tailwind, or plain CSS modules)
