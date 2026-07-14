import readline from "node:readline";
import type { ApprovalQueue } from "../approval/queue.ts";
import type { PendingEvent } from "../types.ts";

/** Interactive stdin/stdout approvals — the default channel for local runs. */
export function startConsoleChannel(queue: ApprovalQueue): void {
  queue.on("pending", ({ summary, expiresAt, code }: PendingEvent) => {
    const seconds = Math.round((expiresAt - Date.now()) / 1000);
    console.log(
      `\n[ClawGuard] APPROVAL NEEDED (auto-deny in ${seconds}s)\n` +
        `  ${summary}\n` +
        `  approve: a ${code}\n` +
        `  deny:    d ${code}\n` +
        `  always:  aa ${code}   (allow + never ask again for this exact action)`,
    );
  });

  const rl = readline.createInterface({ input: process.stdin });
  rl.on("line", (line) => {
    const match = line.trim().match(/^(aa|a|d)\s+(\S+)$/i);
    if (!match) return;
    const cmd = match[1]!.toLowerCase();
    const verdict = cmd === "d" ? "deny" : "allow";
    const ok = queue.decide(match[2]!, verdict, "console", { always: cmd === "aa" });
    console.log(ok ? `[ClawGuard] ${verdict}${cmd === "aa" ? " (always)" : ""} recorded.` : "[ClawGuard] no such pending approval (already decided or expired).");
  });
}
