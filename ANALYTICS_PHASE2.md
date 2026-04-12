# Analytics Phase 2 — Frontend Implementation Guide

This document gives a second workstation everything it needs to build the
Analytics frontend while Phase 1 (backend API routes) is being written in
parallel on another machine.

---

## Project Overview

**MeshtasticForeman** is a self-hosted web dashboard for managing Meshtastic
mesh radio networks. It is a monorepo (`pnpm` workspaces) with three packages:

| Package | Purpose |
|---|---|
| `packages/daemon` | Fastify API + PGlite (in-process PostgreSQL) + WebSocket server |
| `packages/web` | React 19 + Vite frontend (TypeScript, inline styles only) |
| `packages/shared` | Shared TypeScript types used by both |

The frontend talks to the daemon two ways:
- **REST** — `fetch("/api/...")` (proxied by Vite in dev to `localhost:3000`)
- **WebSocket** — live event stream for nodes, messages, activity, logs

---

## Design System

No CSS framework, no Tailwind. All styles are **inline `React.CSSProperties`**
objects defined at the bottom of each file. Follow this pattern exactly.

### Colour Palette

```ts
// Backgrounds
page bg:        #0f172a   // outermost page
card/panel bg:  #0f172a
header bg:      #020617
border:         #1e293b   // dividers, card borders
border-hover:   #334155

// Text
primary:        #e2e8f0
secondary:      #94a3b8
muted:          #64748b
label:          #475569

// Accent colours (used consistently across pages)
blue:    #60a5fa   // mesh source, primary actions
green:   #34d399   // MQTT source, connected/ok
purple:  #a78bfa   // packet types / portnums
orange:  #fb923c   // database tag
amber:   #fbbf24   // warnings
red:     #ef4444   // errors, disconnected
slate:   #94a3b8   // devices tag / neutral

// Chart-specific suggestions
snr-good:   #22c55e
snr-mid:    #f59e0b
snr-bad:    #ef4444
```

### Typography

```ts
fontFamily: "monospace"   // used everywhere — this is the app font
fontSize defaults:
  body/table:  "0.75rem"
  label/small: "0.7rem"
  section hdr: "0.7rem", fontWeight: "bold", letterSpacing: "0.08em",
               textTransform: "uppercase", color: "#64748b"
```

### Common Patterns

```tsx
// Section header (used in cards and stat tables)
<div style={{
  fontSize: "0.7rem", fontWeight: "bold", letterSpacing: "0.08em",
  textTransform: "uppercase", color: "#64748b",
  paddingBottom: "0.4rem", borderBottom: "1px solid #1e293b",
  marginBottom: "0.75rem",
}}>
  Section Title
</div>

// Card/panel
<div style={{
  background: "#0f172a", borderRadius: "0.5rem", padding: "0.75rem",
  border: "1px solid #1e293b",
}}>
  ...
</div>

// Active tab button (see tabStyle() in App.tsx)
background: active ? "#3b82f6" : "transparent"
color:      active ? "#fff"    : "#94a3b8"
border: "none", padding: "0.35rem 1rem", borderRadius: "0.375rem"
cursor: "pointer", fontFamily: "monospace", fontSize: "0.8rem"
```

---

## What Already Exists (Do Not Recreate)

### Existing Pages (packages/web/src/pages/)

| File | Tab key |
|---|---|
| `NodesPage.tsx` | `"nodes"` |
| `MapPage.tsx` | `"map"` |
| `MessagesPage.tsx` | `"messages"` |
| `ActivityPage.tsx` | `"activity"` |
| `LogsPage.tsx` | `"logs"` |
| `NodeOverridesPage.tsx` | `"overrides"` |
| `DeviceConfigPage.tsx` | `"config"` |

### Existing Shared Types (packages/shared/src/types.ts)

```ts
NodeInfo {
  nodeId: number;
  longName: string | null;
  shortName: string | null;
  hwModel: number | null;       // numeric hw model enum
  lastHeard: string | null;     // ISO timestamp
  snr: number | null;           // dB float
  hopsAway: number | null;
  latitude: number | null;
  longitude: number | null;
  altitude: number | null;
  macAddress: string | null;
  publicKey: string | null;
}

MqttNode {
  nodeId: number;
  longName: string | null;
  shortName: string | null;
  hwModel: number | null;
  lastHeard: string | null;
  snr: number | null;
  hopsAway: number | null;
  latitude: number | null;
  longitude: number | null;
  altitude: number | null;
  distanceM: number | null;
  regionPath: string | null;
  lastGateway: string | null;
}

DeviceInfo { id, name, port, status, firmwareVersion, batteryLevel, ... }
```

### Existing Live API Endpoints (Available Right Now)

```
GET  /api/devices                     → DeviceInfo[]
GET  /api/devices/:id/nodes           → NodeInfo[]
GET  /api/mqtt-nodes                  → MqttNode[]
GET  /api/hw-models                   → { modelNum: number; name: string }[]
GET  /api/traceroutes?since=&deviceId= → TracerouteRecord[]
GET  /api/node-overrides              → NodeOverride[]
```

`TracerouteRecord` shape (from existing endpoint):
```ts
{
  id: string;
  deviceId: string;
  fromNodeId: number;
  toNodeId: number;
  route: number[];       // intermediate node IDs
  routeBack: number[];   // return path node IDs
  recordedAt: string;    // ISO timestamp
}
```

---

## Phase 1 API Contract

These endpoints **do not exist yet** — they are being written on the other
machine. Build your fetch calls and components against these shapes.  
Use mock/static data while waiting; the real endpoints will slot in cleanly.

All Phase 1 endpoints live under `/api/analytics/`.

### Common Query Parameters

All endpoints accept:
- `?since=` — ISO timestamp or shorthand (`1h`, `6h`, `24h`, `7d`). Omit for all-time.
- `?deviceId=` — restrict to one device (UUID). Omit for all devices.

### 1. SNR History

```
GET /api/analytics/snr-history?since=&nodeId=&deviceId=
```

Returns time-bucketed SNR and RSSI readings per node, drawn from the
`messages` table.

```ts
// Response: SnrHistoryPoint[]
interface SnrHistoryPoint {
  ts: string;         // ISO timestamp (bucket start, 5-minute granularity)
  nodeId: number;
  snr: number | null; // average rx_snr in bucket (dB, float)
  rssi: number | null;// average rx_rssi in bucket (dBm, int)
  count: number;      // number of messages in bucket
}
```

Query params:
- `?nodeId=` — filter to a single node (numeric node ID)
- `?since=` — default `24h`

### 2. Message Volume

```
GET /api/analytics/message-volume?since=&bucket=&deviceId=
```

```ts
// Response: MessageVolumePoint[]
interface MessageVolumePoint {
  ts: string;        // ISO timestamp (bucket start)
  received: number;
  sent: number;
  relayed: number;
  total: number;
}
```

Query params:
- `?bucket=hour|day` — time bucket size (default `hour`)
- `?since=` — default `7d`

### 3. Message Delivery

```
GET /api/analytics/message-delivery?since=&deviceId=
```

```ts
// Response: MessageDeliveryStats
interface MessageDeliveryStats {
  acked: number;
  pending: number;
  error: number;
  total: number;
  // error breakdown
  errorTypes: { type: string; count: number }[];
}
```

Only counts messages where `role = 'sent'` and `want_ack = true`.

### 4. Busiest Nodes

```
GET /api/analytics/busiest-nodes?since=&limit=&deviceId=
```

```ts
// Response: BusiestNode[]
interface BusiestNode {
  nodeId: number;
  received: number;
  sent: number;
  relayed: number;
  total: number;
}
```

Query params:
- `?limit=` — max results (default 20)
- `?since=` — default `7d`

### 5. Portnum Breakdown

```
GET /api/analytics/portnum-breakdown?since=&deviceId=
```

```ts
// Response: PortnumCount[]
interface PortnumCount {
  portnumName: string;  // e.g. "POSITION_APP", "TELEMETRY_APP"
  count: number;
}
```

Drawn from the `packets` table.

### 6. Packet Timeline

```
GET /api/analytics/packet-timeline?since=&bucket=&deviceId=
```

```ts
// Response: PacketTimelinePoint[]
interface PacketTimelinePoint {
  ts: string;             // ISO timestamp (bucket start)
  counts: {
    [portnumName: string]: number;  // e.g. POSITION_APP: 12
  };
  total: number;
}
```

Query params:
- `?bucket=minute|hour` — default `hour`
- `?since=` — default `24h`

### 7. Hop Distribution

```
GET /api/analytics/hop-distribution?deviceId=
```

```ts
// Response: HopBucket[]
interface HopBucket {
  hopsAway: number;  // 0, 1, 2, 3, ...
  count: number;
}
```

Drawn from the `nodes` table (`hops_away` column). No `since` param needed.

### 8. Hardware Breakdown

```
GET /api/analytics/hardware-breakdown?deviceId=
```

```ts
// Response: HardwareBucket[]
interface HardwareBucket {
  hwModel: number;      // numeric protobuf enum value
  hwModelName: string;  // resolved name e.g. "HELTEC_V3"
  count: number;
}
```

Joins `nodes.hw_model` → `hw_models.name`. No `since` param needed.

### 9. Channel Utilization

```
GET /api/analytics/channel-utilization?since=&deviceId=
```

```ts
// Response: ChannelBucket[]
interface ChannelBucket {
  channelIndex: number;    // 0–7
  channelName: string | null; // from channels table, null if unnamed
  received: number;
  sent: number;
  relayed: number;
  total: number;
}
```

### 10. Message Latency

```
GET /api/analytics/message-latency?since=&deviceId=
```

```ts
// Response: LatencyHistogram
interface LatencyHistogram {
  buckets: {
    label: string;    // e.g. "<1s", "1-5s", "5-30s", "30s-1m", ">1m"
    count: number;
    maxMs: number;    // upper bound in milliseconds for this bucket
  }[];
  medianMs: number | null;
  p95Ms: number | null;
  totalSamples: number;
}
```

Only counts messages where `role = 'sent'`, `ack_status = 'acked'`, and
`ack_at IS NOT NULL`.

---

## What to Build

### Step 1: Install Dependencies

In `packages/web/`:

```bash
pnpm add recharts
pnpm add react-force-graph-2d
pnpm add --save-dev @types/react-force-graph-2d
```

`recharts` covers all standard charts (line, bar, area, pie).  
`react-force-graph-2d` covers the traceroute topology graph only.

### Step 2: Add the Analytics Tab

In [packages/web/src/App.tsx](packages/web/src/App.tsx):

**A.** Add `"analytics"` to the `Tab` type (line ~17):
```ts
type Tab = "nodes" | "map" | "messages" | "activity" | "logs" | "overrides" | "config" | "analytics";
```

**B.** Add the nav button in the `<nav>` block (around line 305–308), after
the Messages button:
```tsx
<button style={tabStyle(tab === "analytics")} onClick={() => setTab("analytics")}>Analytics</button>
```

**C.** Add the tab render block after the `config` block (around line 666):
```tsx
{tab === "analytics" && (
  <div style={{ flex: 1, overflowY: "auto" }}>
    <AnalyticsPage nodes={effectiveNodes} mqttNodes={effectiveMqttNodes} />
  </div>
)}
```

**D.** Import at the top:
```ts
import { AnalyticsPage } from "./pages/AnalyticsPage.js";
```

### Step 3: Create the Analytics Page

Create `packages/web/src/pages/AnalyticsPage.tsx`.

The page receives two props (already available in App.tsx state):

```ts
interface Props {
  nodes: NodeInfo[];
  mqttNodes: MqttNode[];
}
```

The page has **four internal sub-tabs**:

```ts
type AnalyticsTab = "signal" | "messages" | "network" | "packets";
```

Sub-tab nav sits at the top of the page content area (not in the main header).
Style it similarly to the existing tab buttons but slightly smaller, and use a
`border-bottom` underline style rather than filled buttons if you want visual
distinction from the main nav.

---

### Sub-tab: Signal Quality

Charts (all using `recharts`):

**SNR Over Time** — `LineChart`
- Fetch: `GET /api/analytics/snr-history?since=24h`
- X axis: `ts` (formatted as `HH:MM`)
- Y axis: SNR (dB) — label as "SNR (dB)"
- One `<Line>` per unique `nodeId` in the response
- Node display name: resolve via `nodes` prop — `node.longName ?? node.shortName ?? "!"+nodeId.toString(16).padStart(8,"0")`
- Color lines using the same HSL hash pattern used in MapPage for node colors
- Add a time range selector: `1h | 6h | 24h | 7d`
- Show a second `LineChart` below for RSSI (dBm) using the same data

**Node selector**: Multi-select list of node names to toggle which lines show.
Default: show all. Cap at 8 nodes shown simultaneously for readability.

---

### Sub-tab: Messages

**Message Volume Timeline** — `AreaChart` (stacked)
- Fetch: `GET /api/analytics/message-volume?since=7d&bucket=hour`
- X axis: `ts`
- Three stacked `<Area>` series: `received` (#60a5fa), `sent` (#34d399), `relayed` (#a78bfa)
- Time range selector: `6h | 24h | 7d | 30d`; bucket auto-switches to `hour` for <7d, `day` for ≥7d

**Delivery Success Rate** — `PieChart` with inner radius (donut)
- Fetch: `GET /api/analytics/message-delivery`
- Three slices: Acked (#34d399), Pending (#f59e0b), Error (#ef4444)
- Show count + percentage in tooltip
- Show a small summary below: e.g. "47 / 52 delivered (90.4%)"

**Busiest Nodes** — `BarChart` (horizontal)
- Fetch: `GET /api/analytics/busiest-nodes?since=7d&limit=15`
- Layout: `layout="vertical"`, Y axis = node name, X axis = count
- Stacked bars: received, sent, relayed (same colours as volume chart)
- Resolve node names from the `nodes` prop

**Channel Utilization** — `BarChart`
- Fetch: `GET /api/analytics/channel-utilization`
- X axis: channel index (0–7), labelled as `name ?? "Ch N"`
- Stacked bars: received, sent, relayed

**Message Latency** — `BarChart` (histogram)
- Fetch: `GET /api/analytics/message-latency`
- X axis: bucket labels (`<1s`, `1-5s`, etc.)
- Y axis: count
- Bar colour: #60a5fa
- Show median and p95 as text summary above chart: "Median: 2.1s · p95: 14s · 47 samples"

---

### Sub-tab: Network

**Hop Distance Distribution** — `BarChart`
- Fetch: `GET /api/analytics/hop-distribution`
- X axis: hops (0, 1, 2, …)
- Y axis: node count
- Label x=0 as "Direct"
- Bar colour: #60a5fa

**Hardware Model Breakdown** — `PieChart` (donut)
- Fetch: `GET /api/analytics/hardware-breakdown`
- One slice per `hwModelName`
- Use a colour palette cycling through: `#60a5fa #34d399 #a78bfa #fb923c #fbbf24 #f87171 #94a3b8 #22d3ee`
- Show legend below pie

**Traceroute Topology Graph** — `react-force-graph-2d`
- Fetch: `GET /api/traceroutes` (existing endpoint, no Phase 1 needed)
- Build graph data from the route arrays:
  ```ts
  // nodes = unique nodeIds across all traceroutes
  // links = pairs of adjacent nodes in each route
  // e.g. route [A, B, C, D] → links A→B, B→C, C→D
  ```
- Node label: resolved long/short name or hex ID
- Edge label: not needed
- Node colour: same HSL hash as map markers
- Size canvas to fill available panel width; fix height at ~500px
- Add a "since" filter: `1h | 6h | 24h | 7d | all` (pass as `?since=` to the traceroutes endpoint)
- Show node count and link count as a small summary line

---

### Sub-tab: Packets

**Portnum Breakdown** — `PieChart` (donut)
- Fetch: `GET /api/analytics/portnum-breakdown`
- One slice per `portnumName`
- Colour cycle: `#a78bfa #60a5fa #34d399 #fb923c #fbbf24 ...`
- Show raw counts in legend/tooltip
- Add time range selector: `1h | 6h | 24h | 7d`

**Packet Volume Timeline** — `AreaChart` (stacked)
- Fetch: `GET /api/analytics/packet-timeline?since=24h&bucket=hour`
- One `<Area>` per portnum name
- Top 6 portnums by count get individual series; remainder collapsed into "Other"
- X axis: `ts`, Y axis: count per bucket
- Time range selector: `1h | 6h | 24h | 7d`

---

## Mock Data Pattern

While Phase 1 endpoints aren't live, stub each fetch like this:

```ts
// At the top of the component or in a hook
const [data, setData] = useState<SnrHistoryPoint[]>([]);

useEffect(() => {
  // TODO: replace mock with real fetch when Phase 1 is ready
  setData(SNR_MOCK_DATA);
  /*
  fetch(`/api/analytics/snr-history?since=${since}`)
    .then(r => r.json())
    .then(setData)
    .catch(console.error);
  */
}, [since]);
```

Put mock data constants in a sibling file:
`packages/web/src/pages/analytics-mocks.ts`

---

## Recharts Usage Notes

Install once; import per-component:

```tsx
import {
  LineChart, Line, BarChart, Bar, AreaChart, Area,
  PieChart, Pie, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend,
  ResponsiveContainer,
} from "recharts";
```

Always wrap charts in `<ResponsiveContainer width="100%" height={300}>`.

Dark theme wiring for Recharts:

```tsx
<CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
<XAxis dataKey="ts" tick={{ fill: "#64748b", fontSize: 11, fontFamily: "monospace" }} />
<YAxis tick={{ fill: "#64748b", fontSize: 11, fontFamily: "monospace" }} />
<Tooltip
  contentStyle={{ background: "#0f172a", border: "1px solid #334155", borderRadius: "0.375rem", fontFamily: "monospace", fontSize: "0.75rem" }}
  labelStyle={{ color: "#94a3b8" }}
  itemStyle={{ color: "#e2e8f0" }}
/>
<Legend wrapperStyle={{ fontSize: "0.72rem", fontFamily: "monospace", color: "#94a3b8" }} />
```

---

## react-force-graph-2d Usage Notes

```tsx
import ForceGraph2D from "react-force-graph-2d";

// Graph data shape
const graphData = {
  nodes: [{ id: nodeId, name: displayName, color: "#60a5fa" }],
  links: [{ source: fromId, target: toId }],
};

<ForceGraph2D
  graphData={graphData}
  nodeLabel="name"
  nodeColor={(n: any) => n.color}
  linkColor={() => "#334155"}
  backgroundColor="#0f172a"
  width={containerWidth}
  height={500}
  nodeCanvasObjectMode={() => "after"}
  nodeCanvasObject={(node: any, ctx, globalScale) => {
    // Draw node label below the circle
    const label = node.name;
    const fontSize = 12 / globalScale;
    ctx.font = `${fontSize}px monospace`;
    ctx.fillStyle = "#94a3b8";
    ctx.textAlign = "center";
    ctx.fillText(label, node.x, node.y + 8);
  }}
/>
```

Use a `useRef` + `ResizeObserver` to track container width for the `width` prop.

---

## File Checklist

```
packages/web/src/pages/
  AnalyticsPage.tsx          ← new, main page component
  analytics-mocks.ts         ← new, mock data for dev
packages/web/src/App.tsx     ← add "analytics" tab (3 small edits)
packages/web/package.json    ← add recharts + react-force-graph-2d
```

No new files needed anywhere else. Do **not** create new routes, server files,
or shared types — those are Phase 1 work on the other machine.

---

## Coordination Notes

- Phase 1 endpoints will be registered at `/api/analytics/*` — all under that prefix, no exceptions
- All Phase 1 responses are plain JSON arrays or objects (no pagination wrapper)
- Timestamps are always ISO 8601 strings (UTC)
- `nodeId` is always a plain `number` (uint32 Meshtastic node number)
- Node display name resolution is always: `longName ?? shortName ?? "!" + nodeId.toString(16).padStart(8, "0")`
- The daemon runs on port **3000** in dev; Vite proxies `/api` and `/ws` automatically via `vite.config.ts`
- Use `pnpm dev` from `packages/web/` to start the frontend dev server
- Use `pnpm dev` from `packages/daemon/` to start the backend (requires a `.env` in the repo root)
