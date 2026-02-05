import type { MessageContext } from "./types.js";

/**
 * Call OpenClaw Gateway /v1/chat/completions to get agent reply.
 * Requires gateway.http.endpoints.chatCompletions.enabled.
 */
export type GatewayConfig = {
  baseUrl: string;
  token: string;
  agentId: string;
  /** Optional system prompt for TTS-friendly output (short, natural speech). */
  ttsSystemPrompt?: string;
};

const DEFAULT_TTS_PROMPT =
  "You are replying via a voice-only smartwatch with no screen. The user hears your response through text-to-speech.";

const PHYSICAL_STATE_PREFIX =
  "The following is the user's current physical world state (from watch sensors). Use this context to understand and answer their questions. If they ask about steps, battery, or health metrics, you may cite these values.\n\n";

function formatContext(ctx: MessageContext): string {
  const lines: string[] = [];
  if (ctx.location) {
    const latDir = ctx.location.lat >= 0 ? "N" : "S";
    const lngDir = ctx.location.lng >= 0 ? "E" : "W";
    lines.push(`- Location: ${Math.abs(ctx.location.lat).toFixed(4)}°${latDir}, ${Math.abs(ctx.location.lng).toFixed(4)}°${lngDir}`);
  }
  if (ctx.steps != null) {
    lines.push(`- Steps today: ${ctx.steps.value}`);
  }
  if (ctx.battery != null) {
    lines.push(`- Battery: ${ctx.battery.value}%`);
  }
  const h = ctx.health;
  if (h) {
    if (h.heart_rate != null) lines.push(`- Heart rate: ${h.heart_rate.value} bpm`);
    if (h.temperature != null) lines.push(`- Temperature: ${h.temperature.value}°C`);
    if (h.oxygen != null) lines.push(`- Blood oxygen: ${h.oxygen.value}%`);
    if (h.blood_pressure)
      lines.push(`- Blood pressure: ${h.blood_pressure.systolic}/${h.blood_pressure.diastolic} mmHg`);
  }
  return lines.length > 0 ? PHYSICAL_STATE_PREFIX + lines.join("\n") : "";
}

export async function chatCompletion(
  config: GatewayConfig,
  sessionKey: string,
  userMessage: string,
  context?: MessageContext
): Promise<string> {
  const baseUrl = config.baseUrl.replace(/\/$/, "");
  const urls = [
    `${baseUrl}/api/v1/chat/completions`,
    `${baseUrl}/v1/chat/completions`,
  ];

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${config.token}`,
    "x-openclaw-session-key": sessionKey,
    "x-openclaw-agent-id": config.agentId,
  };

  const systemPrompt = config.ttsSystemPrompt ?? DEFAULT_TTS_PROMPT;
  const messages: Array<{ role: "user" | "system"; content: string }> = [];

  if (systemPrompt.length > 0) {
    messages.push({ role: "system", content: systemPrompt });
  }
  const physicalState = context ? formatContext(context) : "";
  if (physicalState) {
    messages.push({ role: "system", content: physicalState });
  }
  messages.push({ role: "user", content: userMessage });

  const body = JSON.stringify({
    model: "openclaw",
    messages,
    stream: true,
  });

  let lastError: Error | null = null;
  for (const url of urls) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers,
        body,
      });

      if (res.ok) {
        if (!res.body) {
          throw new Error("Response body is null");
        }
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let content = "";
        let buffer = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || trimmed === "data: [DONE]") continue;
            if (!trimmed.startsWith("data: ")) continue;

            try {
              const jsonStr = trimmed.slice(6);
              const data = JSON.parse(jsonStr) as {
                choices?: Array<{ delta?: { content?: string } }>;
              };
              const delta = data.choices?.[0]?.delta?.content;
              if (delta) {
                content += delta;
              }
            } catch {
              // Skip invalid JSON lines
            }
          }
        }

        return content;
      }

      // If 405, try next URL; otherwise throw immediately
      if (res.status === 405) {
        const text = await res.text();
        lastError = new Error(`Gateway error ${res.status} for ${url}: ${text}`);
        continue; // Try next URL
      }
      
      // For other errors, throw immediately
      const text = await res.text();
      throw new Error(`Gateway error ${res.status} for ${url}: ${text}`);
    } catch (err) {
      // If it's a 405 error from the catch, continue to next URL
      if (err instanceof Error && err.message.includes("405")) {
        lastError = err;
        continue;
      }
      throw err;
    }
  }

  // If we get here, all URLs returned 405
  throw lastError || new Error("All endpoint paths returned 405 Method Not Allowed. Check gateway.http.endpoints.chatCompletions.enabled");
}
