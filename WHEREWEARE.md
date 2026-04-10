# Where We Are — Meshtastic Foreman

## Why This Project Exists

A ground-up replacement for the official `meshtastic_web` client. The original runs all connection logic in the browser — connections die on tab close, background throttling kills it, no place to tap packets without competing for the serial stream. The correct architecture: a **Node.js daemon** owns all device connections and runs indefinitely. The browser frontend is a pure UI over WebSocket.

---

## Architecture

```
[Meshtastic Device(s)]
        |
   Serial / TCP
        |
[Node.js Daemon]   ← owns connections forever, logs all packets to PGlite
  Fastify HTTP + WebSocket server
  PGlite (embedded Postgres) for all persistence
  DeviceManager — one MeshDevice instance per physical device
        |
    WebSocket /ws
        |
[React/Vite Frontend]  ← pure UI, zero hardware access
  Auto-reconnecting WS client (2s retry)
  Gets state snapshot on connect
  Multiple clients can connect simultaneously
```

In production: daemon serves the built frontend bundle. Single process, single port (3750).
In dev: Vite (port 5173) proxies `/api` and `/ws` to daemon on port 3750.

---

## Monorepo Structure

```
MeshtasticForeman/
├── packages/
│   ├── daemon/src/
│   │   ├── index.ts                  # Fastify entry point, port 3750
│   │   ├── db/
│   │   │   ├── client.ts             # PGlite singleton (./pglite-data, override with PGLITE_DIR)
│   │   │   └── migrations.ts         # All schema migrations (currently 010)
│   │   ├── device/
│   │   │   └── device-manager.ts     # Owns connections, handles all packet events
│   │   ├── mqtt/
│   │   │   └── gateway.ts            # MQTT uplink via regional broker
│   │   └── routes/
│   │       ├── devices.ts            # REST: GET/POST/DELETE /api/devices
│   │       └── websocket.ts          # WS /ws
│   ├── shared/src/
│   │   ├── types.ts                  # Domain types
│   │   ├── ws-protocol.ts            # ServerEvent union + ClientCommand Zod schemas
│   │   └── index.ts
│   └── web/src/
│       ├── ws/client.ts              # ForemanClient — auto-reconnecting WS singleton
│       ├── App.tsx                   # Tab navigation shell
│       └── pages/
│           ├── NodesPage.tsx
│           ├── NodeDetailPanel.tsx   # Per-node side panel with mini chat UI
│           ├── MapPage.tsx
│           ├── ActivityPage.tsx
│           ├── LogsPage.tsx
│           ├── DeviceConfigPage.tsx
│           └── NodeOverridesPage.tsx
├── Samples/
│   └── proxy.py                      # MQTT uplink for WiFi-less devices (nRF52840)
└── start-both.ps1                    # Launches daemon + web in one terminal
```

---

## Running the Project

```bash
pnpm install
pnpm dev           # daemon (3750) + web (5173) in parallel
```

Or use `start-both.ps1` from the repo root.

---

## Database Schema — Current (migration 010)

| Table | Purpose |
|---|---|
| `devices` | Connected serial devices. Columns: `id`, `name`, `port`, `hw_model`, `firmware`, `radio_config` (JSONB), `module_config` (JSONB), `created_at`, `last_seen` |
| `nodes` | Mesh nodes heard by each device. PK `(node_id, device_id)`. Includes position, SNR, hops_away |
| `messages` | All text messages — received, sent by us, and relayed (see below) |
| `packets` | Every raw mesh packet (all portnums), for the activity/debug view |
| `channels` | Channel config per device (name, role, PSK) |
| `waypoints` | Waypoints broadcast on the mesh |
| `mqtt_nodes` | Nodes seen via MQTT regional subscription (separate from local mesh nodes) |
| `node_overrides` | Local display-only name/position overrides for nodes that never broadcast their own |
| `hw_models` | Hardware model number → canonical name, synced from Meshtastic protobufs repo |
| `schema_migrations` | Migration version tracker |

### `messages` table columns

```sql
id            TEXT PRIMARY KEY        -- UUID
packet_id     BIGINT NOT NULL         -- Meshtastic packet ID (used for ACK matching)
device_id     TEXT NOT NULL           -- FK → devices(id) ON DELETE CASCADE
from_node_id  BIGINT NOT NULL
to_node_id    BIGINT NOT NULL
channel_index INT NOT NULL DEFAULT 0
text          TEXT                    -- nullable: NULL for encrypted relayed packets
rx_time       TIMESTAMPTZ NOT NULL    -- receive time (or send time for role='sent')
rx_snr        REAL
rx_rssi       INT
hop_limit     INT
want_ack      BOOLEAN NOT NULL DEFAULT false
via_mqtt      BOOLEAN NOT NULL DEFAULT false
role          TEXT NOT NULL DEFAULT 'received'   -- 'received' | 'sent' | 'relayed'
ack_status    TEXT                    -- 'pending' | 'acked' | 'error' | NULL
ack_at        TIMESTAMPTZ             -- when ACK/NACK arrived
ack_error     TEXT                    -- Routing_Error name on NACK (e.g. 'NO_ROUTE')
```

**Role semantics:**
- `received` — came off the radio, decoded, addressed to us or broadcast
- `sent` — we originated it via `message:send`; `ack_status='pending'` if `wantAck=true`, NULL if not
- `relayed` — encrypted DM for another node that passed through us; `text` is NULL

**ACK flow:** ROUTING_APP (portnum 5) packets are decoded in `_handleRawPacket`. `requestId` on the inner Data proto links back to the sent message's `packet_id`. On ACK → `ack_status='acked'`. On NACK → `ack_status='error'`, `ack_error='NO_ROUTE'` etc.

---

## WebSocket Protocol (current)

**Server → Client** (`ServerEvent` in `shared/src/ws-protocol.ts`):

| Event | Payload | When |
|---|---|---|
| `device:list` | `DeviceInfo[]` | On connect (snapshot) |
| `device:status` | `DeviceInfo` | Device connect/disconnect |
| `node:update` / `node:list` | `NodeInfo` / `NodeInfo[]` | Node heard or on connect |
| `message:received` | `Message` | Incoming text message |
| `message:sent` | `Message` | Outbound message confirmed sent (real packetId) |
| `message:history` | `Message[]` | Response to `messages:request-history` |
| `message:ack` | `{ messageId, packetId, status, ackAt, ackError }` | Delivery ACK or NACK |
| `packet:raw` | `Packet` | Raw decoded packet (subscribers only) |
| `channel:list` | `Channel[]` | On connect or config change |
| `waypoint:update` / `waypoint:list` | `Waypoint` / `Waypoint[]` | Waypoint events |
| `mqtt_node:update` / `mqtt_node:list` | `MqttNode` / `MqttNode[]` | MQTT-sourced nodes |
| `traceroute:result` | `{ nodeId, route, routeBack }` | Traceroute response |
| `activity:entry` / `activity:snapshot` | `ActivityEntry` / `ActivityEntry[]` | Packet activity log |
| `log:entry` / `log:snapshot` | `LogEntry` / `LogEntry[]` | Console log stream |
| `device:config` | `DeviceConfig` | Radio + module config |
| `error` | `{ code, message }` | Command errors |

**Client → Server** (Zod-validated `ClientCommand`):

| Command | Required payload |
|---|---|
| `message:send` | `deviceId`, `text`, `toNodeId`, `channelIndex`, `wantAck` |
| `messages:request-history` | `deviceId`, optional `channelIndex`, `toNodeId`, `limit`, `before` |
| `packets:subscribe` | `deviceId`, `enabled` |
| `nodes:request-list` | `deviceId` |
| `traceroute:send` | `deviceId`, `nodeId` |
| `waypoints:request-list` | `deviceId` |
| `channels:request-list` | `deviceId` |
| `node:remove` | `deviceId`, `nodeId` |
| `device:request-config` | `deviceId` |
| `device:set-config` | `deviceId`, `section`, `config` |

---

## Key Types (`shared/src/types.ts`)

```typescript
export type MessageRole = "received" | "sent" | "relayed";
export type AckStatus = "pending" | "acked" | "error";

export interface Message {
  id: string;
  packetId: number;
  fromNodeId: number;
  toNodeId: number;
  channelIndex: number;
  text: string | null;       // null for encrypted relayed packets
  rxTime: string;
  rxSnr: number | null;
  rxRssi: number | null;
  hopLimit: number | null;
  wantAck: boolean;
  viaMqtt: boolean;
  role: MessageRole;
  ackStatus: AckStatus | null;  // null = no ACK requested or non-sent message
  ackAt: string | null;
  ackError: string | null;
}
```

---

## Messaging System — What Was Built (this session)

We built the full message storage and delivery tracking pipeline:

1. **Migration 009** — `role` column on messages, `text` made nullable, role index
2. **Migration 010** — `ack_status`, `ack_at`, `ack_error` columns, partial index on pending
3. **Sent message storage** — `message:send` handler captures `packetId` returned by `sendText()`, looks up our node ID via `getMyNodeId()`, inserts as `role='sent'` with `ack_status='pending'` (or NULL if `wantAck=false`), broadcasts `message:sent` event
4. **Relay storage** — `_handleRawPacket` detects encrypted TEXT_MESSAGE_APP packets going to other specific nodes (not us, not broadcast) and stores them as `role='relayed'` with `text=NULL`
5. **ACK tracking** — `_handleRawPacket` detects ROUTING_APP (portnum 5) packets, decodes with `fromBinary(Protobuf.Mesh.RoutingSchema, ...)`, extracts `requestId`, updates the matching sent message, emits `message:ack`

---

## Messaging UI — DONE

All three parts completed:

1. **NodeDetailPanel** — uses `useConversation(nodeId)` from store; handles `message:sent` (replaces optimistic), `message:ack` (updates status), ACK indicators (⏳/✓/✗), relayed messages dimmed with label.
2. **MessagesPage** (`packages/web/src/pages/MessagesPage.tsx`) — two-panel layout: conversation list left, thread right. "Messages" tab added to main nav.
3. **Message store** (`packages/web/src/store/messages.ts`) — module-level `Map<nodeId, Message[]>`, initialized once at startup in App.tsx. Both NodeDetailPanel and MessagesPage share state.

---

## Future Idea — MQTT Message Bridging (Hop-Limit Bypass)

The mesh enforces a hard hop limit (default 3). Nodes too far away — or separated by dead zones — can't be reached directly.

**The idea:** when Foreman wants to send a message to a node it can't reach (or that is beyond hop range), publish the message to the MQTT broker as a properly-formed `ServiceEnvelope` protobuf on the right regional topic. Other Foreman instances (or any MQTT-enabled gateway) subscribed to that topic would receive it and inject it into their local mesh, delivering it to the target node over the last few hops.

This is essentially the same thing the official firmware does when `uplink_enabled`/`downlink_enabled` are set on a channel — but we'd be controlling it from the application layer with smarter routing logic.

**Open questions to plan out:**
- Distance boundary logic — how do we decide when to go via MQTT vs. direct mesh? Candidates: `hopsAway` threshold, last-heard age, RSSI/SNR floor, or no-route ACK error triggering a retry via MQTT.
- Which nodes can act as downlink injection points? Need to know which MQTT-connected Foreman instances are "near" the target (GPS bounding box? same region topic?).
- Do we need a Foreman-to-Foreman coordination channel on MQTT (separate topic) to advertise node coverage areas?
- Message deduplication — a node might receive the same message both over-the-air and via MQTT downlink.
- Key/encryption — outbound `ServiceEnvelope` must be encrypted with the channel PSK the target node is listening on. Foreman already stores channel PSKs in the `channels` table.

**Not planning yet — just noting the idea.**

---

## MQTT Gateway — Status: WORKING

The device is a **SEEED_WIO_TRACKER_L1** (nRF52840, no WiFi). `Samples/proxy.py` connects via serial and publishes properly-encrypted `ServiceEnvelope` protobufs to the regional MQTT broker. Local device (`!9ee3d61e`) appears on `meshtastic.org/map`.

`Samples/.env` (copy from `.env.example`):
```
MESHTASTIC_PORT=COM7
MQTT_BROKER=mqtt.meshtastic.org
MQTT_PORT=1883
MQTT_USER=meshdev
MQTT_PASS=large4cats
MQTT_ROOT=msh/US/CA/Humboldt/Eureka
```
