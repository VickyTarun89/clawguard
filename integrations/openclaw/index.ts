/**
 * ClawGuard plugin for OpenClaw.
 *
 * Registers a high-priority `before_tool_call` hook that forwards every tool
 * call to the local ClawGuard daemon and blocks unless it answers "allow".
 *
 * Fail-closed by design: if ClawGuard is unreachable, misconfigured, or slow,
 * the tool call is blocked. An agent without its firewall does not act.
 *
 * NOTE: written against the documented typed-hook surface
 * (https://docs.openclaw.ai/plugins/sdk-overview). Verify the exact plugin
 * manifest/registration shape against the openclaw plugin SDK version you run.
 */

interface ToolCallContext {
  toolName?: string;
  tool?: string;
  params?: Record<string, unknown>;
  arguments?: Record<string, unknown>;
}

interface HookResult {
  block?: boolean;
  blockReason?: string;
}

const GUARD_URL = process.env.CLAWGUARD_URL ?? "http://127.0.0.1:4747";
const GUARD_TOKEN = process.env.CLAWGUARD_TOKEN ?? "";

export default function register(api: {
  on: (hook: string, handler: (ctx: ToolCallContext) => Promise<HookResult>, opts?: { priority?: number }) => void;
}): void {
  api.on(
    "before_tool_call",
    async (ctx: ToolCallContext): Promise<HookResult> => {
      try {
        const res = await fetch(`${GUARD_URL}/v1/check`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${GUARD_TOKEN}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            agent: "openclaw",
            tool: ctx.toolName ?? ctx.tool ?? "unknown",
            params: ctx.params ?? ctx.arguments ?? {},
          }),
        });
        if (!res.ok) {
          return { block: true, blockReason: `ClawGuard error (HTTP ${res.status}) — failing closed` };
        }
        const decision = (await res.json()) as { verdict: string; reason: string };
        if (decision.verdict !== "allow") {
          return { block: true, blockReason: `ClawGuard: ${decision.reason}` };
        }
        return {};
      } catch {
        return { block: true, blockReason: "ClawGuard unreachable — failing closed" };
      }
    },
    { priority: 100 },
  );
}
