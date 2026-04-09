import { useState, useEffect, Fragment } from "react";
import type { DeviceInfo, NodeInfo, MqttNode } from "@foreman/shared";
import { foremanClient } from "../ws/client.js";
import logo from "../assets/logo.png";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatLastHeard(iso: string | null): string {
  if (!iso) return "—";
  const diff = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

function nodeHex(nodeId: number): string {
  return `!${nodeId.toString(16).padStart(8, "0")}`;
}

function formatDistance(distanceM: number | null): string {
  if (distanceM === null) return "—";
  if (distanceM < 1000) return `${Math.round(distanceM)} m`;
  return `${(distanceM / 1000).toFixed(1)} km`;
}

function formatHops(hopsAway: number | null): string {
  if (hopsAway === null) return "—";
  if (hopsAway === 0) return "Direct";
  return `${hopsAway} hop${hopsAway > 1 ? "s" : ""}`;
}

const HW_MODEL: Record<number, string> = {
  0: "UNSET", 1: "TLORA_V2", 2: "TLORA_V1", 4: "TBEAM", 8: "T_ECHO",
  10: "RAK4631", 13: "LILYGO_TBEAM_S3_CORE", 15: "NANO_G1",
  43: "HELTEC_V3", 44: "HELTEC_WSL_V3",
  48: "HELTEC_WIRELESS_TRACKER", 49: "HELTEC_WIRELESS_PAPER",
  50: "T_DECK", 51: "T_WATCH_S3", 64: "TRACKER_T1000_E", 66: "WIO_E5",
  95: "HELTEC_WIRELESS_PAPER_V3", 99: "SEEED_WIO_TRACKER_L1", 255: "PRIVATE_HW",
};

function hwModel(model: number | null): string {
  if (model === null) return "—";
  return HW_MODEL[model] ?? `#${model}`;
}

// ---------------------------------------------------------------------------
// Data merging
// ---------------------------------------------------------------------------

interface MergedNode {
  nodeId: number;
  mesh: NodeInfo | null;
  mqtt: MqttNode | null;
}

function buildMergedNodes(nodes: NodeInfo[], mqttNodes: MqttNode[]): MergedNode[] {
  const map = new Map<number, MergedNode>();
  for (const n of nodes) map.set(n.nodeId, { nodeId: n.nodeId, mesh: n, mqtt: null });
  for (const n of mqttNodes) {
    const existing = map.get(n.nodeId);
    if (existing) {
      existing.mqtt = n;
    } else {
      map.set(n.nodeId, { nodeId: n.nodeId, mesh: null, mqtt: n });
    }
  }
  return [...map.values()];
}

function lastHeardMs(m: MergedNode): number {
  const meshMs = m.mesh?.lastHeard ? new Date(m.mesh.lastHeard).getTime() : 0;
  const mqttMs = m.mqtt?.lastHeard ? new Date(m.mqtt.lastHeard).getTime() : 0;
  return Math.max(meshMs, mqttMs);
}

// ---------------------------------------------------------------------------
// Filter
// ---------------------------------------------------------------------------

function filterNodes(list: MergedNode[], query: string): MergedNode[] {
  const q = query.trim().toLowerCase();
  if (!q) return list;
  return list.filter((m) => {
    const p = m.mesh ?? m.mqtt!;
    const longName  = (p.longName  ?? "").toLowerCase();
    const shortName = (p.shortName ?? "").toLowerCase();
    const hexFull   = nodeHex(m.nodeId).toLowerCase(); // "!abcdef01"
    const hexBare   = hexFull.slice(1);                // "abcdef01"
    const dec       = String(m.nodeId);
    const searchHex = q.startsWith("!") ? q.slice(1) : q;
    return (
      longName.includes(q)  ||
      shortName.includes(q) ||
      hexFull.includes(q)   ||
      hexBare.includes(searchHex) ||
      dec.includes(q)
    );
  });
}

// ---------------------------------------------------------------------------
// Sorting
// ---------------------------------------------------------------------------

type SortCol = "name" | "id" | "connection" | "lastHeard" | "snr" | "model" | "location" | "distance";

function sortMerged(list: MergedNode[], col: SortCol, dir: "asc" | "desc"): MergedNode[] {
  return [...list].sort((a, b) => {
    const pa = a.mesh ?? a.mqtt!;
    const pb = b.mesh ?? b.mqtt!;
    let cmp = 0;
    switch (col) {
      case "name": {
        const na = (pa.longName ?? pa.shortName ?? "").toLowerCase();
        const nb = (pb.longName ?? pb.shortName ?? "").toLowerCase();
        cmp = na.localeCompare(nb);
        break;
      }
      case "id":
        cmp = a.nodeId - b.nodeId;
        break;
      case "connection": {
        // Sort by hops (nulls last), MQTT-only after mesh
        const ha = a.mesh != null ? (a.mesh.hopsAway ?? 999) : 9999;
        const hb = b.mesh != null ? (b.mesh.hopsAway ?? 999) : 9999;
        cmp = ha - hb;
        break;
      }
      case "lastHeard":
        cmp = lastHeardMs(a) - lastHeardMs(b);
        break;
      case "snr": {
        const sa = pa.snr ?? -Infinity;
        const sb = pb.snr ?? -Infinity;
        cmp = sa - sb;
        break;
      }
      case "model": {
        const ma = hwModel(pa.hwModel);
        const mb = hwModel(pb.hwModel);
        cmp = ma.localeCompare(mb);
        break;
      }
      case "location": {
        const la = pa.latitude ?? -Infinity;
        const lb = pb.latitude ?? -Infinity;
        cmp = la - lb;
        break;
      }
      case "distance": {
        const da = a.mqtt?.distanceM ?? Infinity;
        const db = b.mqtt?.distanceM ?? Infinity;
        cmp = da - db;
        break;
      }
    }
    return dir === "asc" ? cmp : -cmp;
  });
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface TracerouteResult {
  route: number[];
  routeBack: number[];
}

interface Props {
  devices: DeviceInfo[];
  nodes: NodeInfo[];
  mqttNodes: MqttNode[];
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function NodesPage({ devices, nodes, mqttNodes }: Props) {
  const [pending, setPending] = useState<Record<string, "position" | "traceroute" | "remove">>({});
  const [traceroutes, setTraceroutes] = useState<Record<number, TracerouteResult>>({});
  const [confirmRemove, setConfirmRemove] = useState<number | null>(null);
  const [filter, setFilter] = useState("");
  const [sortCol, setSortCol] = useState<SortCol>("distance");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");

  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(() => {
    try {
      const saved = localStorage.getItem("nodes-sections-collapsed");
      return saved ? JSON.parse(saved) : {};
    } catch { return {}; }
  });

  function toggleSection(key: string) {
    setCollapsed((prev) => {
      const next = { ...prev, [key]: !prev[key] };
      try { localStorage.setItem("nodes-sections-collapsed", JSON.stringify(next)); } catch { /* ignore */ }
      return next;
    });
  }

  useEffect(() => {
    const off = foremanClient.on((event) => {
      if (event.type === "traceroute:result") {
        const { nodeId, route, routeBack } = event.payload;
        setTraceroutes((prev) => ({ ...prev, [nodeId]: { route, routeBack } }));
        setPending((prev) => { const next = { ...prev }; delete next[String(nodeId)]; return next; });
      }
      if (event.type === "node:removed") {
        const { nodeId } = event.payload;
        setPending((prev) => { const next = { ...prev }; delete next[String(nodeId)]; return next; });
      }
      if (event.type === "error" && (event.payload as unknown as { nodeId?: number }).nodeId != null) {
        const nodeId = (event.payload as unknown as { nodeId: number }).nodeId;
        setPending((prev) => { const next = { ...prev }; delete next[String(nodeId)]; return next; });
      }
    });
    return () => { off(); };
  }, []);

  function handleSort(col: SortCol) {
    if (sortCol === col) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortCol(col);
      setSortDir(col === "name" || col === "model" || col === "id" || col === "distance" ? "asc" : "desc");
    }
  }

  const deviceId = devices.find((d) => d.status === "connected")?.id ?? null;

  function requestPosition(nodeId: number) {
    if (!deviceId) return;
    setPending((prev) => ({ ...prev, [String(nodeId)]: "position" }));
    foremanClient.send({ type: "node:request-position", payload: { deviceId, nodeId } });
    setTimeout(() => setPending((prev) => { const next = { ...prev }; delete next[String(nodeId)]; return next; }), 15000);
  }

  function requestTraceroute(nodeId: number) {
    if (!deviceId) return;
    setPending((prev) => ({ ...prev, [String(nodeId)]: "traceroute" }));
    foremanClient.send({ type: "node:traceroute", payload: { deviceId, nodeId } });
  }

  function removeNode(nodeId: number) {
    if (!deviceId) return;
    setConfirmRemove(null);
    setPending((prev) => ({ ...prev, [String(nodeId)]: "remove" }));
    foremanClient.send({ type: "node:remove", payload: { deviceId, nodeId } });
    setTimeout(() => setPending((prev) => { const next = { ...prev }; delete next[String(nodeId)]; return next; }), 10000);
  }

  // Build, filter, sort, then section
  const allMerged = buildMergedNodes(nodes, mqttNodes);
  const filtered  = filterNodes(allMerged, filter);

  const apply = (list: MergedNode[]) => sortMerged(list, sortCol, sortDir);

  const matched  = apply(filtered.filter((n) => n.mesh && n.mqtt));
  const meshOnly = apply(filtered.filter((n) => n.mesh && !n.mqtt));
  const mqttOnly = apply(filtered.filter((n) => !n.mesh && n.mqtt));

  const totalUnique = nodes.length + allMerged.filter((n) => !n.mesh && n.mqtt).length;
  const colCount = deviceId ? 9 : 8;
  const isEmpty = nodes.length === 0 && mqttNodes.length === 0;
  const noResults = !isEmpty && filtered.length === 0;

  const sharedHeaderProps = { sortCol, sortDir, onSort: handleSort };

  const nodeRowProps = {
    pending, traceroutes, confirmRemove, deviceId,
    onRequestPosition: requestPosition,
    onRequestTraceroute: requestTraceroute,
    onRemove: removeNode,
    onConfirmRemove: setConfirmRemove,
    onClearTraceroute: (id: number) => setTraceroutes((prev) => { const n = { ...prev }; delete n[id]; return n; }),
  };

  return (
    <div style={styles.page}>
      <section style={styles.section}>
        {/* Title + search bar row */}
        <div style={styles.titleRow}>
          <h2 style={styles.sectionTitle}>
            Nodes
            <span style={{ ...styles.badge, background: "#334155", marginLeft: "0.5rem" }}>
              {filter ? `${filtered.length} / ${totalUnique}` : totalUnique}
            </span>
            {matched.length > 0 && !filter && (
              <span style={{ ...styles.badge, background: "#1e3a5f", color: "#60a5fa", marginLeft: "0.4rem", fontSize: "0.65rem" }}>
                {matched.length} matched
              </span>
            )}
          </h2>

          <div style={styles.searchWrap}>
            <input
              style={styles.searchInput}
              placeholder="Search name, short name, !hex or decimal ID…"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            />
            {filter && (
              <button style={styles.clearBtn} onClick={() => setFilter("")} title="Clear search">✕</button>
            )}
          </div>
        </div>

        {isEmpty ? (
          <div style={styles.emptyState}>
            <img src={logo} alt="" style={styles.emptyLogo} />
            <p style={styles.muted}>No nodes seen yet.</p>
          </div>
        ) : noResults ? (
          <div style={styles.emptyState}>
            <p style={styles.muted}>No nodes match &ldquo;{filter}&rdquo;</p>
          </div>
        ) : (
          <div style={styles.tableWrap}>
            <table style={styles.table}>
              <thead>
                <tr>
                  <SortableHeader col="name"       label="Node"        {...sharedHeaderProps} />
                  <SortableHeader col="id"         label="ID"          {...sharedHeaderProps} />
                  <SortableHeader col="connection" label="Connection"  {...sharedHeaderProps} />
                  <SortableHeader col="lastHeard"  label="Last Heard"  {...sharedHeaderProps} />
                  <SortableHeader col="snr"        label="SNR"         {...sharedHeaderProps} />
                  <SortableHeader col="model"      label="Model"       {...sharedHeaderProps} />
                  <SortableHeader col="distance"   label="Distance"    {...sharedHeaderProps} />
                  <SortableHeader col="location"   label="Location"    {...sharedHeaderProps} />
                  {deviceId && <th style={styles.th}>Actions</th>}
                </tr>
              </thead>
              <tbody>
                {matched.length > 0 && (
                  <>
                    <SectionHeader label="Mesh + MQTT" count={matched.length} colCount={colCount} color="#60a5fa"
                      collapsed={!!collapsed["both"]} onToggle={() => toggleSection("both")} />
                    {!collapsed["both"] && matched.map((m) => <NodeRows key={m.nodeId} merged={m} {...nodeRowProps} />)}
                  </>
                )}
                {meshOnly.length > 0 && (
                  <>
                    <SectionHeader label="Mesh only" count={meshOnly.length} colCount={colCount} color="#94a3b8"
                      collapsed={!!collapsed["mesh"]} onToggle={() => toggleSection("mesh")} />
                    {!collapsed["mesh"] && meshOnly.map((m) => <NodeRows key={m.nodeId} merged={m} {...nodeRowProps} />)}
                  </>
                )}
                {mqttOnly.length > 0 && (
                  <>
                    <SectionHeader label="MQTT only" count={mqttOnly.length} colCount={colCount} color="#34d399"
                      collapsed={!!collapsed["mqtt"]} onToggle={() => toggleSection("mqtt")} />
                    {!collapsed["mqtt"] && mqttOnly.map((m) => <NodeRows key={m.nodeId} merged={m} {...nodeRowProps} />)}
                  </>
                )}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sortable column header
// ---------------------------------------------------------------------------

function SortableHeader({ col, label, sortCol, sortDir, onSort }: {
  col: SortCol; label: string; sortCol: SortCol; sortDir: "asc" | "desc";
  onSort: (col: SortCol) => void;
}) {
  const active = sortCol === col;
  return (
    <th
      style={{ ...styles.th, cursor: "pointer", userSelect: "none", color: active ? "#e2e8f0" : "#94a3b8" }}
      onClick={() => onSort(col)}
    >
      {label}
      <span style={{ marginLeft: "0.3rem", fontSize: "0.65rem", opacity: active ? 1 : 0.35 }}>
        {active ? (sortDir === "asc" ? "▲" : "▼") : "▲▼"}
      </span>
    </th>
  );
}

// ---------------------------------------------------------------------------
// Accordion section header row
// ---------------------------------------------------------------------------

function SectionHeader({ label, count, colCount, color, collapsed, onToggle }: {
  label: string; count: number; colCount: number; color: string;
  collapsed: boolean; onToggle: () => void;
}) {
  return (
    <tr
      style={{ background: "#0f172a", cursor: "pointer", userSelect: "none" }}
      onClick={onToggle}
    >
      <td
        colSpan={colCount}
        style={{
          padding: "0.4rem 0.75rem",
          fontSize: "0.7rem",
          fontWeight: "bold",
          letterSpacing: "0.08em",
          textTransform: "uppercase",
          color,
          borderTop: "1px solid #1e293b",
          borderBottom: "1px solid #1e293b",
        }}
      >
        <span style={{ marginRight: "0.5rem", fontSize: "0.6rem", opacity: 0.7 }}>
          {collapsed ? "▶" : "▼"}
        </span>
        {label}
        <span style={{
          marginLeft: "0.5rem",
          background: "#1e293b",
          borderRadius: "9999px",
          padding: "0.1rem 0.4rem",
          fontSize: "0.65rem",
          color: "#64748b",
          fontWeight: "normal",
          letterSpacing: 0,
          textTransform: "none",
        }}>
          {count}
        </span>
      </td>
    </tr>
  );
}

// ---------------------------------------------------------------------------
// Node row(s) — mesh primary + optional MQTT sub-row + optional traceroute row
// ---------------------------------------------------------------------------

interface NodeRowsProps {
  merged: MergedNode;
  pending: Record<string, "position" | "traceroute" | "remove">;
  traceroutes: Record<number, TracerouteResult>;
  confirmRemove: number | null;
  deviceId: string | null;
  onRequestPosition: (id: number) => void;
  onRequestTraceroute: (id: number) => void;
  onRemove: (id: number) => void;
  onConfirmRemove: (id: number | null) => void;
  onClearTraceroute: (id: number) => void;
}

function NodeRows({
  merged, pending, traceroutes, confirmRemove, deviceId,
  onRequestPosition, onRequestTraceroute, onRemove, onConfirmRemove, onClearTraceroute,
}: NodeRowsProps) {
  const { nodeId, mesh, mqtt } = merged;
  const key = String(nodeId);
  const isPending = !!pending[key];
  const trResult = traceroutes[nodeId];
  const colCount = deviceId ? 9 : 8;
  const primary = mesh ?? mqtt!;
  const isMqttOnly = !mesh;

  return (
    <Fragment>
      <tr style={styles.tr}>
        <td style={styles.td}>
          <strong>{primary.longName ?? primary.shortName ?? "Unknown"}</strong>
          {primary.shortName && primary.longName && (
            <span style={{ ...styles.muted, marginLeft: "0.4rem" }}>({primary.shortName})</span>
          )}
        </td>
        <td style={{ ...styles.td, ...styles.mono }}>{nodeHex(nodeId)}</td>
        <td style={styles.td}>
          {isMqttOnly ? (
            <span style={styles.mqttChip}>MQTT</span>
          ) : (
            <>
              {formatHops(mesh!.hopsAway)}
              {mqtt && <span style={{ ...styles.mqttChip, marginLeft: "0.4rem" }}>+MQTT</span>}
            </>
          )}
        </td>
        <td style={styles.td}>{formatLastHeard(primary.lastHeard)}</td>
        <td style={styles.td}>{primary.snr != null ? `${primary.snr.toFixed(1)} dB` : "—"}</td>
        <td style={styles.td}>{hwModel(primary.hwModel)}</td>
        <td style={styles.td}>{formatDistance(mqtt?.distanceM ?? null)}</td>
        <td style={{ ...styles.td, ...styles.mono }}>
          {primary.latitude != null && primary.longitude != null
            ? `${primary.latitude.toFixed(5)}, ${primary.longitude.toFixed(5)}`
            : "—"}
        </td>
        {deviceId && (
          <td style={{ ...styles.td, whiteSpace: "nowrap" }}>
            {!isMqttOnly && (
              <>
                <button style={styles.actionBtn} disabled={isPending} onClick={() => onRequestPosition(nodeId)} title="Ask node to broadcast its current position">
                  {pending[key] === "position" ? "…" : "📍 Pos"}
                </button>
                <button style={{ ...styles.actionBtn, marginLeft: "0.4rem" }} disabled={isPending} onClick={() => onRequestTraceroute(nodeId)} title="Trace the mesh route to this node">
                  {pending[key] === "traceroute" ? "…" : "🔍 Trace"}
                </button>
                {confirmRemove === nodeId ? (
                  <>
                    <button style={{ ...styles.actionBtn, marginLeft: "0.4rem", color: "#f87171", borderColor: "#7f1d1d" }} onClick={() => onRemove(nodeId)}>Confirm</button>
                    <button style={{ ...styles.actionBtn, marginLeft: "0.25rem" }} onClick={() => onConfirmRemove(null)}>Cancel</button>
                  </>
                ) : (
                  <button style={{ ...styles.actionBtn, marginLeft: "0.4rem" }} disabled={isPending} onClick={() => onConfirmRemove(nodeId)} title="Remove from radio nodeDB and clear local cache">
                    {pending[key] === "remove" ? "…" : "Reset"}
                  </button>
                )}
              </>
            )}
          </td>
        )}
      </tr>

      {mesh && mqtt && (
        <tr style={{ background: "#080f1a", borderBottom: "1px solid #1e293b" }}>
          <td colSpan={colCount} style={{ ...styles.td, paddingLeft: "2.25rem", paddingTop: "0.25rem", paddingBottom: "0.3rem", fontSize: "0.75rem", color: "#64748b" }}>
            <span style={{ color: "#34d399", fontWeight: "bold", marginRight: "0.5rem" }}>↳ MQTT</span>
            {mqtt.lastGateway && <>via <span style={{ fontFamily: "monospace", color: "#94a3b8" }}>{mqtt.lastGateway}</span>{" · "}</>}
            {formatLastHeard(mqtt.lastHeard)}
            {mqtt.snr != null && mqtt.snr !== 0 && ` · SNR ${mqtt.snr.toFixed(1)} dB`}
            {mqtt.regionPath && <span style={{ marginLeft: "0.5rem", color: "#475569" }}>{mqtt.regionPath}</span>}
            {mqtt.latitude != null && mqtt.longitude != null && mesh.latitude == null && (
              <span style={{ marginLeft: "0.5rem", fontFamily: "monospace", color: "#94a3b8" }}>
                · GPS {mqtt.latitude.toFixed(5)}, {mqtt.longitude.toFixed(5)}
              </span>
            )}
          </td>
        </tr>
      )}

      {trResult && (
        <tr style={{ ...styles.tr, background: "#0f1f35" }}>
          <td colSpan={colCount} style={{ ...styles.td, ...styles.mono, fontSize: "0.75rem", color: "#94a3b8" }}>
            <strong style={{ color: "#60a5fa" }}>Traceroute</strong>
            {" → "}
            {trResult.route.length === 0 ? "Direct (no intermediate hops)" : trResult.route.map((id) => nodeHex(id)).join(" → ")}
            {trResult.routeBack.length > 0 && (
              <span style={{ marginLeft: "1rem", color: "#94a3b8" }}>
                (back: {trResult.routeBack.map((id) => nodeHex(id)).join(" → ")})
              </span>
            )}
            <button onClick={() => onClearTraceroute(nodeId)} style={{ marginLeft: "1rem", background: "none", border: "none", color: "#64748b", cursor: "pointer", fontSize: "0.75rem" }}>✕</button>
          </td>
        </tr>
      )}
    </Fragment>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const styles: Record<string, React.CSSProperties> = {
  page: { padding: "1.5rem 2rem" },
  section: { marginBottom: "2rem" },
  titleRow: {
    display: "flex",
    alignItems: "center",
    gap: "1rem",
    marginBottom: "0.75rem",
    flexWrap: "wrap",
  },
  sectionTitle: {
    fontSize: "1rem",
    color: "#94a3b8",
    textTransform: "uppercase",
    letterSpacing: "0.1em",
    margin: 0,
    display: "flex",
    alignItems: "center",
    flexShrink: 0,
  },
  badge: {
    padding: "0.15rem 0.5rem",
    borderRadius: "9999px",
    fontSize: "0.75rem",
    color: "#fff",
    fontWeight: "bold",
  },
  searchWrap: {
    position: "relative",
    flex: 1,
    minWidth: "200px",
    maxWidth: "400px",
  },
  searchInput: {
    width: "100%",
    background: "#1e293b",
    border: "1px solid #334155",
    borderRadius: "0.375rem",
    color: "#e2e8f0",
    padding: "0.3rem 2rem 0.3rem 0.6rem",
    fontFamily: "monospace",
    fontSize: "0.8rem",
    boxSizing: "border-box" as const,
    outline: "none",
  },
  clearBtn: {
    position: "absolute",
    right: "0.4rem",
    top: "50%",
    transform: "translateY(-50%)",
    background: "none",
    border: "none",
    color: "#64748b",
    cursor: "pointer",
    fontSize: "0.75rem",
    padding: "0 0.2rem",
    lineHeight: 1,
  },
  muted: { color: "#64748b", fontSize: "0.85rem" },
  tableWrap: { overflowX: "auto" },
  table: { width: "100%", borderCollapse: "collapse", fontSize: "0.875rem" },
  th: {
    textAlign: "left",
    padding: "0.5rem 0.75rem",
    background: "#1e293b",
    color: "#94a3b8",
    fontWeight: "normal",
    borderBottom: "1px solid #334155",
    whiteSpace: "nowrap",
  },
  tr: { borderBottom: "1px solid #1e293b" },
  td: { padding: "0.5rem 0.75rem", verticalAlign: "middle" },
  emptyState: {
    display: "flex",
    flexDirection: "column" as const,
    alignItems: "center",
    justifyContent: "center",
    padding: "4rem 2rem",
    gap: "1.5rem",
  },
  emptyLogo: { width: "12rem", opacity: 0.15 },
  mono: { fontFamily: "monospace", fontSize: "0.8rem", color: "#94a3b8" },
  mqttChip: {
    display: "inline-block",
    background: "#052e16",
    color: "#34d399",
    border: "1px solid #166534",
    borderRadius: "0.2rem",
    padding: "0 0.3rem",
    fontSize: "0.65rem",
    fontWeight: "bold",
    verticalAlign: "middle",
  },
  actionBtn: {
    background: "#1e293b",
    border: "1px solid #334155",
    color: "#94a3b8",
    padding: "0.2rem 0.5rem",
    borderRadius: "0.25rem",
    cursor: "pointer",
    fontSize: "0.75rem",
    fontFamily: "monospace",
  },
};
