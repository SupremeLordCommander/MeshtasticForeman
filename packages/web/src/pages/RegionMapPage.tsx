import { useState, useCallback } from "react";
import Map, { Marker, Popup, NavigationControl } from "react-map-gl/maplibre";
import "maplibre-gl/dist/maplibre-gl.css";
import type { MqttNode } from "@foreman/shared";

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

interface Props {
  nodes: MqttNode[];
}

export function RegionMapPage({ nodes }: Props) {
  const [selected, setSelected] = useState<MqttNode | null>(null);

  const mappable = nodes.filter((n) => n.latitude != null && n.longitude != null);

  const firstNode = mappable[0];
  const initialView = {
    longitude: firstNode?.longitude ?? -124.1,
    latitude:  firstNode?.latitude  ??  40.8,
    zoom: firstNode ? 10 : 9,
  };

  const handleClick = useCallback((node: MqttNode) => {
    setSelected((prev) => (prev?.nodeId === node.nodeId ? null : node));
  }, []);

  return (
    <div style={styles.wrap}>
      <div style={styles.statsBar}>
        <span style={styles.stat}>
          <strong>{nodes.length}</strong> nodes via MQTT
        </span>
        <span style={styles.stat}>
          <strong>{mappable.length}</strong> with GPS
        </span>
        {nodes.length === 0 && (
          <span style={styles.warning}>Waiting for MQTT data — may take a minute after startup</span>
        )}
        {nodes.length > 0 && mappable.length === 0 && (
          <span style={styles.warning}>Nodes seen but no GPS yet — position packets arrive infrequently</span>
        )}
      </div>

      <Map
        key={mappable.length > 0 ? "has-gps" : "no-gps"}
        initialViewState={initialView}
        style={{ width: "100%", height: "100%" }}
        mapStyle={MAP_STYLE}
        attributionControl={false}
      >
        <NavigationControl position="top-right" />

        {mappable.map((node) => {
          const color = nodeColor(node.nodeId);
          return (
            <Marker
              key={node.nodeId}
              longitude={node.longitude!}
              latitude={node.latitude!}
              anchor="center"
              onClick={() => handleClick(node)}
            >
              <div
                title={node.longName ?? nodeHex(node.nodeId)}
                style={{
                  width: "2rem",
                  height: "2rem",
                  borderRadius: "50%",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: "0.6rem",
                  fontWeight: "bold",
                  fontFamily: "monospace",
                  cursor: "pointer",
                  userSelect: "none",
                  background: "#0f172a",
                  color,
                  border: `2px solid ${color}`,
                  boxShadow: `0 0 0 2px ${color}33`,
                }}
              >
                {(node.shortName ?? nodeHex(node.nodeId).slice(-4)).slice(0, 4)}
              </div>
            </Marker>
          );
        })}

        {selected && selected.longitude != null && selected.latitude != null && (
          <Popup
            longitude={selected.longitude}
            latitude={selected.latitude}
            anchor="bottom"
            offset={20}
            closeButton={true}
            closeOnClick={false}
            onClose={() => setSelected(null)}
            style={{ fontFamily: "monospace" }}
          >
            <div style={styles.popup}>
              <div style={styles.popupName}>
                {selected.longName ?? nodeHex(selected.nodeId)}
              </div>
              {selected.shortName && selected.longName && (
                <div style={styles.popupMuted}>{selected.shortName}</div>
              )}
              <div style={styles.popupGrid}>
                <span style={styles.popupLabel}>ID</span>
                <span style={styles.popupMono}>{nodeHex(selected.nodeId)}</span>

                <span style={styles.popupLabel}>Last heard</span>
                <span>{formatLastHeard(selected.lastHeard)}</span>

                <span style={styles.popupLabel}>Gateway</span>
                <span style={styles.popupMono}>{selected.lastGateway ?? "—"}</span>

                {selected.snr != null && (
                  <>
                    <span style={styles.popupLabel}>SNR</span>
                    <span>{selected.snr.toFixed(1)} dB</span>
                  </>
                )}

                {selected.hwModel != null && (
                  <>
                    <span style={styles.popupLabel}>Model</span>
                    <span>{HW_MODEL[selected.hwModel] ?? `#${selected.hwModel}`}</span>
                  </>
                )}

                <span style={styles.popupLabel}>GPS</span>
                <span style={styles.popupMono}>
                  {selected.latitude!.toFixed(5)}, {selected.longitude!.toFixed(5)}
                  {selected.altitude != null && ` (${selected.altitude}m)`}
                </span>
              </div>
            </div>
          </Popup>
        )}
      </Map>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  wrap: {
    flex: 1,
    position: "relative",
    minHeight: 0,
    overflow: "hidden",
    display: "flex",
    flexDirection: "column",
  },
  statsBar: {
    position: "absolute",
    top: "0.75rem",
    left: "50%",
    transform: "translateX(-50%)",
    zIndex: 10,
    background: "#0f172acc",
    backdropFilter: "blur(4px)",
    color: "#e2e8f0",
    padding: "0.35rem 1rem",
    borderRadius: "9999px",
    fontSize: "0.8rem",
    display: "flex",
    gap: "1.25rem",
    alignItems: "center",
    whiteSpace: "nowrap",
  },
  stat: { color: "#e2e8f0" },
  warning: { color: "#fbbf24" },
  popup: { minWidth: "180px", fontSize: "0.8rem", color: "#1e293b" },
  popupName: { fontWeight: "bold", fontSize: "0.9rem", marginBottom: "0.1rem" },
  popupMuted: { color: "#64748b", marginBottom: "0.5rem" },
  popupGrid: {
    display: "grid",
    gridTemplateColumns: "auto 1fr",
    gap: "0.2rem 0.75rem",
    alignItems: "baseline",
  },
  popupLabel: { color: "#64748b", fontSize: "0.75rem" },
  popupMono: { fontFamily: "monospace", fontSize: "0.75rem" },
};
