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

// ---------------------------------------------------------------------------
// Templates — predefined config recipes
// ---------------------------------------------------------------------------

interface ConfigChange {
  namespace: "radio" | "module";
  section: string;
  /** Fields to merge. Only listed keys are sent; existing keys not listed are preserved on device. */
  value: Record<string, unknown>;
}

interface Template {
  id: string;
  label: string;
  description: string;
  /** Keys that will be highlighted in the config view */
  highlights: Array<{ namespace: "radio" | "module"; section: string; key: string }>;
  changes: ConfigChange[];
}

const TEMPLATES: Template[] = [
  {
    id: "mqtt-uplink-on",
    label: "Enable MQTT uplink",
    description: "Turn on MQTT, enable encryption, set proxy to client. Device will forward mesh traffic to the broker.",
    highlights: [
      { namespace: "module", section: "mqtt", key: "enabled" },
      { namespace: "module", section: "mqtt", key: "encryptionEnabled" },
      { namespace: "module", section: "mqtt", key: "proxyToClientEnabled" },
    ],
    changes: [
      {
        namespace: "module",
        section: "mqtt",
        value: { enabled: true, encryptionEnabled: true, proxyToClientEnabled: true },
      },
    ],
  },
  {
    id: "mqtt-uplink-off",
    label: "Disable MQTT uplink",
    description: "Turn off MQTT. Device will stop forwarding mesh traffic to the broker.",
    highlights: [
      { namespace: "module", section: "mqtt", key: "enabled" },
    ],
    changes: [
      {
        namespace: "module",
        section: "mqtt",
        value: { enabled: false },
      },
    ],
  },
  {
    id: "router-mode",
    label: "Router mode",
    description: "Set device role to ROUTER. The node will rebroadcast packets but not originate NodeInfo or position.",
    highlights: [
      { namespace: "radio", section: "device", key: "role" },
    ],
    changes: [
      {
        namespace: "radio",
        section: "device",
        value: { role: 2 },
      },
    ],
  },
  {
    id: "client-mode",
    label: "Client mode",
    description: "Set device role to CLIENT (default). Normal user-facing device.",
    highlights: [
      { namespace: "radio", section: "device", key: "role" },
    ],
    changes: [
      {
        namespace: "radio",
        section: "device",
        value: { role: 0 },
      },
    ],
  },
  {
    id: "store-forward-server",
    label: "Store & Forward server",
    description: "Enable Store & Forward as server with heartbeat. Useful for nodes with good connectivity.",
    highlights: [
      { namespace: "module", section: "storeForward", key: "enabled" },
      { namespace: "module", section: "storeForward", key: "isServer" },
      { namespace: "module", section: "storeForward", key: "heartbeat" },
    ],
    changes: [
      {
        namespace: "module",
        section: "storeForward",
        value: { enabled: true, isServer: true, heartbeat: true },
      },
    ],
  },
];

// ---------------------------------------------------------------------------

export function DeviceConfigPage({ devices, configs }: Props) {
  const connectedDevices = devices.filter((d) => d.status === "connected");
  const [selectedId, setSelectedId] = useState<string | null>(
    connectedDevices[0]?.id ?? null
  );
  const [activeTemplate, setActiveTemplate] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);
  const [lastApplied, setLastApplied] = useState<string | null>(null);
  const [applyError, setApplyError] = useState<string | null>(null);

  const config = selectedId ? configs.get(selectedId) : null;
  const device = devices.find((d) => d.id === selectedId);

  const highlightedKeys = activeTemplate
    ? (TEMPLATES.find((t) => t.id === activeTemplate)?.highlights ?? [])
    : [];

  function isHighlighted(namespace: "radio" | "module", section: string, key: string) {
    return highlightedKeys.some(
      (h) => h.namespace === namespace && h.section === section && h.key === key
    );
  }

  // On mount (or when selected device changes), request a fresh config snapshot
  useEffect(() => {
    if (!selectedId) return;
    foremanClient.send({ type: "device:config-request", payload: { deviceId: selectedId } });
  }, [selectedId]);

  function applyTemplate(template: Template) {
    if (!selectedId || applying) return;
    setApplying(true);
    setApplyError(null);

    for (const change of template.changes) {
      foremanClient.send({
        type: "device:set-config",
        payload: {
          deviceId: selectedId,
          namespace: change.namespace,
          section: change.section,
          value: change.value,
        },
      });
    }

    // Wait for device:config (success) or error event from the daemon
    const deviceId = selectedId;
    const timeout = setTimeout(() => {
      off();
      setApplying(false);
      setApplyError("Timed out — no response from device.");
    }, 10_000);

    const off = foremanClient.on((event) => {
      if (event.type === "device:config" && event.payload.deviceId === deviceId) {
        clearTimeout(timeout);
        off();
        setApplying(false);
        setLastApplied(template.id);
        setTimeout(() => setLastApplied(null), 3000);
      }
      if (event.type === "error" && event.payload.code === "SET_CONFIG_FAILED") {
        clearTimeout(timeout);
        off();
        setApplying(false);
        setApplyError(event.payload.message);
      }
    });
  }

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

          {/* Templates */}
          <Section title="Templates">
            <div style={styles.templateGrid}>
              {TEMPLATES.map((t) => (
                <div
                  key={t.id}
                  style={templateCardStyle(activeTemplate === t.id)}
                  onClick={() => setActiveTemplate((prev) => prev === t.id ? null : t.id)}
                >
                  <div style={styles.templateLabel}>{t.label}</div>
                  <div style={styles.templateDesc}>{t.description}</div>
                  {activeTemplate === t.id && (
                    <button
                      style={applyBtnStyle(applying)}
                      disabled={applying}
                      onClick={(e) => { e.stopPropagation(); applyTemplate(t); }}
                    >
                      {applying ? "Applying…" : lastApplied === t.id ? "Applied ✓" : "Apply to device"}
                    </button>
                  )}
                </div>
              ))}
            </div>
            {applyError && (
              <div style={styles.applyError}>
                <span style={{ color: "#f87171", fontWeight: "bold" }}>Error: </span>
                {applyError}
                <button
                  style={styles.dismissBtn}
                  onClick={() => setApplyError(null)}
                >✕</button>
              </div>
            )}
          </Section>

          {/* Channels */}
          <Section title="Channels">
            <ChannelTable channels={config.channels} />
          </Section>

          {/* Radio config */}
          {Object.keys(config.radioConfig).length > 0 && (
            <Section title="Radio Config">
              {Object.entries(config.radioConfig).map(([key, value]) => (
                <ConfigCard
                  key={key}
                  title={key}
                  data={value as Record<string, unknown>}
                  highlightKeys={highlightedKeys
                    .filter((h) => h.namespace === "radio" && h.section === key)
                    .map((h) => h.key)}
                />
              ))}
            </Section>
          )}

          {/* Module config */}
          {Object.keys(config.moduleConfig).length > 0 && (
            <Section title="Module Config">
              {Object.entries(config.moduleConfig).map(([key, value]) => (
                <ConfigCard
                  key={key}
                  title={key}
                  data={value as Record<string, unknown>}
                  highlightKeys={highlightedKeys
                    .filter((h) => h.namespace === "module" && h.section === key)
                    .map((h) => h.key)}
                />
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

function ConfigCard({
  title,
  data,
  highlightKeys = [],
}: {
  title: string;
  data: Record<string, unknown>;
  highlightKeys?: string[];
}) {
  const hasHighlight = highlightKeys.length > 0;
  const [open, setOpen] = useState(hasHighlight);
  const entries = Object.entries(data).filter(([k]) => k !== "$typeName");

  return (
    <div style={{ ...styles.card, borderColor: hasHighlight ? "#3b82f6" : "#1e293b" }}>
      <button style={styles.cardHeader} onClick={() => setOpen((v) => !v)}>
        <span style={{ ...styles.cardTitle, color: hasHighlight ? "#60a5fa" : "#94a3b8" }}>
          {title}
        </span>
        <span style={{ color: "#475569", fontSize: "0.65rem" }}>{open ? "▲" : "▼"}</span>
      </button>
      {open && (
        <div style={styles.cardBody}>
          {entries.map(([k, v]) => {
            const highlighted = highlightKeys.includes(k);
            return (
              <div key={k} style={{ ...styles.row, background: highlighted ? "#172036" : undefined }}>
                <span style={{ ...styles.rowKey, color: highlighted ? "#60a5fa" : "#475569" }}>
                  {camelToLabel(k)}
                </span>
                <span style={styles.rowVal}>{formatValue(v)}</span>
              </div>
            );
          })}
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

function templateCardStyle(active: boolean): React.CSSProperties {
  return {
    background: active ? "#0f2a4a" : "#0f172a",
    border: `1px solid ${active ? "#3b82f6" : "#1e293b"}`,
    borderRadius: "0.375rem",
    padding: "0.75rem",
    cursor: "pointer",
    display: "flex",
    flexDirection: "column",
    gap: "0.35rem",
  };
}

function applyBtnStyle(disabled: boolean): React.CSSProperties {
  return {
    marginTop: "0.35rem",
    alignSelf: "flex-start",
    background: disabled ? "#1e293b" : "#1d4ed8",
    border: "none",
    color: disabled ? "#64748b" : "#fff",
    padding: "0.3rem 0.8rem",
    borderRadius: "0.25rem",
    cursor: disabled ? "not-allowed" : "pointer",
    fontFamily: "monospace",
    fontSize: "0.78rem",
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
  templateGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))",
    gap: "0.5rem",
  },
  templateLabel: {
    color: "#e2e8f0",
    fontSize: "0.82rem",
    fontWeight: "bold",
  },
  applyError: {
    display: "flex",
    alignItems: "center",
    gap: "0.5rem",
    background: "#2d0f0f",
    border: "1px solid #7f1d1d",
    borderRadius: "0.375rem",
    padding: "0.45rem 0.75rem",
    fontSize: "0.78rem",
    color: "#fca5a5",
    fontFamily: "monospace",
  },
  dismissBtn: {
    marginLeft: "auto",
    background: "none",
    border: "none",
    color: "#64748b",
    cursor: "pointer",
    fontSize: "0.75rem",
    padding: "0 0.2rem",
    lineHeight: 1,
    flexShrink: 0,
  },
  templateDesc: {
    color: "#64748b",
    fontSize: "0.74rem",
    lineHeight: "1.4",
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
    padding: "0.1rem 0.2rem",
    borderRadius: "0.2rem",
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
