import type { ApprovalQueue } from "../approval/queue.ts";
import type { PendingEvent } from "../types.ts";

export interface WhatsAppConfig {
  /** Meta Cloud API access token. */
  accessToken: string;
  /** Meta Cloud API phone number id (the business number that sends approvals). */
  phoneNumberId: string;
  /** E.164 numbers allowed to approve/deny. Anyone else is ignored. */
  approvers: string[];
  /**
   * Outbound-poll relay for inbound replies (e.g. a Cloudflare Worker that
   * receives the Cloud API webhook and queues messages). Keeps the local
   * machine free of open inbound ports. Omit to run send-only.
   */
  relayUrl?: string;
  pollIntervalMs?: number;
}

const GRAPH_API = "https://graph.facebook.com/v20.0";

interface RelayMessage {
  from: string;
  body: string;
  ts: number;
}

/**
 * WhatsApp approval channel. Outbound via Meta Cloud API; inbound replies via
 * relay polling. Sender allowlist is the v0.1 authorization model — v0.2 adds
 * per-device pairing codes so a spoofed/compromised sender id is not enough.
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
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
  }

  async #notify({ request, summary, expiresAt }: PendingEvent): Promise<void> {
    const seconds = Math.round((expiresAt - Date.now()) / 1000);
    const text =
      `🛡️ ClawGuard: approval needed (auto-deny in ${seconds}s)\n\n${summary}\n\n` +
      `Reply:\nAPPROVE ${request.id}\nDENY ${request.id}`;
    await Promise.allSettled(this.#cfg.approvers.map((to) => this.#send(to, text)));
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

  async #poll(): Promise<void> {
    try {
      const res = await fetch(`${this.#cfg.relayUrl}/messages?since=${this.#cursor}`);
      if (!res.ok) return;
      const messages = (await res.json()) as RelayMessage[];
      for (const msg of messages) {
        this.#cursor = Math.max(this.#cursor, msg.ts);
        if (!this.#cfg.approvers.includes(msg.from)) continue;
        const match = String(msg.body).trim().match(/^(APPROVE|DENY)\s+(\S+)$/i);
        if (!match) continue;
        const verdict = match[1]!.toUpperCase() === "APPROVE" ? "allow" : "deny";
        this.#queue.decide(match[2]!, verdict, `whatsapp:${msg.from}`);
      }
    } catch (err) {
      console.error(`[ClawGuard] relay poll failed: ${(err as Error).message}`);
    }
  }
}
