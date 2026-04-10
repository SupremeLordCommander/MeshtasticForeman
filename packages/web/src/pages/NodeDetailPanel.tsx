import { useState, useEffect, useRef } from "react";
import type { NodeInfo, MqttNode, DeviceInfo, Message } from "@foreman/shared";
import { foremanClient } from "../ws/client.js";

interface Props {
  nodeId: number;
  mesh: NodeInfo | null;
  mqtt: MqttNode | null;
  devices: DeviceInfo[];
  onClose: () => void;
}

const CHANNEL_ROLES_SHORT = ["Pri", "Sec", "Sec", "Sec", "Sec", "Sec", "Sec", "Sec"];

const HW_MODEL: Record<number, string> = {
  0: "UNSET", 1: "TLORA_V2", 2: "TLORA_V1", 4: "TBEAM", 8: "T_ECHO",
  10: "RAK4631", 13: "LILYGO_TBEAM_S3_CORE", 15: "NANO_G1",
  43: "HELTEC_V3", 44: "HELTEC_WSL_V3",
  48: "HELTEC_WIRELESS_TRACKER", 49: "HELTEC_WIRELESS_PAPER",
  50: "T_DECK", 51: "T_WATCH_S3", 64: "TRACKER_T1000_E", 66: "WIO_E5",
  69: "RAK11310", 70: "RAKWIRELESS_RAK4631", 71: "STATION_G2",
  89: "TLORA_C6", 93: "PICOMPUTER_S3", 94: "HELTEC_HT62",
  95: "HELTEC_WIRELESS_PAPER_V3", 99: "SEEED_WIO_TRACKER_L1",
  100: "TLORA_T3S3", 101: "NANO_G2_ULTRA", 105: "HELTEC_V3_PLUS",
  110: "TBEAM_S3_CORE_V2", 255: "PRIVATE_HW",
};

function nodeHex(nodeId: number) {
  return `!${nodeId.toString(16).padStart(8, "0")}`;
}

function formatLastHeard(iso: string | null) {
  if (!iso) return "—";
  const diff = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

function formatTime(iso: string) {
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export function NodeDetailPanel({ nodeId, mesh, mqtt, devices, onClose }: Props) {
  const deviceId = devices.find((d) => d.status === "connected")?.id ?? null;
  const primary = mesh ?? mqtt!;

  const [messages, setMessages] = useState<Message[]>([]);
  const [msgText, setMsgText] = useState("");
  const [channel, setChannel] = useState(0);
  const [sending, setSending] = useState(false);
  const [sentId, setSentId] = useState<number | null>(null);
  const [pendingAction, setPendingAction] = useState<"position" | "traceroute" | null>(null);
  const [traceroute, setTraceroute] = useState<{ route: number[]; routeBack: number[] } | null>(null);
  const msgEndRef = useRef<HTMLDivElement>(null);

  // Request message history and listen for new messages / traceroute results
  useEffect(() => {
    if (deviceId) {
      foremanClient.send({
        type: "messages:request-history",
        payload: { deviceId, toNodeId: nodeId, limit: 100 },
      });
    }

    const off = foremanClient.on((event) => {
      if (event.type === "message:received") {
        const m = event.payload;
        if (m.fromNodeId === nodeId || m.toNodeId === nodeId) {
          setMessages((prev) => [...prev, m]);
        }
      }
      if (event.type === "message:history") {
        setMessages(event.payload.filter(
          (m) => m.fromNodeId === nodeId || m.toNodeId === nodeId
        ));
      }
      if (event.type === "traceroute:result" && event.payload.nodeId === nodeId) {
        setTraceroute({ route: event.payload.route, routeBack: event.payload.routeBack });
        setPendingAction(null);
      }
    });
    return () => { off(); };
  }, [deviceId, nodeId]);

  // Auto-scroll messages
  useEffect(() => {
    msgEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  function sendMessage() {
    if (!deviceId || !msgText.trim() || sending) return;
    setSending(true);
    foremanClient.send({
      type: "message:send",
      payload: { deviceId, toNodeId: nodeId, text: msgText.trim(), channelIndex: channel, wantAck: true },
    });
    // Optimistic local message
    const optimistic: Message = {
      id: `local-${Date.now()}`,
      packetId: 0,
      fromNodeId: 0,
      toNodeId: nodeId,
      channelIndex: channel,
      text: msgText.trim(),
      rxTime: new Date().toISOString(),
      rxSnr: null,
      rxRssi: null,
      hopLimit: null,
      wantAck: true,
      viaMqtt: false,
    };
    setMessages((prev) => [...prev, optimistic]);
    setMsgText("");
    setSentId(optimistic.packetId);
    setTimeout(() => { setSending(false); setSentId(null); }, 5000);
  }

  function requestPosition() {
    if (!deviceId) return;
    setPendingAction("position");
    foremanClient.send({ type: "node:request-position", payload: { deviceId, nodeId } });
    setTimeout(() => setPendingAction(null), 15000);
  }

  function requestTraceroute() {
    if (!deviceId) return;
    setPendingAction("traceroute");
    setTraceroute(null);
    foremanClient.send({ type: "node:traceroute", payload: { deviceId, nodeId } });
    setTimeout(() => setPendingAction(null), 30000);
  }

  const isMqttOnly = !mesh;

  return (
    <div style={styles.overlay} onClick={onClose}>
      <div style={styles.panel} onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div style={styles.header}>
          <div>
            <div style={styles.headerName}>{primary.longName ?? primary.shortName ?? "Unknown"}</div>
            <div style={styles.headerSub}>
              <span style={styles.mono}>{nodeHex(nodeId)}</span>
              {primary.shortName && primary.longName && (
                <span style={{ color: "#64748b", marginLeft: "0.5rem" }}>({primary.shortName})</span>
              )}
            </div>
          </div>
          <button style={styles.closeBtn} onClick={onClose}>✕</button>
        </div>

        <div style={styles.body}>
          {/* Details grid */}
          <div style={styles.detailGrid}>
            <Detail label="Node ID" value={nodeHex(nodeId)} mono />
            <Detail label="Hardware" value={primary.hwModel != null ? (HW_MODEL[primary.hwModel] ?? `#${primary.hwModel}`) : "—"} />
            <Detail label="Last Heard" value={formatLastHeard(primary.lastHeard)} />
            <Detail label="SNR" value={primary.snr != null ? `${primary.snr.toFixed(1)} dB` : "—"} />
            {mesh && <Detail label="Hops Away" value={mesh.hopsAway != null ? (mesh.hopsAway === 0 ? "Direct" : `${mesh.hopsAway} hop${mesh.hopsAway > 1 ? "s" : ""}`) : "—"} />}
            {primary.latitude != null && <Detail label="Latitude" value={primary.latitude.toFixed(6)} mono />}
            {primary.longitude != null && <Detail label="Longitude" value={primary.longitude.toFixed(6)} mono />}
            {primary.altitude != null && <Detail label="Altitude" value={`${primary.altitude} m`} />}
            {mesh?.macAddress && <Detail label="MAC" value={mesh.macAddress} mono />}
            {mesh?.publicKey && <Detail label="Public Key" value={mesh.publicKey.slice(0, 16) + "…"} mono />}
            {mqtt?.lastGateway && <Detail label="MQTT Gateway" value={mqtt.lastGateway} />}
            {mqtt?.distanceM != null && <Detail label="MQTT Distance" value={mqtt.distanceM < 1000 ? `${Math.round(mqtt.distanceM)} m` : `${(mqtt.distanceM / 1000).toFixed(1)} km`} />}
            {mqtt?.regionPath && <Detail label="Region" value={mqtt.regionPath} />}
          </div>

          {/* Actions */}
          {deviceId && !isMqttOnly && (
            <div style={styles.actions}>
              <button
                style={actionBtnStyle(pendingAction === "position")}
                disabled={!!pendingAction}
                onClick={requestPosition}
              >
                {pendingAction === "position" ? "Requesting…" : "📍 Request Position"}
              </button>
              <button
                style={actionBtnStyle(pendingAction === "traceroute")}
                disabled={!!pendingAction}
                onClick={requestTraceroute}
              >
                {pendingAction === "traceroute" ? "Tracing…" : "🔍 Traceroute"}
              </button>
            </div>
          )}

          {/* Traceroute result */}
          {traceroute && (
            <div style={styles.traceResult}>
              <span style={{ color: "#60a5fa", fontWeight: "bold" }}>Route: </span>
              {traceroute.route.length === 0
                ? "Direct"
                : traceroute.route.map((id) => nodeHex(id)).join(" → ")}
              {traceroute.routeBack.length > 0 && (
                <span style={{ color: "#64748b", marginLeft: "0.75rem" }}>
                  ← {traceroute.routeBack.map((id) => nodeHex(id)).join(" ← ")}
                </span>
              )}
            </div>
          )}

          {/* Messages */}
          {deviceId && !isMqttOnly && (
            <>
              <div style={styles.sectionLabel}>Messages</div>
              <div style={styles.messageList}>
                {messages.length === 0 ? (
                  <div style={styles.noMessages}>No messages with this node.</div>
                ) : (
                  messages.map((m) => {
                    const outgoing = m.fromNodeId !== nodeId;
                    return (
                      <div key={m.id} style={messageBubbleStyle(outgoing)}>
                        <div style={styles.msgText}>{m.text}</div>
                        <div style={styles.msgMeta}>
                          {formatTime(m.rxTime)}
                          {m.rxSnr != null && ` · SNR ${m.rxSnr.toFixed(1)}`}
                          {m.viaMqtt && " · MQTT"}
                        </div>
                      </div>
                    );
                  })
                )}
                <div ref={msgEndRef} />
              </div>

              {/* Compose */}
              <div style={styles.compose}>
                <select
                  style={styles.channelSelect}
                  value={channel}
                  onChange={(e) => setChannel(Number(e.target.value))}
                  title="Channel"
                >
                  {[0, 1, 2, 3, 4, 5, 6, 7].map((i) => (
                    <option key={i} value={i}>Ch {i}</option>
                  ))}
                </select>
                <input
                  style={styles.msgInput}
                  placeholder="Send a message…"
                  value={msgText}
                  onChange={(e) => setMsgText(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMessage(); } }}
                  maxLength={228}
                />
                <button
                  style={sendBtnStyle(sending || !msgText.trim())}
                  disabled={sending || !msgText.trim()}
                  onClick={sendMessage}
                >
                  {sending ? "…" : "Send"}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function Detail({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <>
      <span style={styles.detailLabel}>{label}</span>
      <span style={{ ...styles.detailValue, ...(mono ? { fontFamily: "monospace", color: "#94a3b8" } : {}) }}>
        {value}
      </span>
    </>
  );
}

function actionBtnStyle(active: boolean): React.CSSProperties {
  return {
    background: active ? "#1e3a5f" : "#1e293b",
    border: `1px solid ${active ? "#3b82f6" : "#334155"}`,
    color: active ? "#60a5fa" : "#94a3b8",
    padding: "0.35rem 0.8rem",
    borderRadius: "0.375rem",
    cursor: active ? "not-allowed" : "pointer",
    fontFamily: "monospace",
    fontSize: "0.8rem",
  };
}

function messageBubbleStyle(outgoing: boolean): React.CSSProperties {
  return {
    alignSelf: outgoing ? "flex-end" : "flex-start",
    maxWidth: "80%",
    background: outgoing ? "#1e3a5f" : "#1e293b",
    border: `1px solid ${outgoing ? "#2563eb" : "#334155"}`,
    borderRadius: "0.5rem",
    padding: "0.4rem 0.65rem",
  };
}

function sendBtnStyle(disabled: boolean): React.CSSProperties {
  return {
    background: disabled ? "#1e293b" : "#1d4ed8",
    border: "none",
    color: disabled ? "#475569" : "#fff",
    padding: "0.4rem 0.9rem",
    borderRadius: "0.375rem",
    cursor: disabled ? "not-allowed" : "pointer",
    fontFamily: "monospace",
    fontSize: "0.8rem",
    flexShrink: 0,
  };
}

const styles: Record<string, React.CSSProperties> = {
  overlay: {
    position: "fixed",
    inset: 0,
    background: "rgba(0,0,0,0.5)",
    zIndex: 200,
    display: "flex",
    justifyContent: "flex-end",
  },
  panel: {
    width: "min(480px, 100vw)",
    height: "100%",
    background: "#0f172a",
    borderLeft: "1px solid #1e293b",
    display: "flex",
    flexDirection: "column",
    overflow: "hidden",
  },
  header: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "flex-start",
    padding: "1rem 1.25rem",
    borderBottom: "1px solid #1e293b",
    flexShrink: 0,
  },
  headerName: {
    fontSize: "1rem",
    fontWeight: "bold",
    color: "#f1f5f9",
  },
  headerSub: {
    marginTop: "0.2rem",
    fontSize: "0.8rem",
    display: "flex",
    alignItems: "center",
  },
  closeBtn: {
    background: "none",
    border: "none",
    color: "#64748b",
    cursor: "pointer",
    fontSize: "1rem",
    padding: "0.2rem",
    lineHeight: 1,
  },
  body: {
    flex: 1,
    overflowY: "auto",
    padding: "1rem 1.25rem",
    display: "flex",
    flexDirection: "column",
    gap: "1rem",
  },
  detailGrid: {
    display: "grid",
    gridTemplateColumns: "9rem 1fr",
    rowGap: "0.4rem",
    columnGap: "0.75rem",
  },
  detailLabel: {
    color: "#475569",
    fontSize: "0.78rem",
    alignSelf: "center",
  },
  detailValue: {
    color: "#e2e8f0",
    fontSize: "0.82rem",
    wordBreak: "break-all",
  },
  actions: {
    display: "flex",
    gap: "0.5rem",
    flexWrap: "wrap",
  },
  traceResult: {
    background: "#0f2a4a",
    border: "1px solid #1e3a5f",
    borderRadius: "0.375rem",
    padding: "0.5rem 0.75rem",
    fontSize: "0.78rem",
    fontFamily: "monospace",
    color: "#94a3b8",
    wordBreak: "break-all",
  },
  sectionLabel: {
    fontSize: "0.65rem",
    color: "#334155",
    textTransform: "uppercase",
    letterSpacing: "0.08em",
  },
  messageList: {
    display: "flex",
    flexDirection: "column",
    gap: "0.5rem",
    minHeight: "6rem",
    maxHeight: "16rem",
    overflowY: "auto",
    background: "#020617",
    border: "1px solid #1e293b",
    borderRadius: "0.375rem",
    padding: "0.75rem",
  },
  noMessages: {
    color: "#334155",
    fontSize: "0.8rem",
    textAlign: "center",
    margin: "auto",
  },
  msgText: {
    color: "#e2e8f0",
    fontSize: "0.82rem",
    lineHeight: "1.4",
  },
  msgMeta: {
    color: "#475569",
    fontSize: "0.68rem",
    marginTop: "0.2rem",
  },
  compose: {
    display: "flex",
    gap: "0.4rem",
    alignItems: "center",
  },
  channelSelect: {
    background: "#1e293b",
    border: "1px solid #334155",
    color: "#94a3b8",
    borderRadius: "0.375rem",
    padding: "0.4rem 0.3rem",
    fontFamily: "monospace",
    fontSize: "0.75rem",
    flexShrink: 0,
  },
  msgInput: {
    flex: 1,
    background: "#1e293b",
    border: "1px solid #334155",
    color: "#e2e8f0",
    borderRadius: "0.375rem",
    padding: "0.4rem 0.6rem",
    fontFamily: "monospace",
    fontSize: "0.8rem",
    outline: "none",
  },
  mono: {
    fontFamily: "monospace",
    fontSize: "0.8rem",
    color: "#94a3b8",
  },
};
