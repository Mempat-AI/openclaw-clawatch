import type {
  ClawatchWSFrame,
  RegisterFrame,
  RegisteredFrame,
  ErrorFrame,
  PongFrame,
  UnboundFrame,
  InboundMessageFrame,
  ControlAckFrame,
  MessageContext,
} from "./types.js";
import { PLUGIN_VERSION } from "./config.js";

export type ConnectorCallbacks = {
  onRegistered: (watches: { imei: string; label?: string }[]) => void;
  onError: (code: string | undefined, message: string, id?: string) => void;
  onPong: () => void;
  onUnbound: (imei: string, reason?: string) => void;
  /** Called when connection drops; implementor should call connect() to reconnect */
  onReconnect?: () => void;
  /** Optional debug logger for tracing message flow */
  onDebug?: (msg: string, ...args: unknown[]) => void;
  onMessage: (
    id: string,
    imei: string,
    text: string,
    timestamp?: number,
    isCommand?: boolean,
    context?: MessageContext
  ) => void;
  onControlAck?: (id: string, ok: boolean) => void;
};

export class ClawatchConnector {
  private ws: WebSocket | null = null;
  private token: string;
  private url: string;
  private callbacks: ConnectorCallbacks;
  private pingInterval: ReturnType<typeof setInterval> | null = null;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 0; // 0 = no limit for now
  private baseReconnectMs = 1000;
  private maxReconnectMs = 5 * 60 * 1000;

  constructor(
    url: string,
    token: string,
    callbacks: ConnectorCallbacks
  ) {
    this.url = url;
    this.token = token;
    this.callbacks = callbacks;
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        this.ws = new WebSocket(this.url);
      } catch (err) {
        reject(err);
        return;
      }

      const timeout = setTimeout(() => {
        if (this.ws?.readyState === WebSocket.CONNECTING) {
          this.ws.close();
          reject(new Error("WebSocket connection timeout"));
        }
      }, 15000);

      this.ws.onopen = () => {
        clearTimeout(timeout);
        this.reconnectAttempts = 0;
        const register: RegisterFrame = {
          type: "register",
          token: this.token,
          client: "openclaw-clawatch",
          version: PLUGIN_VERSION,
        };
        this.send(register);
      };

      this.ws.onmessage = (event) => {
        try {
          const frame = JSON.parse(event.data as string) as ClawatchWSFrame;
          this.handleFrame(frame);
        } catch {
          this.callbacks.onError("invalid_frame", "Invalid JSON from server");
        }
      };

      this.ws.onclose = () => {
        this.stopPing();
        this.ws = null;
        if (this.callbacks.onReconnect) {
          this.scheduleReconnect(this.callbacks.onReconnect);
        }
      };

      this.ws.onerror = () => {
        clearTimeout(timeout);
        // onerror usually leads to onclose, but ensure cleanup
        if (this.ws) {
          // Let onclose handle the reconnect logic
          // Don't reject immediately - wait for onclose
        }
        reject(new Error("WebSocket error"));
      };

      // First meaningful response is registered or error
      const originalOnRegistered = this.callbacks.onRegistered;
      const originalOnError = this.callbacks.onError;
      this.callbacks.onRegistered = (...args) => {
        clearTimeout(timeout);
        this.startPing();
        originalOnRegistered(...args);
        resolve();
      };
      this.callbacks.onError = (code, message, id) => {
        clearTimeout(timeout);
        originalOnError(code, message, id);
        if (code === "invalid_token" || code === "unauthorized") {
          reject(new Error(message));
        }
      };
    });
  }

  private handleFrame(frame: ClawatchWSFrame): void {
    switch (frame.type) {
      case "registered": {
        const f = frame as RegisteredFrame;
        this.callbacks.onRegistered(f.watches);
        break;
      }
      case "error": {
        const f = frame as ErrorFrame;
        this.callbacks.onError(f.code, f.message, f.id);
        break;
      }
      case "pong":
        (this.callbacks as ConnectorCallbacks).onPong();
        break;
      case "unbound": {
        const f = frame as UnboundFrame;
        this.callbacks.onUnbound(f.imei, f.reason);
        break;
      }
      case "message": {
        const f = frame as InboundMessageFrame;
        this.callbacks.onDebug?.("Clawatch received message: id=%s imei=%s text=%s", f.id, f.imei, (f.text ?? "").slice(0, 50));
        this.callbacks.onMessage(
          f.id,
          f.imei,
          f.text,
          f.timestamp,
          f.isCommand,
          f.context
        );
        break;
      }
      case "control_ack":
        if (this.callbacks.onControlAck) {
          const f = frame as ControlAckFrame;
          this.callbacks.onControlAck(f.id, f.ok);
        }
        break;
      default:
        this.callbacks.onDebug?.("Clawatch unknown frame type: %s", (frame as { type?: string }).type ?? "undefined");
        break;
    }
  }

  private startPing(intervalMs = 45000): void {
    this.stopPing();
    this.pingInterval = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.send({ type: "ping" });
      }
    }, intervalMs);
  }

  private stopPing(): void {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
  }

  send(frame: object): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(frame));
    }
  }

  disconnect(): void {
    this.stopPing();
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  isConnected(): boolean {
    return (this.ws?.readyState ?? WebSocket.CLOSED) === WebSocket.OPEN;
  }

  scheduleReconnect(onReconnect: () => void): void {
    if (
      this.maxReconnectAttempts > 0 &&
      this.reconnectAttempts >= this.maxReconnectAttempts
    ) {
      return;
    }
    const delay = Math.min(
      this.baseReconnectMs * Math.pow(2, this.reconnectAttempts),
      this.maxReconnectMs
    );
    this.reconnectAttempts++;
    setTimeout(onReconnect, delay);
  }
}
