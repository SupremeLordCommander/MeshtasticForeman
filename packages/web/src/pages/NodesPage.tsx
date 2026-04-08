import { useState, useEffect } from "react";
import type { DeviceInfo, NodeInfo } from "@foreman/shared";
import { foremanClient } from "../ws/client.js";

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

const HW_MODEL: Record<number, string> = {
  0: "UNSET", 4: "TBEAM", 8: "T_ECHO", 10: "RAK4631", 13: "LILYGO_TBEAM_S3_CORE",
  43: "HELTEC_V3", 48: "HELTEC_WIRELESS_TRACKER", 49: "HELTEC_WIRELESS_PAPER",
  50: "T_DECK", 51: "T_WATCH_S3", 64: "TRACKER_T1000_E", 66: "WIO_E5",
  95: "HELTEC_WIRELESS_PAPER_V3", 99: "SEEED_WIO_TRACKER_L1", 255: "PRIVATE_HW",
};

function formatHops(hopsAway: number | null): string {
  if (hopsAway === null) return "—";
  if (hopsAway === 0) return "Direct";
  return `${hopsAway} hop${hopsAway > 1 ? "s" : ""}`;
}

interface TracerouteResult {
  route: number[];
  routeBack: number[];
}

interface Props {
  devices: DeviceInfo[];
  nodes: NodeInfo[];
}

export function NodesPage({ devices, nodes }: Props) {
  const [pending, setPending] = useState<Record<string, "position" | "traceroute">>({});
  const [traceroutes, setTraceroutes] = useState<Record<number, TracerouteResult>>({});

  // Listen for traceroute results from the daemon
  useEffect(() => {
    const off = foremanClient.on((event) => {
      if (event.type === "traceroute:result") {
        const { nodeId, route, routeBack } = event.payload;
        setTraceroutes((prev) => ({ ...prev, [nodeId]: { route, routeBack } }));
        setPending((prev) => {
          const next = { ...prev };
          delete next[String(nodeId)];
          return next;
        });
      }
      // Clear pending spinner if the daemon reported the node was unreachable
      if (event.type === "error" && (event.payload as unknown as { nodeId?: number }).nodeId != null) {
        const nodeId = (event.payload as unknown as { nodeId: number }).nodeId;
        setPending((prev) => {
          const next = { ...prev };
          delete next[String(nodeId)];
          return next;
        });
      }
    });
    return () => { off(); };
  }, []);

  const deviceId = devices.find((d) => d.status === "connected")?.id ?? null;

  function requestPosition(nodeId: number) {
    if (!deviceId) return;
    setPending((prev) => ({ ...prev, [String(nodeId)]: "position" }));
    foremanClient.send({ type: "node:request-position", payload: { deviceId, nodeId } });
    // Position arrives as a node:update — clear pending after a timeout
    setTimeout(() => setPending((prev) => {
      const next = { ...prev };
      delete next[String(nodeId)];
      return next;
    }), 15000);
  }

  function requestTraceroute(nodeId: number) {
    if (!deviceId) return;
    setPending((prev) => ({ ...prev, [String(nodeId)]: "traceroute" }));
    foremanClient.send({ type: "node:traceroute", payload: { deviceId, nodeId } });
  }

  return (
    <div style={styles.page}>
      {/* Compact device status bar */}
      <div style={styles.deviceBar}>
        {devices.length === 0 ? (
          <span style={styles.muted}>No devices — POST /api/devices/connect</span>
        ) : (
          devices.map((d) => (
            <span key={d.id} style={styles.deviceChip}>
              <span style={{ ...styles.dot, background: d.status === "connected" ? "#22c55e" : "#ef4444" }} />
              <strong>{d.name}</strong>
              {d.port !== d.name && <span style={styles.muted}>{d.port}</span>}
              {d.firmwareVersion && <span style={styles.muted}>· fw {d.firmwareVersion}</span>}
              {d.lastSeenAt && <span style={styles.muted}>· {formatLastHeard(d.lastSeenAt)}</span>}
            </span>
          ))
        )}
      </div>

      <section style={styles.section}>
        <h2 style={styles.sectionTitle}>
          Mesh Nodes
          <span style={{ ...styles.badge, background: "#334155", marginLeft: "0.5rem" }}>
            {nodes.length}
          </span>
        </h2>
        {nodes.length === 0 ? (
          <p style={styles.muted}>No nodes seen yet.</p>
        ) : (
          <div style={styles.tableWrap}>
            <table style={styles.table}>
              <thead>
                <tr>
                  <th style={styles.th}>Node</th>
                  <th style={styles.th}>ID</th>
                  <th style={styles.th}>Connection</th>
                  <th style={styles.th}>Last Heard</th>
                  <th style={styles.th}>SNR</th>
                  <th style={styles.th}>Model</th>
                  <th style={styles.th}>Location</th>
                  {deviceId && <th style={styles.th}>Actions</th>}
                </tr>
              </thead>
              <tbody>
                {nodes.map((n) => {
                  const key = String(n.nodeId);
                  const isPending = !!pending[key];
                  const trResult = traceroutes[n.nodeId];
                  return (
                    <>
                      <tr key={n.nodeId} style={styles.tr}>
                        <td style={styles.td}>
                          <strong>{n.longName ?? n.shortName ?? "Unknown"}</strong>
                          {n.shortName && n.longName && (
                            <span style={{ ...styles.muted, marginLeft: "0.4rem" }}>({n.shortName})</span>
                          )}
                        </td>
                        <td style={{ ...styles.td, ...styles.mono }}>{nodeHex(n.nodeId)}</td>
                        <td style={styles.td}>{formatHops(n.hopsAway)}</td>
                        <td style={styles.td}>{formatLastHeard(n.lastHeard)}</td>
                        <td style={styles.td}>{n.snr != null ? `${n.snr.toFixed(1)} dB` : "—"}</td>
                        <td style={styles.td}>{n.hwModel != null ? (HW_MODEL[n.hwModel] ?? `#${n.hwModel}`) : "—"}</td>
                        <td style={{ ...styles.td, ...styles.mono }}>
                          {n.latitude != null && n.longitude != null
                            ? `${n.latitude.toFixed(5)}, ${n.longitude.toFixed(5)}`
                            : "—"}
                        </td>
                        {deviceId && (
                          <td style={{ ...styles.td, whiteSpace: "nowrap" }}>
                            <button
                              style={styles.actionBtn}
                              disabled={isPending}
                              onClick={() => requestPosition(n.nodeId)}
                              title="Ask node to broadcast its current position"
                            >
                              {pending[key] === "position" ? "…" : "📍 Pos"}
                            </button>
                            <button
                              style={{ ...styles.actionBtn, marginLeft: "0.4rem" }}
                              disabled={isPending}
                              onClick={() => requestTraceroute(n.nodeId)}
                              title="Trace the mesh route to this node"
                            >
                              {pending[key] === "traceroute" ? "…" : "🔍 Trace"}
                            </button>
                          </td>
                        )}
                      </tr>
                      {trResult && (
                        <tr key={`${n.nodeId}-trace`} style={{ ...styles.tr, background: "#0f1f35" }}>
                          <td colSpan={deviceId ? 8 : 7} style={{ ...styles.td, ...styles.mono, fontSize: "0.75rem", color: "#94a3b8" }}>
                            <strong style={{ color: "#60a5fa" }}>Traceroute</strong>
                            {" → "}
                            {trResult.route.length === 0
                              ? "Direct (no intermediate hops)"
                              : trResult.route.map((id) => nodeHex(id)).join(" → ")}
                            {trResult.routeBack.length > 0 && (
                              <span style={{ marginLeft: "1rem", color: "#94a3b8" }}>
                                (back: {trResult.routeBack.map((id) => nodeHex(id)).join(" → ")})
                              </span>
                            )}
                            <button
                              onClick={() => setTraceroutes((prev) => { const n2 = {...prev}; delete n2[n.nodeId]; return n2; })}
                              style={{ marginLeft: "1rem", background: "none", border: "none", color: "#64748b", cursor: "pointer", fontSize: "0.75rem" }}
                            >
                              ✕
                            </button>
                          </td>
                        </tr>
                      )}
                    </>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  page: { padding: "1.5rem 2rem" },
  deviceBar: {
    display: "flex",
    flexWrap: "wrap",
    gap: "0.75rem",
    marginBottom: "1.5rem",
    padding: "0.5rem 0.75rem",
    background: "#1e293b",
    borderRadius: "0.5rem",
    alignItems: "center",
  },
  deviceChip: {
    display: "flex",
    alignItems: "center",
    gap: "0.5rem",
    fontSize: "0.875rem",
  },
  dot: {
    width: "0.5rem",
    height: "0.5rem",
    borderRadius: "50%",
    flexShrink: 0,
  },
  section: { marginBottom: "2rem" },
  sectionTitle: {
    fontSize: "1rem",
    color: "#94a3b8",
    textTransform: "uppercase",
    letterSpacing: "0.1em",
    marginBottom: "0.75rem",
    display: "flex",
    alignItems: "center",
  },
  badge: {
    padding: "0.15rem 0.5rem",
    borderRadius: "9999px",
    fontSize: "0.75rem",
    color: "#fff",
    fontWeight: "bold",
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
  mono: { fontFamily: "monospace", fontSize: "0.8rem", color: "#94a3b8" },
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
