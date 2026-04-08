import { useState, useCallback } from "react";
import Map, { Marker, Popup, NavigationControl } from "react-map-gl/maplibre";
import "maplibre-gl/dist/maplibre-gl.css";
import type { NodeInfo, MqttNode } from "@foreman/shared";

const MAP_STYLE = "https://tiles.openfreemap.org/styles/liberty";

const HW_MODEL: Record<number, string> = {
  0: "UNSET", 4: "TBEAM", 8: "T_ECHO", 10: "RAK4631", 13: "LILYGO_TBEAM_S3_CORE",
  43: "HELTEC_V3", 48: "HELTEC_WIRELESS_TRACKER", 49: "HELTEC_WIRELESS_PAPER",
  50: "T_DECK", 51: "T_WATCH_S3", 64: "TRACKER_T1000_E", 66: "WIO_E5",
  95: "HELTEC_WIRELESS_PAPER_V3", 99: "SEEED_WIO_TRACKER_L1", 255: "PRIVATE_HW",
};

function nodeHex(nodeId: number): string {
  return `!${nodeId.toString(16).padStart(8, "0")}`;
}

function formatLastHeard(iso: string | null): string {
  if (!iso) return "never";
  const diff = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

function nodeColor(nodeId: number): string {
  const hue = (nodeId * 137.508) % 360;
  return `hsl(${hue}, 70%, 55%)`;
}

type SelectedNode =
  | { source: "mesh"; node: NodeInfo }
  | { source: "mqtt"; node: MqttNode };

interface Props {
  nodes: NodeInfo[];
  mqttNodes: MqttNode[];
}

export function MapPage({ nodes, mqttNodes }: Props) {
  const [showMesh, setShowMesh] = useState(true);
  const [showMqtt, setShowMqtt] = useState(true);
  const [selected, setSelected] = useState<SelectedNode | null>(null);

  const mappableMesh = nodes.filter((n) => n.latitude != null && n.longitude != null);
  const mappableMqtt = mqttNodes.filter((n) => n.latitude != null && n.longitude != null);
  const allMappable = [...mappableMesh, ...mappableMqtt];

  const firstNode = allMappable[0];
  const initialView = {
    longitude: firstNode?.longitude ?? -98.5,
    latitude: firstNode?.latitude ?? 39.5,
    zoom: firstNode ? 10 : 4,
  };

  const handleMeshClick = useCallback((node: NodeInfo) => {
    setSelected((prev) =>
      prev?.source === "mesh" && prev.node.nodeId === node.nodeId ? null : { source: "mesh", node }
    );
  }, []);

  const handleMqttClick = useCallback((node: MqttNode) => {
    setSelected((prev) =>
      prev?.source === "mqtt" && prev.node.nodeId === node.nodeId ? null : { source: "mqtt", node }
    );
  }, []);

  const selectedLon =
    selected?.source === "mesh" ? selected.node.longitude :
    selected?.source === "mqtt" ? selected.node.longitude : null;
  const selectedLat =
    selected?.source === "mesh" ? selected.node.latitude :
    selected?.source === "mqtt" ? selected.node.latitude : null;

  return (
    <div style={styles.wrap}>
      <Map
        key={allMappable.length > 0 ? "has-gps" : "no-gps"}
        initialViewState={initialView}
        style={{ width: "100%", height: "100%" }}
        mapStyle={MAP_STYLE}
        attributionControl={false}
      >
        <NavigationControl position="top-right" />

        {/* Mesh node markers */}
        {showMesh && mappableMesh.map((node) => {
          const isLocal = node.hopsAway === 0;
          const color = nodeColor(node.nodeId);
          return (
            <Marker
              key={`mesh-${node.nodeId}`}
              longitude={node.longitude!}
              latitude={node.latitude!}
              anchor="center"
              onClick={() => handleMeshClick(node)}
            >
              <div
                title={node.longName ?? nodeHex(node.nodeId)}
                style={{ ...styles.markerOuter, borderColor: color, boxShadow: `0 0 0 2px ${color}33`, cursor: "pointer" }}
              >
                <div
                  style={{
                    ...styles.markerInner,
                    background: isLocal ? color : "#0f172a",
                    color: isLocal ? "#fff" : color,
                    border: `2px solid ${color}`,
                  }}
                >
                  {(node.shortName ?? nodeHex(node.nodeId).slice(-4)).slice(0, 4)}
                </div>
                {isLocal && <div style={styles.localRing} />}
              </div>
            </Marker>
          );
        })}

        {/* MQTT node markers — dashed border to distinguish from mesh */}
        {showMqtt && mappableMqtt.map((node) => {
          const color = nodeColor(node.nodeId);
          return (
            <Marker
              key={`mqtt-${node.nodeId}`}
              longitude={node.longitude!}
              latitude={node.latitude!}
              anchor="center"
              onClick={() => handleMqttClick(node)}
            >
              <div
                title={`[MQTT] ${node.longName ?? nodeHex(node.nodeId)}`}
                style={{
                  ...styles.markerInner,
                  background: "#0f172a",
                  color,
                  border: `2px dashed ${color}`,
                  boxShadow: `0 0 0 2px ${color}22`,
                  cursor: "pointer",
                }}
              >
                {(node.shortName ?? nodeHex(node.nodeId).slice(-4)).slice(0, 4)}
              </div>
            </Marker>
          );
        })}

        {selected && selectedLon != null && selectedLat != null && (
          <Popup
            longitude={selectedLon}
            latitude={selectedLat}
            anchor="bottom"
            offset={20}
            closeButton={true}
            closeOnClick={false}
            onClose={() => setSelected(null)}
            style={{ fontFamily: "monospace" }}
          >
            {selected.source === "mesh" ? (
              <MeshPopup node={selected.node} />
            ) : (
              <MqttPopup node={selected.node} />
            )}
          </Popup>
        )}
      </Map>

      {/* Filter toggles — top left */}
      <div style={styles.filters}>
        <button
          style={filterBtnStyle(showMesh)}
          onClick={() => { setShowMesh((v) => !v); if (selected?.source === "mesh") setSelected(null); }}
        >
          <span style={{ ...styles.filterDot, border: "2px solid #94a3b8", background: "#0f172a" }} />
          Mesh {mappableMesh.length > 0 && <span style={styles.filterCount}>{mappableMesh.length}</span>}
        </button>
        <button
          style={filterBtnStyle(showMqtt)}
          onClick={() => { setShowMqtt((v) => !v); if (selected?.source === "mqtt") setSelected(null); }}
        >
          <span style={{ ...styles.filterDot, border: "2px dashed #94a3b8", background: "#0f172a" }} />
          MQTT {mappableMqtt.length > 0 && <span style={styles.filterCount}>{mappableMqtt.length}</span>}
        </button>
      </div>

      {/* Legend — bottom left */}
      <div style={styles.legend}>
        <span style={styles.legendItem}>
          <span style={{ ...styles.legendDot, background: "#3b82f6", border: "2px solid #3b82f6" }} />
          Local / direct
        </span>
        <span style={styles.legendItem}>
          <span style={{ ...styles.legendDot, background: "#0f172a", border: "2px solid #94a3b8" }} />
          Mesh
        </span>
        <span style={styles.legendItem}>
          <span style={{ ...styles.legendDot, background: "#0f172a", border: "2px dashed #94a3b8" }} />
          MQTT
        </span>
        <span style={{ color: "#64748b" }}>
          {mappableMesh.length + mappableMqtt.length} / {nodes.length + mqttNodes.length} with GPS
        </span>
      </div>
    </div>
  );
}

function MeshPopup({ node }: { node: NodeInfo }) {
  return (
    <div style={popupStyles.popup}>
      <div style={popupStyles.name}>{node.longName ?? nodeHex(node.nodeId)}</div>
      {node.shortName && node.longName && <div style={popupStyles.muted}>{node.shortName}</div>}
      <div style={popupStyles.grid}>
        <span style={popupStyles.label}>ID</span>
        <span style={popupStyles.mono}>{nodeHex(node.nodeId)}</span>

        <span style={popupStyles.label}>Last heard</span>
        <span>{formatLastHeard(node.lastHeard)}</span>

        <span style={popupStyles.label}>Hops</span>
        <span>
          {node.hopsAway === null ? "—" : node.hopsAway === 0 ? "Direct" : `${node.hopsAway} away`}
        </span>

        {node.snr != null && (
          <>
            <span style={popupStyles.label}>SNR</span>
            <span>{node.snr.toFixed(1)} dB</span>
          </>
        )}

        {node.hwModel != null && (
          <>
            <span style={popupStyles.label}>Model</span>
            <span>{HW_MODEL[node.hwModel] ?? `#${node.hwModel}`}</span>
          </>
        )}

        <span style={popupStyles.label}>GPS</span>
        <span style={popupStyles.mono}>
          {node.latitude!.toFixed(5)}, {node.longitude!.toFixed(5)}
          {node.altitude != null && ` (${node.altitude}m)`}
        </span>
      </div>
    </div>
  );
}

function MqttPopup({ node }: { node: MqttNode }) {
  return (
    <div style={popupStyles.popup}>
      <div style={popupStyles.name}>{node.longName ?? nodeHex(node.nodeId)}</div>
      {node.shortName && node.longName && <div style={popupStyles.muted}>{node.shortName}</div>}
      <div style={popupStyles.tag}>MQTT</div>
      <div style={popupStyles.grid}>
        <span style={popupStyles.label}>ID</span>
        <span style={popupStyles.mono}>{nodeHex(node.nodeId)}</span>

        <span style={popupStyles.label}>Last heard</span>
        <span>{formatLastHeard(node.lastHeard)}</span>

        <span style={popupStyles.label}>Gateway</span>
        <span style={popupStyles.mono}>{node.lastGateway ?? "—"}</span>

        {node.snr != null && (
          <>
            <span style={popupStyles.label}>SNR</span>
            <span>{node.snr.toFixed(1)} dB</span>
          </>
        )}

        {node.hwModel != null && (
          <>
            <span style={popupStyles.label}>Model</span>
            <span>{HW_MODEL[node.hwModel] ?? `#${node.hwModel}`}</span>
          </>
        )}

        <span style={popupStyles.label}>GPS</span>
        <span style={popupStyles.mono}>
          {node.latitude!.toFixed(5)}, {node.longitude!.toFixed(5)}
          {node.altitude != null && ` (${node.altitude}m)`}
        </span>
      </div>
    </div>
  );
}

function filterBtnStyle(active: boolean): React.CSSProperties {
  return {
    display: "flex",
    alignItems: "center",
    gap: "0.4rem",
    background: active ? "#1e3a5f" : "#0f172a",
    border: `1px solid ${active ? "#3b82f6" : "#334155"}`,
    color: active ? "#e2e8f0" : "#64748b",
    padding: "0.3rem 0.65rem",
    borderRadius: "0.375rem",
    cursor: "pointer",
    fontSize: "0.75rem",
    fontFamily: "monospace",
  };
}

const styles: Record<string, React.CSSProperties> = {
  wrap: {
    flex: 1,
    position: "relative",
    minHeight: 0,
    overflow: "hidden",
  },
  markerOuter: {
    position: "relative",
    borderRadius: "50%",
  },
  markerInner: {
    width: "2rem",
    height: "2rem",
    borderRadius: "50%",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontSize: "0.6rem",
    fontWeight: "bold",
    fontFamily: "monospace",
    userSelect: "none",
  },
  localRing: {
    position: "absolute",
    inset: "-4px",
    borderRadius: "50%",
    border: "2px dashed #22c55e",
    pointerEvents: "none",
  },
  filters: {
    position: "absolute",
    top: "0.75rem",
    left: "0.75rem",
    zIndex: 10,
    display: "flex",
    gap: "0.4rem",
  },
  filterDot: {
    width: "0.7rem",
    height: "0.7rem",
    borderRadius: "50%",
    display: "inline-block",
    flexShrink: 0,
  },
  filterCount: {
    background: "#334155",
    borderRadius: "9999px",
    padding: "0 0.3rem",
    fontSize: "0.65rem",
    marginLeft: "0.15rem",
  },
  legend: {
    position: "absolute",
    bottom: "1rem",
    left: "1rem",
    background: "#0f172acc",
    backdropFilter: "blur(4px)",
    color: "#e2e8f0",
    padding: "0.5rem 0.75rem",
    borderRadius: "0.5rem",
    fontSize: "0.75rem",
    display: "flex",
    gap: "1rem",
    alignItems: "center",
    zIndex: 10,
  },
  legendItem: {
    display: "flex",
    alignItems: "center",
    gap: "0.4rem",
  },
  legendDot: {
    width: "0.75rem",
    height: "0.75rem",
    borderRadius: "50%",
    display: "inline-block",
  },
};

const popupStyles: Record<string, React.CSSProperties> = {
  popup: { minWidth: "180px", fontSize: "0.8rem", color: "#1e293b" },
  name: { fontWeight: "bold", fontSize: "0.9rem", marginBottom: "0.1rem" },
  muted: { color: "#64748b", marginBottom: "0.25rem" },
  tag: {
    display: "inline-block",
    background: "#dbeafe",
    color: "#1d4ed8",
    borderRadius: "0.25rem",
    padding: "0 0.35rem",
    fontSize: "0.65rem",
    fontWeight: "bold",
    marginBottom: "0.4rem",
  },
  grid: {
    display: "grid",
    gridTemplateColumns: "auto 1fr",
    gap: "0.2rem 0.75rem",
    alignItems: "baseline",
  },
  label: { color: "#64748b", fontSize: "0.75rem" },
  mono: { fontFamily: "monospace", fontSize: "0.75rem" },
};
