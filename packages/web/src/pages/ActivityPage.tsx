import { useState, useEffect, useRef } from "react";
import type { ActivityEntry } from "@foreman/shared";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
}

function sourceColor(source: "mesh" | "mqtt"): string {
  return source === "mesh" ? "#60a5fa" : "#34d399";
}

type Window = "5m" | "15m" | "1h" | "all";

function windowMs(w: Window): number {
  if (w === "5m")  return  5 * 60 * 1000;
  if (w === "15m") return 15 * 60 * 1000;
  if (w === "1h")  return 60 * 60 * 1000;
  return Infinity;
}

function filterWindow(entries: ActivityEntry[], w: Window): ActivityEntry[] {
  if (w === "all") return entries;
  const cutoff = Date.now() - windowMs(w);
  return entries.filter((e) => new Date(e.ts).getTime() >= cutoff);
}

// ---------------------------------------------------------------------------
// Stats helpers
// ---------------------------------------------------------------------------

function countBy<T extends string | null>(
  entries: ActivityEntry[],
  key: (e: ActivityEntry) => T,
): [T, number][] {
  const map = new Map<T, number>();
  for (const e of entries) {
    const k = key(e);
    map.set(k, (map.get(k) ?? 0) + 1);
  }
  return [...map.entries()].sort((a, b) => b[1] - a[1]);
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function StatTable({ title, rows, color }: {
  title: string;
  rows: [string | null, number][];
  color: string;
}) {
  if (rows.length === 0) return null;
  const max = rows[0][1];
  return (
    <div style={styles.statCard}>
      <div style={{ ...styles.statTitle, color }}>{title}</div>
      {rows.slice(0, 15).map(([label, count]) => (
        <div key={label ?? "__null__"} style={styles.statRow}>
          <div style={styles.statBar}>
            <div style={{ ...styles.statBarFill, width: `${(count / max) * 100}%`, background: color + "40" }} />
          </div>
          <span style={styles.statLabel}>{label ?? "—"}</span>
          <span style={styles.statCount}>{count}</span>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface Props {
  entries: ActivityEntry[];
}

export function ActivityPage({ entries }: Props) {
  const [window, setWindow] = useState<Window>("15m");
  const [paused, setPaused] = useState(false);
  const [frozen, setFrozen] = useState<ActivityEntry[]>([]);
  const feedRef = useRef<HTMLDivElement>(null);
  const autoScroll = useRef(true);

  // Freeze the display while paused
  useEffect(() => {
    if (!paused) setFrozen([]);
  }, [paused]);

  const displayEntries = paused ? frozen : filterWindow(entries, window);

  // Auto-scroll feed to bottom when new entries arrive
  useEffect(() => {
    if (!paused && autoScroll.current && feedRef.current) {
      feedRef.current.scrollTop = feedRef.current.scrollHeight;
    }
  }, [displayEntries.length, paused]);

  const windowed = filterWindow(entries, window);
  const meshCount = windowed.filter((e) => e.source === "mesh").length;
  const mqttCount = windowed.filter((e) => e.source === "mqtt").length;
  const total     = windowed.length;

  const byPortnum = countBy(windowed, (e) => e.portnum);
  const byRegion  = countBy(
    windowed.filter((e) => e.source === "mqtt"),
    (e) => e.region,
  );

  return (
    <div style={styles.page}>
      {/* Controls */}
      <div style={styles.controls}>
        <span style={styles.label}>Window:</span>
        {(["5m", "15m", "1h", "all"] as Window[]).map((w) => (
          <button key={w} style={{ ...styles.btn, ...(window === w ? styles.btnActive : {}) }}
            onClick={() => setWindow(w)}>{w}</button>
        ))}
        <span style={{ marginLeft: "1rem", color: "#475569", fontSize: "0.75rem" }}>
          {total} packets
          {total > 0 && (
            <> — <span style={{ color: "#60a5fa" }}>{meshCount} mesh</span>
              {" / "}
              <span style={{ color: "#34d399" }}>{mqttCount} mqtt</span>
            </>
          )}
        </span>
        <button
          style={{ ...styles.btn, marginLeft: "auto", ...(paused ? styles.btnActive : {}) }}
          onClick={() => {
            if (!paused) setFrozen(filterWindow(entries, window));
            setPaused((p) => !p);
          }}
        >
          {paused ? "▶ Resume" : "⏸ Pause"}
        </button>
      </div>

      <div style={styles.body}>
        {/* Live feed */}
        <div style={styles.feedWrap}>
          <div style={styles.feedHeader}>Live Feed {paused && <span style={{ color: "#f59e0b" }}>(paused)</span>}</div>
          <div
            ref={feedRef}
            style={styles.feed}
            onMouseEnter={() => { autoScroll.current = false; }}
            onMouseLeave={() => { autoScroll.current = true; }}
          >
            {[...displayEntries].reverse().map((e) => (
              <div key={e.id} style={styles.feedRow}>
                <span style={styles.feedTime}>{formatTime(e.ts)}</span>
                <span style={{ ...styles.feedSource, color: sourceColor(e.source) }}>{e.source}</span>
                <span style={styles.feedPortnum}>{e.portnum}</span>
                <span style={styles.feedFrom}>{e.fromHex}</span>
                {e.region && <span style={styles.feedRegion}>{e.region}</span>}
                {e.viaMqtt && <span style={styles.viaMqtt}>via-mqtt</span>}
              </div>
            ))}
            {displayEntries.length === 0 && (
              <div style={{ color: "#475569", padding: "1rem", textAlign: "center" }}>No activity in this window</div>
            )}
          </div>
        </div>

        {/* Stats */}
        <div style={styles.statsWrap}>
          <StatTable title="By Packet Type" rows={byPortnum} color="#a78bfa" />
          <StatTable title="By MQTT Region" rows={byRegion as [string | null, number][]} color="#34d399" />
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const styles: Record<string, React.CSSProperties> = {
  page:     { padding: "1rem 1.5rem", display: "flex", flexDirection: "column", height: "100%", boxSizing: "border-box" },
  controls: { display: "flex", alignItems: "center", gap: "0.35rem", marginBottom: "0.75rem", flexWrap: "wrap" },
  label:    { color: "#64748b", fontSize: "0.75rem", marginRight: "0.15rem" },
  btn: {
    background: "#1e293b", border: "1px solid #334155", color: "#94a3b8",
    padding: "0.2rem 0.6rem", borderRadius: "0.25rem", cursor: "pointer",
    fontSize: "0.75rem", fontFamily: "monospace",
  },
  btnActive: { background: "#3b82f6", borderColor: "#3b82f6", color: "#fff" },
  body:      { display: "flex", gap: "1rem", flex: 1, minHeight: 0 },
  feedWrap:  { flex: 1, display: "flex", flexDirection: "column", minHeight: 0 },
  feedHeader: {
    fontSize: "0.7rem", fontWeight: "bold", letterSpacing: "0.08em",
    textTransform: "uppercase", color: "#64748b",
    paddingBottom: "0.4rem", borderBottom: "1px solid #1e293b", marginBottom: "0.4rem",
  },
  feed: {
    flex: 1, overflowY: "auto", fontFamily: "monospace", fontSize: "0.75rem",
    display: "flex", flexDirection: "column-reverse",
  },
  feedRow:    { display: "flex", gap: "0.6rem", padding: "0.15rem 0", alignItems: "center", borderBottom: "1px solid #0f172a" },
  feedTime:   { color: "#475569", flexShrink: 0, width: "5.5rem" },
  feedSource: { flexShrink: 0, width: "2.5rem", fontWeight: "bold" },
  feedPortnum:{ color: "#a78bfa", flexShrink: 0, minWidth: "10rem" },
  feedFrom:   { color: "#94a3b8", flexShrink: 0, width: "6rem" },
  feedRegion: { color: "#64748b", fontSize: "0.7rem", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  viaMqtt:    { color: "#64748b", fontSize: "0.65rem", border: "1px solid #334155", borderRadius: "0.2rem", padding: "0 0.25rem" },
  statsWrap:  { width: "280px", flexShrink: 0, display: "flex", flexDirection: "column", gap: "1rem", overflowY: "auto" },
  statCard:   { background: "#0f172a", borderRadius: "0.5rem", padding: "0.75rem" },
  statTitle:  { fontSize: "0.7rem", fontWeight: "bold", letterSpacing: "0.08em", textTransform: "uppercase", marginBottom: "0.5rem" },
  statRow:    { display: "flex", alignItems: "center", gap: "0.4rem", marginBottom: "0.25rem", position: "relative" },
  statBar:    { position: "absolute", inset: 0, borderRadius: "0.15rem", overflow: "hidden", zIndex: 0 },
  statBarFill:{ height: "100%", transition: "width 0.3s ease" },
  statLabel:  { fontSize: "0.7rem", color: "#94a3b8", flex: 1, zIndex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  statCount:  { fontSize: "0.7rem", color: "#64748b", zIndex: 1, flexShrink: 0 },
};
