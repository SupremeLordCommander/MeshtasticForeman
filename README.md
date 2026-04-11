# MeshtasticForeman

**Version:** — see [VERSION.txt](VERSION.txt)

## Goals

A self-hosted API backend and web frontend for Meshtastic devices.

- **Backend daemon** — maintains a persistent serial connection between a Meshtastic device and the server
- **MQTT gateway** — forwards mesh traffic to an MQTT broker (defaults to `mqtt.meshtastic.org`)
- **PostgreSQL-based DB** (via PGlite) — easy to port and query
- **Separate API and frontend** — flexible deployment; the daemon serves the frontend in production
- **Full replacement** for the abilities found in `client.meshtastic.org`
- **Unified ETL** — mesh and MQTT data normalized to a single interface
- **Richer device data** — exposes additional info like GPS connection status
- **User-assignable metadata** — alias names, manual positions, and notes on any node
- **Modular** — individual subsystems (MQTT gateway, auto-connect) can be toggled via environment variables
- **Installers** - Windows and Linux based devices for easy deployment



## NOTE!

This is still an alpha project. I have goals but am learning as I go. I have drawn heavily from what [https://github.com/meshtastic/](https://github.com/meshtastic/) was already doing.

This is built in partnership with AI. If that bothers you, please don't run it!

## Architecture

```
Serial device (e.g. COM7)
      │
      ▼
┌──────────────────────┐
│  daemon              │  Node.js + Fastify
│  - DeviceManager     │  Owns serial connections, auto-reconnect
│  - MqttGateway       │  Forwards mesh traffic to MQTT broker
│  - PGlite (DB)       │  Persists devices, nodes, messages, packets
│  - REST API          │  /api/devices, /api/nodes, /api/messages, …
│  - WebSocket         │  /ws  (live event stream)
│  - Static file host  │  Serves the built frontend
└──────────────────────┘
         │                        │
         ▼                        ▼
  web frontend              mqtt.meshtastic.org
  (packages/web)            msh/US/CA/Humboldt/Eureka/2/e/...
```

## Packages

| Package | Description |
|---|---|
| `packages/daemon` | Node.js backend — serial, MQTT, API, DB |
| `packages/web` | React frontend — full UI (nodes, map, messages, config, …) |
| `packages/shared` | Shared TypeScript types |
| `Samples/proxy.py` | Python prototype (superseded by daemon) |

## Setup

1. Copy `.env.example` to `.env` at the repo root and fill in your values
2. Install dependencies: `pnpm install`
3. Start everything: `start-both.ps1` (Windows) or `start-both.sh` (Unix)
   - `start-api.ps1` / `start-api.sh` — daemon only
   - `start-frontend.ps1` / `start-frontend.sh` — frontend dev server only

## Environment variables

| Variable | Description |
|---|---|
| `MESHTASTIC_PORT` | Serial port of the connected device (e.g. `COM7`, `/dev/ttyUSB0`) |
| `MESHTASTIC_NAME` | Display name for the device (optional, defaults to port) |
| `API_PORT` | Daemon HTTP port (default `3172`) |
| `API_HOST` | Daemon bind address (default `0.0.0.0`) |
| `API_URI` | Base URI the frontend uses to reach the daemon (default `http://localhost`) |
| `FRONTEND_PORT` | Frontend dev server port (default `3173`) |
| `FRONTEND_HOST` | Frontend dev server bind address (default `0.0.0.0`) |
| `MQTT_BROKER` | MQTT broker hostname (gateway disabled if unset) |
| `MQTT_PORT` | MQTT broker port (default `1883`) |
| `MQTT_USER` | MQTT username |
| `MQTT_PASS` | MQTT password |
| `MQTT_ROOT` | Root topic prefix (e.g. `msh/US/CA/Humboldt/Eureka`) |
| `PGLITE_DIR` | Override path for the PGlite data directory |
| `VITE_MAP_STYLE` | MapLibre GL style JSON URL (default: OpenFreeMap liberty style) |

## MQTT gateway

The daemon acts as a WiFi gateway for nRF52-based Meshtastic devices that have no WiFi. When `MQTT_BROKER` is set it:

- Connects to the device via serial
- Subscribes to all mesh events
- Re-encrypts decoded packets with the channel PSK (AES-128-CTR)
- Publishes `ServiceEnvelope` protobufs to `{root}/2/e/{channel}/{!gatewayId}`
- Publishes `MAP_REPORT_APP` to `{root}/2/map/`
- Re-announces the node (NODEINFO + POSITION + MAP_REPORT) every 15 minutes

## What is working

- [x] Serial connection to Meshtastic device, auto-reconnect on disconnect
- [x] MQTT gateway — encrypted packet forwarding + MAP_REPORT (optional, enabled by `MQTT_BROKER`)
- [x] Device auto-connect from `MESHTASTIC_PORT` env var on daemon startup
- [x] PGlite persistence to disk (worker-thread pattern, Windows compatible)
- [x] REST API: devices, nodes, node overrides, messages, device config, MQTT nodes
- [x] WebSocket event stream at `/ws`
- [x] Hardware model name sync from the Meshtastic protobufs repo
- [x] Web frontend — Nodes list, Map (MapLibre GL), Messages, Activity feed, Logs, Node overrides, Device config

## Things I'm looking into

- [ ] **Message delivery confirmation** — combine MQTT data with the message system to create a back-channel for verifying receipt
- [ ] **Cross-mesh relay** — when a recipient is out of direct range, use MQTT to hand the message off to another relay node that can reach them
- [ ] **Traceroute visualization** — display traceroute paths on the map
- [ ] **Ping data** — surface device ping/latency info in the UI
- [ ] **Node list improvements** — find a cleaner way to present node data
- [ ] **Message system bugs** — ongoing fixes to the messaging subsystem
- [ ] **Multi-device MQTT messages** — use a private channel key to decrypt messages from other devices via MQTT
- [ ] **Multiple devices connected to the same API backend daemon.


## Contributing

Patches, bug reports, and feature suggestions are all welcome! This is a community project and contributions of any size are appreciated.

1. Fork the repo and create a branch for your change
2. Make your changes and test them locally
3. Open a pull request with a clear description of what you changed and why

If you're not sure where to start, open an issue first to discuss the idea — no PR required just to have a conversation.

## Thanks

None of this would exist without the incredible work done by the [Meshtastic](https://meshtastic.org) team and community. They built the firmware, the protocol, the client libraries, and the broader ecosystem that this project builds on top of.

- [meshtastic.org](https://meshtastic.org) — official site, docs, and firmware downloads
- [github.com/meshtastic](https://github.com/meshtastic/) — all of their open-source repositories
