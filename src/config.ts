import type { ClawatchConfig } from "./types.js";

const DEFAULT_SESSION_PREFIX = "clawatch:";
const DEFAULT_AGENT_ID = "main";
const PLUGIN_VERSION = "0.1.22";

const API_URL_ENV_KEYS = ["CLAWATCH_API_URL", "OPENCLAW_CLAWATCH_API_URL"];
const DEFAULT_API_URL = "wss://api.sg.mempat.com/api/v1/watch/connect";

export function resolveConfig(raw: unknown): ClawatchConfig | null {
  const o = (raw && typeof raw === "object") ? (raw as Record<string, unknown>) : {};
  const apiUrl =
    (typeof o.apiUrl === "string" && o.apiUrl ? o.apiUrl : "") ||
    API_URL_ENV_KEYS.map((k) => process.env[k]).find(Boolean) ||
    DEFAULT_API_URL;
  if (!apiUrl) return null;

  return {
    enabled: o.enabled !== false,
    apiUrl,
    deviceCode: typeof o.deviceCode === "string" ? o.deviceCode : undefined,
    apiToken: typeof o.apiToken === "string" && o.apiToken ? o.apiToken : undefined,
    agentId: typeof o.agentId === "string" ? o.agentId : DEFAULT_AGENT_ID,
    sessionKeyPrefix:
      typeof o.sessionKeyPrefix === "string"
        ? o.sessionKeyPrefix
        : DEFAULT_SESSION_PREFIX,
    ttsSystemPrompt:
      typeof o.ttsSystemPrompt === "string" ? o.ttsSystemPrompt : undefined,
    interimStatusEnabled: o.interimStatusEnabled !== false,
  };
}

export function getSessionKey(prefix: string, imei: string): string {
  return `${prefix}${imei}`;
}

export function parseImeiFromSessionKey(sessionKey: string): string | null {
  if (!sessionKey || typeof sessionKey !== "string") return null;
  // Match formats: "clawatch:860000035452456" or "session:clawatch:860000035452456"
  const m = sessionKey.match(/^(?:session:)?clawatch:(\d{15})$/);
  return m ? m[1]! : null;
}

export { DEFAULT_SESSION_PREFIX, DEFAULT_AGENT_ID, PLUGIN_VERSION, DEFAULT_API_URL };
