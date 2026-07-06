# ClawGuard × Hermes Agent

Python plugin that puts every Hermes tool call behind the ClawGuard firewall.

## Install

1. Copy this directory to `~/.hermes/plugins/clawguard/` (Hermes loads plugins from there automatically).
2. Make sure the ClawGuard daemon is running (`npm start` in the repo root) and export the same token in the environment Hermes runs in:

```bash
export CLAWGUARD_TOKEN=<your token>
# optional overrides:
export CLAWGUARD_URL=http://127.0.0.1:4747
export CLAWGUARD_CHECK_TIMEOUT=150   # seconds; keep > the daemon's ask_timeout
```

3. Restart Hermes. From the first tool call on, `allow` rules flow, `hard_deny` blocks instantly, and everything else pings your approval channel.

## Fail-closed behavior

If the daemon is down or unreachable, **all tool calls are blocked**. An agent without its firewall does not act. Start ClawGuard before starting Hermes.

## Bypass detection

Hermes has a known issue where `pre_tool_call` hooks can silently not fire
([NousResearch/hermes-agent#44582](https://github.com/NousResearch/hermes-agent/issues/44582)).
This plugin therefore also reports every *executed* tool call via `post_tool_call`
to ClawGuard's `/v1/events` endpoint. In the audit log:

- `action.requested` = the call was checked before execution
- `action.observed` = the call actually executed

An `action.observed` entry with no matching `action.requested` means a tool call
bypassed the pre-execution check — you'll see it in the log instead of never
knowing. Until the upstream issue is resolved, prefer running Hermes with the
Docker terminal backend as an additional containment layer.
