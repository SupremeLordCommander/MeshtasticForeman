import type { ServerEvent, ClientCommand } from "@foreman/shared";

type EventHandler = (event: ServerEvent) => void;
type ConnectionHandler = (connected: boolean) => void;

/**
 * Persistent WebSocket client for the Foreman daemon.
 * Reconnects automatically on close — the frontend is just a viewer,
 * the daemon holds all state.
 */
export class ForemanClient {
  private ws: WebSocket | null = null;
  private handlers = new Set<EventHandler>();
  private connectionHandlers = new Set<ConnectionHandler>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private shouldReconnect = true;

  constructor(private readonly url: string = getWsUrl()) {}

  connect() {
    this.shouldReconnect = true;
    this.open();
  }

  disconnect() {
    this.shouldReconnect = false;
    this.ws?.close();
  }

  send(command: ClientCommand) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(command));
    }
  }

  on(handler: EventHandler) {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  onConnection(handler: ConnectionHandler) {
    this.connectionHandlers.add(handler);
    return () => this.connectionHandlers.delete(handler);
  }

  private open() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    const ws = new WebSocket(this.url);
    this.ws = ws;

    ws.onopen = () => {
      console.log("[ws] connected to daemon");
      for (const h of this.connectionHandlers) h(true);
    };

    ws.onmessage = (e) => {
      let event: ServerEvent;
      try {
        event = JSON.parse(e.data as string);
      } catch {
        return;
      }
      for (const handler of this.handlers) handler(event);
    };

    ws.onclose = () => {
      console.log("[ws] disconnected");
      for (const h of this.connectionHandlers) h(false);
      if (this.shouldReconnect) {
        this.reconnectTimer = setTimeout(() => this.open(), 2000);
      }
    };

    ws.onerror = (err) => {
      console.error("[ws] error", err);
    };
  }
}

function getWsUrl() {
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${window.location.host}/ws`;
}

// Singleton for use across the app
export const foremanClient = new ForemanClient();
