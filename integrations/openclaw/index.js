/**
 * ClawGuard plugin for OpenClaw (verified against OpenClaw 2026.6.11).
 *
 * Registers a high-priority `before_tool_call` hook that forwards every tool
 * call to the local ClawGuard daemon and blocks unless it answers "allow".
 *
 * Fail-closed by design: if ClawGuard is unreachable, misconfigured, or slow,
 * the tool call is blocked. An agent without its firewall does not act.
 *
 * Also observes `after_tool_call` and reports executed calls to /v1/events,
 * so the audit log can reconcile what was checked against what actually ran
 * (bypass detection).
 */
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const GUARD_URL = process.env.CLAWGUARD_URL ?? "http://127.0.0.1:4747";

// Prefer an explicit env token; otherwise read the file the daemon publishes,
// so the plugin authenticates even when the gateway runs as a background
// service with no CLAWGUARD_TOKEN in its environment.
function resolveToken() {
  if (process.env.CLAWGUARD_TOKEN) return process.env.CLAWGUARD_TOKEN;
  const path = process.env.CLAWGUARD_TOKEN_FILE ?? join(homedir(), ".clawguard", "token");
  try {
    return readFileSync(path, "utf8").trim();
  } catch {
    return "";
  }
}
let guardToken = resolveToken();
// A check may legitimately take as long as the human-approval window
// (daemon default ask_timeout is 120s), so leave headroom past that.
const CHECK_TIMEOUT_MS = Number(process.env.CLAWGUARD_CHECK_TIMEOUT_MS ?? 150000);
const REPORT_TIMEOUT_MS = 5000;

async function postOnce(path, payload, timeoutMs) {
  return fetch(`${GUARD_URL}${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${guardToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(timeoutMs),
  });
}

// A restarted daemon publishes a fresh token to the token file; a token cached
// at plugin load would then 401 every call until the gateway restarts. On 401,
// re-read the file and retry once. Still fail-closed: a retry that also fails
// leaves the non-OK response for the caller to block on.
async function post(path, payload, timeoutMs) {
  const res = await postOnce(path, payload, timeoutMs);
  if (res.status !== 401 || process.env.CLAWGUARD_TOKEN) return res;
  const fresh = resolveToken();
  if (!fresh || fresh === guardToken) return res;
  guardToken = fresh;
  return postOnce(path, payload, timeoutMs);
}

export default definePluginEntry({
  id: "clawguard",
  name: "ClawGuard",
  description:
    "Firewall for agent tool calls: default-deny policy, human approval over Telegram/WhatsApp, tamper-evident audit — enforced by the local ClawGuard daemon.",
  register(api) {
    api.on(
      "before_tool_call",
      async (event) => {
        try {
          const res = await post(
            "/v1/check",
            { agent: "openclaw", tool: event.toolName ?? "unknown", params: event.params ?? {} },
            CHECK_TIMEOUT_MS,
          );
          if (!res.ok) {
            return { block: true, blockReason: `ClawGuard error (HTTP ${res.status}) — failing closed` };
          }
          const decision = await res.json();
          if (decision.verdict !== "allow") {
            return { block: true, blockReason: `ClawGuard: ${decision.reason}` };
          }
          return;
        } catch {
          return { block: true, blockReason: "ClawGuard unreachable — failing closed" };
        }
      },
      { priority: 100 },
    );

    api.on("after_tool_call", async (event) => {
      try {
        await post(
          "/v1/events",
          {
            agent: "openclaw",
            tool: event.toolName ?? "unknown",
            params: event.params ?? {},
            duration_ms: event.durationMs,
          },
          REPORT_TIMEOUT_MS,
        );
      } catch {
        // observability only — never break the agent on reporting
      }
    });
  },
});
