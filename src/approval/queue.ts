import { EventEmitter } from "node:events";
import { randomInt } from "node:crypto";
import type { ActionRequest, Decision, PendingEvent } from "../types.ts";

interface PendingEntry extends PendingEvent {
  settle: (decision: Decision) => void;
  timer: NodeJS.Timeout;
}

// Human-typable approval codes: no 0/O, 1/I/L lookalikes.
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 6;

/**
 * Holds actions awaiting a human decision. Emits "pending" for channels to
 * relay; a timeout always resolves to deny — never allow.
 *
 * Each pending request carries a short single-use code (the per-decision
 * nonce). Channels quote the code, humans reply with it, and it expires with
 * the decision — so a leaked or replayed code from an earlier approval is
 * worthless.
 */
export class ApprovalQueue extends EventEmitter {
  #pending = new Map<string, PendingEntry>();
  #idByCode = new Map<string, string>();

  #newCode(): string {
    // Collisions are ~impossible (31^6 space) but codes must be unique among
    // pending entries for decide-by-code to be unambiguous.
    for (;;) {
      let code = "";
      for (let i = 0; i < CODE_LENGTH; i++) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
      if (!this.#idByCode.has(code)) return code;
    }
  }

  ask(request: ActionRequest, summary: string, timeoutMs: number): Promise<Decision> {
    return new Promise<Decision>((resolve) => {
      const code = this.#newCode();

      const remove = (): void => {
        this.#pending.delete(request.id);
        this.#idByCode.delete(code);
      };

      const timer = setTimeout(() => {
        remove();
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
        code,
        timer,
        settle: (decision) => {
          clearTimeout(timer);
          remove();
          resolve(decision);
        },
      };
      this.#pending.set(request.id, entry);
      this.#idByCode.set(code, request.id);
      const event: PendingEvent = { request, summary, expiresAt: entry.expiresAt, code };
      this.emit("pending", event);
    });
  }

  /** Accepts either the request id or the short approval code. */
  #resolveEntry(idOrCode: string): PendingEntry | undefined {
    const direct = this.#pending.get(idOrCode);
    if (direct) return direct;
    const id = this.#idByCode.get(idOrCode.toUpperCase());
    return id === undefined ? undefined : this.#pending.get(id);
  }

  decide(
    idOrCode: string,
    verdict: "allow" | "deny",
    approver: string,
    opts?: { always?: boolean },
  ): boolean {
    const entry = this.#resolveEntry(idOrCode);
    if (!entry) return false;
    // "always" can only ever widen an allow — a remembered deny is not a thing.
    const remember = verdict === "allow" && opts?.always === true;
    entry.settle({ verdict, reason: `decided by ${approver}`, decidedBy: "human", approver, remember });
    return true;
  }

  list(): PendingEvent[] {
    return [...this.#pending.values()].map(({ request, summary, expiresAt, code }) => ({
      request,
      summary,
      expiresAt,
      code,
    }));
  }
}
