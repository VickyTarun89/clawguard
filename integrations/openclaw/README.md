# ClawGuard × OpenClaw

Native OpenClaw plugin (verified against OpenClaw 2026.6.11) that puts every
tool call behind the ClawGuard firewall.

## Install

```bash
# from the clawguard repo root:
openclaw plugins install ./integrations/openclaw
```

**Token:** you do **not** need to set `CLAWGUARD_TOKEN` in the gateway's
environment. On startup the daemon publishes its token to `~/.clawguard/token`
(user-readable only), and the plugin reads it automatically. This matters
because OpenClaw's gateway often runs as a background service where injecting an
env var is awkward. Set `CLAWGUARD_TOKEN` explicitly only if you want to pin a
specific token; otherwise auto-discovery just works.

Optional overrides: `CLAWGUARD_URL` (default `http://127.0.0.1:4747`),
`CLAWGUARD_CHECK_TIMEOUT_MS` (default 150000 — keep it above the daemon's
`ask_timeout` so human approvals have time to arrive).

Start the ClawGuard daemon first, then (re)start the gateway to load the plugin.
OpenClaw treats external plugins as untrusted until allowlisted; if you see a
"plugins.allow is empty" warning, it is only a warning — the plugin still loads.
To silence it, add just this plugin without disabling bundled ones:
`openclaw config set plugins.allow '[\"clawguard\"]'` **only if** you also keep
the bundled provider plugins working (an empty-except-clawguard allowlist will
disable the model provider — prefer leaving `plugins.allow` unset).

## What it registers

- **`before_tool_call` (priority 100):** forwards `{tool, params}` to
  `POST /v1/check` and blocks unless the daemon answers `allow`. **Fail-closed**
  — if ClawGuard is down, unreachable, or slow, the tool call is blocked.
- **`after_tool_call`:** reports executed calls to `POST /v1/events` so the
  audit log can reconcile checked-vs-executed (bypass detection). Reporting
  failures never break the agent.

## Verify

```bash
openclaw plugins list      # ClawGuard: enabled
openclaw gateway restart   # then check the startup log lists clawguard among loaded plugins
```

The plugin's manifest sets `activation.onStartup: true` — **this is required.**
Without it, OpenClaw *discovers* the plugin ("Status: loaded") but never runs
its code, so the `before_tool_call` hook never registers and nothing is gated.
Confirm the gateway startup log's `http server listening (N plugins: …)` line
includes `clawguard`. If you edit and reinstall, use
`openclaw plugins install ./integrations/openclaw --force`.

Then ask the agent to read a `.env` file. Expected (verified on OpenClaw
2026.6.11): the agent replies that access was **denied by ClawGuard**, and
`data/audit.jsonl` shows `action.requested` → `action.decided: deny`.

### Gotchas

- **Leave `plugins.allow` unset.** It's a strict allowlist over *all* plugins —
  setting it to only `["clawguard"]` disables the bundled model-provider
  plugins and breaks the agent. The "plugins.allow is empty" line is just a
  warning; ignore it.
- **Approval (`ask`) actions** hold the tool call open until you decide. Keep
  the agent's turn timeout (`agents.defaults.timeoutSeconds`) comfortably above
  how long you'll take to approve on your phone.
