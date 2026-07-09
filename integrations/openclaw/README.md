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
openclaw plugins doctor    # no errors expected
```

Then ask the agent to do something your policy hard-denies (e.g. read a `.env`)
— the tool call should come back blocked with a `ClawGuard: matched hard_deny
rule` reason, and both events should appear in `data/audit.jsonl`.
