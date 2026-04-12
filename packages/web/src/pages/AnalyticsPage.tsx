import { useState, useEffect, useMemo, useRef, lazy, Suspense } from "react";
import type { NodeInfo, MqttNode } from "@foreman/shared";
import {
  LineChart, Line, BarChart, Bar, AreaChart, Area,
  PieChart, Pie, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend,
  ResponsiveContainer,
} from "recharts";

const ForceGraph2D = lazy(() => import("react-force-graph-2d"));

// ---------------------------------------------------------------------------
// API response types (match packages/daemon/src/routes/analytics.ts)
// ---------------------------------------------------------------------------

interface SnrHistoryPoint {
  ts: string;
  nodeId: number;
  snr: number | null;
  rssi: number | null;
  count: number;
}

interface MessageVolumePoint {
  ts: string;
  received: number;
  sent: number;
  relayed: number;
  total: number;
}

interface MessageDeliveryStats {
  acked: number;
  pending: number;
  error: number;
  total: number;
  errorTypes: { type: string; count: number }[];
}

interface BusiestNode {
  nodeId: number;
  received: number;
  sent: number;
  relayed: number;
  total: number;
}

interface PortnumCount {
  portnumName: string;
  count: number;
}

interface PacketTimelinePoint {
  ts: string;
  counts: Record<string, number>;
  total: number;
}

interface HopBucket {
  hopsAway: number;
  count: number;
}

interface HardwareBucket {
  hwModel: number;
  hwModelName: string;
  count: number;
}

interface ChannelBucket {
  channelIndex: number;
  channelName: string | null;
  received: number;
  sent: number;
  relayed: number;
  total: number;
}

interface LatencyHistogram {
  buckets: { label: string; maxMs: number; count: number }[];
  medianMs: number | null;
  p95Ms: number | null;
  totalSamples: number;
}

interface TracerouteRecord {
  id: string;
  deviceId: string;
  fromNodeId: number;
  toNodeId: number;
  route: number[];
  routeBack: number[];
  recordedAt: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function nodeHex(id: number): string {
  return `!${id.toString(16).padStart(8, "0")}`;
}

function nodeName(id: number, nodes: NodeInfo[], mqttNodes: MqttNode[]): string {
  const n = (nodes as Array<NodeInfo | MqttNode>).concat(mqttNodes).find((x) => x.nodeId === id);
  if (!n) return nodeHex(id);
  return n.longName ?? n.shortName ?? nodeHex(id);
}

/** Deterministic HSL colour from a node ID — same hashing as MapPage. */
function nodeColor(id: number): string {
  const h = Math.round((id * 137.508) % 360);
  return `hsl(${h},65%,60%)`;
}

function formatTs(ts: string, bucket = "hour"): string {
  const d = new Date(ts);
  if (bucket === "day") return d.toLocaleDateString([], { month: "short", day: "numeric" });
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
}

function formatMs(ms: number | null): string {
  if (ms === null) return "—";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}

async function apiFetch<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json() as Promise<T>;
}

// ---------------------------------------------------------------------------
// Recharts dark-theme constants
// ---------------------------------------------------------------------------

const GRID_COLOR  = "#1e293b";
const TICK_STYLE  = { fill: "#64748b", fontSize: 11, fontFamily: "monospace" };
const TOOLTIP_STYLE = {
  contentStyle: {
    background: "#0f172a", border: "1px solid #334155",
    borderRadius: "0.375rem", fontFamily: "monospace", fontSize: "0.75rem",
  },
  labelStyle: { color: "#94a3b8" },
  itemStyle:  { color: "#e2e8f0" },
};

const ROLE_COLORS  = { received: "#60a5fa", sent: "#34d399", relayed: "#a78bfa" };
const PIE_PALETTE  = ["#60a5fa","#34d399","#a78bfa","#fb923c","#fbbf24","#f87171","#94a3b8","#22d3ee","#e879f9","#4ade80"];

// ---------------------------------------------------------------------------
// Shared UI primitives
// ---------------------------------------------------------------------------

function ChartCard({ title, children, fullWidth }: {
  title: string;
  children: React.ReactNode;
  fullWidth?: boolean;
}) {
  return (
    <div style={{ ...styles.card, gridColumn: fullWidth ? "1 / -1" : undefined }}>
      <div style={styles.cardTitle}>{title}</div>
      {children}
    </div>
  );
}

function Empty({ message = "No data" }: { message?: string }) {
  return (
    <div style={styles.empty}>{message}</div>
  );
}

function Loading() {
  return <div style={styles.empty}>Loading…</div>;
}

function RangeBtn({ options, value, onChange }: {
  options: string[];
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div style={{ display: "flex", gap: "0.25rem", marginBottom: "0.6rem" }}>
      {options.map((o) => (
        <button key={o} style={rangeStyle(value === o)} onClick={() => onChange(o)}>{o}</button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tab 1 — Signal Quality
// ---------------------------------------------------------------------------

function SignalTab({ nodes, mqttNodes }: { nodes: NodeInfo[]; mqttNodes: MqttNode[] }) {
  const [since, setSince]     = useState("24h");
  const [snrData, setSnrData] = useState<SnrHistoryPoint[] | null>(null);

  useEffect(() => {
    setSnrData(null);
    apiFetch<SnrHistoryPoint[]>(`/api/analytics/snr-history?since=${since}`)
      .then(setSnrData)
      .catch(() => setSnrData([]));
  }, [since]);

  // Collect unique node IDs, sorted by total count desc (cap at 8 lines)
  const topNodes = useMemo(() => {
    if (!snrData) return [];
    const totals = new Map<number, number>();
    for (const p of snrData) totals.set(p.nodeId, (totals.get(p.nodeId) ?? 0) + p.count);
    return [...totals.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([id]) => id);
  }, [snrData]);

  // Pivot: one row per timestamp bucket, one key per nodeId
  const pivotedSnr = useMemo(() => {
    if (!snrData) return [];
    const byTs = new Map<string, Record<string, unknown>>();
    for (const p of snrData) {
      if (!topNodes.includes(p.nodeId)) continue;
      if (!byTs.has(p.ts)) byTs.set(p.ts, { ts: p.ts });
      byTs.get(p.ts)![String(p.nodeId)] = p.snr;
    }
    return [...byTs.values()].sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
  }, [snrData, topNodes]);

  const pivotedRssi = useMemo(() => {
    if (!snrData) return [];
    const byTs = new Map<string, Record<string, unknown>>();
    for (const p of snrData) {
      if (!topNodes.includes(p.nodeId)) continue;
      if (!byTs.has(p.ts)) byTs.set(p.ts, { ts: p.ts });
      byTs.get(p.ts)![String(p.nodeId)] = p.rssi;
    }
    return [...byTs.values()].sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
  }, [snrData, topNodes]);

  const hasData = snrData !== null && snrData.length > 0;

  return (
    <div style={styles.grid}>
      <ChartCard title="SNR over Time (dB)" fullWidth>
        <RangeBtn options={["1h","6h","24h","7d"]} value={since} onChange={setSince} />
        {snrData === null ? <Loading /> : !hasData ? <Empty /> : (
          <ResponsiveContainer width="100%" height={260}>
            <LineChart data={pivotedSnr}>
              <CartesianGrid strokeDasharray="3 3" stroke={GRID_COLOR} />
              <XAxis dataKey="ts" tickFormatter={(v) => formatTs(v)} tick={TICK_STYLE} />
              <YAxis tick={TICK_STYLE} unit=" dB" />
              <Tooltip {...TOOLTIP_STYLE} labelFormatter={(v) => new Date(v as string).toLocaleString()} />
              <Legend wrapperStyle={styles.legendWrap} />
              {topNodes.map((id) => (
                <Line
                  key={id}
                  dataKey={String(id)}
                  name={nodeName(id, nodes, mqttNodes)}
                  stroke={nodeColor(id)}
                  dot={false}
                  connectNulls
                />
              ))}
            </LineChart>
          </ResponsiveContainer>
        )}
      </ChartCard>

      <ChartCard title="RSSI over Time (dBm)" fullWidth>
        {snrData === null ? <Loading /> : !hasData ? <Empty /> : (
          <ResponsiveContainer width="100%" height={260}>
            <LineChart data={pivotedRssi}>
              <CartesianGrid strokeDasharray="3 3" stroke={GRID_COLOR} />
              <XAxis dataKey="ts" tickFormatter={(v) => formatTs(v)} tick={TICK_STYLE} />
              <YAxis tick={TICK_STYLE} unit=" dBm" />
              <Tooltip {...TOOLTIP_STYLE} labelFormatter={(v) => new Date(v as string).toLocaleString()} />
              <Legend wrapperStyle={styles.legendWrap} />
              {topNodes.map((id) => (
                <Line
                  key={id}
                  dataKey={String(id)}
                  name={nodeName(id, nodes, mqttNodes)}
                  stroke={nodeColor(id)}
                  dot={false}
                  connectNulls
                />
              ))}
            </LineChart>
          </ResponsiveContainer>
        )}
      </ChartCard>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tab 2 — Messages
// ---------------------------------------------------------------------------

function MessagesTab({ nodes, mqttNodes }: { nodes: NodeInfo[]; mqttNodes: MqttNode[] }) {
  const [since, setSince] = useState("7d");
  const bucket = since === "30d" ? "day" : "hour";

  const [volume,   setVolume]   = useState<MessageVolumePoint[] | null>(null);
  const [delivery, setDelivery] = useState<MessageDeliveryStats | null>(null);
  const [busiest,  setBusiest]  = useState<BusiestNode[] | null>(null);
  const [channels, setChannels] = useState<ChannelBucket[] | null>(null);
  const [latency,  setLatency]  = useState<LatencyHistogram | null>(null);

  useEffect(() => {
    setVolume(null);
    apiFetch<MessageVolumePoint[]>(`/api/analytics/message-volume?since=${since}&bucket=${bucket}`)
      .then(setVolume).catch(() => setVolume([]));
  }, [since, bucket]);

  useEffect(() => {
    setDelivery(null);
    apiFetch<MessageDeliveryStats>(`/api/analytics/message-delivery?since=${since}`)
      .then(setDelivery).catch(() => setDelivery({ acked: 0, pending: 0, error: 0, total: 0, errorTypes: [] }));
  }, [since]);

  useEffect(() => {
    setBusiest(null);
    apiFetch<BusiestNode[]>(`/api/analytics/busiest-nodes?since=${since}`)
      .then(setBusiest).catch(() => setBusiest([]));
  }, [since]);

  useEffect(() => {
    setChannels(null);
    apiFetch<ChannelBucket[]>(`/api/analytics/channel-utilization?since=${since}`)
      .then(setChannels).catch(() => setChannels([]));
  }, [since]);

  useEffect(() => {
    setLatency(null);
    apiFetch<LatencyHistogram>(`/api/analytics/message-latency?since=${since}`)
      .then(setLatency).catch(() => setLatency(null));
  }, [since]);

  // Delivery donut data
  const deliverySlices = delivery ? [
    { name: "Acked",   value: delivery.acked,   fill: "#34d399" },
    { name: "Pending", value: delivery.pending,  fill: "#f59e0b" },
    { name: "Error",   value: delivery.error,    fill: "#ef4444" },
  ].filter((s) => s.value > 0) : [];

  // Busiest nodes with resolved names
  const busiestRows = useMemo(() => (busiest ?? []).map((b) => ({
    ...b,
    name: nodeName(b.nodeId, nodes, mqttNodes),
  })), [busiest, nodes, mqttNodes]);

  // Channel utilization with display names
  const channelRows = useMemo(() => (channels ?? []).map((c) => ({
    ...c,
    label: c.channelName ? `${c.channelName} (${c.channelIndex})` : `Ch ${c.channelIndex}`,
  })), [channels]);

  return (
    <div style={styles.grid}>
      {/* Range selector spanning full width */}
      <div style={{ gridColumn: "1 / -1" }}>
        <RangeBtn options={["6h","24h","7d","30d"]} value={since} onChange={setSince} />
      </div>

      {/* Message Volume — full width */}
      <ChartCard title="Message Volume" fullWidth>
        {volume === null ? <Loading /> : volume.length === 0 ? <Empty /> : (
          <ResponsiveContainer width="100%" height={220}>
            <AreaChart data={volume}>
              <CartesianGrid strokeDasharray="3 3" stroke={GRID_COLOR} />
              <XAxis dataKey="ts" tickFormatter={(v) => formatTs(v, bucket)} tick={TICK_STYLE} />
              <YAxis tick={TICK_STYLE} allowDecimals={false} />
              <Tooltip {...TOOLTIP_STYLE} labelFormatter={(v) => new Date(v as string).toLocaleString()} />
              <Legend wrapperStyle={styles.legendWrap} />
              <Area type="monotone" dataKey="received" name="Received" stackId="a" fill={ROLE_COLORS.received + "80"} stroke={ROLE_COLORS.received} />
              <Area type="monotone" dataKey="sent"     name="Sent"     stackId="a" fill={ROLE_COLORS.sent     + "80"} stroke={ROLE_COLORS.sent} />
              <Area type="monotone" dataKey="relayed"  name="Relayed"  stackId="a" fill={ROLE_COLORS.relayed  + "80"} stroke={ROLE_COLORS.relayed} />
            </AreaChart>
          </ResponsiveContainer>
        )}
      </ChartCard>

      {/* Delivery Rate */}
      <ChartCard title="Delivery Rate">
        {delivery === null ? <Loading /> : delivery.total === 0 ? <Empty message="No sent messages with ACK requested" /> : (
          <>
            <div style={styles.deliverySummary}>
              {delivery.total > 0 && (
                <span style={{ color: "#94a3b8" }}>
                  {delivery.acked} / {delivery.total} delivered
                  <span style={{ color: "#64748b" }}> ({Math.round((delivery.acked / delivery.total) * 100)}%)</span>
                </span>
              )}
            </div>
            <ResponsiveContainer width="100%" height={200}>
              <PieChart>
                <Pie dataKey="value" data={deliverySlices} innerRadius={55} outerRadius={80} paddingAngle={3}>
                  {deliverySlices.map((s, i) => <Cell key={i} fill={s.fill} />)}
                </Pie>
                <Tooltip {...TOOLTIP_STYLE} />
                <Legend wrapperStyle={styles.legendWrap} />
              </PieChart>
            </ResponsiveContainer>
            {delivery.errorTypes.length > 0 && (
              <div style={{ marginTop: "0.5rem" }}>
                <div style={styles.subLabel}>Error breakdown</div>
                {delivery.errorTypes.map((e) => (
                  <div key={e.type} style={styles.errorRow}>
                    <span style={{ color: "#f87171" }}>{e.type}</span>
                    <span style={{ color: "#64748b" }}>{e.count}</span>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </ChartCard>

      {/* Channel Utilization */}
      <ChartCard title="Channel Utilization">
        {channels === null ? <Loading /> : channels.length === 0 ? <Empty /> : (
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={channelRows}>
              <CartesianGrid strokeDasharray="3 3" stroke={GRID_COLOR} />
              <XAxis dataKey="label" tick={TICK_STYLE} />
              <YAxis tick={TICK_STYLE} allowDecimals={false} />
              <Tooltip {...TOOLTIP_STYLE} />
              <Legend wrapperStyle={styles.legendWrap} />
              <Bar dataKey="received" name="Received" stackId="a" fill={ROLE_COLORS.received} />
              <Bar dataKey="sent"     name="Sent"     stackId="a" fill={ROLE_COLORS.sent} />
              <Bar dataKey="relayed"  name="Relayed"  stackId="a" fill={ROLE_COLORS.relayed} />
            </BarChart>
          </ResponsiveContainer>
        )}
      </ChartCard>

      {/* Busiest Nodes — full width */}
      <ChartCard title="Busiest Nodes" fullWidth>
        {busiest === null ? <Loading /> : busiest.length === 0 ? <Empty /> : (
          <ResponsiveContainer width="100%" height={Math.max(200, busiestRows.length * 28)}>
            <BarChart layout="vertical" data={busiestRows}>
              <CartesianGrid strokeDasharray="3 3" stroke={GRID_COLOR} horizontal={false} />
              <XAxis type="number" tick={TICK_STYLE} allowDecimals={false} />
              <YAxis type="category" dataKey="name" width={160} tick={{ ...TICK_STYLE, fontSize: 10 }} />
              <Tooltip {...TOOLTIP_STYLE} />
              <Legend wrapperStyle={styles.legendWrap} />
              <Bar dataKey="received" name="Received" stackId="a" fill={ROLE_COLORS.received} />
              <Bar dataKey="sent"     name="Sent"     stackId="a" fill={ROLE_COLORS.sent} />
              <Bar dataKey="relayed"  name="Relayed"  stackId="a" fill={ROLE_COLORS.relayed} />
            </BarChart>
          </ResponsiveContainer>
        )}
      </ChartCard>

      {/* Message Latency */}
      <ChartCard title="Message Latency (ACK round-trip)" fullWidth>
        {latency === null ? <Loading /> : latency.totalSamples === 0 ? <Empty message="No ACKed messages in this window" /> : (
          <>
            <div style={styles.latencySummary}>
              <span>Median: <strong style={{ color: "#e2e8f0" }}>{formatMs(latency.medianMs)}</strong></span>
              <span>p95: <strong style={{ color: "#e2e8f0" }}>{formatMs(latency.p95Ms)}</strong></span>
              <span style={{ color: "#64748b" }}>{latency.totalSamples} samples</span>
            </div>
            <ResponsiveContainer width="100%" height={200}>
              <BarChart data={latency.buckets}>
                <CartesianGrid strokeDasharray="3 3" stroke={GRID_COLOR} />
                <XAxis dataKey="label" tick={TICK_STYLE} />
                <YAxis tick={TICK_STYLE} allowDecimals={false} />
                <Tooltip {...TOOLTIP_STYLE} />
                <Bar dataKey="count" name="Messages" fill="#60a5fa" />
              </BarChart>
            </ResponsiveContainer>
          </>
        )}
      </ChartCard>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tab 3 — Network
// ---------------------------------------------------------------------------

function NetworkTab({ nodes, mqttNodes }: { nodes: NodeInfo[]; mqttNodes: MqttNode[] }) {
  const [hops,     setHops]     = useState<HopBucket[] | null>(null);
  const [hardware, setHardware] = useState<HardwareBucket[] | null>(null);
  const [routes,   setRoutes]   = useState<TracerouteRecord[] | null>(null);
  const [graphSince, setGraphSince] = useState("24h");

  const containerRef = useRef<HTMLDivElement>(null);
  const [graphWidth, setGraphWidth] = useState(600);

  useEffect(() => {
    apiFetch<HopBucket[]>("/api/analytics/hop-distribution").then(setHops).catch(() => setHops([]));
    apiFetch<HardwareBucket[]>("/api/analytics/hardware-breakdown").then(setHardware).catch(() => setHardware([]));
  }, []);

  useEffect(() => {
    setRoutes(null);
    const q = graphSince !== "all" ? `?since=${graphSince}` : "";
    apiFetch<TracerouteRecord[]>(`/api/traceroutes${q}`).then(setRoutes).catch(() => setRoutes([]));
  }, [graphSince]);

  // Measure container for graph width
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      setGraphWidth(entries[0].contentRect.width - 32);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Build force-graph data from traceroutes
  const graphData = useMemo(() => {
    if (!routes) return { nodes: [], links: [] };
    const nodeIds = new Set<number>();
    const edgeSet = new Set<string>();
    const links: { source: number; target: number }[] = [];

    for (const tr of routes) {
      const path = [tr.fromNodeId, ...tr.route, tr.toNodeId];
      for (const id of path) nodeIds.add(id);
      for (let i = 0; i < path.length - 1; i++) {
        const key = `${Math.min(path[i], path[i + 1])}_${Math.max(path[i], path[i + 1])}`;
        if (!edgeSet.has(key)) {
          edgeSet.add(key);
          links.push({ source: path[i], target: path[i + 1] });
        }
      }
    }

    return {
      nodes: [...nodeIds].map((id) => ({
        id,
        name: nodeName(id, nodes, mqttNodes),
        color: nodeColor(id),
      })),
      links,
    };
  }, [routes, nodes, mqttNodes]);

  // Hop distribution data — label 0 as "Direct"
  const hopRows = useMemo(() => (hops ?? []).map((h) => ({
    label: h.hopsAway === 0 ? "Direct" : `${h.hopsAway} hop${h.hopsAway > 1 ? "s" : ""}`,
    count: h.count,
  })), [hops]);

  return (
    <div style={styles.grid}>
      {/* Hop Distribution */}
      <ChartCard title="Hop Distance Distribution">
        {hops === null ? <Loading /> : hops.length === 0 ? <Empty message="No nodes with hop data" /> : (
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={hopRows}>
              <CartesianGrid strokeDasharray="3 3" stroke={GRID_COLOR} />
              <XAxis dataKey="label" tick={TICK_STYLE} />
              <YAxis tick={TICK_STYLE} allowDecimals={false} />
              <Tooltip {...TOOLTIP_STYLE} />
              <Bar dataKey="count" name="Nodes" fill="#60a5fa" />
            </BarChart>
          </ResponsiveContainer>
        )}
      </ChartCard>

      {/* Hardware Breakdown */}
      <ChartCard title="Hardware Breakdown">
        {hardware === null ? <Loading /> : hardware.length === 0 ? <Empty /> : (
          <ResponsiveContainer width="100%" height={220}>
            <PieChart>
              <Pie dataKey="count" data={hardware} nameKey="hwModelName" innerRadius={50} outerRadius={80} paddingAngle={2}>
                {hardware.map((_, i) => <Cell key={i} fill={PIE_PALETTE[i % PIE_PALETTE.length]} />)}
              </Pie>
              <Tooltip {...TOOLTIP_STYLE} />
              <Legend wrapperStyle={styles.legendWrap} formatter={(value) => <span style={{ color: "#94a3b8", fontSize: "0.7rem", fontFamily: "monospace" }}>{value}</span>} />
            </PieChart>
          </ResponsiveContainer>
        )}
      </ChartCard>

      {/* Traceroute Topology */}
      <ChartCard title="Traceroute Topology" fullWidth>
        <div style={{ display: "flex", alignItems: "center", gap: "1rem", marginBottom: "0.6rem" }}>
          <RangeBtn options={["1h","6h","24h","7d","all"]} value={graphSince} onChange={setGraphSince} />
          {routes && (
            <span style={{ color: "#64748b", fontSize: "0.7rem", fontFamily: "monospace", marginLeft: "auto" }}>
              {graphData.nodes.length} nodes · {graphData.links.length} links
            </span>
          )}
        </div>
        <div ref={containerRef} style={{ background: "#020617", borderRadius: "0.375rem", overflow: "hidden" }}>
          {routes === null ? (
            <div style={{ height: 400, display: "flex", alignItems: "center", justifyContent: "center", color: "#475569", fontSize: "0.75rem" }}>Loading…</div>
          ) : graphData.nodes.length === 0 ? (
            <div style={{ height: 400, display: "flex", alignItems: "center", justifyContent: "center", color: "#475569", fontSize: "0.75rem" }}>No traceroute data in this window</div>
          ) : (
            <Suspense fallback={<div style={{ height: 400, display: "flex", alignItems: "center", justifyContent: "center", color: "#475569", fontSize: "0.75rem" }}>Loading graph…</div>}>
              <ForceGraph2D
                graphData={graphData as Parameters<typeof ForceGraph2D>[0]["graphData"]}
                width={graphWidth}
                height={400}
                backgroundColor="#020617"
                nodeLabel="name"
                nodeColor={(n: Record<string, unknown>) => (n.color as string | undefined) ?? "#60a5fa"}
                linkColor={() => "#334155"}
                nodeCanvasObjectMode={() => "after"}
                nodeCanvasObject={(node: { x?: number; y?: number; name?: string }, ctx: CanvasRenderingContext2D, globalScale: number) => {
                  if (!node.name || node.x == null || node.y == null) return;
                  const fontSize = Math.max(10, 12 / globalScale);
                  ctx.font = `${fontSize}px monospace`;
                  ctx.fillStyle = "#94a3b8";
                  ctx.textAlign = "center";
                  ctx.fillText(node.name, node.x, node.y + 10);
                }}
              />
            </Suspense>
          )}
        </div>
      </ChartCard>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tab 4 — Packets
// ---------------------------------------------------------------------------

function PacketsTab() {
  const [since,    setSince]    = useState("24h");
  const [portnum,  setPortnum]  = useState<PortnumCount[] | null>(null);
  const [timeline, setTimeline] = useState<PacketTimelinePoint[] | null>(null);

  const bucket = since === "7d" ? "hour" : "hour";

  useEffect(() => {
    setPortnum(null);
    apiFetch<PortnumCount[]>(`/api/analytics/portnum-breakdown?since=${since}`)
      .then(setPortnum).catch(() => setPortnum([]));
  }, [since]);

  useEffect(() => {
    setTimeline(null);
    apiFetch<PacketTimelinePoint[]>(`/api/analytics/packet-timeline?since=${since}&bucket=${bucket}`)
      .then(setTimeline).catch(() => setTimeline([]));
  }, [since, bucket]);

  // Top 6 portnums for the area chart; rest → "Other"
  const topPortnums = useMemo(() => {
    if (!portnum) return [];
    return portnum.slice(0, 6).map((p) => p.portnumName);
  }, [portnum]);

  // Flatten packet timeline for recharts: one object per ts with portnum keys
  const timelineFlat = useMemo(() => {
    if (!timeline) return [];
    return timeline.map((pt) => {
      const row: Record<string, unknown> = { ts: pt.ts };
      let other = 0;
      for (const [k, v] of Object.entries(pt.counts)) {
        if (topPortnums.includes(k)) row[k] = v;
        else other += v;
      }
      if (other > 0) row["Other"] = other;
      return row;
    });
  }, [timeline, topPortnums]);

  const areaKeys = topPortnums.length > 0
    ? [...topPortnums, ...(timeline?.some((pt) => {
        let hasOther = false;
        for (const k of Object.keys(pt.counts)) { if (!topPortnums.includes(k)) { hasOther = true; break; } }
        return hasOther;
      }) ? ["Other"] : [])]
    : [];

  return (
    <div style={styles.grid}>
      <div style={{ gridColumn: "1 / -1" }}>
        <RangeBtn options={["1h","6h","24h","7d"]} value={since} onChange={setSince} />
      </div>

      {/* Portnum Breakdown */}
      <ChartCard title="Packet Type Breakdown">
        {portnum === null ? <Loading /> : portnum.length === 0 ? <Empty /> : (
          <ResponsiveContainer width="100%" height={280}>
            <PieChart>
              <Pie dataKey="count" data={portnum} nameKey="portnumName" innerRadius={60} outerRadius={100} paddingAngle={2}>
                {portnum.map((_, i) => <Cell key={i} fill={PIE_PALETTE[i % PIE_PALETTE.length]} />)}
              </Pie>
              <Tooltip {...TOOLTIP_STYLE} />
              <Legend
                wrapperStyle={styles.legendWrap}
                formatter={(value) => <span style={{ color: "#94a3b8", fontSize: "0.68rem", fontFamily: "monospace" }}>{value}</span>}
              />
            </PieChart>
          </ResponsiveContainer>
        )}
      </ChartCard>

      {/* Packet Timeline */}
      <ChartCard title="Packet Volume over Time" fullWidth>
        {timeline === null ? <Loading /> : timeline.length === 0 ? <Empty /> : (
          <ResponsiveContainer width="100%" height={240}>
            <AreaChart data={timelineFlat}>
              <CartesianGrid strokeDasharray="3 3" stroke={GRID_COLOR} />
              <XAxis dataKey="ts" tickFormatter={(v) => formatTs(v)} tick={TICK_STYLE} />
              <YAxis tick={TICK_STYLE} allowDecimals={false} />
              <Tooltip {...TOOLTIP_STYLE} labelFormatter={(v) => new Date(v as string).toLocaleString()} />
              <Legend wrapperStyle={styles.legendWrap} />
              {areaKeys.map((key, i) => (
                <Area
                  key={key}
                  type="monotone"
                  dataKey={key}
                  stackId="a"
                  fill={PIE_PALETTE[i % PIE_PALETTE.length] + "80"}
                  stroke={PIE_PALETTE[i % PIE_PALETTE.length]}
                />
              ))}
            </AreaChart>
          </ResponsiveContainer>
        )}
      </ChartCard>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main AnalyticsPage
// ---------------------------------------------------------------------------

type AnalyticsTab = "signal" | "messages" | "network" | "packets";

interface Props {
  nodes: NodeInfo[];
  mqttNodes: MqttNode[];
}

export function AnalyticsPage({ nodes, mqttNodes }: Props) {
  const [tab, setTab] = useState<AnalyticsTab>("messages");

  return (
    <div style={styles.page}>
      {/* Sub-tab nav */}
      <div style={styles.subNav}>
        {(["messages", "signal", "network", "packets"] as AnalyticsTab[]).map((t) => (
          <button key={t} style={subTabStyle(tab === t)} onClick={() => setTab(t)}>
            {t.charAt(0).toUpperCase() + t.slice(1)}
          </button>
        ))}
      </div>

      {tab === "signal"   && <SignalTab   nodes={nodes} mqttNodes={mqttNodes} />}
      {tab === "messages" && <MessagesTab nodes={nodes} mqttNodes={mqttNodes} />}
      {tab === "network"  && <NetworkTab  nodes={nodes} mqttNodes={mqttNodes} />}
      {tab === "packets"  && <PacketsTab />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

function subTabStyle(active: boolean): React.CSSProperties {
  return {
    background:    "transparent",
    color:         active ? "#e2e8f0" : "#64748b",
    border:        "none",
    borderBottom:  active ? "2px solid #3b82f6" : "2px solid transparent",
    padding:       "0.3rem 0.9rem",
    cursor:        "pointer",
    fontFamily:    "monospace",
    fontSize:      "0.8rem",
    marginBottom:  "-1px",
  };
}

function rangeStyle(active: boolean): React.CSSProperties {
  return {
    background:   active ? "#1e3a5f" : "#0f172a",
    color:        active ? "#60a5fa" : "#64748b",
    border:       `1px solid ${active ? "#3b82f6" : "#1e293b"}`,
    padding:      "0.15rem 0.5rem",
    borderRadius: "0.25rem",
    cursor:       "pointer",
    fontFamily:   "monospace",
    fontSize:     "0.72rem",
  };
}

const styles: Record<string, React.CSSProperties> = {
  page: {
    padding:    "1rem 1.5rem",
    display:    "flex",
    flexDirection: "column",
    height:     "100%",
    boxSizing:  "border-box",
    overflowY:  "auto",
  },
  subNav: {
    display:       "flex",
    gap:           "0.1rem",
    borderBottom:  "1px solid #1e293b",
    marginBottom:  "1rem",
    flexShrink:    0,
  },
  grid: {
    display:             "grid",
    gridTemplateColumns: "repeat(2, 1fr)",
    gap:                 "1rem",
    alignItems:          "start",
  },
  card: {
    background:   "#0f172a",
    borderRadius: "0.5rem",
    padding:      "1rem",
    border:       "1px solid #1e293b",
  },
  cardTitle: {
    fontSize:      "0.7rem",
    fontWeight:    "bold",
    letterSpacing: "0.08em",
    textTransform: "uppercase" as const,
    color:         "#64748b",
    paddingBottom: "0.5rem",
    borderBottom:  "1px solid #1e293b",
    marginBottom:  "0.75rem",
  },
  empty: {
    height:         "160px",
    display:        "flex",
    alignItems:     "center",
    justifyContent: "center",
    color:          "#475569",
    fontSize:       "0.75rem",
    fontFamily:     "monospace",
  },
  legendWrap: {
    fontSize:   "0.7rem",
    fontFamily: "monospace",
    color:      "#94a3b8",
  },
  subLabel: {
    fontSize:      "0.65rem",
    fontWeight:    "bold",
    letterSpacing: "0.06em",
    textTransform: "uppercase" as const,
    color:         "#475569",
    marginBottom:  "0.3rem",
    marginTop:     "0.5rem",
  },
  errorRow: {
    display:        "flex",
    justifyContent: "space-between",
    fontSize:       "0.72rem",
    fontFamily:     "monospace",
    padding:        "0.1rem 0",
  },
  deliverySummary: {
    fontSize:     "0.72rem",
    fontFamily:   "monospace",
    color:        "#94a3b8",
    marginBottom: "0.25rem",
  },
  latencySummary: {
    display:      "flex",
    gap:          "1.5rem",
    fontSize:     "0.72rem",
    fontFamily:   "monospace",
    color:        "#64748b",
    marginBottom: "0.5rem",
  },
};
