# ClawGuard × OpenClaw

Native OpenClaw plugin (verified against OpenClaw 2026.6.11) that puts every
tool call behind the ClawGuard firewall.

## Install

```bash
# from the clawguard repo root:
openclaw plugins install ./integrations/openclaw
```

Then make sure the OpenClaw gateway process has the same token as the daemon:

```bash
set CLAWGUARD_TOKEN=<your token>
# optional: CLAWGUARD_URL (default http://127.0.0.1:4747),
#           CLAWGUARD_CHECK_TIMEOUT_MS (default 150000 — keep it above the
#           daemon's ask_timeout so human approvals have time to arrive)
```

Start the ClawGuard daemon first, then restart the gateway to load the plugin.

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
