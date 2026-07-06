import { randomUUID } from "node:crypto";
import type { ActionRequest, Decision, Policy } from "./types.ts";
import { evaluate } from "./policy/engine.ts";
import type { ApprovalQueue } from "./approval/queue.ts";
import type { AuditLog } from "./audit/log.ts";

export interface CheckInput {
  agent: string;
  tool: string;
  params?: Record<string, unknown>;
}

export class Broker {
  readonly policy: Policy;
  readonly queue: ApprovalQueue;
  readonly audit: AuditLog;

  constructor(policy: Policy, queue: ApprovalQueue, audit: AuditLog) {
    this.policy = policy;
    this.queue = queue;
    this.audit = audit;
  }

  #summarize(req: ActionRequest): string {
    const params = JSON.stringify(req.params);
    const preview = params.length > 200 ? `${params.slice(0, 200)}…` : params;
    return `${req.agent} wants ${req.tool} ${preview}`;
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

    const decision: Decision =
      evaluation.verdict === "ask"
        ? await this.queue.ask(req, this.#summarize(req), this.policy.defaults.ask_timeout_seconds * 1000)
        : { verdict: evaluation.verdict, reason: evaluation.reason, rule: evaluation.rule, decidedBy: "policy" };

    this.audit.append({ type: "action.decided", requestId: req.id, decision });
    return { ...decision, id: req.id };
  }
}
