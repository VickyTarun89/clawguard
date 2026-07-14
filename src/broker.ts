import { randomUUID } from "node:crypto";
import type { ActionRequest, Decision, Policy } from "./types.ts";
import { evaluate } from "./policy/engine.ts";
import type { ApprovalQueue } from "./approval/queue.ts";
import type { AuditLog } from "./audit/log.ts";
import type { RememberedStore } from "./remember.ts";

export interface CheckInput {
  agent: string;
  tool: string;
  params?: Record<string, unknown>;
}

export class Broker {
  readonly policy: Policy;
  readonly queue: ApprovalQueue;
  readonly audit: AuditLog;
  readonly remembered: RememberedStore;

  constructor(policy: Policy, queue: ApprovalQueue, audit: AuditLog, remembered: RememberedStore) {
    this.policy = policy;
    this.queue = queue;
    this.audit = audit;
    this.remembered = remembered;
  }

  #summarize(req: ActionRequest): string {
    const params = JSON.stringify(req.params);
    const preview = params.length > 200 ? `${params.slice(0, 200)}…` : params;
    return `${req.agent} wants ${req.tool} ${preview}`;
  }

  /**
   * One-line console form. Params are truncated hard: a write's content can
   * carry exactly the secrets this tool exists to protect, and console output
   * ends up in screenshots and pasted logs.
   */
  #line(req: ActionRequest): string {
    const params = JSON.stringify(req.params);
    const preview = params.length > 80 ? `${params.slice(0, 80)}…` : params;
    return `${req.agent} ${req.tool} ${preview}`;
  }

  /**
   * Record a tool call the agent reports as already executed. Reconciling
   * these against action.requested entries exposes any call that bypassed
   * the pre-execution check (e.g. an agent whose hook silently didn't fire).
   */
  observe(input: CheckInput & { durationMs?: number }): void {
    this.audit.append({
      type: "action.observed",
      agent: input.agent,
      tool: input.tool,
      params: input.params ?? {},
      durationMs: input.durationMs,
      observedAt: new Date().toISOString(),
    });
  }

  async check(input: CheckInput): Promise<Decision & { id: string }> {
    const req: ActionRequest = {
      id: randomUUID(),
      agent: input.agent,
      tool: input.tool,
      params: input.params ?? {},
      receivedAt: new Date().toISOString(),
    };

    const evaluation = evaluate(this.policy, req);
    this.audit.append({ type: "action.requested", request: req, evaluation });

    // Remembered "always allow" rules apply ONLY to would-ask actions: policy
    // evaluates first, so a hard_deny (or deny) can never be remembered around.
    const remembered = evaluation.verdict === "ask" ? this.remembered.find(req) : undefined;

    let decision: Decision;
    if (remembered) {
      decision = {
        verdict: "allow",
        reason: `remembered exact action (always-allowed by ${remembered.approver} on ${remembered.createdAt.slice(0, 10)})`,
        rule: "remembered",
        decidedBy: "remembered",
      };
      console.log(`[ClawGuard] 📌 ALLOW ${this.#line(req)} — remembered exact action`);
    } else if (evaluation.verdict === "ask") {
      console.log(`[ClawGuard] ⏳ ASK   ${this.#line(req)} — waiting for your approval…`);
      decision = await this.queue.ask(req, this.#summarize(req), this.policy.defaults.ask_timeout_seconds * 1000);
    } else {
      if (evaluation.verdict === "deny") {
        console.log(`[ClawGuard] ⛔ DENY  ${this.#line(req)} — ${evaluation.rule ?? evaluation.reason}`);
      }
      decision = { verdict: evaluation.verdict, reason: evaluation.reason, rule: evaluation.rule, decidedBy: "policy" };
    }

    this.audit.append({ type: "action.decided", requestId: req.id, decision });

    if (decision.decidedBy === "human" && decision.verdict === "allow" && decision.remember) {
      const rule = this.remembered.add(req, decision.approver ?? "unknown");
      this.audit.append({ type: "rule.remembered", key: rule.key, agent: req.agent, tool: req.tool, params: req.params, approver: rule.approver });
      console.log(`[ClawGuard] 📌 remembered — this exact action will auto-allow from now on (delete data/remembered.json to revoke)`);
    }

    if (decision.decidedBy === "human" || decision.decidedBy === "timeout") {
      const icon = decision.verdict === "allow" ? "✅ ALLOW" : "⛔ DENY ";
      const by = decision.decidedBy === "human" ? `you (${decision.approver})` : decision.decidedBy;
      console.log(`[ClawGuard] ${icon} ${this.#line(req)} — decided by ${by}`);
    }

    return { ...decision, id: req.id };
  }
}
