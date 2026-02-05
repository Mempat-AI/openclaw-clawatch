/**
 * Clawatch Channel Plugin — enables Reminder/Cron delivery to Clawatch devices.
 * channel: "clawatch", to: "<imei>"
 */
import type { ClawatchRuntime } from "./runtime.js";

export type GetRuntime = () => ClawatchRuntime | null;

export function createClawatchChannelPlugin(getRuntime: GetRuntime) {
  return {
    id: "clawatch",
    meta: {
      id: "clawatch",
      label: "Clawatch",
      selectionLabel: "Clawatch (Smartwatch)",
      docsPath: "/plugins/clawatch-channel-requirements",
      blurb: "Clawatch device via Clawatch plugin.",
      aliases: ["watch"],
      order: 200,
    },
    capabilities: {
      chatTypes: ["direct"],
      media: false,
      reactions: false,
      threads: false,
      polls: false,
      nativeCommands: false,
      blockStreaming: false,
    },
    config: {
      listAccountIds: (_cfg?: unknown) => ["default"],
      resolveAccount: (_cfg: unknown, accountId?: string) => ({
        accountId: accountId || "default",
        enabled: true,
        config: {},
      }),
      defaultAccountId: () => "default",
      setAccountEnabled: async (opts: { cfg: unknown }) => opts.cfg,
      deleteAccount: async (opts: { cfg: unknown }) => opts.cfg,
      isConfigured: () => true,
      describeAccount: () => ({
        accountId: "default",
        name: "Clawatch",
        enabled: true,
        configured: true,
      }),
      resolveAllowFrom: () => {
        const rt = getRuntime();
        if (rt) {
          return rt.getPairedWatches().map((w) => w.imei);
        }
        return [];
      },
      formatAllowFrom: (opts: { allowFrom: string[] }) =>
        opts.allowFrom.map(String),
    },
    resolver: {
      resolveTargets: async ({
        inputs,
      }: {
        cfg: unknown;
        accountId: string | null;
        inputs: string[];
        kind: string;
        runtime?: unknown;
      }) => {
        return inputs.map((input) => {
          const imei = input.trim();
          const valid = /^\d{15}$/.test(imei);
          return {
            input,
            resolved: valid,
            id: valid ? imei : undefined,
            name: valid ? undefined : undefined,
            note: valid ? undefined : "IMEI must be 15 digits",
          };
        });
      },
    },
    outbound: {
      deliveryMode: "direct",
      textChunkLimit: 500,
      sendText: async ({
        to,
        text,
      }: {
        to: string;
        text: string;
        deps?: unknown;
      }) => {
        const rt = getRuntime();
        if (!rt) {
          throw new Error("Clawatch runtime not available");
        }
        rt.sendPush(to, text);
        return {
          channel: "clawatch",
          messageId: `push-${to}-${Date.now()}`,
        };
      },
      sendMedia: async ({
        to,
        text,
        mediaUrl,
      }: {
        to: string;
        text: string;
        mediaUrl?: string;
        deps?: unknown;
      }) => {
        const rt = getRuntime();
        if (!rt) {
          throw new Error("Clawatch runtime not available");
        }
        if (mediaUrl) {
          throw new Error("Clawatch does not support media; use text only");
        }
        rt.sendPush(to, text);
        return {
          channel: "clawatch",
          messageId: `push-${to}-${Date.now()}`,
        };
      },
    },
  };
}
