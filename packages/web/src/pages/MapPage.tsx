import { useState, useCallback, useEffect, useMemo } from "react";
import MapGL, { Marker, Popup, NavigationControl, Source, Layer } from "react-map-gl/maplibre";
import "maplibre-gl/dist/maplibre-gl.css";
import type { NodeInfo, MqttNode } from "@foreman/shared";
import { foremanClient } from "../ws/client.js";

const MAP_STYLE =
  import.meta.env.VITE_MAP_STYLE ?? "https://tiles.openfreemap.org/styles/liberty";

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

// ---------------------------------------------------------------------------
// Traceroute types
// ---------------------------------------------------------------------------

interface StoredTraceroute {
  id: string;
  deviceId: string;
  fromNodeId: number;
  toNodeId: number;
  route: number[];
  routeBack: number[];
  recordedAt: string;
}

// ---------------------------------------------------------------------------
// Age filter options
// ---------------------------------------------------------------------------

const AGE_OPTIONS: { label: string; hours: number }[] = [
  { label: "1h",  hours: 1 },
  { label: "6h",  hours: 6 },
  { label: "24h", hours: 24 },
  { label: "7d",  hours: 168 },
  { label: "All", hours: 0 },
];

// ---------------------------------------------------------------------------
// GeoJSON line building
// ---------------------------------------------------------------------------

type Coord = [number, number];

interface Segment {
  coords: Coord[];
  dashed: boolean;
  color: string;
}

/**
 * Build map line segments for a traceroute. The full path is:
 *   fromNodeId → route[0] → ... → route[n] → toNodeId
 *
 * For each consecutive pair where BOTH nodes have known GPS: solid segment.
 * Where one or more hops are missing GPS data, we "skip" to the next known
 * node and draw a dashed segment to indicate the gap.
 */
function buildSegments(
  traceroute: StoredTraceroute,
  posMap: Map<number, Coord>,
): Segment[] {
  const path = [traceroute.fromNodeId, ...traceroute.route, traceroute.toNodeId];
  const color = nodeColor(traceroute.toNodeId);
  const segments: Segment[] = [];

  let lastKnownIdx: number | null = null;
  let hadGap = false;

  for (let i = 0; i < path.length; i++) {
    const pos = posMap.get(path[i]);
    if (!pos) {
      if (lastKnownIdx !== null) hadGap = true;
      continue;
    }
    if (lastKnownIdx !== null) {
      const prevPos = posMap.get(path[lastKnownIdx])!;
      segments.push({ coords: [prevPos, pos], dashed: hadGap, color });
    }
    lastKnownIdx = i;
    hadGap = false;
  }

  return segments;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

type SelectedNode =
  | { source: "mesh"; node: NodeInfo }
  | { source: "mqtt"; node: MqttNode };

interface Props {
  nodes: NodeInfo[];
  mqttNodes: MqttNode[];
  showMesh: boolean;
  setShowMesh: (fn: (v: boolean) => boolean) => void;
  showMqtt: boolean;
  setShowMqtt: (fn: (v: boolean) => boolean) => void;
}

export function MapPage({ nodes, mqttNodes, showMesh, setShowMesh, showMqtt, setShowMqtt }: Props) {
  const [selected, setSelected] = useState<SelectedNode | null>(null);
  const [traceroutes, setTraceroutes] = useState<StoredTraceroute[]>([]);
  const [showTraceroutes, setShowTraceroutes] = useState(true);
  const [ageHours, setAgeHours] = useState(24);

  // Clear popup when the relevant source is hidden
  useEffect(() => {
    if (!showMesh && selected?.source === "mesh") setSelected(null);
  }, [showMesh]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!showMqtt && selected?.source === "mqtt") setSelected(null);
  }, [showMqtt]); // eslint-disable-line react-hooks/exhaustive-deps

  // Fetch stored traceroutes from the API
  const fetchTraceroutes = useCallback(async () => {
    try {
      let url = "/api/traceroutes";
      if (ageHours > 0) {
        const since = new Date(Date.now() - ageHours * 3600 * 1000).toISOString();
        url += `?since=${encodeURIComponent(since)}`;
      }
      const res = await fetch(url);
      if (!res.ok) return;
      const data = await res.json() as StoredTraceroute[];
      setTraceroutes(data);
    } catch {
      // ignore fetch errors (daemon may be restarting)
    }
  }, [ageHours]);

  // Fetch on mount and whenever the age filter changes
  useEffect(() => {
    fetchTraceroutes();
  }, [fetchTraceroutes]);

  // Re-fetch when a new traceroute result arrives via WebSocket
  useEffect(() => {
    const off = foremanClient.on((event) => {
      if (event.type === "traceroute:result") {
        fetchTraceroutes();
      }
    });
    return () => { off(); };
  }, [fetchTraceroutes]);

  // Build nodeId → [lon, lat] lookup from all known nodes
  const posMap = useMemo<Map<number, Coord>>(() => {
    const m = new Map<number, Coord>();
    for (const n of nodes) {
      if (n.latitude != null && n.longitude != null) {
        m.set(n.nodeId, [n.longitude, n.latitude]);
      }
    }
    for (const n of mqttNodes) {
      if (n.latitude != null && n.longitude != null) {
        m.set(n.nodeId, [n.longitude, n.latitude]);
      }
    }
    return m;
  }, [nodes, mqttNodes]);

  // Build GeoJSON for traceroute lines — two layers: solid and dashed
  const { solidGeoJson, dashedGeoJson } = useMemo(() => {
    const solidFeatures: GeoJSON.Feature[] = [];
    const dashedFeatures: GeoJSON.Feature[] = [];

    if (!showTraceroutes) return { solidGeoJson: mkFeatureCollection([]), dashedGeoJson: mkFeatureCollection([]) };

    for (const tr of traceroutes) {
      const segs = buildSegments(tr, posMap);
      for (const seg of segs) {
        const feature: GeoJSON.Feature<GeoJSON.LineString> = {
          type: "Feature",
          properties: { color: seg.color, trId: tr.id },
          geometry: { type: "LineString", coordinates: seg.coords },
        };
        if (seg.dashed) {
          dashedFeatures.push(feature);
        } else {
          solidFeatures.push(feature);
        }
      }
    }

    return {
      solidGeoJson: mkFeatureCollection(solidFeatures),
      dashedGeoJson: mkFeatureCollection(dashedFeatures),
    };
  }, [traceroutes, posMap, showTraceroutes]);

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
      <MapGL
        key={allMappable.length > 0 ? "has-gps" : "no-gps"}
        initialViewState={initialView}
        style={{ width: "100%", height: "100%" }}
        mapStyle={MAP_STYLE}
        attributionControl={false}
      >
        <NavigationControl position="top-right" />

        {/* Traceroute lines — solid (all hops known) */}
        <Source id="traceroutes-solid" type="geojson" data={solidGeoJson}>
          <Layer
            id="traceroutes-solid-line"
            type="line"
            paint={{
              "line-color": ["get", "color"],
              "line-width": 2,
              "line-opacity": 0.75,
            }}
          />
        </Source>

        {/* Traceroute lines — dashed (some hops missing GPS) */}
        <Source id="traceroutes-dashed" type="geojson" data={dashedGeoJson}>
          <Layer
            id="traceroutes-dashed-line"
            type="line"
            paint={{
              "line-color": ["get", "color"],
              "line-width": 2,
              "line-opacity": 0.5,
              "line-dasharray": [3, 3],
            }}
          />
        </Source>

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
      </MapGL>

      {/* Age filter + traceroute toggle — top left */}
      <div style={styles.controls}>
        <span style={styles.controlLabel}>Routes:</span>
        {AGE_OPTIONS.map((opt) => (
          <button
            key={opt.label}
            style={ageFilterBtnStyle(ageHours === opt.hours && showTraceroutes)}
            onClick={() => {
              if (!showTraceroutes) setShowTraceroutes(true);
              setAgeHours(opt.hours);
            }}
          >
            {opt.label}
          </button>
        ))}
        <button
          style={ageFilterBtnStyle(!showTraceroutes)}
          onClick={() => setShowTraceroutes((v) => !v)}
          title="Hide all traceroute lines"
        >
          Off
        </button>
        <span style={{ color: "#64748b", fontSize: "0.7rem", marginLeft: "0.25rem" }}>
          {showTraceroutes ? `${traceroutes.length} route${traceroutes.length !== 1 ? "s" : ""}` : "hidden"}
        </span>
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
        <span style={styles.legendItem}>
          <span style={styles.legendLine} />
          Route
        </span>
        <span style={styles.legendItem}>
          <span style={{ ...styles.legendLine, borderStyle: "dashed", opacity: 0.6 }} />
          Route (gap)
        </span>
        <span style={{ color: "#64748b" }}>
          {mappableMesh.length + mappableMqtt.length} / {nodes.length + mqttNodes.length} with GPS
        </span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mkFeatureCollection(features: GeoJSON.Feature[]): GeoJSON.FeatureCollection {
  return { type: "FeatureCollection", features };
}

function ageFilterBtnStyle(active: boolean): React.CSSProperties {
  return {
    padding: "0.2rem 0.45rem",
    fontSize: "0.7rem",
    borderRadius: "0.3rem",
    border: active ? "1px solid #60a5fa" : "1px solid #334155",
    background: active ? "#1e3a5f" : "#1e293b",
    color: active ? "#93c5fd" : "#94a3b8",
    cursor: "pointer",
  };
}

// ---------------------------------------------------------------------------
// Popup components
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

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
  controls: {
    position: "absolute",
    top: "1rem",
    left: "1rem",
    background: "#0f172acc",
    backdropFilter: "blur(4px)",
    color: "#e2e8f0",
    padding: "0.4rem 0.6rem",
    borderRadius: "0.5rem",
    fontSize: "0.75rem",
    display: "flex",
    gap: "0.3rem",
    alignItems: "center",
    zIndex: 10,
  },
  controlLabel: {
    color: "#94a3b8",
    marginRight: "0.15rem",
    fontSize: "0.7rem",
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
  legendLine: {
    display: "inline-block",
    width: "1.5rem",
    height: 0,
    borderTop: "2px solid #94a3b8",
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
