import type { ApprovalQueue } from "../approval/queue.ts";
import type { PendingEvent } from "../types.ts";

export interface TelegramConfig {
  /** Bot token from @BotFather. */
  botToken: string;
  /**
   * Numeric Telegram user ids allowed to approve/deny (get yours from
   * @userinfobot). Ids are assigned by Telegram and cannot be spoofed by
   * other users — a stronger approver identity than a display name.
   */
  approvers: number[];
  /** Long-poll wait in seconds (Telegram getUpdates timeout). */
  pollTimeoutS?: number;
}

interface TgUser {
  id: number;
}

interface TgMessage {
  message_id: number;
  from?: TgUser;
  chat: { id: number };
  text?: string;
}

interface TgCallbackQuery {
  id: string;
  from: TgUser;
  message?: TgMessage;
  data?: string;
}

interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  callback_query?: TgCallbackQuery;
}

/**
 * Telegram approval channel — the zero-infrastructure path. The daemon
 * long-polls Telegram's getUpdates API (outbound-only, no webhook, no relay),
 * and approvals arrive as inline Approve/Deny buttons.
 *
 * Note: Telegram bots cannot message a user first. Each approver must open
 * the bot and send /start once; after that, approvals arrive forever.
 */
export class TelegramChannel {
  #cfg: TelegramConfig;
  #queue: ApprovalQueue;
  #offset = 0;
  #running = false;
  #pollFailures = 0;

  constructor(cfg: TelegramConfig, queue: ApprovalQueue) {
    this.#cfg = cfg;
    this.#queue = queue;
  }

  start(): void {
    this.#running = true;
    this.#queue.on("pending", (event: PendingEvent) => {
      void this.#notify(event);
    });
    void this.#pollLoop();
  }

  stop(): void {
    this.#running = false;
  }

  async #api(method: string, payload: Record<string, unknown>): Promise<unknown> {
    const res = await fetch(`https://api.telegram.org/bot${this.#cfg.botToken}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(((this.#cfg.pollTimeoutS ?? 25) + 10) * 1000),
    });
    const body = (await res.json()) as { ok: boolean; result?: unknown; description?: string };
    if (!body.ok) throw new Error(`telegram ${method}: ${body.description ?? res.status}`);
    return body.result;
  }

  async #notify({ request, summary, expiresAt }: PendingEvent): Promise<void> {
    const seconds = Math.round((expiresAt - Date.now()) / 1000);
    const text = `🛡 ClawGuard: approval needed (auto-deny in ${seconds}s)\n\n${summary}`;
    await Promise.allSettled(
      this.#cfg.approvers.map((chatId) =>
        this.#api("sendMessage", {
          chat_id: chatId,
          text,
          reply_markup: {
            inline_keyboard: [
              [
                { text: "✅ Approve", callback_data: `a:${request.id}` },
                { text: "⛔ Deny", callback_data: `d:${request.id}` },
              ],
              [{ text: "📌 Always allow this exact action", callback_data: `r:${request.id}` }],
            ],
          },
        }).catch((err: unknown) => {
          console.error(`[ClawGuard] Telegram notify ${chatId} failed: ${(err as Error).message}`);
        }),
      ),
    );
  }

  #isApprover(user: TgUser | undefined): boolean {
    return user !== undefined && this.#cfg.approvers.includes(user.id);
  }

  async #handleCallback(cb: TgCallbackQuery): Promise<void> {
    const ack = (text: string) =>
      this.#api("answerCallbackQuery", { callback_query_id: cb.id, text }).catch(() => {});

    if (!this.#isApprover(cb.from)) return void (await ack("Not authorized."));

    const match = (cb.data ?? "").match(/^([adr]):(\S+)$/);
    if (!match) return void (await ack("Unrecognized action."));

    const always = match[1] === "r";
    const verdict = match[1] === "d" ? "deny" : "allow";
    const decided = this.#queue.decide(match[2]!, verdict, `telegram:${cb.from.id}`, { always });
    await ack(decided ? `Recorded: ${verdict}${always ? " (always)" : ""}.` : "Already decided or expired.");

    if (decided && cb.message) {
      // Replace the buttons so the thread shows the outcome.
      const outcome = always ? "📌 ALWAYS ALLOWED" : verdict === "allow" ? "✅ APPROVED" : "⛔ DENIED";
      await this.#api("editMessageText", {
        chat_id: cb.message.chat.id,
        message_id: cb.message.message_id,
        text: `${cb.message.text ?? "ClawGuard approval"}\n\n${outcome}`,
      }).catch(() => {});
    }
  }

  #handleMessage(msg: TgMessage): void {
    if (!this.#isApprover(msg.from)) return;
    const match = (msg.text ?? "").trim().match(/^(APPROVE|DENY)\s+(\S+)$/i);
    if (!match) return;
    const verdict = match[1]!.toUpperCase() === "APPROVE" ? "allow" : "deny";
    this.#queue.decide(match[2]!, verdict, `telegram:${msg.from!.id}`);
  }

  async #pollLoop(): Promise<void> {
    while (this.#running) {
      try {
        const updates = (await this.#api("getUpdates", {
          offset: this.#offset,
          timeout: this.#cfg.pollTimeoutS ?? 25,
          allowed_updates: ["message", "callback_query"],
        })) as TgUpdate[];
        for (const update of updates) {
          this.#offset = Math.max(this.#offset, update.update_id + 1);
          if (update.callback_query) await this.#handleCallback(update.callback_query);
          else if (update.message) this.#handleMessage(update.message);
        }
        this.#pollFailures = 0;
      } catch (err) {
        // A long-poll that stalls on a network blip aborts on our timeout —
        // that's expected. Only surface it if it keeps happening, so a single
        // transient hiccup doesn't look like a failure.
        this.#pollFailures++;
        if (this.#pollFailures >= 3) {
          console.error(
            `[ClawGuard] Telegram polling has failed ${this.#pollFailures}× — check the bot token / network. (${(err as Error).message})`,
          );
        }
        await new Promise((r) => setTimeout(r, 5000)); // back off, then resume
      }
    }
  }
}
