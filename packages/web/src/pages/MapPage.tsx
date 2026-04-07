import { useState, useCallback } from "react";
import Map, { Marker, Popup, NavigationControl } from "react-map-gl/maplibre";
import "maplibre-gl/dist/maplibre-gl.css";
import type { NodeInfo } from "@foreman/shared";

const MAP_STYLE =
  "https://raw.githubusercontent.com/hc-oss/maplibre-gl-styles/master/styles/osm-mapnik/v8/default.json";

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

// Deterministic color from nodeId — matches the sister project's approach
function nodeColor(nodeId: number): string {
  const hue = (nodeId * 137.508) % 360;
  return `hsl(${hue}, 70%, 55%)`;
}

interface Props {
  nodes: NodeInfo[];
}

export function MapPage({ nodes }: Props) {
  const [selected, setSelected] = useState<NodeInfo | null>(null);

  const mappableNodes = nodes.filter(
    (n) => n.latitude != null && n.longitude != null
  );

  // Default center: first node with GPS, or fallback to US center
  const firstNode = mappableNodes[0];
  const initialView = {
    longitude: firstNode?.longitude ?? -98.5,
    latitude: firstNode?.latitude ?? 39.5,
    zoom: firstNode ? 10 : 4,
  };

  const handleMarkerClick = useCallback((node: NodeInfo) => {
    setSelected((prev) => (prev?.nodeId === node.nodeId ? null : node));
  }, []);

  return (
    <div style={styles.wrap}>
      {mappableNodes.length === 0 && (
        <div style={styles.noGps}>No nodes with GPS data yet.</div>
      )}
      <Map
        initialViewState={initialView}
        style={{ width: "100%", height: "100%" }}
        mapStyle={MAP_STYLE}
        attributionControl={false}
      >
        <NavigationControl position="top-right" />

        {mappableNodes.map((node) => {
          const isLocal = node.hopsAway === 0;
          const color = nodeColor(node.nodeId);

          return (
            <Marker
              key={node.nodeId}
              longitude={node.longitude!}
              latitude={node.latitude!}
              anchor="center"
              onClick={() => handleMarkerClick(node)}
            >
              <div
                title={node.longName ?? nodeHex(node.nodeId)}
                style={{
                  ...styles.markerOuter,
                  borderColor: color,
                  boxShadow: `0 0 0 2px ${color}33`,
                  cursor: "pointer",
                }}
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

                <span style={styles.popupLabel}>Hops</span>
                <span>
                  {selected.hopsAway === null
                    ? "—"
                    : selected.hopsAway === 0
                    ? "Direct"
                    : `${selected.hopsAway} away`}
                </span>

                {selected.snr != null && (
                  <>
                    <span style={styles.popupLabel}>SNR</span>
                    <span>{selected.snr.toFixed(1)} dB</span>
                  </>
                )}

                {selected.hwModel != null && (
                  <>
                    <span style={styles.popupLabel}>Model</span>
                    <span>{selected.hwModel}</span>
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

      <div style={styles.legend}>
        <span style={styles.legendItem}>
          <span style={{ ...styles.legendDot, background: "#3b82f6", border: "2px solid #3b82f6" }} />
          Local device
        </span>
        <span style={styles.legendItem}>
          <span style={{ ...styles.legendDot, background: "#0f172a", border: "2px solid #94a3b8" }} />
          Remote node
        </span>
        <span style={{ color: "#64748b" }}>
          {mappableNodes.length} / {nodes.length} nodes have GPS
        </span>
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  wrap: {
    flex: 1,
    position: "relative",
    minHeight: 0,
    height: "calc(100vh - 57px)", // full remaining height after header
  },
  noGps: {
    position: "absolute",
    top: "1rem",
    left: "50%",
    transform: "translateX(-50%)",
    background: "#1e293b",
    color: "#94a3b8",
    padding: "0.5rem 1rem",
    borderRadius: "0.5rem",
    fontSize: "0.875rem",
    zIndex: 10,
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
  popup: {
    minWidth: "180px",
    fontSize: "0.8rem",
    color: "#1e293b",
  },
  popupName: {
    fontWeight: "bold",
    fontSize: "0.9rem",
    marginBottom: "0.1rem",
  },
  popupMuted: {
    color: "#64748b",
    marginBottom: "0.5rem",
  },
  popupGrid: {
    display: "grid",
    gridTemplateColumns: "auto 1fr",
    gap: "0.2rem 0.75rem",
    alignItems: "baseline",
  },
  popupLabel: {
    color: "#64748b",
    fontSize: "0.75rem",
  },
  popupMono: {
    fontFamily: "monospace",
    fontSize: "0.75rem",
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
