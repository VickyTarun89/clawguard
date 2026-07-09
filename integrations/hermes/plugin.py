"""ClawGuard plugin for Hermes Agent.

Registers a pre_tool_call hook that forwards every tool call to the local
ClawGuard daemon and blocks unless it answers "allow". Fail-closed by design:
if ClawGuard is unreachable, misconfigured, or slow, the tool call is blocked.

Also registers a post_tool_call observer that reports what actually executed
to ClawGuard's /v1/events endpoint. Reconciling those reports against the
pre-execution checks in the audit log exposes any tool call that bypassed the
hook (see NousResearch/hermes-agent#44582, where pre_tool_call can silently
not fire) — bypass detection instead of blind trust.

Install: copy this directory to ~/.hermes/plugins/clawguard/ and set
CLAWGUARD_TOKEN (and CLAWGUARD_URL if not the default) in the agent's
environment. Verify the packaging shape against your hermes-agent version's
"Build a Plugin" guide.
"""

import json
import os
import urllib.request


def _resolve_token():
    """Prefer CLAWGUARD_TOKEN; else read the file the daemon publishes, so the
    plugin authenticates even when Hermes runs with no token in its env."""
    env = os.environ.get("CLAWGUARD_TOKEN")
    if env:
        return env
    path = os.environ.get("CLAWGUARD_TOKEN_FILE") or os.path.join(
        os.path.expanduser("~"), ".clawguard", "token"
    )
    try:
        with open(path, "r", encoding="utf-8") as fh:
            return fh.read().strip()
    except OSError:
        return ""


GUARD_URL = os.environ.get("CLAWGUARD_URL", "http://127.0.0.1:4747")
GUARD_TOKEN = _resolve_token()
# A check may legitimately take as long as the human-approval window
# (daemon default ask_timeout is 120s), so leave headroom past that.
CHECK_TIMEOUT_S = float(os.environ.get("CLAWGUARD_CHECK_TIMEOUT", "150"))
REPORT_TIMEOUT_S = 5.0


def _post(path, payload, timeout):
    req = urllib.request.Request(
        GUARD_URL + path,
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Authorization": "Bearer " + GUARD_TOKEN,
            "Content-Type": "application/json",
        },
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=timeout) as res:
        return json.loads(res.read().decode("utf-8"))


def _params(args):
    return args if isinstance(args, dict) else {"value": str(args)}


def _check_tool_call(tool_name, args, task_id, **kwargs):
    try:
        decision = _post(
            "/v1/check",
            {"agent": "hermes", "tool": str(tool_name), "params": _params(args)},
            CHECK_TIMEOUT_S,
        )
        if decision.get("verdict") != "allow":
            return {"action": "block", "message": "ClawGuard: " + decision.get("reason", "denied")}
        return None
    except Exception as err:  # no firewall, no action
        return {
            "action": "block",
            "message": "ClawGuard unreachable (" + err.__class__.__name__ + ") — failing closed",
        }


def _report_tool_call(tool_name, args, result, task_id, duration_ms=None, **kwargs):
    try:
        _post(
            "/v1/events",
            {
                "agent": "hermes",
                "tool": str(tool_name),
                "params": _params(args),
                "duration_ms": duration_ms,
            },
            REPORT_TIMEOUT_S,
        )
    except Exception:
        pass  # observability only — never break the agent on reporting


def register(ctx):
    ctx.register_hook("pre_tool_call", _check_tool_call)
    ctx.register_hook("post_tool_call", _report_tool_call)
