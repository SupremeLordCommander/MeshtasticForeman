import type { MqttNode } from "@foreman/shared";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function nodeHex(nodeId: number): string {
  return `!${nodeId.toString(16).padStart(8, "0")}`;
}

// Meshtastic HardwareModel enum — common values only
const HW_MODEL: Record<number, string> = {
  0: "UNSET", 1: "TLORA_V2", 2: "TLORA_V1", 3: "TLORA_V2_1_1P6", 4: "TBEAM",
  6: "HELTEC_V2_0", 7: "TBEAM_V0P7", 8: "T_ECHO", 9: "TLORA_V1_1P3",
  10: "RAK4631", 11: "HELTEC_V2_1", 12: "HELTEC_V1", 13: "LILYGO_TBEAM_S3_CORE",
  14: "RAK11200", 15: "NANO_G1", 16: "TLORA_V2_1_1P8", 17: "TLORA_T3_S3",
  18: "NANO_G1_EXPLORER", 19: "NANO_G2_ULTRA", 20: "LORA_TYPE",
  21: "WIPHONE", 22: "WIO_WM1110", 23: "RAK2560", 24: "HELTEC_HRU_3800",
  25: "STATION_G1", 26: "RAK11310", 27: "SENSELORA_RP2040", 28: "SENSELORA_S3",
  29: "CANARYONE", 30: "RP2040_LORA", 31: "STATION_G2", 32: "LORA_RELAY_V1",
  33: "NRF52840DK", 34: "PPR", 35: "GENIEBLOCKS", 36: "NRF52_UNKNOWN",
  37: "PORTDUINO", 38: "ANDROID_SIM", 39: "DIY_V1", 40: "NRF52840_PCA10059",
  41: "DR_DEV", 42: "M5STACK", 43: "HELTEC_V3", 44: "HELTEC_WSL_V3",
  45: "BETAFPV_2400_TX", 46: "BETAFPV_900_NANO_TX", 47: "RPI_PICO",
  48: "HELTEC_WIRELESS_TRACKER", 49: "HELTEC_WIRELESS_PAPER", 50: "T_DECK",
  51: "T_WATCH_S3", 52: "PICOMPUTER_S3", 53: "HELTEC_HT62", 54: "EBYTE_ESP32_S3",
  55: "ESP32_S3_PICO", 56: "ESP32_C3_POWERSAVE", 57: "MESH_TAB", 58: "HELTEC_CAPSULE_SENSOR_V3",
  59: "HELTEC_VISION_MASTER_T190", 60: "HELTEC_VISION_MASTER_E213",
  61: "HELTEC_VISION_MASTER_E290", 62: "HELTEC_MESH_NODE_T114",
  63: "SENSECAP_INDICATOR", 64: "TRACKER_T1000_E", 65: "RAK3172",
  66: "WIO_E5", 67: "RADIOMASTER_900_BANDIT_NANO", 68: "HELTEC_WIRELESS_PAPER_V1_0",
  69: "HELTEC_WIRELESS_TRACKER_V1_0", 70: "UNPHONE", 71: "TD_LORAC",
  72: "CDEBYTE_EORA_S3", 73: "TWC_MESH_V4", 74: "NRF52_PROMICRO_DIY",
  75: "RADIOMASTER_900_BANDIT", 76: "ME25LS01_4Y10TD", 77: "RP2040_FEATHER_RFM95",
  78: "M5STACK_COREBASIC", 79: "M5STACK_CORE2", 80: "RPI_PICO2",
  81: "M5STACK_CORES3", 82: "SEEED_XIAO_S3", 83: "MS24SF1",
  95: "HELTEC_WIRELESS_PAPER_V3",
  97: "TLORA_C6", 98: "WISMESH_TAP", 99: "SEEED_WIO_TRACKER_L1",
  255: "PRIVATE_HW",
};

function hwModelName(model: number | null): string {
  if (model === null) return "—";
  return HW_MODEL[model] ?? `#${model}`;
}

function formatLastHeard(iso: string | null): string {
  if (!iso) return "—";
  const diff = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

// Parse regionPath "US/CA/Humboldt/Eureka" into labelled segments
function parseRegion(path: string | null): string[] {
  if (!path) return ["Unknown"];
  return path.split("/").filter(Boolean);
}

// Build a nested tree: { [seg]: { nodes: MqttNode[], children: Tree } }
interface Tree {
  nodes: MqttNode[];
  children: Record<string, Tree>;
}

function buildTree(nodes: MqttNode[]): Tree {
  const root: Tree = { nodes: [], children: {} };
  for (const node of nodes) {
    const segs = parseRegion(node.regionPath);
    let cursor = root;
    for (const seg of segs) {
      if (!cursor.children[seg]) cursor.children[seg] = { nodes: [], children: {} };
      cursor = cursor.children[seg];
    }
    cursor.nodes.push(node);
  }
  return root;
}

function countNodes(tree: Tree): number {
  let n = tree.nodes.length;
  for (const child of Object.values(tree.children)) n += countNodes(child);
  return n;
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function NodeRow({ node }: { node: MqttNode }) {
  return (
    <tr style={s.tr}>
      <td style={s.td}>
        <strong>{node.longName ?? node.shortName ?? "Unknown"}</strong>
        {node.shortName && node.longName && (
          <span style={s.muted}> ({node.shortName})</span>
        )}
      </td>
      <td style={{ ...s.td, ...s.mono }}>{nodeHex(node.nodeId)}</td>
      <td style={s.td}>{formatLastHeard(node.lastHeard)}</td>
      <td style={{ ...s.td, ...s.mono }}>{node.lastGateway ?? "—"}</td>
      <td style={s.td}>{node.snr != null && node.snr !== 0 ? `${node.snr.toFixed(1)} dB` : "—"}</td>
      <td style={s.td}>{hwModelName(node.hwModel)}</td>
      <td style={{ ...s.td, ...s.mono }}>
        {node.latitude != null && node.longitude != null
          ? `${node.latitude.toFixed(4)}, ${node.longitude.toFixed(4)}`
          : "—"}
      </td>
    </tr>
  );
}

function NodeTable({ nodes }: { nodes: MqttNode[] }) {
  if (nodes.length === 0) return null;
  const sorted = [...nodes].sort((a, b) => {
    if (!a.lastHeard) return 1;
    if (!b.lastHeard) return -1;
    return new Date(b.lastHeard).getTime() - new Date(a.lastHeard).getTime();
  });
  return (
    <div style={s.tableWrap}>
      <table style={s.table}>
        <thead>
          <tr>
            <th style={s.th}>Node</th>
            <th style={s.th}>ID</th>
            <th style={s.th}>Last Heard</th>
            <th style={s.th}>Gateway</th>
            <th style={s.th}>SNR</th>
            <th style={s.th}>Model</th>
            <th style={s.th}>Location</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((n) => <NodeRow key={n.nodeId} node={n} />)}
        </tbody>
      </table>
    </div>
  );
}

// Recursively render a tree node as a collapsible section
function TreeSection({
  label,
  tree,
  depth,
}: {
  label: string;
  tree: Tree;
  depth: number;
}) {
  const total = countNodes(tree);
  const hasChildren = Object.keys(tree.children).length > 0;

  // Label semantics by depth: 0=country, 1=state, 2=county, 3+=city/region
  const depthLabels = ["Country", "State", "County", "City/Region"];
  const depthLabel = depthLabels[depth] ?? "Region";

  return (
    <div style={{ ...s.section, marginLeft: depth > 0 ? "1.5rem" : 0 }}>
      <div style={{ ...s.sectionHeader, borderLeftColor: depthColor(depth) }}>
        <span style={{ ...s.sectionLabel, color: depthColor(depth) }}>
          {depthLabel.toUpperCase()}
        </span>
        <span style={s.sectionName}>{label}</span>
        <span style={s.sectionCount}>{total} node{total !== 1 ? "s" : ""}</span>
      </div>

      {/* Nodes directly at this level (uncommon but possible) */}
      {tree.nodes.length > 0 && <NodeTable nodes={tree.nodes} />}

      {/* Child sections */}
      {hasChildren && Object.entries(tree.children)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([childLabel, childTree]) => (
          <TreeSection key={childLabel} label={childLabel} tree={childTree} depth={depth + 1} />
        ))
      }
    </div>
  );
}

function depthColor(depth: number): string {
  const colors = ["#60a5fa", "#34d399", "#f59e0b", "#a78bfa"];
  return colors[depth] ?? "#94a3b8";
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

interface Props {
  nodes: MqttNode[];
}

export function MqttNodesPage({ nodes }: Props) {
  const tree = buildTree(nodes);
  const withGps = nodes.filter((n) => n.latitude != null).length;

  return (
    <div style={s.page}>
      <div style={s.statsBar}>
        <span><strong>{nodes.length}</strong> total nodes</span>
        <span style={s.muted}>·</span>
        <span><strong>{withGps}</strong> with GPS</span>
        {nodes.length === 0 && (
          <span style={{ color: "#fbbf24" }}>
            Waiting for MQTT data — nodes appear as packets arrive
          </span>
        )}
      </div>

      {nodes.length === 0 ? null : (
        Object.entries(tree.children)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([label, subtree]) => (
            <TreeSection key={label} label={label} tree={subtree} depth={0} />
          ))
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const s: Record<string, React.CSSProperties> = {
  page: { padding: "1.5rem 2rem", overflowY: "auto" },
  statsBar: {
    display: "flex",
    gap: "0.75rem",
    alignItems: "center",
    marginBottom: "1.5rem",
    padding: "0.5rem 0.75rem",
    background: "#1e293b",
    borderRadius: "0.5rem",
    fontSize: "0.875rem",
  },
  muted: { color: "#64748b", fontSize: "0.85rem" },
  section: { marginBottom: "1.25rem" },
  sectionHeader: {
    display: "flex",
    alignItems: "center",
    gap: "0.75rem",
    borderLeft: "3px solid",
    paddingLeft: "0.75rem",
    marginBottom: "0.5rem",
  },
  sectionLabel: {
    fontSize: "0.65rem",
    letterSpacing: "0.1em",
    fontWeight: "bold",
    minWidth: "4rem",
  },
  sectionName: {
    fontSize: "1rem",
    fontWeight: "bold",
    color: "#f1f5f9",
  },
  sectionCount: {
    fontSize: "0.75rem",
    color: "#64748b",
    marginLeft: "auto",
  },
  tableWrap: { overflowX: "auto", marginBottom: "0.5rem" },
  table: { width: "100%", borderCollapse: "collapse", fontSize: "0.825rem" },
  th: {
    textAlign: "left",
    padding: "0.4rem 0.75rem",
    background: "#1e293b",
    color: "#94a3b8",
    fontWeight: "normal",
    borderBottom: "1px solid #334155",
    whiteSpace: "nowrap",
  },
  tr: { borderBottom: "1px solid #1e293b" },
  td: { padding: "0.4rem 0.75rem", verticalAlign: "middle" },
  mono: { fontFamily: "monospace", fontSize: "0.78rem", color: "#94a3b8" },
};
