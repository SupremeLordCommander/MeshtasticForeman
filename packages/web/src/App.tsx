import { useEffect, useState, useCallback } from "react";
import { foremanClient } from "./ws/client.js";
import type { DeviceInfo, NodeInfo, MqttNode, NodeOverride, ActivityEntry, LogEntry } from "@foreman/shared";
import { NodesPage } from "./pages/NodesPage.js";
import { MapPage } from "./pages/MapPage.js";
import { NodeOverridesPage } from "./pages/NodeOverridesPage.js";
import { ActivityPage } from "./pages/ActivityPage.js";
import { LogsPage } from "./pages/LogsPage.js";
import logo from "./assets/logo.png";

type Tab = "nodes" | "map" | "activity" | "logs" | "overrides";
type ActivityWindow = "5m" | "15m" | "1h" | "all";
type ActivitySource = "all" | "mesh" | "mqtt";
type LogsLevel = "all" | "log" | "warn" | "error";

const KNOWN_TAGS = ["devices", "mqtt", "ws", "db", "foreman"] as const;
type TagFilter = "all" | typeof KNOWN_TAGS[number];

const TAG_COLORS: Record<string, string> = {
  devices: "#60a5fa",
  mqtt:    "#34d399",
  ws:      "#a78bfa",
  db:      "#fb923c",
  foreman: "#94a3b8",
};

/** Apply fallback lat/lon/altitude from overrides when the node has no GPS data. */
function applyNodeOverrides<T extends { nodeId: number; latitude: number | null; longitude: number | null; altitude: number | null; longName?: string | null; shortName?: string | null }>(
  nodes: T[],
  overrides: Map<number, NodeOverride>,
): T[] {
  return nodes.map((n) => {
    const ov = overrides.get(n.nodeId);
    if (!ov) return n;
    return {
      ...n,
      latitude:  n.latitude  ?? ov.latitude,
      longitude: n.longitude ?? ov.longitude,
      altitude:  n.altitude  ?? ov.altitude,
      longName:  ("longName" in n  ? n.longName  : null) ?? ov.aliasName ?? null,
      shortName: ("shortName" in n ? n.shortName : null) ?? null,
    };
  });
}

export function App() {
  const [devices, setDevices] = useState<DeviceInfo[]>([]);
  const [nodes, setNodes] = useState<NodeInfo[]>([]);
  const [mqttNodes, setMqttNodes] = useState<MqttNode[]>([]);
  const [overrides, setOverrides] = useState<Map<number, NodeOverride>>(new Map());
  const [activity, setActivity] = useState<ActivityEntry[]>([]);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [mqttEnabled, setMqttEnabled] = useState(false);
  const [connected, setConnected] = useState(false);
  const [tab, setTab] = useState<Tab>("nodes");

  // ── Map filters ────────────────────────────────────────────────────────────
  const [showMesh, setShowMesh] = useState(true);
  const [showMqtt, setShowMqtt] = useState(true);

  // ── Activity filters ───────────────────────────────────────────────────────
  const [activityWindow, setActivityWindow] = useState<ActivityWindow>("15m");
  const [activitySource, setActivitySource] = useState<ActivitySource>("all");
  const [activityPaused, setActivityPaused] = useState(false);

  // ── Logs filters ───────────────────────────────────────────────────────────
  const [logsLevel, setLogsLevel] = useState<LogsLevel>("all");
  const [logsTag, setLogsTag] = useState<TagFilter>("all");
  const [logsPaused, setLogsPaused] = useState(false);

  const loadOverrides = useCallback(async () => {
    try {
      const res = await fetch("/api/node-overrides");
      if (!res.ok) return;
      const list: NodeOverride[] = await res.json();
      setOverrides(new Map(list.map((o) => [o.nodeId, o])));
    } catch {
      // daemon may not be up yet — silently ignore
    }
  }, []);

  useEffect(() => {
    loadOverrides();
  }, [loadOverrides]);

  useEffect(() => {
    foremanClient.connect();
    setConnected(true);

    const off = foremanClient.on((event) => {
      if (event.type === "device:list") {
        setDevices(event.payload);
      }
      if (event.type === "device:status") {
        setDevices((prev) => {
          const exists = prev.find((d) => d.id === event.payload.id);
          if (exists) return prev.map((d) => (d.id === event.payload.id ? event.payload : d));
          return [...prev, event.payload];
        });
      }
      if (event.type === "node:list") {
        setNodes((prev) => {
          const map = new Map(prev.map((n) => [n.nodeId, n]));
          for (const n of event.payload) map.set(n.nodeId, n);
          return sortNodes([...map.values()]);
        });
      }
      if (event.type === "node:update") {
        setNodes((prev) => {
          const exists = prev.find((n) => n.nodeId === event.payload.nodeId);
          const updated = exists
            ? prev.map((n) => (n.nodeId === event.payload.nodeId ? event.payload : n))
            : [...prev, event.payload];
          return sortNodes(updated);
        });
      }
      if (event.type === "mqtt_node:list") {
        setMqttNodes((prev) => {
          const map = new Map(prev.map((n) => [n.nodeId, n]));
          for (const n of event.payload) map.set(n.nodeId, n);
          return sortMqttNodes([...map.values()]);
        });
      }
      if (event.type === "mqtt_node:update") {
        setMqttNodes((prev) => {
          const exists = prev.find((n) => n.nodeId === event.payload.nodeId);
          const updated = exists
            ? prev.map((n) => (n.nodeId === event.payload.nodeId ? event.payload : n))
            : [...prev, event.payload];
          return sortMqttNodes(updated);
        });
      }
      if (event.type === "activity:snapshot") {
        setActivity(event.payload);
      }
      if (event.type === "activity:entry") {
        setActivity((prev) => {
          const next = [...prev, event.payload];
          return next.length > 500 ? next.slice(next.length - 500) : next;
        });
      }
      if (event.type === "log:snapshot") {
        setLogs(event.payload);
      }
      if (event.type === "log:entry") {
        setLogs((prev) => {
          const next = [...prev, event.payload];
          return next.length > 500 ? next.slice(next.length - 500) : next;
        });
      }
      if (event.type === "mqtt:status") {
        setMqttEnabled(event.payload.enabled);
      }
    });

    return () => {
      off();
      foremanClient.disconnect();
      setConnected(false);
    };
  }, []);

  const toggleMqtt = useCallback(() => {
    foremanClient.send({ type: "mqtt:toggle", payload: { enabled: !mqttEnabled } });
  }, [mqttEnabled]);

  // Merge override fallbacks before passing to pages
  const effectiveNodes     = applyNodeOverrides(nodes,     overrides);
  const effectiveMqttNodes = applyNodeOverrides(mqttNodes, overrides);

  // Counts for map filter buttons
  const mappableMeshCount = effectiveNodes.filter((n) => n.latitude != null && n.longitude != null).length;
  const mappableMqttCount = effectiveMqttNodes.filter((n) => n.latitude != null && n.longitude != null).length;

  // Tag counts for log filter buttons
  const logTagCounts: Record<string, number> = {};
  for (const e of logs) logTagCounts[e.tag] = (logTagCounts[e.tag] ?? 0) + 1;

  const noLocationNodes: Array<{ nodeId: number; longName: string | null; shortName: string | null }> = (() => {
    const seen = new Map<number, { nodeId: number; longName: string | null; shortName: string | null }>();
    for (const n of nodes) {
      if (n.latitude == null) seen.set(n.nodeId, { nodeId: n.nodeId, longName: n.longName, shortName: n.shortName });
    }
    for (const n of mqttNodes) {
      if (n.latitude == null && !seen.has(n.nodeId)) seen.set(n.nodeId, { nodeId: n.nodeId, longName: n.longName, shortName: n.shortName });
    }
    for (const [id, ov] of overrides) {
      if (ov.latitude != null) seen.delete(id);
    }
    return [...seen.values()].sort((a, b) => a.nodeId - b.nodeId);
  })();

  return (
    <div style={styles.page}>
      <header style={styles.header}>
        <img src={logo} alt="Meshtastic Foreman" style={styles.logo} />
        <h1 style={styles.title}>Meshtastic Foreman</h1>
        <nav style={styles.nav}>
          <button style={tabStyle(tab === "nodes")} onClick={() => setTab("nodes")}>Nodes</button>
          <button style={tabStyle(tab === "map")} onClick={() => setTab("map")}>Map</button>
          <button style={tabStyle(tab === "activity")} onClick={() => setTab("activity")}>
            Activity {activity.length > 0 && <span style={styles.tabCount}>{activity.length}</span>}
          </button>
          <button style={tabStyle(tab === "logs")} onClick={() => setTab("logs")}>
            Logs {logs.length > 0 && <span style={styles.tabCount}>{logs.length}</span>}
          </button>
          <button style={tabStyle(tab === "overrides")} onClick={() => setTab("overrides")}>
            Overrides {overrides.size > 0 && <span style={styles.tabCount}>{overrides.size}</span>}
          </button>
        </nav>

        {/* ── Tab-specific filters ───────────────────────────────────────── */}
        <div style={styles.filterGroup}>

          {tab === "map" && (
            <>
              <span style={styles.filterLabel}>Show:</span>
              <button
                style={hdrFilterBtn(showMesh)}
                onClick={() => setShowMesh((v) => !v)}
              >
                <span style={{ ...styles.dotBase, border: "2px solid #94a3b8", background: "#0f172a" }} />
                Mesh
                {mappableMeshCount > 0 && <span style={styles.hdrCount}>{mappableMeshCount}</span>}
              </button>
              <button
                style={hdrFilterBtn(showMqtt)}
                onClick={() => setShowMqtt((v) => !v)}
              >
                <span style={{ ...styles.dotBase, border: "2px dashed #94a3b8", background: "#0f172a" }} />
                MQTT
                {mappableMqttCount > 0 && <span style={styles.hdrCount}>{mappableMqttCount}</span>}
              </button>
            </>
          )}

          {tab === "activity" && (
            <>
              <span style={styles.filterLabel}>Window:</span>
              {(["5m", "15m", "1h", "all"] as ActivityWindow[]).map((w) => (
                <button key={w} style={hdrFilterBtn(activityWindow === w)} onClick={() => setActivityWindow(w)}>{w}</button>
              ))}
              <span style={{ ...styles.filterLabel, marginLeft: "0.4rem" }}>Source:</span>
              {(["all", "mesh", "mqtt"] as ActivitySource[]).map((s) => (
                <button
                  key={s}
                  style={{
                    ...hdrFilterBtn(activitySource === s),
                    color: activitySource === s ? "#fff" : s === "mesh" ? "#60a5fa" : s === "mqtt" ? "#34d399" : undefined,
                  }}
                  onClick={() => setActivitySource(s)}
                >{s}</button>
              ))}
              <button
                style={{ ...hdrFilterBtn(activityPaused), marginLeft: "0.25rem" }}
                onClick={() => setActivityPaused((p) => !p)}
              >
                {activityPaused ? "▶ Resume" : "⏸ Pause"}
              </button>
            </>
          )}

          {tab === "logs" && (
            <>
              <span style={styles.filterLabel}>Level:</span>
              {(["all", "log", "warn", "error"] as LogsLevel[]).map((l) => (
                <button
                  key={l}
                  style={{
                    ...hdrFilterBtn(logsLevel === l),
                    color: logsLevel === l ? "#fff" : l === "warn" ? "#fbbf24" : l === "error" ? "#f87171" : undefined,
                  }}
                  onClick={() => setLogsLevel(l)}
                >{l}</button>
              ))}
              <span style={{ ...styles.filterLabel, marginLeft: "0.4rem" }}>Tag:</span>
              <button style={hdrFilterBtn(logsTag === "all")} onClick={() => setLogsTag("all")}>all</button>
              {KNOWN_TAGS.map((t) => (
                <button
                  key={t}
                  style={{ ...hdrFilterBtn(logsTag === t), color: logsTag === t ? "#fff" : TAG_COLORS[t] }}
                  onClick={() => setLogsTag(t)}
                >
                  {t}
                  {logTagCounts[t] ? <span style={styles.hdrCount}>{logTagCounts[t]}</span> : null}
                </button>
              ))}
              <button
                style={{ ...hdrFilterBtn(logsPaused), marginLeft: "0.25rem" }}
                onClick={() => setLogsPaused((p) => !p)}
              >
                {logsPaused ? "▶ Resume" : "⏸ Pause"}
              </button>
            </>
          )}

          {/* Divider */}
          <div style={styles.divider} />

          <button
            onClick={toggleMqtt}
            style={{
              background: mqttEnabled ? "#166534" : "#1e293b",
              border: `1px solid ${mqttEnabled ? "#16a34a" : "#ef4444"}`,
              color: mqttEnabled ? "#4ade80" : "#f87171",
              padding: "0.2rem 0.7rem",
              borderRadius: "0.25rem",
              cursor: "pointer",
              fontSize: "0.75rem",
              fontFamily: "monospace",
            }}
          >
            MQTT {mqttEnabled ? "ON" : "OFF"}
          </button>
          <span style={{ ...styles.badge, background: connected ? "#22c55e" : "#ef4444" }}>
            {connected ? "connected" : "disconnected"}
          </span>
        </div>
      </header>

      {tab === "nodes" && (
        <div style={{ flex: 1, overflowY: "auto" }}>
          <NodesPage devices={devices} nodes={effectiveNodes} mqttNodes={effectiveMqttNodes} />
        </div>
      )}
      {tab === "map" && (
        <MapPage
          nodes={effectiveNodes}
          mqttNodes={effectiveMqttNodes}
          showMesh={showMesh}
          setShowMesh={setShowMesh}
          showMqtt={showMqtt}
          setShowMqtt={setShowMqtt}
        />
      )}
      {tab === "activity" && (
        <div style={{ flex: 1, overflowY: "auto" }}>
          <ActivityPage
            entries={activity}
            window={activityWindow}
            sourceFilter={activitySource}
            paused={activityPaused}
            setPaused={setActivityPaused}
          />
        </div>
      )}
      {tab === "logs" && (
        <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
          <LogsPage
            entries={logs}
            levelFilter={logsLevel}
            tagFilter={logsTag}
            paused={logsPaused}
            setPaused={setLogsPaused}
          />
        </div>
      )}
      {tab === "overrides" && (
        <div style={{ flex: 1, overflowY: "auto" }}>
          <NodeOverridesPage
            overrides={[...overrides.values()]}
            noLocationNodes={noLocationNodes}
            onChanged={loadOverrides}
          />
        </div>
      )}
    </div>
  );
}

function sortMqttNodes(nodes: MqttNode[]): MqttNode[] {
  return [...nodes].sort((a, b) => {
    if (!a.lastHeard) return 1;
    if (!b.lastHeard) return -1;
    return new Date(b.lastHeard).getTime() - new Date(a.lastHeard).getTime();
  });
}

function sortNodes(nodes: NodeInfo[]): NodeInfo[] {
  return [...nodes].sort((a, b) => {
    if (!a.lastHeard) return 1;
    if (!b.lastHeard) return -1;
    return new Date(b.lastHeard).getTime() - new Date(a.lastHeard).getTime();
  });
}

function tabStyle(active: boolean): React.CSSProperties {
  return {
    background: active ? "#3b82f6" : "transparent",
    color: active ? "#fff" : "#94a3b8",
    border: "none",
    padding: "0.35rem 1rem",
    borderRadius: "0.375rem",
    cursor: "pointer",
    fontFamily: "monospace",
    fontSize: "0.875rem",
  };
}

function hdrFilterBtn(active: boolean): React.CSSProperties {
  return {
    display: "inline-flex",
    alignItems: "center",
    gap: "0.3rem",
    background: active ? "#1e3a5f" : "#0f172a",
    border: `1px solid ${active ? "#3b82f6" : "#1e293b"}`,
    color: active ? "#e2e8f0" : "#64748b",
    padding: "0.15rem 0.5rem",
    borderRadius: "0.25rem",
    cursor: "pointer",
    fontSize: "0.72rem",
    fontFamily: "monospace",
  };
}

const styles: Record<string, React.CSSProperties> = {
  page: {
    fontFamily: "monospace",
    background: "#0f172a",
    color: "#e2e8f0",
    height: "100%",
    display: "flex",
    flexDirection: "column",
  },
  header: {
    display: "flex",
    alignItems: "center",
    gap: "0.75rem",
    padding: "0.65rem 1.25rem",
    borderBottom: "1px solid #1e293b",
    flexShrink: 0,
    flexWrap: "wrap",
  },
  logo: {
    height: "2rem",
    width: "auto",
    flexShrink: 0,
  },
  title: {
    margin: 0,
    fontSize: "1.25rem",
    color: "#f8fafc",
    whiteSpace: "nowrap",
  },
  nav: {
    display: "flex",
    gap: "0.25rem",
  },
  tabCount: {
    background: "#334155",
    borderRadius: "9999px",
    padding: "0 0.35rem",
    fontSize: "0.7rem",
    marginLeft: "0.3rem",
  },
  filterGroup: {
    marginLeft: "auto",
    display: "flex",
    alignItems: "center",
    gap: "0.3rem",
    flexWrap: "wrap",
  },
  filterLabel: {
    color: "#475569",
    fontSize: "0.7rem",
    whiteSpace: "nowrap",
  },
  dotBase: {
    width: "0.6rem",
    height: "0.6rem",
    borderRadius: "50%",
    display: "inline-block",
    flexShrink: 0,
  },
  hdrCount: {
    background: "#334155",
    borderRadius: "9999px",
    padding: "0 0.3rem",
    fontSize: "0.6rem",
    marginLeft: "0.1rem",
  },
  divider: {
    width: "1px",
    height: "1.2rem",
    background: "#1e293b",
    margin: "0 0.2rem",
    flexShrink: 0,
  },
  badge: {
    padding: "0.15rem 0.5rem",
    borderRadius: "9999px",
    fontSize: "0.75rem",
    color: "#fff",
    fontWeight: "bold",
  },
};
