import type { ClawatchConfig } from "./types.js";
import { resolveConfig, getSessionKey } from "./config.js";
import { ClawatchConnector } from "./connector.js";
import type { WatchInfo } from "./types.js";

import type { MessageContext } from "./types.js";

export type RuntimeCallbacks = {
  onInboundMessage: (
    msgId: string,
    imei: string,
    text: string,
    sessionKey: string,
    context?: MessageContext
  ) => Promise<string>;
  logger: { info: (msg: string, ...args: unknown[]) => void; error: (msg: string, ...args: unknown[]) => void };
};

export function createClawatchRuntime(
  config: ClawatchConfig,
  callbacks: RuntimeCallbacks
) {
  let connector: ClawatchConnector | null = null;
  let pairedWatches: WatchInfo[] = [];
  let disconnecting = false;
  // Map sessionKey -> IMEI for tool execution context
  const sessionKeyToImei = new Map<string, string>();

  const wsUrl = config.apiUrl.replace(/^http/, "ws");

  function handleInboundMessage(
    id: string,
    imei: string,
    text: string,
    _timestamp?: number,
    _isCommand?: boolean,
    context?: MessageContext
  ): void {
    callbacks.logger.info(`Clawatch inbound: imei=${imei} text=${text.slice(0, 50)}`);
    const sessionKey = getSessionKey(
      config.sessionKeyPrefix ?? "watch:",
      imei
    );
    // Store sessionKey -> IMEI mapping for tool context
    sessionKeyToImei.set(sessionKey, imei);
    // Also store alternative formats that Gateway might use
    sessionKeyToImei.set(`session:${sessionKey}`, imei);
    callbacks
      .onInboundMessage(id, imei, text, sessionKey, context)
      .then((replyText) => {
        callbacks.logger.info(`Clawatch sending reply: id=${id} imei=${imei} text=${replyText.slice(0, 50)}`);
        connector?.send({
          type: "reply",
          id,
          text: replyText,
          done: true,
        });
      })
      .catch((err) => {
        const errMsg = err instanceof Error ? err.message : String(err);
        const errStack = err instanceof Error ? err.stack : undefined;
        callbacks.logger.error(`Clawatch message error: ${errMsg}`, errStack ? { stack: errStack } : undefined);
        connector?.send({
          type: "error",
          id,
          message: errMsg,
          code: "agent_error",
        });
      });
  }

  const connectorCallbacks = {
    onDebug: (msg: string, ...args: unknown[]) => {
      callbacks.logger.info(msg, ...args);
    },
    onRegistered: (watches: { imei: string; label?: string }[]) => {
      pairedWatches = watches.map((w) => ({ imei: w.imei, label: w.label }));
      callbacks.logger.info(
        `Clawatch registered, watches: ${JSON.stringify(pairedWatches)}`
      );
    },
    onError: (code: string | undefined, message: string) => {
      callbacks.logger.error(`Clawatch error [${code ?? ""}]: ${message}`);
    },
    onPong: () => {},
    onUnbound: (imei: string, reason?: string) => {
      pairedWatches = pairedWatches.filter((w) => w.imei !== imei);
      callbacks.logger.info(
        `Watch unbound: imei=${imei} reason=${reason ?? ""}`
      );
    },
    onMessage: handleInboundMessage,
  };

  function attemptReconnect(): void {
    if (disconnecting) return;
    connector = null;
    callbacks.logger.info("Clawatch: reconnecting after disconnect...");
    doConnect().catch((err) => {
      callbacks.logger.error("Clawatch reconnect failed: %s", String(err));
      // If connect() fails (e.g., server not ready), retry after delay
      // This handles cases where connect() rejects before onclose fires
      if (!disconnecting) {
        setTimeout(() => {
          if (!disconnecting) {
            attemptReconnect();
          }
        }, 2000);
      }
    });
  }

  async function doConnect(): Promise<void> {
    if (!config.apiToken) {
      callbacks.logger.error("Clawatch: no apiToken, login first");
      throw new Error("No apiToken. Run: openclaw clawatch login <countryCode> <phoneNumber>");
    }
    connector = new ClawatchConnector(
      wsUrl,
      config.apiToken,
      {
        ...connectorCallbacks,
        onReconnect: attemptReconnect,
      }
    );
    try {
      await connector.connect();
    } catch (err) {
      // If connect() rejects (timeout, error), onclose should fire and trigger onReconnect
      // But if onclose doesn't fire immediately, manually trigger reconnect after a short delay
      callbacks.logger.error("Clawatch connect() rejected: %s", String(err));
      if (!disconnecting && connector) {
        // Give onclose a chance to fire (it's async), then manually retry if needed
        setTimeout(() => {
          if (!disconnecting && connector && !connector.isConnected()) {
            callbacks.logger.info("Clawatch: manual reconnect after connect() failure");
            attemptReconnect();
          }
        }, 1000);
      }
      throw err;
    }
  }

  return {
    async connect(): Promise<void> {
      disconnecting = false;
      await doConnect();
    },

    disconnect(): void {
      disconnecting = true;
      connector?.disconnect();
      connector = null;
      pairedWatches = [];
      sessionKeyToImei.clear();
    },

    isConnected(): boolean {
      return connector?.isConnected() ?? false;
    },

    getPairedWatches(): WatchInfo[] {
      return [...pairedWatches];
    },

    sendReply(id: string, text: string, done: boolean): void {
      connector?.send({ type: "reply", id, text, done });
    },

    async sendControl(params: {
      action: string;
      imei: string;
      params?: Record<string, unknown>;
    }): Promise<void> {
      const id = `ctrl-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
      connector?.send({
        type: "control",
        id,
        action: params.action,
        imei: params.imei,
        params: params.params,
      });
    },

    sendPush(imei: string, text: string): void {
      if (!connector?.isConnected()) {
        throw new Error("Clawatch not connected");
      }
      const paired = pairedWatches.some((w) => w.imei === imei);
      if (!paired) {
        throw new Error(`IMEI ${imei} not paired`);
      }
      const id = `push-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
      connector.send({
        type: "push",
        id,
        imei,
        text,
      });
    },

    getImeiFromSessionKey(sessionKey: string): string | null {
      return sessionKeyToImei.get(sessionKey) ?? null;
    },

    // Expose logger for debugging
    logger: callbacks.logger,
  };
}

export type ClawatchRuntime = ReturnType<typeof createClawatchRuntime>;
