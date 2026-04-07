import { useEffect, useState } from "react";
import { foremanClient } from "./ws/client.js";
import type { DeviceInfo, NodeInfo } from "@foreman/shared";
import { NodesPage } from "./pages/NodesPage.js";
import { MapPage } from "./pages/MapPage.js";

type Tab = "nodes" | "map";

export function App() {
  const [devices, setDevices] = useState<DeviceInfo[]>([]);
  const [nodes, setNodes] = useState<NodeInfo[]>([]);
  const [connected, setConnected] = useState(false);
  const [tab, setTab] = useState<Tab>("nodes");

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
    });

    return () => {
      off();
      foremanClient.disconnect();
      setConnected(false);
    };
  }, []);

  return (
    <div style={styles.page}>
      <header style={styles.header}>
        <h1 style={styles.title}>Meshtastic Foreman</h1>
        <nav style={styles.nav}>
          <button style={tabStyle(tab === "nodes")} onClick={() => setTab("nodes")}>Nodes</button>
          <button style={tabStyle(tab === "map")} onClick={() => setTab("map")}>Map</button>
        </nav>
        <span style={{ ...styles.badge, background: connected ? "#22c55e" : "#ef4444", marginLeft: "auto" }}>
          {connected ? "connected" : "disconnected"}
        </span>
      </header>

      {tab === "nodes" && <NodesPage devices={devices} nodes={nodes} />}
      {tab === "map" && <MapPage nodes={nodes} />}
    </div>
  );
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

const styles: Record<string, React.CSSProperties> = {
  page: {
    fontFamily: "monospace",
    background: "#0f172a",
    color: "#e2e8f0",
    minHeight: "100vh",
    display: "flex",
    flexDirection: "column",
  },
  header: {
    display: "flex",
    alignItems: "center",
    gap: "1rem",
    padding: "1rem 2rem",
    borderBottom: "1px solid #1e293b",
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
  badge: {
    padding: "0.15rem 0.5rem",
    borderRadius: "9999px",
    fontSize: "0.75rem",
    color: "#fff",
    fontWeight: "bold",
  },
};
