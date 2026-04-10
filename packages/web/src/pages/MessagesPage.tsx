import { useState, useRef, useEffect } from "react";
import type { DeviceInfo, NodeInfo, MqttNode, Message } from "@foreman/shared";
import { foremanClient } from "../ws/client.js";
import {
  useConversationList,
  useConversation,
  loadConversation,
  addOptimisticMessage,
} from "../store/messages.js";

interface Props {
  devices: DeviceInfo[];
  nodes: NodeInfo[];
  mqttNodes: MqttNode[];
}

function nodeHex(nodeId: number) {
  return `!${nodeId.toString(16).padStart(8, "0")}`;
}

function nodeName(
  nodeId: number,
  nodes: NodeInfo[],
  mqttNodes: MqttNode[]
): string {
  const mesh = nodes.find((n) => n.nodeId === nodeId);
  if (mesh?.shortName) return mesh.shortName;
  if (mesh?.longName) return mesh.longName;
  const mqtt = mqttNodes.find((n) => n.nodeId === nodeId);
  if (mqtt?.shortName) return mqtt.shortName;
  if (mqtt?.longName) return mqtt.longName;
  return nodeHex(nodeId);
}

function formatTime(iso: string) {
  const d = new Date(iso);
  const now = new Date();
  const diffDays = Math.floor((now.getTime() - d.getTime()) / 86400000);
  if (diffDays === 0) return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  if (diffDays < 7) return d.toLocaleDateString([], { weekday: "short" }) + " " + d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
}

function truncate(text: string | null, max: number): string {
  if (!text) return "(encrypted)";
  if (text.length <= max) return text;
  return text.slice(0, max) + "…";
}

// ─── Thread view ─────────────────────────────────────────────────────────────

interface ThreadProps {
  nodeId: number;
  nodes: NodeInfo[];
  mqttNodes: MqttNode[];
  deviceId: string;
}

function ThreadView({ nodeId, nodes, mqttNodes, deviceId }: ThreadProps) {
  const messages = useConversation(nodeId);
  const [msgText, setMsgText] = useState("");
  const [channel, setChannel] = useState(0);
  const [sending, setSending] = useState(false);
  const msgEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    loadConversation(deviceId, nodeId);
  }, [deviceId, nodeId]);

  useEffect(() => {
    msgEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  function sendMessage() {
    if (!msgText.trim() || sending) return;
    setSending(true);
    foremanClient.send({
      type: "message:send",
      payload: { deviceId, toNodeId: nodeId, text: msgText.trim(), channelIndex: channel, wantAck: true },
    });
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
      role: "sent",
      ackStatus: "pending",
      ackAt: null,
      ackError: null,
    };
    addOptimisticMessage(optimistic);
    setMsgText("");
    setTimeout(() => setSending(false), 5000);
  }

  const name = nodeName(nodeId, nodes, mqttNodes);

  return (
    <div style={styles.thread}>
      <div style={styles.threadHeader}>
        <span style={styles.threadName}>{name}</span>
        <span style={styles.threadHex}>{nodeHex(nodeId)}</span>
      </div>

      <div style={styles.messageList}>
        {messages.length === 0 ? (
          <div style={styles.empty}>No messages yet.</div>
        ) : (
          messages.map((m) => {
            const outgoing = m.role === "sent";
            return (
              <div key={m.id} style={bubbleWrapStyle(outgoing)}>
                <div style={bubbleStyle(outgoing, m.role === "relayed")}>
                  {m.role === "relayed" && (
                    <div style={styles.relayedLabel}>relayed</div>
                  )}
                  <div style={{ ...styles.msgText, opacity: m.role === "relayed" ? 0.5 : 1 }}>
                    {m.text ?? <em style={{ color: "#475569" }}>encrypted</em>}
                  </div>
                  <div style={styles.msgMeta}>
                    {formatTime(m.rxTime)}
                    {m.rxSnr != null && ` · SNR ${m.rxSnr.toFixed(1)}`}
                    {m.viaMqtt && " · MQTT"}
                    {outgoing && m.ackStatus === "pending" && (
                      <span style={styles.ackPending} title="Waiting for ACK">⏳</span>
                    )}
                    {outgoing && m.ackStatus === "acked" && (
                      <span style={styles.ackOk} title="Delivered">✓</span>
                    )}
                    {outgoing && m.ackStatus === "error" && (
                      <span style={styles.ackErr} title={m.ackError ?? "Delivery failed"}>✗</span>
                    )}
                  </div>
                </div>
              </div>
            );
          })
        )}
        <div ref={msgEndRef} />
      </div>

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
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMessage(); }
          }}
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
    </div>
  );
}

// ─── Main page ───────────────────────────────────────────────────────────────

export function MessagesPage({ devices, nodes, mqttNodes }: Props) {
  const conversations = useConversationList();
  const [selectedNodeId, setSelectedNodeId] = useState<number | null>(null);
  const deviceId = devices.find((d) => d.status === "connected")?.id ?? null;

  // Auto-select first conversation when list populates
  useEffect(() => {
    if (selectedNodeId == null && conversations.length > 0) {
      setSelectedNodeId(conversations[0].nodeId);
    }
  }, [conversations, selectedNodeId]);

  return (
    <div style={styles.page}>
      {/* Left: conversation list */}
      <div style={styles.sidebar}>
        <div style={styles.sidebarHeader}>Conversations</div>
        {conversations.length === 0 ? (
          <div style={styles.empty}>No conversations yet.</div>
        ) : (
          conversations.map(({ nodeId, lastMessage }) => {
            const name = nodeName(nodeId, nodes, mqttNodes);
            const active = nodeId === selectedNodeId;
            return (
              <button
                key={nodeId}
                style={convoRowStyle(active)}
                onClick={() => setSelectedNodeId(nodeId)}
              >
                <div style={styles.convoName}>{name}</div>
                <div style={styles.convoPreview}>{truncate(lastMessage.text, 40)}</div>
                <div style={styles.convoTime}>{formatTime(lastMessage.rxTime)}</div>
              </button>
            );
          })
        )}
      </div>

      {/* Right: thread */}
      <div style={styles.threadPane}>
        {selectedNodeId != null && deviceId != null ? (
          <ThreadView
            key={selectedNodeId}
            nodeId={selectedNodeId}
            nodes={nodes}
            mqttNodes={mqttNodes}
            deviceId={deviceId}
          />
        ) : (
          <div style={styles.placeholder}>
            {deviceId == null
              ? "No device connected."
              : "Select a conversation."}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Styles ──────────────────────────────────────────────────────────────────

function bubbleWrapStyle(outgoing: boolean): React.CSSProperties {
  return {
    display: "flex",
    justifyContent: outgoing ? "flex-end" : "flex-start",
  };
}

function bubbleStyle(outgoing: boolean, relayed: boolean): React.CSSProperties {
  return {
    maxWidth: "72%",
    background: relayed ? "#0f172a" : outgoing ? "#1e3a5f" : "#1e293b",
    border: `1px solid ${relayed ? "#1e293b" : outgoing ? "#2563eb" : "#334155"}`,
    borderRadius: "0.5rem",
    padding: "0.45rem 0.7rem",
    opacity: relayed ? 0.7 : 1,
  };
}

function convoRowStyle(active: boolean): React.CSSProperties {
  return {
    display: "block",
    width: "100%",
    background: active ? "#1e3a5f" : "transparent",
    border: `1px solid ${active ? "#3b82f6" : "transparent"}`,
    borderRadius: "0.375rem",
    color: "inherit",
    cursor: "pointer",
    textAlign: "left",
    padding: "0.55rem 0.75rem",
    marginBottom: "0.2rem",
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
  page: {
    display: "flex",
    height: "100%",
    overflow: "hidden",
  },
  sidebar: {
    width: "260px",
    flexShrink: 0,
    borderRight: "1px solid #1e293b",
    overflowY: "auto",
    padding: "0.75rem 0.5rem",
    display: "flex",
    flexDirection: "column",
  },
  sidebarHeader: {
    color: "#334155",
    fontSize: "0.65rem",
    textTransform: "uppercase",
    letterSpacing: "0.08em",
    padding: "0 0.25rem",
    marginBottom: "0.5rem",
  },
  threadPane: {
    flex: 1,
    display: "flex",
    flexDirection: "column",
    overflow: "hidden",
  },
  thread: {
    display: "flex",
    flexDirection: "column",
    height: "100%",
  },
  threadHeader: {
    padding: "0.75rem 1.25rem",
    borderBottom: "1px solid #1e293b",
    flexShrink: 0,
    display: "flex",
    alignItems: "baseline",
    gap: "0.75rem",
  },
  threadName: {
    color: "#f1f5f9",
    fontWeight: "bold",
    fontSize: "0.95rem",
  },
  threadHex: {
    color: "#475569",
    fontSize: "0.78rem",
    fontFamily: "monospace",
  },
  messageList: {
    flex: 1,
    overflowY: "auto",
    padding: "1rem 1.25rem",
    display: "flex",
    flexDirection: "column",
    gap: "0.6rem",
  },
  msgText: {
    color: "#e2e8f0",
    fontSize: "0.83rem",
    lineHeight: "1.45",
  },
  msgMeta: {
    color: "#475569",
    fontSize: "0.68rem",
    marginTop: "0.2rem",
    display: "flex",
    alignItems: "center",
    gap: "0.3rem",
  },
  relayedLabel: {
    color: "#475569",
    fontSize: "0.62rem",
    textTransform: "uppercase",
    letterSpacing: "0.06em",
    marginBottom: "0.15rem",
  },
  ackPending: {
    fontSize: "0.7rem",
    opacity: 0.6,
  },
  ackOk: {
    color: "#22c55e",
    fontSize: "0.75rem",
  },
  ackErr: {
    color: "#ef4444",
    fontSize: "0.75rem",
    cursor: "help",
  },
  compose: {
    display: "flex",
    gap: "0.4rem",
    alignItems: "center",
    padding: "0.75rem 1.25rem",
    borderTop: "1px solid #1e293b",
    flexShrink: 0,
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
  convoName: {
    color: "#e2e8f0",
    fontWeight: "bold",
    fontSize: "0.82rem",
    marginBottom: "0.15rem",
  },
  convoPreview: {
    color: "#64748b",
    fontSize: "0.74rem",
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
    marginBottom: "0.15rem",
  },
  convoTime: {
    color: "#334155",
    fontSize: "0.68rem",
  },
  empty: {
    color: "#334155",
    fontSize: "0.8rem",
    textAlign: "center",
    padding: "2rem 0",
  },
  placeholder: {
    flex: 1,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    color: "#334155",
    fontSize: "0.85rem",
  },
};
