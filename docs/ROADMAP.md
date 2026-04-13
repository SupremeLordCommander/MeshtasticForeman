# Roadmap

## Working now

- [x] Serial connection to Meshtastic device, auto-reconnect on disconnect
- [x] MQTT gateway — encrypted packet forwarding + MAP_REPORT
- [x] Device auto-connect from `MESHTASTIC_PORT` on daemon startup
- [x] PGlite persistence to disk (worker-thread pattern, Windows compatible)
- [x] REST API: devices, nodes, node overrides, messages, device config, MQTT nodes
- [x] WebSocket event stream at `/ws`
- [x] Hardware model name sync from the Meshtastic protobufs repo
- [x] Full web frontend — Nodes, Map, Messages, Analytics, Activity, Logs, Overrides, Device Config

## In progress / exploring

- [ ] **Message delivery confirmation** — combine MQTT data with the message system to create a back-channel for verifying receipt
- [ ] **Cross-mesh relay** — when a recipient is out of direct range, use MQTT to hand the message off to another relay node that can reach them
- [ ] **Traceroute visualization** — display traceroute paths on the map
- [ ] **Ping data** — surface device ping/latency info in the UI
- [ ] **Node list improvements** — cleaner presentation of node data
- [ ] **Message system stability** — ongoing fixes to the messaging subsystem
- [ ] **Multi-device MQTT messages** — use a private channel key to decrypt messages from other devices via MQTT
- [ ] **Multiple devices per daemon** — connect more than one device to the same backend

## Ideas welcome

Open an issue to discuss features before building — saves everyone time.
