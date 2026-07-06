import { EventEmitter } from "node:events";
import type { ActionRequest, Decision, PendingEvent } from "../types.ts";

interface PendingEntry extends PendingEvent {
  settle: (decision: Decision) => void;
  timer: NodeJS.Timeout;
}

/**
 * Holds actions awaiting a human decision. Emits "pending" for channels to
 * relay; a timeout always resolves to deny — never allow.
 */
export class ApprovalQueue extends EventEmitter {
  #pending = new Map<string, PendingEntry>();

  ask(request: ActionRequest, summary: string, timeoutMs: number): Promise<Decision> {
    return new Promise<Decision>((resolve) => {
      const timer = setTimeout(() => {
        this.#pending.delete(request.id);
        resolve({
          verdict: "deny",
          reason: `no human decision within ${Math.round(timeoutMs / 1000)}s — failing closed`,
          decidedBy: "timeout",
        });
      }, timeoutMs);
      timer.unref?.();

      const entry: PendingEntry = {
        request,
        summary,
        expiresAt: Date.now() + timeoutMs,
        timer,
        settle: (decision) => {
          clearTimeout(timer);
          this.#pending.delete(request.id);
          resolve(decision);
        },
      };
      this.#pending.set(request.id, entry);
      const event: PendingEvent = { request, summary, expiresAt: entry.expiresAt };
      this.emit("pending", event);
    });
  }

  decide(id: string, verdict: "allow" | "deny", approver: string): boolean {
    const entry = this.#pending.get(id);
    if (!entry) return false;
    entry.settle({ verdict, reason: `decided by ${approver}`, decidedBy: "human", approver });
    return true;
  }

  list(): PendingEvent[] {
    return [...this.#pending.values()].map(({ request, summary, expiresAt }) => ({ request, summary, expiresAt }));
  }
}
