import { useEffect, useState } from "react";
import { foremanClient } from "./ws/client.js";
import type { DeviceInfo } from "@foreman/shared";

export function App() {
  const [devices, setDevices] = useState<DeviceInfo[]>([]);
  const [connected, setConnected] = useState(false);

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
          if (exists) {
            return prev.map((d) => (d.id === event.payload.id ? event.payload : d));
          }
          return [...prev, event.payload];
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
    <div style={{ fontFamily: "monospace", padding: "2rem" }}>
      <h1>Meshtastic Foreman</h1>
      <p>Daemon: {connected ? "connected" : "disconnected"}</p>
      <h2>Devices</h2>
      {devices.length === 0 ? (
        <p>No devices connected. Use POST /api/devices/connect to add one.</p>
      ) : (
        <ul>
          {devices.map((d) => (
            <li key={d.id}>
              <strong>{d.name}</strong> — {d.port} [{d.status}]
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
