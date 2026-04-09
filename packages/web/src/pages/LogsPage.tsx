import { useState, useEffect, useRef } from "react";
import type { LogEntry } from "@foreman/shared";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
}

const KNOWN_TAGS = ["devices", "mqtt", "ws", "db", "foreman"] as const;
type TagFilter = "all" | typeof KNOWN_TAGS[number];

const LEVEL_COLORS: Record<string, string> = {
  log:   "#94a3b8",
  warn:  "#fbbf24",
  error: "#f87171",
};

const TAG_COLORS: Record<string, string> = {
  devices: "#60a5fa",
  mqtt:    "#34d399",
  ws:      "#a78bfa",
  db:      "#fb923c",
  foreman: "#94a3b8",
};

function tagColor(tag: string): string {
  return TAG_COLORS[tag] ?? "#64748b";
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface Props {
  entries: LogEntry[];
}

export function LogsPage({ entries }: Props) {
  const [levelFilter, setLevelFilter] = useState<"all" | "log" | "warn" | "error">("all");
  const [tagFilter, setTagFilter]     = useState<TagFilter>("all");
  const [paused, setPaused]           = useState(false);
  const [frozen, setFrozen]           = useState<LogEntry[]>([]);
  const feedRef  = useRef<HTMLDivElement>(null);
  const autoScroll = useRef(true);

  useEffect(() => {
    if (!paused) setFrozen([]);
  }, [paused]);

  const applyFilters = (list: LogEntry[]) => list.filter((e) => {
    if (levelFilter !== "all" && e.level !== levelFilter) return false;
    if (tagFilter !== "all" && e.tag !== tagFilter) return false;
    return true;
  });

  const displayEntries = applyFilters(paused ? frozen : entries);

  useEffect(() => {
    if (!paused && autoScroll.current && feedRef.current) {
      feedRef.current.scrollTop = feedRef.current.scrollHeight;
    }
  }, [displayEntries.length, paused]);

  // Count by tag for the badge on each filter button
  const tagCounts: Record<string, number> = {};
  for (const e of entries) tagCounts[e.tag] = (tagCounts[e.tag] ?? 0) + 1;

  return (
    <div style={styles.page}>
      {/* Controls */}
      <div style={styles.controls}>
        <span style={styles.label}>Level:</span>
        {(["all", "log", "warn", "error"] as const).map((l) => (
          <button
            key={l}
            style={{
              ...styles.btn,
              ...(levelFilter === l ? styles.btnActive : {}),
              ...(l === "warn"  ? { color: levelFilter === l ? "#fff" : "#fbbf24" } : {}),
              ...(l === "error" ? { color: levelFilter === l ? "#fff" : "#f87171" } : {}),
            }}
            onClick={() => setLevelFilter(l)}
          >{l}</button>
        ))}

        <span style={{ ...styles.label, marginLeft: "0.75rem" }}>Tag:</span>
        <button
          style={{ ...styles.btn, ...(tagFilter === "all" ? styles.btnActive : {}) }}
          onClick={() => setTagFilter("all")}
        >all</button>
        {KNOWN_TAGS.map((t) => (
          <button
            key={t}
            style={{
              ...styles.btn,
              ...(tagFilter === t ? styles.btnActive : {}),
              color: tagFilter === t ? "#fff" : tagColor(t),
            }}
            onClick={() => setTagFilter(t)}
          >
            {t}
            {tagCounts[t] ? <span style={styles.tagCount}>{tagCounts[t]}</span> : null}
          </button>
        ))}

        <span style={{ marginLeft: "0.75rem", color: "#475569", fontSize: "0.75rem" }}>
          {displayEntries.length} lines
        </span>

        <button
          style={{ ...styles.btn, marginLeft: "auto", ...(paused ? styles.btnActive : {}) }}
          onClick={() => {
            if (!paused) setFrozen(applyFilters(entries));
            setPaused((p) => !p);
          }}
        >
          {paused ? "▶ Resume" : "⏸ Pause"}
        </button>
      </div>

      {/* Feed */}
      <div
        ref={feedRef}
        style={styles.feed}
        onMouseEnter={() => { autoScroll.current = false; }}
        onMouseLeave={() => { autoScroll.current = true; }}
      >
        {displayEntries.map((e) => (
          <div key={e.id} style={styles.row}>
            <span style={styles.time}>{formatTime(e.ts)}</span>
            {e.tag && (
              <span style={{ ...styles.tag, color: tagColor(e.tag) }}>[{e.tag}]</span>
            )}
            <span style={{ ...styles.text, color: LEVEL_COLORS[e.level] ?? "#94a3b8" }}>
              {e.tag ? e.text.replace(`[${e.tag}]`, "").trimStart() : e.text}
            </span>
          </div>
        ))}
        {displayEntries.length === 0 && (
          <div style={{ color: "#475569", padding: "1rem", textAlign: "center" }}>No log lines</div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const styles: Record<string, React.CSSProperties> = {
  page:     { padding: "0.75rem 1.5rem", display: "flex", flexDirection: "column", height: "100%", boxSizing: "border-box" },
  controls: { display: "flex", alignItems: "center", gap: "0.3rem", marginBottom: "0.6rem", flexWrap: "wrap" },
  label:    { color: "#64748b", fontSize: "0.75rem" },
  btn: {
    background: "#1e293b", border: "1px solid #334155", color: "#94a3b8",
    padding: "0.2rem 0.55rem", borderRadius: "0.25rem", cursor: "pointer",
    fontSize: "0.7rem", fontFamily: "monospace",
  },
  btnActive: { background: "#3b82f6", borderColor: "#3b82f6", color: "#fff" },
  tagCount: {
    background: "#334155", borderRadius: "9999px",
    padding: "0 0.3rem", fontSize: "0.65rem", marginLeft: "0.25rem",
  },
  feed: {
    flex: 1,
    overflowY: "auto",
    fontFamily: "monospace",
    fontSize: "0.72rem",
    display: "flex",
    flexDirection: "column",
    background: "#0a0f1a",
    borderRadius: "0.4rem",
    padding: "0.4rem 0.6rem",
  },
  row:  { display: "flex", gap: "0.6rem", padding: "0.1rem 0", alignItems: "flex-start", borderBottom: "1px solid #0f172a" },
  time: { color: "#334155", flexShrink: 0, width: "5.5rem" },
  tag:  { flexShrink: 0, fontWeight: "bold", width: "5.5rem" },
  text: { flex: 1, whiteSpace: "pre-wrap", wordBreak: "break-all" },
};
