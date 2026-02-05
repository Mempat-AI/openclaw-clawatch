import { resolveConfig, PLUGIN_VERSION, DEFAULT_API_URL, parseImeiFromSessionKey } from "./config.js";
import { createClawatchRuntime } from "./runtime.js";
import { chatCompletion } from "./gateway.js";
import { createClawatchChannelPlugin } from "./channel.js";
import type { ClawatchRuntime } from "./runtime.js";
import type { OpenClawPluginApi } from "openclaw";

let runtime: ClawatchRuntime | null = null;

function getRuntime(): ClawatchRuntime | null {
  return runtime;
}

function formatStatus(connected: boolean, watches: Array<{ imei: string; label?: string }>): string {
  const lines: string[] = [
    `Connected: ${connected ? "yes" : "no"}`,
    `Paired: ${watches.length === 0 ? "none" : watches.map((w) => `${w.imei}${w.label ? ` (${w.label})` : ""}`).join(", ")}`,
  ];
  return lines.join("\n");
}

export function register(api: OpenClawPluginApi) {
  function getGatewayConfig(): { baseUrl: string; token: string } | null {
    const cfg = api.config?.gateway;
  if (!cfg) return null;
  const baseUrl =
    (cfg as { remote?: { url?: string } }).remote?.url ??
    `http://127.0.0.1:${(cfg as { port?: number }).port ?? 18789}`;
  const auth = (cfg as { auth?: { token?: string; password?: string } }).auth;
    const token = auth?.token ?? auth?.password ?? "";
    return { baseUrl, token };
  }

  api.registerService({
  id: "clawatch",
  start: async (ctx) => {
    const raw = api.pluginConfig;
    const config = resolveConfig(raw);
    if (!config?.enabled || !config.apiUrl) {
      ctx.logger?.info?.("Clawatch disabled or no apiUrl");
      return;
    }
    // apiUrl has default, no need to persist here
    const gateway = getGatewayConfig();
    if (!gateway) {
      ctx.logger?.error?.("Clawatch: no gateway config");
      return;
    }

    runtime = createClawatchRuntime(config, {
      logger: {
        info: (msg, ...args) => ctx.logger?.info?.(msg, ...args),
        error: (msg, ...args) => ctx.logger?.error?.(msg, ...args),
      },
      onInboundMessage: async (msgId, imei, text, sessionKey, context) => {
        const reply = await chatCompletion(
          {
            baseUrl: gateway.baseUrl,
            token: gateway.token,
            agentId: config.agentId ?? "main",
            ttsSystemPrompt: config.ttsSystemPrompt,
          },
          sessionKey,
          text,
          context
        );
        return reply;
      },
    });

    // Attempt initial connection; if it fails, runtime's reconnect logic will handle retries
    runtime.connect().catch((err) => {
      ctx.logger?.error?.("Clawatch initial connect failed: %s", String(err));
      // Don't set runtime = null here - let the reconnect logic handle retries
      // The connector's onReconnect will be triggered via onclose or manual retry
    });
  },
  stop: async () => {
    runtime?.disconnect();
    runtime = null;
  },
  });

  if (api.registerChannel) {
    api.registerChannel({
      plugin: createClawatchChannelPlugin(getRuntime),
    });
  }

  api.registerCli(
  ({ program }) => {
    const clawatch = program.command("clawatch").description("Clawatch plugin");

    clawatch
      .command("config")
      .description("Show resolved config (apiUrl, agentId, sign-in status)")
      .action(async () => {
        const raw = api.pluginConfig;
        const config = resolveConfig(raw);
        if (!config) {
          console.log("Config: disabled or invalid.");
          return;
        }
        console.log("apiUrl:", config.apiUrl);
        console.log("agentId:", config.agentId ?? "main");
        if (config.apiToken) {
          console.log("apiToken: (set, signed in)");
        } else {
          console.log("apiToken: (not set, signed off)");
        }
      });

    const LOGIN_USAGE = "Usage: openclaw clawatch login <countryCode> <phoneNumber>";
    const LOGIN_EXAMPLE = "Example: openclaw clawatch login +65 87654321";
    const PAIR_USAGE = "Usage: openclaw clawatch pair <imei>";
    const PAIR_EXAMPLE = "Example: openclaw clawatch pair 860000035452456";

    function getBaseUrl(config: { apiUrl: string }): string {
      const url = new URL(config.apiUrl);
      return url.origin.replace(/^ws:/, "http:").replace(/^wss:/, "https:");
    }

    async function doLogin(countryCode: string, phoneNumber: string): Promise<void> {
      const raw = api.pluginConfig;
      const config = resolveConfig(raw);
      if (!config?.apiUrl) {
        console.error("apiUrl not configured. Run: openclaw clawatch config");
        process.exit(1);
      }
      const baseUrl = getBaseUrl(config);
      let loginRes: Response;
      try {
        loginRes = await fetch(`${baseUrl}/api/v1/watch/login`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ countryCode, phoneNumber }),
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error("Network error: cannot reach cloud API.", msg.includes("fetch failed") ? "Check your connection." : msg);
        process.exit(1);
      }
      if (!loginRes.ok) {
        const t = await loginRes.text();
        console.error("Login failed:", loginRes.status, t);
        process.exit(1);
      }
      const loginData = (await loginRes.json()) as { session?: string; error?: string };
      if (loginData.error) {
        console.error(loginData.error);
        process.exit(1);
      }
      const session = loginData.session;
      if (!session) {
        console.error("No session in response");
        process.exit(1);
      }

      console.log("Enter OTP from your phone:");
      const otp = await new Promise<string>((resolve) => {
        process.stdin.once("data", (d) => resolve(d.toString().trim()));
      });
      let confirmRes: Response;
      try {
        confirmRes = await fetch(`${baseUrl}/api/v1/watch/login/confirm`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ session, otp }),
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error("Network error: cannot reach cloud API.", msg.includes("fetch failed") ? "Check your connection." : msg);
        process.exit(1);
      }
      if (!confirmRes.ok) {
        const t = await confirmRes.text();
        console.error("Confirm failed:", confirmRes.status, t);
        process.exit(1);
      }
      const confirmData = (await confirmRes.json()) as { apiToken?: string; error?: string };
      if (confirmData.error) {
        console.error(confirmData.error);
        process.exit(1);
      }
      const apiToken = confirmData.apiToken;
      if (!apiToken) {
        console.error("No apiToken in response");
        process.exit(1);
      }
      try {
        const { execSync } = await import("child_process");
        execSync(`openclaw config set plugins.entries.clawatch.config.apiToken "${apiToken}"`, {
          stdio: ["ignore", "ignore", "ignore"],
          encoding: "utf-8",
        });
      } catch {
        // Silent fail
      }
    }

    async function doPair(imei: string): Promise<void> {
      const raw = api.pluginConfig;
      const config = resolveConfig(raw);
      if (!config?.apiUrl) {
        console.error("apiUrl not configured. Run: openclaw clawatch config");
        process.exit(1);
      }
      if (!config.apiToken) {
        console.error("Not signed in. Run: openclaw clawatch login <countryCode> <phoneNumber>");
        process.exit(1);
      }
      if (!/^\d{15}$/.test(imei)) {
        console.error("IMEI must be 15 digits (from watch box or settings).");
        process.exit(1);
      }
      const baseUrl = getBaseUrl(config);
      let res: Response;
      try {
        res = await fetch(`${baseUrl}/api/v1/watch/pair`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${config.apiToken}`,
          },
          body: JSON.stringify({ imei }),
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error("Network error: cannot reach cloud API.", msg.includes("fetch failed") ? "Check your connection." : msg);
        process.exit(1);
      }
      if (!res.ok) {
        const t = await res.text();
        console.error("Pair failed:", res.status, t);
        process.exit(1);
      }
      const data = (await res.json()) as { error?: string };
      if (data.error) {
        console.error(data.error);
        process.exit(1);
      }
    }

    clawatch
      .command("login [countryCode] [phoneNumber]")
      .description("Sign in (phone + OTP)")
      .addHelpText("after", `\n${LOGIN_USAGE}\n${LOGIN_EXAMPLE}\n  countryCode: e.g. +65, +1\n  phoneNumber: number used in Clawatch app`)
      .action(async (countryCode?: string, phoneNumber?: string) => {
        if (!countryCode?.trim() || !phoneNumber?.trim()) {
          console.error("Sign in requires country code and phone number.");
          console.error("");
          console.error(LOGIN_USAGE);
          console.error(LOGIN_EXAMPLE);
          console.error("");
          console.error("  countryCode: e.g. +65, +1");
          console.error("  phoneNumber: number used in Clawatch app");
          process.exit(1);
        }
        await doLogin(countryCode.trim(), phoneNumber.trim());
        console.log("Signed in. Run 'openclaw clawatch pair <imei>' to pair a watch.");
        process.exit(0);
      });

    clawatch
      .command("pair [imei]")
      .description("Pair device (requires sign-in)")
      .addHelpText("after", `\n${PAIR_USAGE}\n${PAIR_EXAMPLE}\n  imei: 15 digits from watch box or settings`)
      .action(async (imei?: string) => {
        const raw = api.pluginConfig;
        const config = resolveConfig(raw);
        if (!config?.apiToken) {
          console.error("Not signed in.");
          console.error("");
          console.error("Sign in first:");
          console.error(`  openclaw clawatch login <countryCode> <phoneNumber>`);
          console.error(`  ${LOGIN_EXAMPLE}`);
          process.exit(1);
        }
        if (!imei?.trim()) {
          console.error("Pair requires imei.");
          console.error("");
          console.error(PAIR_USAGE);
          console.error(PAIR_EXAMPLE);
          process.exit(1);
        }
        await doPair(imei.trim());
        console.log("Device paired. Restart Gateway to connect.");
        process.exit(0);
      });

    clawatch
      .command("logout")
      .description("Sign off (clear local token)")
      .action(async () => {
        const raw = api.pluginConfig;
        const config = resolveConfig(raw);
        if (!config?.apiToken) {
          console.log("Already signed off.");
          return;
        }
        try {
          const { execSync } = await import("child_process");
          execSync(`openclaw config set plugins.entries.clawatch.config.apiToken ""`, {
            stdio: ["ignore", "ignore", "ignore"],
            encoding: "utf-8",
          });
          console.log("Signed off.");
        } catch {
          console.error("Failed to clear config.");
          process.exit(1);
        }
      });

        clawatch
      .command("status")
      .description("Show connection and paired watches")
      .action(async () => {
      if (runtime) {
        console.log(formatStatus(runtime.isConnected(), runtime.getPairedWatches()));
        return;
      }
      // CLI runs in separate process; runtime lives in Gateway.
      const config = resolveConfig(api.pluginConfig);
      if (!config?.apiToken) {
        console.log("Signed off.");
        console.log("");
        console.log("Sign in: openclaw clawatch login <countryCode> <phoneNumber>");
        console.log("Example: openclaw clawatch login +65 87654321");
        return;
      }
      const gateway = getGatewayConfig();
      if (!gateway?.token) {
        console.log("Signed in.\nConnected: no (Gateway not configured or not running)\nPaired: unknown");
        return;
      }
      try {
        const url = `${gateway.baseUrl.replace(/\/$/, "")}/tools/invoke`;
        const res = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${gateway.token}`,
          },
          body: JSON.stringify({ tool: "clawatch_status", args: {} }),
        });
        if (!res.ok) {
          if (res.status === 401) {
            console.log("Signed in.\nConnected: no (Gateway auth failed)");
          } else if (res.status === 404) {
            console.log("Signed in.\nConnected: no (Gateway not running or clawatch not loaded)\nPaired: unknown");
          } else {
            const errorText = await res.text();
            console.error("Gateway error:", res.status, errorText);
          }
          return;
        }
        const data = (await res.json()) as { ok?: boolean; result?: { content?: Array<{ type: string; text?: string }> } };
        if (data.ok && data.result?.content?.[0]?.text) {
          console.log(data.result.content[0].text);
        } else {
          console.log("Signed in.\nConnected: no\nPaired: unknown (unexpected Gateway response)");
        }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        if (errMsg.includes("ECONNREFUSED") || errMsg.includes("fetch failed")) {
          console.log("Signed in.\nConnected: no (Gateway not running or unreachable)\nPaired: unknown");
        } else {
          console.log(`Signed in.\nConnected: no\nPaired: unknown (Gateway error: ${errMsg})`);
        }
        return;
      }
    });

        clawatch
      .command("unpair [imei]")
      .alias("disconnect")
      .description("Unpair device from cloud")
      .action(async (imei?: string) => {
        let targetImei: string | undefined;
        if (runtime) {
          const watches = runtime.getPairedWatches();
          const target = imei ? watches.find((w) => w.imei === imei) : watches[0];
          if (target) {
            await runtime.sendControl({ action: "unpair", imei: target.imei });
            console.log("Unpaired", target.imei);
            return;
          }
          targetImei = imei?.trim();
        } else {
          targetImei = imei?.trim();
        }
        if (!targetImei || !/^\d{15}$/.test(targetImei)) {
          console.error("IMEI required when Gateway is not running.");
          console.error("");
          console.error("Usage: openclaw clawatch unpair <imei>");
          console.error("  imei: 15 digits from watch box or settings");
          process.exit(1);
        }
        // CLI runs in separate process: call cloud API unpair directly (requires apiToken)
        const config = resolveConfig(api.pluginConfig);
        if (!config?.apiUrl) {
          console.error("apiUrl not configured. Run: openclaw clawatch config");
          process.exit(1);
        }
        if (!config.apiToken) {
          console.error("Not signed in.");
          console.error("");
          console.error("Sign in first: openclaw clawatch login <countryCode> <phoneNumber>");
          console.error("Or run unpair when Gateway is running (uses first paired watch).");
          process.exit(1);
        }
        const url = new URL(config.apiUrl);
        const baseUrl = url.origin.replace(/^ws:/, "http:").replace(/^wss:/, "https:");
        let res: Response;
        try {
          res = await fetch(`${baseUrl}/api/v1/watch/unpair`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${config.apiToken}`,
            },
            body: JSON.stringify({ device_id: targetImei }),
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error("Network error: cannot reach cloud API.", msg.includes("fetch failed") ? "Check your connection." : msg);
          process.exit(1);
        }
        const data = (await res.json()) as { ok?: boolean; error?: string; message?: string };
        if (!res.ok) {
          console.error("Unpair failed:", data.error ?? data.message ?? res.status);
          process.exit(1);
        }
        console.log("Unpaired", targetImei);
      });

        clawatch
      .command("set-interval [imei] [sec]")
      .description("Set heartbeat interval (seconds) for a paired watch")
      .action(async (imei?: string, sec?: string) => {
        if (!imei?.trim() || sec === undefined || sec === "") {
          console.error("Usage: openclaw clawatch set-interval <imei> <sec>");
          console.error("  imei: 15 digits");
          console.error("  sec:  positive seconds (e.g. 60)");
          process.exit(1);
        }
        if (!runtime) {
          console.error("Not connected.");
          console.error("");
          console.error("Start Gateway first: openclaw start");
          process.exit(1);
        }
        const intervalSec = parseInt(String(sec).trim(), 10);
        if (Number.isNaN(intervalSec) || intervalSec < 1) {
          console.error("Invalid interval. Use a positive number of seconds.");
          process.exit(1);
        }
        await runtime.sendControl({
          action: "set_interval",
          imei: imei.trim(),
          params: { intervalSec },
        });
        console.log("Interval set to", intervalSec, "s for", imei.trim());
      });

    clawatch
      .command("bind [agentId]")
      .description("Bind clawatch channel to an agent (default: main). Shares memory/config with other channels using the same agent.")
      .action(async (agentId?: string) => {
        const targetAgent = agentId?.trim() || "main";
        try {
          const { execSync } = await import("child_process");
          const binding = JSON.stringify([{ agentId: targetAgent, match: { channel: "clawatch" } }]);
          execSync(`openclaw config set bindings '${binding}' --json`, {
            stdio: ["ignore", "ignore", "pipe"],
            encoding: "utf-8",
          });
          console.log(`Bound clawatch to agent "${targetAgent}".`);
          console.log("Restart Gateway for changes to take effect.");
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error("Failed to set binding:", msg);
          process.exit(1);
        }
      });

    clawatch
      .command("send <imei> <message>")
      .description("Send a message to OpenClaw as if from the watch (useful for config tasks on screenless device)")
      .action(async (imei: string, message: string) => {
        if (!/^\d{15}$/.test(imei)) {
          console.error("IMEI must be 15 digits.");
          process.exit(1);
        }
        const gateway = getGatewayConfig();
        if (!gateway) {
          console.error("Gateway not configured.");
          process.exit(1);
        }
        const config = resolveConfig(api.pluginConfig);
        const agentId = config?.agentId ?? "main";
        const sessionKey = `clawatch:${imei}`;
        const chatId = Math.floor(Date.now() / 1000);
        
        const url = `${gateway.baseUrl.replace(/\/$/, "")}/v1/chat/completions`;
        try {
          const res = await fetch(url, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${gateway.token}`,
              "x-openclaw-session-key": sessionKey,
              "x-openclaw-agent-id": agentId,
            },
            body: JSON.stringify({
              model: "openclaw",
              messages: [{ role: "user", content: message }],
              stream: false,
            }),
          });
          if (!res.ok) {
            const text = await res.text();
            console.error("Request failed:", res.status, text);
            process.exit(1);
          }
          const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
          const reply = data.choices?.[0]?.message?.content ?? "(no reply)";
          console.log(JSON.stringify({ chat_id: chatId, imei, reply }, null, 2));
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error("Request failed:", msg);
          process.exit(1);
        }
      });
  },
  { commands: ["clawatch"] }
  );

  api.registerTool({
  name: "clawatch_control",
  description:
    "Send control commands to paired smartwatch (set_interval, unpair, get_config)",
  parameters: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["set_interval", "unpair", "get_config"],
      },
      imei: { type: "string" },
      intervalSec: { type: "number" },
    },
    required: ["action"],
  },
  execute: async (_ctx, params: { action: string; imei?: string; intervalSec?: number }) => {
    if (!runtime) {
      return { content: [{ type: "text", text: "Clawatch not connected." }] };
    }
    const watches = runtime.getPairedWatches();
    const imei = params.imei ?? watches[0]?.imei;
    if (!imei) {
      return { content: [{ type: "text", text: "No paired watch." }] };
    }
    if (params.action === "set_interval" && params.intervalSec != null) {
      await runtime.sendControl({
        action: "set_interval",
        imei,
        params: { intervalSec: params.intervalSec },
      });
      return {
        content: [{ type: "text", text: `Interval set to ${params.intervalSec}s for ${imei}` }],
      };
    }
    if (params.action === "unpair") {
      await runtime.sendControl({ action: "unpair", imei });
      return {
        content: [{ type: "text", text: `Unpaired ${imei}` }],
      };
    }
    if (params.action === "get_config") {
      await runtime.sendControl({ action: "get_config", imei });
      return {
        content: [{ type: "text", text: `Config request sent for ${imei}` }],
      };
    }
    return { content: [{ type: "text", text: "Unknown action." }] };
  },
  });

  api.registerTool({
  name: "clawatch_status",
  description: "Check Clawatch connection and paired watches",
  parameters: { type: "object", properties: {} },
  execute: async () => {
    if (!runtime) {
      return {
        content: [{ type: "text", text: "Connected: no\nPaired: unknown (service may not be started)" }],
      };
    }
    return {
      content: [{ type: "text", text: formatStatus(runtime.isConnected(), runtime.getPairedWatches()) }],
    };
  },
  });

  api.registerTool({
  name: "clawatch_push",
  description: "Push text to a paired watch (for Reminder/Cron). Active push, no preceding message.",
  parameters: {
    type: "object",
    properties: {
      imei: { type: "string", description: "Watch IMEI (15 digits). Omit to use first paired watch." },
      text: { type: "string", description: "Text to push (e.g. reminder message)" },
    },
    required: ["text"],
  },
  execute: async (_ctx, params: { imei?: string; text: string }) => {
    if (!runtime) {
      return { content: [{ type: "text", text: "Clawatch not connected." }] };
    }
    const watches = runtime.getPairedWatches();
    const imei = params.imei ?? watches[0]?.imei;
    if (!imei) {
      return { content: [{ type: "text", text: "No paired watch." }] };
    }
    try {
      runtime.sendPush(imei, params.text);
      return { content: [{ type: "text", text: `Pushed to ${imei}: ${params.text.slice(0, 50)}${params.text.length > 50 ? "…" : ""}` }] };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { content: [{ type: "text", text: `Push failed: ${msg}` }] };
    }
  },
  });

  // Interim status tool: send brief contextual status before long-running tools
  // Use factory form to get sessionKey from ctx at run time
  api.registerTool((ctx: { sessionKey?: string; messageChannel?: string }) => {
    // Parse IMEI from sessionKey at tool creation time (per run)
    const sessionKey = ctx.sessionKey ?? "";
    const sessionImei = parseImeiFromSessionKey(sessionKey);
    const logger = runtime?.logger;
    
    logger?.info?.(`clawatch_interim factory: sessionKey=${sessionKey} sessionImei=${sessionImei ?? "(none)"} messageChannel=${ctx.messageChannel ?? "(none)"}`);
    
    return {
      name: "clawatch_interim",
      description:
        "Send a brief interim message to the smartwatch before long-running tools. Keep the message short and natural.",
      parameters: {
        type: "object",
        properties: {
          message: {
            type: "string",
            description: "Brief, natural, first-person conversational message in user's language (under 10 words).",
          },
        },
        required: [],
      },
      execute: async (_id: string, params: { message?: string }) => {
        logger?.info?.(`clawatch_interim called: sessionKey=${sessionKey} sessionImei=${sessionImei ?? "(none)"} message=${params.message ?? "(none)"}`);
        
        // Only allow for clawatch sessions (sessionKey starts with "clawatch:")
        if (!sessionImei) {
          logger?.info?.(`clawatch_interim: skipped, not a clawatch session (sessionKey=${sessionKey})`);
          return { content: [{ type: "text", text: "Skipped: not a clawatch session." }] };
        }
        
        if (!runtime) {
          logger?.info?.("clawatch_interim: runtime not available");
          return { content: [{ type: "text", text: "Clawatch not connected." }] };
        }
        
        // Check if this IMEI is actually paired
        const watches = runtime.getPairedWatches();
        const isPaired = watches.some(w => w.imei === sessionImei);
        logger?.info?.(`clawatch_interim: imei=${sessionImei} isPaired=${isPaired} pairedWatches=${watches.map(w => w.imei).join(",")}`);
        
        if (!isPaired) {
          logger?.info?.(`clawatch_interim: IMEI ${sessionImei} not in paired list, skipping`);
          return { content: [{ type: "text", text: `Skipped: IMEI ${sessionImei} not paired.` }] };
        }
        
        const text = String(params.message?.trim() || "ok").slice(0, 80);
        try {
          runtime.sendPush(sessionImei, text);
          logger?.info?.(`clawatch_interim: sent to ${sessionImei}: ${text}`);
          return { content: [{ type: "text", text: `Sent interim: ${text}` }] };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          logger?.error?.(`clawatch_interim: push failed: ${msg}`);
          return { content: [{ type: "text", text: `Interim failed: ${msg}` }] };
        }
      },
    };
  });

  // Hook: inject guidance to call clawatch_interim before long-running tools
  // The tool itself will filter non-clawatch sessions via sessionKey
  const apiWithHooks = api as {
    on?: (
      event: string,
      handler: (event: { prompt?: string }) => Promise<{ prependContext?: string } | void>
    ) => void;
  };
  if (typeof apiWithHooks.on === "function") {
    apiWithHooks.on("before_agent_start", async () => {
      const config = resolveConfig(api.pluginConfig);
      if (config?.interimStatusEnabled === false) {
        return;
      }
      
      // Always inject prependContext; the tool will filter non-clawatch sessions via sessionKey
      const logger = runtime?.logger;
      logger?.info?.("before_agent_start: injecting prependContext for clawatch interim");
      return {
        prependContext:
          "[Behavior] Before long-running tools (exec, curl, web search, multi-step flows), call clawatch_interim with a brief, natural message. Keep it short and conversational. The tool will automatically skip if not a clawatch session.",
      };
    });
  }
}

export { PLUGIN_VERSION };
