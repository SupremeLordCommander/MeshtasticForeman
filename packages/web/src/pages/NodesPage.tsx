import type { DeviceInfo, NodeInfo } from "@foreman/shared";

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

function formatHops(hopsAway: number | null): string {
  if (hopsAway === null) return "—";
  if (hopsAway === 0) return "Direct";
  return `${hopsAway} hop${hopsAway > 1 ? "s" : ""}`;
}

interface Props {
  devices: DeviceInfo[];
  nodes: NodeInfo[];
}

export function NodesPage({ devices, nodes }: Props) {
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
                </tr>
              </thead>
              <tbody>
                {nodes.map((n) => (
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
                    <td style={styles.td}>{n.hwModel ?? "—"}</td>
                    <td style={{ ...styles.td, ...styles.mono }}>
                      {n.latitude != null && n.longitude != null
                        ? `${n.latitude.toFixed(5)}, ${n.longitude.toFixed(5)}`
                        : "—"}
                    </td>
                  </tr>
                ))}
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
};
