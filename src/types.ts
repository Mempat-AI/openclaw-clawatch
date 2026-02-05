export type ClawatchConfig = {
  enabled?: boolean;
  apiUrl: string;
  deviceCode?: string;
  apiToken?: string;
  agentId?: string;
  sessionKeyPrefix?: string;
  /** System prompt for TTS-friendly replies (short, natural speech). Empty = use agent default. */
  ttsSystemPrompt?: string;
  /** Enable interim status messages before long-running tools. Default: true. */
  interimStatusEnabled?: boolean;
};

export type WatchInfo = {
  imei: string;
  label?: string;
};

// WebSocket frames (plugin <-> API)
export type RegisterFrame = {
  type: "register";
  token: string;
  client: string;
  version: string;
};

export type RegisteredFrame = {
  type: "registered";
  watches: WatchInfo[];
};

export type ErrorFrame = {
  type: "error";
  code?: string;
  message: string;
  id?: string;
};

export type PingFrame = { type: "ping" };
export type PongFrame = { type: "pong" };

export type UnboundFrame = {
  type: "unbound";
  imei: string;
  reason?: string;
};

/** Device context from server (location, steps, battery, health). */
export type MessageContext = {
  location?: { lat: number; lng: number; received_at?: number };
  steps?: { value: number; received_at?: number };
  battery?: { value: number; received_at?: number };
  health?: {
    heart_rate?: { value: number; received_at?: number };
    temperature?: { value: number; received_at?: number };
    oxygen?: { value: number; received_at?: number };
    blood_pressure?: { systolic: number; diastolic: number; received_at?: number };
  };
};

export type InboundMessageFrame = {
  type: "message";
  id: string;
  imei: string;
  text: string;
  timestamp?: number;
  isCommand?: boolean;
  context?: MessageContext;
};

export type ReplyFrame = {
  type: "reply";
  id: string;
  text: string;
  done: boolean;
};

export type ControlFrame = {
  type: "control";
  id: string;
  action: string;
  imei: string;
  params?: Record<string, unknown>;
};

export type ControlAckFrame = {
  type: "control_ack";
  id: string;
  ok: boolean;
};

/** Outbound: plugin → cloud. For Reminder/Cron push to watch. */
export type PushFrame = {
  type: "push";
  id: string;
  imei: string;
  text: string;
};

export type ClawatchWSFrame =
  | RegisterFrame
  | RegisteredFrame
  | ErrorFrame
  | PingFrame
  | PongFrame
  | UnboundFrame
  | InboundMessageFrame
  | ReplyFrame
  | ControlFrame
  | ControlAckFrame;
