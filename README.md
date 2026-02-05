# Clawatch (OpenClaw plugin)

Connect Clawatch device to OpenClaw for remote chat and control. The plugin runs inside OpenClaw and connects to the Clawatch cloud service; no Tailscale or port forwarding required.

## Install

```bash
openclaw plugins install @mempat-ai/clawatch
```

Or from GitHub:

```bash
openclaw plugins install github:Mempat-AI/openclaw-clawatch
```

Or from a local clone:

```bash
git clone https://github.com/Mempat-AI/openclaw-clawatch.git
cd openclaw-clawatch && npm run build
openclaw plugins install ./openclaw-clawatch
```

Restart OpenClaw/Gateway after installing. The plugin is enabled by default. If you use `plugins.allow`, add `clawatch` to the list.

**apiUrl** has a default (`wss://api.sg.mempat.com/api/v1/watch/connect`) and is auto-persisted on first run. Run `openclaw clawatch config` to verify.

**Enable Gateway endpoint** (required for AI replies):

```bash
openclaw config set gateway.http.endpoints.chatCompletions.enabled true
```

Restart Gateway after setting this.

**Reinstall** (if plugin was deleted): Remove `clawatch` from `plugins.entries` in `~/.openclaw/openclaw.json` first, then install. Or run `openclaw doctor --fix` to clear invalid entries.

## Login / Sign-off

- **Sign in**: `openclaw clawatch login <countryCode> <phoneNumber>`. Signs in with phone + OTP.
- **Sign off**: `openclaw clawatch logout`. Clears local token; cloud pairing remains until you unpair.
- **Status**: When signed off, `status` shows `Signed off`. When signed in, shows connection and paired watches.

## Pairing

1. Sign in: `openclaw clawatch login <countryCode> <phoneNumber>`, enter OTP when prompted.
2. Pair watch: `openclaw clawatch pair <imei>` (IMEI: 15 digits from watch box or settings).
3. Restart Gateway so the plugin connects.

## Commands

- `openclaw clawatch config` — Show resolved config (apiUrl, agentId, sign-in status).
- `openclaw clawatch login <countryCode> <phoneNumber>` — Sign in (phone + OTP).
- `openclaw clawatch pair <imei>` — Pair device (requires sign-in).
- `openclaw clawatch logout` — Sign off (clear local token).
- `openclaw clawatch status` — Show connection and paired watches; shows "Signed off" when not logged in.
- `openclaw clawatch unpair [imei]` / `disconnect` — Unpair device from cloud. Requires sign-in when Gateway is not running.
- `openclaw clawatch set-interval <imei> <sec>` — Set heartbeat/report interval (seconds).
- `openclaw clawatch bind [agentId]` — Bind clawatch to an agent (default: main). Shares memory/config with other channels.
- `openclaw clawatch send <imei> <message>` — Send a message to OpenClaw as if from the watch. Useful for config tasks on screenless device.

## Requirements

- OpenClaw with Gateway endpoint enabled (see Install section above).

## Troubleshooting

### Messages sent to OpenClaw are not received

1. **Check API response**: If you get `{"error": "no OpenClaw connection for this user"}`, the plugin is not connected or the device's user doesn't match the connection.
   - Ensure Gateway is running and the Clawatch plugin started (see `openclaw clawatch status`).
   - Ensure `apiUrl` points to the **same** cloud service instance that receives the deliver request (load balancers need sticky sessions for WebSockets).
2. **Check logs**: OpenClaw shows `Clawatch received message` and `Clawatch inbound` when a message is received.
3. **Ensure `gateway.http.endpoints.chatCompletions.enabled: true`** so the plugin can get AI replies.

### Network error / fetch failed

If you see `Network error: cannot reach cloud API` or `fetch failed` when running `pair` or `status`:
- **pair**: Check internet connection; the cloud API must be reachable.
- **status**: Ensure Gateway is running (it connects to `http://127.0.0.1:18789` by default).

### Punycode deprecation warning (logs show "error")

Root cause: `grammy → node-fetch → whatwg-url@5.0.0 → tr46` use deprecated `require("punycode")`.

**Fix (until OpenClaw adds override):** Patch the installed files (lost on `openclaw` updates):

```bash
OPENCLAW_MODULES="/opt/homebrew/lib/node_modules/openclaw/node_modules"  # or npm root -g/openclaw/node_modules

# Patch whatwg-url
sed -i.bak 's/require("punycode")/require("punycode.js")/' \
  "$OPENCLAW_MODULES/whatwg-url/lib/url-state-machine.js"

# Patch tr46
sed -i.bak 's/require("punycode")/require("punycode.js")/' \
  "$OPENCLAW_MODULES/tr46/index.js"
```

Or add to OpenClaw's `package.json` (if you have a local fork): `"overrides": { "whatwg-url": "^14.0.0" }`
