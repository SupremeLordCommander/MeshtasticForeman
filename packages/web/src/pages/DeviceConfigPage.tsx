import { useState, useEffect } from "react";
import type { DeviceConfig, DeviceInfo, Channel } from "@foreman/shared";
import { foremanClient } from "../ws/client.js";

interface Props {
  devices: DeviceInfo[];
  configs: Map<string, DeviceConfig>;
}

const CHANNEL_ROLES: Record<number, string> = {
  0: "DISABLED",
  1: "PRIMARY",
  2: "SECONDARY",
};

export function DeviceConfigPage({ devices, configs }: Props) {
  const connectedDevices = devices.filter((d) => d.status === "connected");
  const [selectedId, setSelectedId] = useState<string | null>(
    connectedDevices[0]?.id ?? null
  );

  const config = selectedId ? configs.get(selectedId) : null;
  const device = devices.find((d) => d.id === selectedId);

  // On mount (or when selected device changes), request a fresh config snapshot
  useEffect(() => {
    if (!selectedId) return;
    foremanClient.send({ type: "device:config-request", payload: { deviceId: selectedId } });
  }, [selectedId]);

  return (
    <div style={styles.page}>
      {/* Device selector */}
      {devices.length > 1 && (
        <div style={styles.deviceBar}>
          {devices.map((d) => (
            <button
              key={d.id}
              style={deviceBtnStyle(d.id === selectedId, d.status === "connected")}
              onClick={() => setSelectedId(d.id)}
            >
              <span style={{ color: d.status === "connected" ? "#22c55e" : "#ef4444" }}>●</span>
              {d.port}
            </button>
          ))}
        </div>
      )}

      {!config ? (
        <div style={styles.empty}>
          {device
            ? `No config captured yet for ${device.port} — connect the device and wait for configure() to complete.`
            : "No device selected."}
        </div>
      ) : (
        <div style={styles.body}>
          {/* Channels */}
          <Section title="Channels">
            <ChannelTable channels={config.channels} />
          </Section>

          {/* Radio config */}
          {Object.keys(config.radioConfig).length > 0 && (
            <Section title="Radio Config">
              {Object.entries(config.radioConfig).map(([key, value]) => (
                <ConfigCard key={key} title={key} data={value as Record<string, unknown>} />
              ))}
            </Section>
          )}

          {/* Module config */}
          {Object.keys(config.moduleConfig).length > 0 && (
            <Section title="Module Config">
              {Object.entries(config.moduleConfig).map(([key, value]) => (
                <ConfigCard key={key} title={key} data={value as Record<string, unknown>} />
              ))}
            </Section>
          )}
        </div>
      )}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={styles.section}>
      <div style={styles.sectionTitle}>{title}</div>
      <div style={styles.sectionBody}>{children}</div>
    </div>
  );
}

function ConfigCard({ title, data }: { title: string; data: Record<string, unknown> }) {
  const [open, setOpen] = useState(false);
  const entries = Object.entries(data).filter(([k]) => k !== "$typeName");

  return (
    <div style={styles.card}>
      <button style={styles.cardHeader} onClick={() => setOpen((v) => !v)}>
        <span style={styles.cardTitle}>{title}</span>
        <span style={{ color: "#475569", fontSize: "0.65rem" }}>{open ? "▲" : "▼"}</span>
      </button>
      {open && (
        <div style={styles.cardBody}>
          {entries.map(([k, v]) => (
            <div key={k} style={styles.row}>
              <span style={styles.rowKey}>{camelToLabel(k)}</span>
              <span style={styles.rowVal}>{formatValue(v)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function ChannelTable({ channels }: { channels: Channel[] }) {
  const active = channels.filter((c) => c.role !== 0);
  const rows = active.length > 0 ? active : channels.slice(0, 1);

  return (
    <table style={styles.table}>
      <thead>
        <tr>
          <th style={styles.th}>Index</th>
          <th style={styles.th}>Name</th>
          <th style={styles.th}>Role</th>
          <th style={styles.th}>PSK</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((ch) => (
          <tr key={ch.index}>
            <td style={styles.td}>{ch.index}</td>
            <td style={styles.td}>{ch.name || <span style={{ color: "#475569" }}>(default)</span>}</td>
            <td style={styles.td}>
              <span style={{ color: ch.role === 1 ? "#22c55e" : "#94a3b8" }}>
                {CHANNEL_ROLES[ch.role] ?? ch.role}
              </span>
            </td>
            <td style={styles.td}>
              {ch.psk ? <span style={{ color: "#475569" }}>●●●●●●●●</span> : <span style={{ color: "#334155" }}>none</span>}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function camelToLabel(key: string): string {
  return key.replace(/([A-Z])/g, " $1").replace(/^./, (s) => s.toUpperCase());
}

function formatValue(v: unknown): string {
  if (v === null || v === undefined) return "—";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") return String(v);
  if (typeof v === "string") return v === "" ? '""' : v;
  if (Array.isArray(v)) return v.length === 0 ? "[]" : JSON.stringify(v);
  return JSON.stringify(v);
}

function deviceBtnStyle(active: boolean, connected: boolean): React.CSSProperties {
  return {
    display: "inline-flex",
    alignItems: "center",
    gap: "0.3rem",
    background: active ? "#1e293b" : "transparent",
    border: `1px solid ${active ? "#3b82f6" : "#1e293b"}`,
    color: connected ? "#e2e8f0" : "#64748b",
    padding: "0.2rem 0.7rem",
    borderRadius: "0.375rem",
    cursor: "pointer",
    fontFamily: "monospace",
    fontSize: "0.8rem",
  };
}

const styles: Record<string, React.CSSProperties> = {
  page: {
    padding: "1.25rem",
    display: "flex",
    flexDirection: "column",
    gap: "1.25rem",
  },
  deviceBar: {
    display: "flex",
    gap: "0.5rem",
  },
  empty: {
    color: "#475569",
    fontSize: "0.85rem",
    padding: "2rem",
    textAlign: "center",
  },
  body: {
    display: "flex",
    flexDirection: "column",
    gap: "1.25rem",
  },
  section: {
    display: "flex",
    flexDirection: "column",
    gap: "0.5rem",
  },
  sectionTitle: {
    fontSize: "0.65rem",
    color: "#334155",
    textTransform: "uppercase",
    letterSpacing: "0.08em",
    marginBottom: "0.1rem",
  },
  sectionBody: {
    display: "flex",
    flexDirection: "column",
    gap: "0.4rem",
  },
  card: {
    border: "1px solid #1e293b",
    borderRadius: "0.375rem",
    overflow: "hidden",
  },
  cardHeader: {
    width: "100%",
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    background: "#0f172a",
    border: "none",
    padding: "0.45rem 0.75rem",
    cursor: "pointer",
    fontFamily: "monospace",
  },
  cardTitle: {
    color: "#94a3b8",
    fontSize: "0.8rem",
    fontWeight: "bold",
  },
  cardBody: {
    background: "#020617",
    padding: "0.5rem 0.75rem",
    display: "flex",
    flexDirection: "column",
    gap: "0.25rem",
  },
  row: {
    display: "flex",
    gap: "0.75rem",
    fontSize: "0.78rem",
    lineHeight: "1.4",
  },
  rowKey: {
    color: "#475569",
    width: "14rem",
    flexShrink: 0,
  },
  rowVal: {
    color: "#e2e8f0",
    wordBreak: "break-all",
  },
  table: {
    width: "100%",
    borderCollapse: "collapse",
    fontSize: "0.8rem",
  },
  th: {
    textAlign: "left",
    color: "#475569",
    padding: "0.4rem 0.75rem",
    borderBottom: "1px solid #1e293b",
    fontWeight: "normal",
  },
  td: {
    color: "#e2e8f0",
    padding: "0.35rem 0.75rem",
    borderBottom: "1px solid #0f172a",
    fontFamily: "monospace",
  },
};
