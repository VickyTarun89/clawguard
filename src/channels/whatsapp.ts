import type { ApprovalQueue } from "../approval/queue.ts";
import type { PendingEvent } from "../types.ts";
import { safeEqual } from "../util/safe-equal.ts";

export interface WhatsAppConfig {
  /** Meta Cloud API access token. */
  accessToken: string;
  /** Meta Cloud API phone number id (the business number that sends approvals). */
  phoneNumberId: string;
  /** E.164 numbers allowed to approve/deny. Anyone else is ignored. */
  approvers: string[];
  /**
   * Per-approver pairing PINs (E.164 → PIN), established out-of-band via
   * WA_APPROVER_PINS. An approver with a PIN must quote it in every decision
   * reply — so a spoofed or hijacked sender number alone can no longer
   * approve. Approvers without a PIN fall back to allowlist-only (v0.1).
   */
  pins?: Record<string, string>;
  /**
   * Outbound-poll relay for inbound replies (the Cloudflare Worker in relay/
   * that receives the Cloud API webhook and queues messages). Keeps the local
   * machine free of open inbound ports. Omit to run send-only.
   */
  relayUrl?: string;
  /** Bearer token the relay's /messages endpoint requires. */
  relayToken?: string;
  pollIntervalMs?: number;
}

const GRAPH_API = "https://graph.facebook.com/v20.0";

interface RelayMessage {
  from: string;
  body: string;
  ts: number;
}

// "YES K7M2QF 1234" / "NO K7M2QF" / "ALWAYS K7M2QF 1234" — verb, code (or
// legacy request id), optional pairing PIN.
export const DECISION_RE = /^(YES|APPROVE|ALWAYS|NO|DENY)\s+(\S+)(?:\s+(\S+))?$/i;

export type AuthResult = "ok" | "not-approver" | "missing-pin" | "wrong-pin";

/** Sender must be allowlisted AND, if paired, quote the right PIN. */
export function authorizeApprover(
  approvers: string[],
  pins: Record<string, string> | undefined,
  from: string,
  pin: string | undefined,
): AuthResult {
  if (!approvers.includes(from)) return "not-approver";
  const expected = pins?.[from];
  if (expected === undefined) return "ok"; // unpaired approver — allowlist-only
  if (pin === undefined) return "missing-pin";
  return safeEqual(pin, expected) ? "ok" : "wrong-pin";
}

/**
 * WhatsApp approval channel. Outbound via Meta Cloud API; inbound replies via
 * relay polling. Authorization: sender allowlist, plus per-approver pairing
 * PINs and per-decision codes (single-use, expire with the decision) — a
 * spoofed sender id or a replayed old message is not enough to approve.
 */
export class WhatsAppChannel {
  #cfg: WhatsAppConfig;
  #queue: ApprovalQueue;
  #cursor = 0;
  #timer: NodeJS.Timeout | undefined;

  constructor(cfg: WhatsAppConfig, queue: ApprovalQueue) {
    this.#cfg = cfg;
    this.#queue = queue;
  }

  start(): void {
    this.#queue.on("pending", (event: PendingEvent) => {
      void this.#notify(event);
    });
    if (this.#cfg.relayUrl) {
      const interval = this.#cfg.pollIntervalMs ?? 3000;
      this.#timer = setInterval(() => void this.#poll(), interval);
      this.#timer.unref?.();
    }
    const unpaired = this.#cfg.approvers.filter((a) => !this.#cfg.pins?.[a]);
    if (unpaired.length > 0) {
      // Mask numbers — startup output ends up in screenshots and pasted logs.
      const masked = unpaired.map((a) => `…${a.slice(-4)}`).join(", ");
      console.warn(
        `[ClawGuard] ${unpaired.length} WhatsApp approver(s) without a pairing PIN (allowlist-only auth): ${masked} — set WA_APPROVER_PINS to require a PIN per decision.`,
      );
    }
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
  }

  async #notify({ summary, expiresAt, code }: PendingEvent): Promise<void> {
    const seconds = Math.round((expiresAt - Date.now()) / 1000);
    await Promise.allSettled(
      this.#cfg.approvers.map((to) => {
        const pinHint = this.#cfg.pins?.[to] ? " <your PIN>" : "";
        const text =
          `🛡️ ClawGuard: approval needed (auto-deny in ${seconds}s)\n\n${summary}\n\n` +
          `Reply:\nYES ${code}${pinHint}\nNO ${code}${pinHint}\nALWAYS ${code}${pinHint} (never ask again for this exact action)`;
        return this.#send(to, text);
      }),
    );
  }

  async #send(to: string, body: string): Promise<void> {
    const res = await fetch(`${GRAPH_API}/${this.#cfg.phoneNumberId}/messages`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.#cfg.accessToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ messaging_product: "whatsapp", to, type: "text", text: { body } }),
    });
    if (!res.ok) {
      console.error(`[ClawGuard] WhatsApp send to ${to} failed: ${res.status} ${await res.text()}`);
    }
  }

  #authorize(from: string, pin: string | undefined): boolean {
    const result = authorizeApprover(this.#cfg.approvers, this.#cfg.pins, from, pin);
    if (result === "missing-pin" || result === "wrong-pin") {
      console.warn(`[ClawGuard] WhatsApp decision from …${from.slice(-4)} rejected: ${result === "missing-pin" ? "missing" : "wrong"} pairing PIN.`);
    }
    return result === "ok";
  }

  async #poll(): Promise<void> {
    try {
      const res = await fetch(`${this.#cfg.relayUrl}/messages?since=${this.#cursor}`, {
        headers: this.#cfg.relayToken ? { authorization: `Bearer ${this.#cfg.relayToken}` } : {},
      });
      if (!res.ok) return;
      const messages = (await res.json()) as RelayMessage[];
      for (const msg of messages) {
        this.#cursor = Math.max(this.#cursor, msg.ts);
        const match = String(msg.body).trim().match(DECISION_RE);
        if (!match) continue;
        if (!this.#authorize(msg.from, match[3])) continue;
        const verb = match[1]!.toUpperCase();
        const verdict = verb === "NO" || verb === "DENY" ? "deny" : "allow";
        this.#queue.decide(match[2]!, verdict, `whatsapp:${msg.from}`, { always: verb === "ALWAYS" });
      }
    } catch (err) {
      console.error(`[ClawGuard] relay poll failed: ${(err as Error).message}`);
    }
  }
}
