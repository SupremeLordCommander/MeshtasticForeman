import { useState, useCallback, useEffect, useMemo, useRef } from "react";
import MapGL, { type MapRef, Marker, Popup, NavigationControl, Source, Layer } from "react-map-gl/maplibre";
import "maplibre-gl/dist/maplibre-gl.css";
import type { NodeInfo, MqttNode, DeviceConfig } from "@foreman/shared";
import { foremanClient } from "../ws/client.js";

type PendingMapAction = { nodeId: number; action: "ping" | "traceroute" };

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
// Coverage circle helpers
// ---------------------------------------------------------------------------

const COVERAGE_RADII_KM = [1, 3, 5, 10, 20];

/**
 * Expected typical LoRa range per modem preset (km).
 * Based on Meshtastic's documented spreading-factor / bandwidth combinations.
 * These are optimistic open-terrain estimates — terrain will reduce them.
 *
 * Preset numbers match Meshtastic's Config.LoRaConfig.ModemPreset enum:
 *   0 LONG_FAST · 1 LONG_SLOW · 2 VERY_LONG_SLOW · 3 MEDIUM_SLOW
 *   4 MEDIUM_FAST · 5 SHORT_SLOW · 6 SHORT_FAST · 7 LONG_MODERATE · 8 SHORT_TURBO
 */
const MODEM_PRESET_RADIUS_KM: Record<number, number> = {
  0: 10,  // LONG_FAST
  1: 15,  // LONG_SLOW
  2: 20,  // VERY_LONG_SLOW
  3: 7,   // MEDIUM_SLOW
  4: 5,   // MEDIUM_FAST
  5: 3,   // SHORT_SLOW
  6: 2,   // SHORT_FAST
  7: 12,  // LONG_MODERATE
  8: 1,   // SHORT_TURBO
};
export const MODEM_PRESET_LABEL: Record<number, string> = {
  0: "LONG_FAST", 1: "LONG_SLOW", 2: "VERY_LONG_SLOW",
  3: "MEDIUM_SLOW", 4: "MEDIUM_FAST", 5: "SHORT_SLOW",
  6: "SHORT_FAST", 7: "LONG_MODERATE", 8: "SHORT_TURBO",
};
const DEFAULT_RADIUS_KM = 10; // LONG_FAST fallback

/** Map channel name strings from MQTT topic paths to modem preset numbers.
 *  Matching is case-insensitive and ignores underscores/hyphens so both
 *  "LongFast" (topic) and "LONG_FAST" (enum label) resolve correctly. */
export function channelNameToPreset(name: string | null | undefined): number | null {
  if (!name) return null;
  const key = name.toLowerCase().replace(/[_\-\s]/g, "");
  const map: Record<string, number> = {
    longfast: 0, longslow: 1, verylongslow: 2,
    mediumslow: 3, mediumfast: 4, shortslow: 5,
    shortfast: 6, longmoderate: 7, shortturbo: 8,
  };
  return map[key] ?? null;
}

/** Always fetch viewsheds at this radius — one cache entry per node regardless of display radius. */
const TERRAIN_FETCH_RADIUS_KM = 20;

// ---------------------------------------------------------------------------
// Viewshed clip helpers
// ---------------------------------------------------------------------------

/** Spherical destination point — mirrors the formula in coverage.ts */
function destinationPoint(
  lat: number, lon: number, bearingDeg: number, distKm: number,
): { lat: number; lon: number } {
  const R = 6371;
  const δ = distKm / R;
  const φ1 = (lat * Math.PI) / 180;
  const λ1 = (lon * Math.PI) / 180;
  const θ = (bearingDeg * Math.PI) / 180;
  const φ2 = Math.asin(Math.sin(φ1) * Math.cos(δ) + Math.cos(φ1) * Math.sin(δ) * Math.cos(θ));
  const λ2 = λ1 + Math.atan2(Math.sin(θ) * Math.sin(δ) * Math.cos(φ1), Math.cos(δ) - Math.sin(φ1) * Math.sin(φ2));
  return { lat: (φ2 * 180) / Math.PI, lon: (((λ2 * 180) / Math.PI) + 540) % 360 - 180 };
}

/**
 * Trim a viewshed polygon (always fetched at TERRAIN_FETCH_RADIUS_KM) to a
 * smaller display radius.  Each vertex beyond maxRadiusKm is projected back
 * to that radius along the same bearing from the source, preserving the
 * terrain shape where it's closer than the limit.
 */
function clipViewshedToRadius(
  polygon: GeoJSON.Feature<GeoJSON.Polygon>,
  sourceLat: number,
  sourceLon: number,
  maxRadiusKm: number,
): GeoJSON.Feature<GeoJSON.Polygon> {
  const R = 6371;
  const ring = polygon.geometry.coordinates[0];
  const clipped = ring.map(([lon, lat]): [number, number] => {
    const dLat = ((lat - sourceLat) * Math.PI) / 180;
    const dLon = ((lon - sourceLon) * Math.PI) / 180;
    const a = Math.sin(dLat / 2) ** 2
      + Math.cos((sourceLat * Math.PI) / 180) * Math.cos((lat * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
    const distKm = R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    if (distKm <= maxRadiusKm) return [lon, lat];
    // Bearing source → vertex, then project back to maxRadiusKm
    const φ1 = (sourceLat * Math.PI) / 180;
    const φ2 = (lat * Math.PI) / 180;
    const Δλ = ((lon - sourceLon) * Math.PI) / 180;
    const bearing = (Math.atan2(Math.sin(Δλ) * Math.cos(φ2), Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ)) * 180) / Math.PI;
    const pt = destinationPoint(sourceLat, sourceLon, bearing, maxRadiusKm);
    return [pt.lon, pt.lat];
  });
  return { ...polygon, geometry: { type: "Polygon", coordinates: [clipped] } };
}

function presetRadiusKm(deviceConfigs: Map<string, DeviceConfig>, deviceId: string | null | undefined): number {
  if (!deviceId) return DEFAULT_RADIUS_KM;
  const cfg = deviceConfigs.get(deviceId);
  const preset = (cfg?.radioConfig as { lora?: { modemPreset?: number } } | undefined)?.lora?.modemPreset;
  if (preset == null) return DEFAULT_RADIUS_KM;
  return MODEM_PRESET_RADIUS_KM[preset] ?? DEFAULT_RADIUS_KM;
}

/**
 * Approximate a geodesic circle as a GeoJSON Polygon.
 * Uses equirectangular projection — accurate enough for LoRa ranges (≤20 km).
 */
function buildCoverageCircle(
  lon: number,
  lat: number,
  radiusKm: number,
  color: string,
  steps = 64,
  focused = false,
): GeoJSON.Feature<GeoJSON.Polygon> {
  const latRad = (lat * Math.PI) / 180;
  const dLat = radiusKm / 110.574;
  const dLon = radiusKm / (111.32 * Math.cos(latRad));
  const coords: [number, number][] = [];
  for (let i = 0; i <= steps; i++) {
    const angle = (i / steps) * 2 * Math.PI;
    coords.push([lon + dLon * Math.cos(angle), lat + dLat * Math.sin(angle)]);
  }
  return {
    type: "Feature",
    properties: { color, focused: focused ? 1 : 0 },
    geometry: { type: "Polygon", coordinates: [coords] },
  };
}

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
  deviceId?: string | null;
  deviceConfigs?: Map<string, DeviceConfig>;
  onMessage?: (nodeId: number) => void;
  focusedNodeId?: number | null;
  onClearFocusedNode?: () => void;
  /** Only show coverage for nodes on this modem preset (null = show all). */
  presetFilter?: number | null;
}

export function MapPage({ nodes, mqttNodes, showMesh, setShowMesh, showMqtt, setShowMqtt, deviceId, deviceConfigs, onMessage, focusedNodeId, onClearFocusedNode, presetFilter = null }: Props) {
  const [selected, setSelected] = useState<SelectedNode | null>(null);
  const [traceroutes, setTraceroutes] = useState<StoredTraceroute[]>([]);
  const [showTraceroutes, setShowTraceroutes] = useState(false);
  const [ageHours, setAgeHours] = useState(24);
  const [pendingAction, setPendingAction] = useState<PendingMapAction | null>(null);
  const [showCoverage, setShowCoverage] = useState(false);
  const [terrainMode, setTerrainMode] = useState(false);
  const [coverageRadiusKm, setCoverageRadiusKm] = useState(() =>
    presetRadiusKm(deviceConfigs ?? new Map(), deviceId)
  );
  // Re-snap radius to preset when config first arrives (e.g. device connects after page load),
  // but only if the user hasn't manually picked a radius yet.
  const [userPickedRadius, setUserPickedRadius] = useState(false);
  useEffect(() => {
    if (userPickedRadius) return;
    setCoverageRadiusKm(presetRadiusKm(deviceConfigs ?? new Map(), deviceId));
  }, [deviceId, deviceConfigs]); // eslint-disable-line react-hooks/exhaustive-deps

  // Tracks nodes whose terrain is currently being force-refreshed via the popup button.
  const [refreshingTerrainNodes, setRefreshingTerrainNodes] = useState<Set<number>>(new Set());

  // Viewshed cache: nodeId → GeoJSON polygon always fetched at TERRAIN_FETCH_RADIUS_KM.
  // One entry per node; display radius is applied via clipViewshedToRadius at render time.
  const viewshedCache = useRef(new Map<string, GeoJSON.Feature<GeoJSON.Polygon>>());
  const [viewshedStatus, setViewshedStatus] = useState<Map<number, "loading" | "ready" | "error">>(new Map());
  const mapRef = useRef<MapRef>(null);

  // When a node is focused from the Nodes tab: enable terrain coverage and fly to it.
  useEffect(() => {
    if (focusedNodeId == null) return;
    setShowCoverage(true);
    setTerrainMode(true);
  }, [focusedNodeId]);

  useEffect(() => {
    if (focusedNodeId == null) return;
    const node = [...mappableMesh, ...mappableMqtt].find((n) => n.nodeId === focusedNodeId);
    if (!node?.longitude || !node?.latitude) return;
    mapRef.current?.flyTo({ center: [node.longitude, node.latitude], zoom: 12, duration: 1200 });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusedNodeId]);

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

  // Re-fetch when a new traceroute result arrives via WebSocket; clear pending action
  useEffect(() => {
    const off = foremanClient.on((event) => {
      if (event.type === "traceroute:result") {
        fetchTraceroutes();
        setPendingAction((p) =>
          p?.action === "traceroute" && p.nodeId === event.payload.nodeId ? null : p
        );
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

  // Stable keys — recompute only when the set of GPS-equipped nodes or their positions change.
  // Sorted so ordering differences in the incoming array don't cause spurious cache misses.
  const meshGpsKey = nodes
    .filter((n) => n.latitude != null && n.longitude != null)
    .map((n) => `${n.nodeId}:${n.latitude?.toFixed(4)}:${n.longitude?.toFixed(4)}`)
    .sort()
    .join("|");
  const mqttGpsKey = mqttNodes
    .filter((n) => n.latitude != null && n.longitude != null)
    .map((n) => `${n.nodeId}:${n.latitude?.toFixed(4)}:${n.longitude?.toFixed(4)}`)
    .sort()
    .join("|");

  // Only produce new array references when GPS-relevant data actually changes,
  // preventing the viewshed effect from re-firing on every WebSocket update.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const mappableMesh = useMemo(() => nodes.filter((n) => n.latitude != null && n.longitude != null), [meshGpsKey]);
  // Exclude any MQTT node whose nodeId is already present in the mesh list —
  // the mesh copy is authoritative and we don't want duplicate markers/coverage.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const mappableMqtt = useMemo(() => {
    const meshIds = new Set(mappableMesh.map((n) => n.nodeId));
    return mqttNodes.filter((n) => n.latitude != null && n.longitude != null && !meshIds.has(n.nodeId));
  }, [mqttGpsKey, meshGpsKey]);
  const allMappable = [...mappableMesh, ...mappableMqtt];

  // Fetch terrain viewsheds for all mappable nodes when terrain mode is active.
  // Placed after mappableMesh/mappableMqtt so those variables are in scope.
  useEffect(() => {
    if (!showCoverage || !terrainMode) {
      setViewshedStatus(new Map());
      return;
    }
    // In single-node mode only fetch for that node; otherwise fetch all.
    const allNodes = focusedNodeId != null
      ? [...mappableMesh, ...mappableMqtt].filter((n) => n.nodeId === focusedNodeId)
      : [...mappableMesh, ...mappableMqtt];
    if (allNodes.length === 0) return;

    // Initialise status without resetting already-cached nodes — avoids the
    // "X/76 loading" flicker when the effect fires due to unrelated node updates.
    // Cache key is just nodeId — always fetched at TERRAIN_FETCH_RADIUS_KM (20km).
    const pending = new Map<number, "loading" | "ready" | "error">();
    for (const n of allNodes) {
      pending.set(n.nodeId, viewshedCache.current.has(`${n.nodeId}`) ? "ready" : "loading");
    }
    setViewshedStatus(new Map(pending));

    // Fetch viewsheds with limited concurrency (3 at a time) rather than firing
    // all requests at once.  Nodes in the same area share terrain — the first
    // few responses warm the backend elevation cache so later ones are fast DB
    // hits.  3 concurrent keeps throughput reasonable without bursting the API.
    let cancelled = false;
    const queue = allNodes.filter((n) => !viewshedCache.current.has(`${n.nodeId}`));
    let qi = 0;

    async function fetchOne(n: typeof allNodes[0]): Promise<void> {
      const key = `${n.nodeId}`;
      const antennaM = n.altitude != null ? n.altitude + 2 : 2;
      const url = `/api/coverage/viewshed?lat=${n.latitude}&lon=${n.longitude}&radiusKm=${TERRAIN_FETCH_RADIUS_KM}&altitudeM=${antennaM}`;
      try {
        const r = await fetch(url);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const geojson = await r.json() as GeoJSON.Feature<GeoJSON.Polygon>;
        // Always write to cache — preserves work even if cancelled so a
        // subsequent toggle-on skips nodes already fetched.
        viewshedCache.current.set(key, geojson);
        pending.set(n.nodeId, "ready");
      } catch {
        pending.set(n.nodeId, "error");
      }
      if (!cancelled) setViewshedStatus(new Map(pending));
    }

    async function worker(): Promise<void> {
      while (true) {
        if (cancelled) break;
        const idx = qi++;
        if (idx >= queue.length) break;
        await fetchOne(queue[idx]);
      }
    }

    const CONCURRENCY = 3;
    Promise.all(Array.from({ length: CONCURRENCY }, worker));

    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showCoverage, terrainMode, focusedNodeId, mappableMesh, mappableMqtt]);

  // Build GeoJSON coverage layer.
  // In terrain mode: only show nodes whose polygon has been computed — no
  // placeholder circles.  Nodes pop onto the map as their terrain arrives.
  // In circle mode: show all nodes as geodesic circles immediately.
  // Each MQTT node uses its own radius derived from its channelName; mesh nodes
  // use the device config preset.  presetFilter hides nodes not on that preset.
  // viewshedStatus is in deps so the memo refreshes as terrain data arrives.
  const coverageGeoJson = useMemo<GeoJSON.FeatureCollection>(() => {
    if (!showCoverage) return mkFeatureCollection([]);

    const meshPreset = (() => {
      const cfg = deviceConfigs?.get(deviceId ?? "");
      return (cfg?.radioConfig as { lora?: { modemPreset?: number } } | undefined)?.lora?.modemPreset ?? null;
    })();

    const features: GeoJSON.Feature[] = [];

    // Helper to get the radius for a given preset number (or fall back to default)
    const radiusFor = (preset: number | null) =>
      preset != null ? (MODEM_PRESET_RADIUS_KM[preset] ?? DEFAULT_RADIUS_KM) : DEFAULT_RADIUS_KM;

    // ── Mesh nodes ────────────────────────────────────────────────────────────
    const meshToShow = focusedNodeId != null
      ? mappableMesh.filter((n) => n.nodeId === focusedNodeId)
      : mappableMesh;
    for (const n of meshToShow) {
      if (presetFilter != null && meshPreset !== presetFilter) continue;
      const color = nodeColor(n.nodeId);
      const isFocused = n.nodeId === focusedNodeId;
      const radius = radiusFor(meshPreset);
      const cached = viewshedCache.current.get(`${n.nodeId}`);
      if (terrainMode) {
        if (!cached) continue;
        const poly = radius < TERRAIN_FETCH_RADIUS_KM
          ? clipViewshedToRadius(cached, n.latitude!, n.longitude!, radius)
          : cached;
        features.push({ ...poly, properties: { ...poly.properties, color, focused: isFocused ? 1 : 0 } });
      } else {
        features.push(buildCoverageCircle(n.longitude!, n.latitude!, radius, color, 64, isFocused));
      }
    }

    // ── MQTT nodes ────────────────────────────────────────────────────────────
    if (showMqtt) {
      const mqttToShow = focusedNodeId != null
        ? mappableMqtt.filter((n) => n.nodeId === focusedNodeId)
        : mappableMqtt;
      for (const n of mqttToShow) {
        const nodePreset = channelNameToPreset(n.channelName);
        if (presetFilter != null && nodePreset !== presetFilter) continue;
        const color = nodeColor(n.nodeId);
        const isFocused = n.nodeId === focusedNodeId;
        const radius = radiusFor(nodePreset);
        const cached = viewshedCache.current.get(`${n.nodeId}`);
        if (terrainMode) {
          if (!cached) continue;
          const poly = radius < TERRAIN_FETCH_RADIUS_KM
            ? clipViewshedToRadius(cached, n.latitude!, n.longitude!, radius)
            : cached;
          features.push({ ...poly, properties: { ...poly.properties, color, focused: isFocused ? 1 : 0 } });
        } else {
          features.push(buildCoverageCircle(n.longitude!, n.latitude!, radius, color, 64, isFocused));
        }
      }
    }

    return mkFeatureCollection(features);
  }, [showCoverage, terrainMode, coverageRadiusKm, focusedNodeId, mappableMesh, mappableMqtt, showMqtt, presetFilter, deviceId, deviceConfigs, viewshedStatus]);

  const firstNode = allMappable[0];
  const initialView = {
    longitude: firstNode?.longitude ?? -98.5,
    latitude: firstNode?.latitude ?? 39.5,
    zoom: firstNode ? 10 : 4,
  };

  const handleMeshClick = useCallback((node: NodeInfo, e: { originalEvent: MouseEvent }) => {
    e.originalEvent.stopPropagation();
    setSelected((prev) =>
      prev?.source === "mesh" && prev.node.nodeId === node.nodeId ? null : { source: "mesh", node }
    );
  }, []);

  const handleMqttClick = useCallback((node: MqttNode, e: { originalEvent: MouseEvent }) => {
    e.originalEvent.stopPropagation();
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
        ref={mapRef}
        key={allMappable.length > 0 ? "has-gps" : "no-gps"}
        initialViewState={initialView}
        style={{ width: "100%", height: "100%" }}
        mapStyle={MAP_STYLE}
        attributionControl={false}
        onClick={() => setSelected(null)}
      >
        <NavigationControl position="top-right" />

        {/* Coverage circles — one per node with GPS */}
        <Source id="coverage" type="geojson" data={coverageGeoJson}>
          <Layer
            id="coverage-fill"
            type="fill"
            paint={{
              "fill-color": ["get", "color"],
              "fill-opacity": ["case", ["==", ["get", "focused"], 1], 0.28, 0.15],
            }}
          />
          <Layer
            id="coverage-outline"
            type="line"
            paint={{
              "line-color": ["get", "color"],
              "line-width": ["case", ["==", ["get", "focused"], 1], 2, 1],
              "line-opacity": ["case", ["==", ["get", "focused"], 1], 0.8, 0.5],
              "line-dasharray": [4, 2],
            }}
          />
        </Source>

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
              onClick={(e) => handleMeshClick(node, e)}
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
              onClick={(e) => handleMqttClick(node, e)}
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

        {selected && selectedLon != null && selectedLat != null && (() => {
          // Build a refresh callback only when terrain mode is on and the node
          // has a known position (needed to key the viewshed_cache row).
          const refreshTerrain = (terrainMode && selected.source === "mesh" && selected.node.latitude != null && selected.node.longitude != null)
            ? async () => {
                const n = selected.node;
                const nodeId = n.nodeId;
                setRefreshingTerrainNodes((prev) => new Set(prev).add(nodeId));
                // 1. Evict the DB-cached viewshed polygon for this position
                await fetch(
                  `/api/coverage/viewshed?lat=${n.latitude}&lon=${n.longitude}&radiusKm=${TERRAIN_FETCH_RADIUS_KM}`,
                  { method: "DELETE" },
                ).catch(() => {/* ignore — we'll re-fetch regardless */});
                // 2. Drop the in-memory polygon so the fetch loop doesn't skip it
                viewshedCache.current.delete(`${nodeId}`);
                // 3. Fetch the fresh viewshed directly (bypasses the loop queue)
                const antennaM = n.altitude != null ? n.altitude + 2 : 2;
                const url = `/api/coverage/viewshed?lat=${n.latitude}&lon=${n.longitude}&radiusKm=${TERRAIN_FETCH_RADIUS_KM}&altitudeM=${antennaM}`;
                try {
                  const r = await fetch(url);
                  if (!r.ok) throw new Error(`HTTP ${r.status}`);
                  const geojson = await r.json() as GeoJSON.Feature<GeoJSON.Polygon>;
                  viewshedCache.current.set(`${nodeId}`, geojson);
                  setViewshedStatus((prev) => new Map(prev).set(nodeId, "ready"));
                } catch {
                  setViewshedStatus((prev) => new Map(prev).set(nodeId, "error"));
                } finally {
                  setRefreshingTerrainNodes((prev) => { const s = new Set(prev); s.delete(nodeId); return s; });
                }
              }
            : undefined;

          return (
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
              <MeshPopup
                node={selected.node}
                deviceId={deviceId ?? null}
                pending={pendingAction?.nodeId === selected.node.nodeId ? pendingAction.action : null}
                onRequestPosition={() => {
                  if (!deviceId) return;
                  setPendingAction({ nodeId: selected.node.nodeId, action: "ping" });
                  foremanClient.send({ type: "node:request-position", payload: { deviceId, nodeId: selected.node.nodeId } });
                  setTimeout(() => setPendingAction((p) => p?.nodeId === selected.node.nodeId ? null : p), 15000);
                }}
                onTraceroute={() => {
                  if (!deviceId) return;
                  setPendingAction({ nodeId: selected.node.nodeId, action: "traceroute" });
                  foremanClient.send({ type: "node:traceroute", payload: { deviceId, nodeId: selected.node.nodeId } });
                  setTimeout(() => setPendingAction((p) => p?.nodeId === selected.node.nodeId ? null : p), 30000);
                }}
                onMessage={onMessage ? () => { setSelected(null); onMessage(selected.node.nodeId); } : undefined}
                onRefreshTerrain={refreshTerrain}
                terrainRefreshing={refreshingTerrainNodes.has(selected.node.nodeId)}
              />
            ) : (
              <MqttPopup
                node={selected.node}
                onRefreshTerrain={refreshTerrain}
                terrainRefreshing={refreshingTerrainNodes.has(selected.node.nodeId)}
              />
            )}
          </Popup>
          );
        })()}
      </MapGL>

      {/* Age filter + traceroute toggle — top left */}
      <div style={styles.controls}>
        <span style={styles.controlLabel}>Traceroutes:</span>
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

      {/* Coverage radius controls — below traceroute controls */}
      <div style={{ ...styles.controls, top: "3.5rem" }}>
        <span style={styles.controlLabel}>
          Coverage
          {(() => {
            if (!deviceId || !deviceConfigs) return ":";
            const cfg = deviceConfigs.get(deviceId);
            const preset = (cfg?.radioConfig as { lora?: { modemPreset?: number } } | undefined)?.lora?.modemPreset;
            if (preset == null) return ":";
            return ` (${MODEM_PRESET_LABEL[preset] ?? preset}):`;
          })()}
        </span>
        {COVERAGE_RADII_KM.map((km) => (
          <button
            key={km}
            style={ageFilterBtnStyle(showCoverage && coverageRadiusKm === km)}
            onClick={() => {
              setShowCoverage(true);
              setCoverageRadiusKm(km);
              setUserPickedRadius(true);
            }}
          >
            {km}km
          </button>
        ))}
        <button
          style={{
            ...ageFilterBtnStyle(showCoverage && terrainMode),
            borderColor: showCoverage && terrainMode ? "#86efac" : undefined,
            color: showCoverage && terrainMode ? "#86efac" : undefined,
            background: showCoverage && terrainMode ? "#14532d" : undefined,
          }}
          onClick={() => {
            setShowCoverage(true);
            setTerrainMode((v) => !v);
          }}
          title="Terrain-aware coverage (fetches elevation data)"
        >
          Terrain
        </button>
        <button
          style={ageFilterBtnStyle(!showCoverage)}
          onClick={() => { setShowCoverage((v) => !v); if (showCoverage) setTerrainMode(false); }}
          title="Hide coverage"
        >
          Off
        </button>
        {focusedNodeId != null && (
          <button
            style={{
              ...ageFilterBtnStyle(false),
              borderColor: "#86efac",
              color: "#86efac",
              marginLeft: "0.25rem",
            }}
            onClick={() => onClearFocusedNode?.()}
            title="Return to all-nodes coverage view"
          >
            ← All nodes
          </button>
        )}
        {showCoverage && terrainMode && (() => {
          const total = viewshedStatus.size;
          const done  = [...viewshedStatus.values()].filter((s) => s !== "loading").length;
          const errors = [...viewshedStatus.values()].filter((s) => s === "error").length;
          if (total === 0) return null;
          if (done < total) return (
            <span style={{ color: "#fbbf24", fontSize: "0.7rem", fontFamily: "monospace" }} title="Computing terrain line-of-sight for each node. First run fetches elevation data from the internet; subsequent runs use the local cache and are instant.">
              ⛰ Computing terrain… {done}/{total}
            </span>
          );
          return (
            <span style={{ color: errors > 0 ? "#fca5a5" : "#86efac", fontSize: "0.7rem", fontFamily: "monospace" }}>
              {errors > 0 ? `⛰ ${errors} failed` : "⛰ ready"}
            </span>
          );
        })()}
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
        {showCoverage && (
          <span style={styles.legendItem}>
            <span style={{
              display: "inline-block", width: "1rem", height: "1rem",
              borderRadius: terrainMode ? "2px" : "50%",
              background: "#94a3b833", border: "1px dashed #94a3b8",
            }} />
            {terrainMode ? "Terrain LOS" : `${coverageRadiusKm}km range`}
          </span>
        )}
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

interface MeshPopupProps {
  node: NodeInfo;
  deviceId: string | null;
  pending: "ping" | "traceroute" | null;
  onRequestPosition: () => void;
  onTraceroute: () => void;
  onMessage?: () => void;
  onRefreshTerrain?: () => void;
  terrainRefreshing?: boolean;
}

function MeshPopup({ node, deviceId, pending, onRequestPosition, onTraceroute, onMessage, onRefreshTerrain, terrainRefreshing }: MeshPopupProps) {
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

      <div style={popupStyles.actions}>
        {deviceId && (
          <>
            <button
              style={popupActionBtnStyle(pending === "ping")}
              disabled={!!pending}
              onClick={onRequestPosition}
            >
              {pending === "ping" ? "Requesting…" : "📍 Request Position"}
            </button>
            <button
              style={popupActionBtnStyle(pending === "traceroute")}
              disabled={!!pending}
              onClick={onTraceroute}
            >
              {pending === "traceroute" ? "Tracing…" : "🔍 Traceroute"}
            </button>
            {onMessage && (
              <button style={popupActionBtnStyle(false)} onClick={onMessage}>
                ✉ Messages Tab
              </button>
            )}
          </>
        )}
        {onRefreshTerrain && (
          <button
            style={popupActionBtnStyle(terrainRefreshing === true)}
            disabled={terrainRefreshing}
            onClick={onRefreshTerrain}
            title="Clear cached terrain data and recompute line-of-sight from fresh elevation data"
          >
            {terrainRefreshing ? "⛰ Recalculating…" : "⛰ Recalculate Terrain"}
          </button>
        )}
      </div>
    </div>
  );
}

function MqttPopup({ node, onRefreshTerrain, terrainRefreshing }: {
  node: MqttNode;
  onRefreshTerrain?: () => void;
  terrainRefreshing?: boolean;
}) {
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
      {onRefreshTerrain && (
        <div style={popupStyles.actions}>
          <button
            style={popupActionBtnStyle(terrainRefreshing === true)}
            disabled={terrainRefreshing}
            onClick={onRefreshTerrain}
            title="Clear cached terrain data and recompute line-of-sight from fresh elevation data"
          >
            {terrainRefreshing ? "⛰ Recalculating…" : "⛰ Recalculate Terrain"}
          </button>
        </div>
      )}
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

function popupActionBtnStyle(active: boolean): React.CSSProperties {
  return {
    display: "block",
    width: "100%",
    textAlign: "left",
    background: active ? "#dbeafe" : "#f1f5f9",
    border: `1px solid ${active ? "#93c5fd" : "#cbd5e1"}`,
    color: active ? "#1d4ed8" : "#334155",
    borderRadius: "0.25rem",
    padding: "0.3rem 0.5rem",
    cursor: active ? "not-allowed" : "pointer",
    fontFamily: "monospace",
    fontSize: "0.75rem",
  };
}

const popupStyles: Record<string, React.CSSProperties> = {
  popup: { minWidth: "200px", fontSize: "0.8rem", color: "#1e293b" },
  name: { fontWeight: "bold", fontSize: "0.9rem", marginBottom: "0.1rem" },
  muted: { color: "#64748b", marginBottom: "0.25rem" },
  actions: {
    display: "flex",
    flexDirection: "column",
    gap: "0.3rem",
    marginTop: "0.6rem",
    paddingTop: "0.5rem",
    borderTop: "1px solid #e2e8f0",
  },
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
