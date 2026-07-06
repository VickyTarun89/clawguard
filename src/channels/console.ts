import readline from "node:readline";
import type { ApprovalQueue } from "../approval/queue.ts";
import type { PendingEvent } from "../types.ts";

/** Interactive stdin/stdout approvals — the default channel for local runs. */
export function startConsoleChannel(queue: ApprovalQueue): void {
  queue.on("pending", ({ request, summary, expiresAt }: PendingEvent) => {
    const seconds = Math.round((expiresAt - Date.now()) / 1000);
    console.log(
      `\n[ClawGuard] APPROVAL NEEDED (auto-deny in ${seconds}s)\n` +
        `  ${summary}\n` +
        `  approve: a ${request.id}\n` +
        `  deny:    d ${request.id}`,
    );
  });

  const rl = readline.createInterface({ input: process.stdin });
  rl.on("line", (line) => {
    const match = line.trim().match(/^([ad])\s+(\S+)$/i);
    if (!match) return;
    const verdict = match[1]!.toLowerCase() === "a" ? "allow" : "deny";
    const ok = queue.decide(match[2]!, verdict, "console");
    console.log(ok ? `[ClawGuard] ${verdict} recorded.` : "[ClawGuard] no such pending approval (already decided or expired).");
  });
}
