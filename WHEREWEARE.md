# Where We Are — Meshtastic Foreman

## Why This Project Exists

This is a ground-up replacement for the official `meshtastic_web` client (Patrick's fork lives at `D:\Projects\GitHub\meshtastic_web`). The original project has fundamental architectural problems:

- **All connection logic runs in the browser** — Web Serial/Bluetooth APIs were never designed for daemon-like continuous operation. Connections die when the tab closes, the browser throttles background tabs, and there is no clean way to add packet logging without breaking the stream.
- **Industrial use case requires 24/7 uptime** — devices may send/receive data for days. A browser tab is not an acceptable runtime for this.
- **Security bypass extensions** — the HTTP transport requires CORS-bypass browser extensions because Meshtastic devices don't serve proper CORS headers. This is a red flag, not a workaround.
- **Packet logging is broken by design** — because the serial stream goes through the browser, there is no place to tap it without competing for the stream.

The correct architecture: a **Node.js daemon** owns all device connections and runs indefinitely. The **browser frontend** is a pure UI that connects to the daemon via WebSocket. Page reload, tab close, browser crash — none of it affects the device connection.

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
│   ├── daemon/                  # Node.js process
│   │   └── src/
│   │       ├── index.ts         # Fastify server entry point, port 3750
│   │       ├── db/
│   │       │   ├── client.ts    # PGlite singleton (data dir: ./pglite-data)
│   │       │   └── migrations.ts # Schema + migration runner
│   │       ├── device/
│   │       │   └── device-manager.ts  # Owns connections, emits ServerEvents
│   │       └── routes/
│   │           ├── devices.ts   # REST: GET /api/devices, POST /api/devices/connect, DELETE /api/devices/:id
│   │           └── websocket.ts # WS /ws — broadcasts events, handles ClientCommands
│   ├── shared/                  # Protocol contract used by both daemon and web
│   │   └── src/
│   │       ├── types.ts         # Domain types: DeviceInfo, NodeInfo, Message, Packet, Channel, Waypoint
│   │       ├── ws-protocol.ts   # ServerEvent union type + ClientCommand Zod schemas
│   │       └── index.ts         # Re-exports
│   └── web/                     # React 19 + Vite frontend
│       └── src/
│           ├── ws/client.ts     # ForemanClient — auto-reconnecting WebSocket singleton
│           ├── App.tsx          # Skeleton UI (device list wired to WS events)
│           └── main.tsx         # React entry point
├── package.json                 # pnpm workspace root, onlyBuiltDependencies configured
├── pnpm-workspace.yaml
├── .npmrc
└── .gitignore
```

---

## Key Technical Decisions

| Decision | Choice | Why |
|---|---|---|
| Backend framework | Fastify | Lightweight, TypeScript-native, excellent WebSocket plugin |
| Database | PGlite (embedded Postgres) | Full SQL semantics, no separate server process, single-writer fits single-daemon model |
| Frontend | React 19 + Vite | Familiar, fast, no SSR needed — this is a tool UI not a website |
| No Next.js | Deliberate | Next.js is built around stateless request/response — it fights you when you need persistent device connections |
| Meshtastic packages | `@meshtastic/core@2.6.7`, `@meshtastic/transport-node-serial@0.0.2` | Official packages published to npm, reuse protobuf handling |

---

## PGlite Schema (migration 001)

Tables: `devices`, `nodes`, `messages`, `packets`, `channels`, `waypoints`, `schema_migrations`

All tables except `devices` have `device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE` — data is fully partitioned by device. Multiple devices never bleed into each other.

PGlite data directory: `./pglite-data` (relative to repo root, gitignored). Override with `PGLITE_DIR` env var.

---

## WebSocket Protocol

**Server → Client** (`ServerEvent` union in `shared/src/ws-protocol.ts`):
- `device:list` — full device snapshot sent on connect
- `device:status` — single device status update
- `node:update` / `node:list`
- `message:received` / `message:history`
- `packet:raw` — raw decoded packet (only sent if client subscribed)
- `channel:list`, `waypoint:update`, `waypoint:list`
- `error` — `{ code: string, message: string }`

**Client → Server** (`ClientCommand` discriminated union, validated with Zod):
- `message:send` — requires `deviceId`, `text`, `toNodeId`, `channelIndex`, `wantAck`
- `packets:subscribe` — requires `deviceId`, `enabled`
- `messages:request-history` — requires `deviceId`, optional `channelIndex`, `toNodeId`, `limit`, `before`

**All client commands require `deviceId: z.string().uuid()`** — this was added deliberately so multi-device routing is explicit at the protocol level from day one. The WS handler validates the device exists and returns `DEVICE_NOT_FOUND` before touching any device logic.

---

## What Is NOT Wired Up Yet (next work)

The `DeviceManager` has the multi-device Map and DB persistence in place, but the actual `MeshDevice` + `SerialConnection` instantiation is stubbed with TODO comments. This is the next piece to build:

1. **`device-manager.ts` `connect()` method** — instantiate `SerialConnection` from `@meshtastic/transport-node-serial`, attach `MeshDevice` from `@meshtastic/core`, subscribe to packet events
2. **`handlePacket()` method** — decode portnum, write to `packets` table, emit `packet:raw` event; if `portnum === TEXT_MESSAGE_APP`, also write to `messages` table and emit `message:received`
3. **`websocket.ts` `message:send` handler** — call `device.meshDevice.sendText()` once MeshDevice is wired
4. **`messages:request-history` handler** — query `messages` table with filters and stream results back
5. **Auto-reconnect on serial disconnect** — detect disconnect event from transport, wait, retry `connect()`

---

## Running the Project

```bash
# Install dependencies
pnpm install

# Dev mode (run daemon and web in parallel)
pnpm dev

# Daemon only
pnpm --filter @foreman/daemon dev

# Web only
pnpm --filter @foreman/web dev
```

Daemon runs on port 3750. Web dev server on port 5173.

---

## Context on Patrick (user)

Building this for an **industrial Meshtastic deployment** — devices running 24/7, potentially days between human interaction. The old browser-based architecture was fundamentally unsuitable. He identified the architectural problems independently and the reasoning is sound. He understands the tradeoffs well.
