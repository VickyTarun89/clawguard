export interface ActionRequest {
  id: string;
  /** Which agent asked, e.g. "openclaw", "hermes". */
  agent: string;
  /** Tool name exactly as the agent reports it. */
  tool: string;
  params: Record<string, unknown>;
  receivedAt: string;
}

export type RuleVerdict = "allow" | "deny" | "ask";

export interface Decision {
  verdict: "allow" | "deny";
  reason: string;
  rule?: string;
  /** "remembered" = matched a persisted "always allow this exact action" rule. */
  decidedBy: "policy" | "human" | "timeout" | "remembered";
  approver?: string;
  /** Human chose "always allow": persist this exact action as a remembered rule. */
  remember?: boolean;
}

export interface PolicyRule {
  /** Glob matched against the tool name. Defaults to "*". */
  tool?: string;
  /** Globs matched against params.command / cmd / script. */
  command?: string[];
  /** Globs matched against params.path / file_path / filePath (separators normalized to "/"). */
  path?: string[];
  /** Substrings matched case-insensitively anywhere in the serialized params. */
  params_contain?: string[];
  /** Human-readable label, shown in audit logs and approval messages. */
  note?: string;
}

export interface Policy {
  version: number;
  defaults: {
    /** Verdict when no rule matches. "allow" is deliberately not representable. */
    unmatched: "ask" | "deny";
    ask_timeout_seconds: number;
    /** Timeouts can only deny — an unattended machine must never self-approve. */
    on_timeout: "deny";
  };
  hard_deny: PolicyRule[];
  allow: PolicyRule[];
  ask: PolicyRule[];
}

export interface PendingEvent {
  request: ActionRequest;
  summary: string;
  expiresAt: number;
  /**
   * Short single-use approval code, unique among pending requests. Doubles as
   * the per-decision nonce: knowing an old request's id is not enough to
   * approve a new one, and a code dies with its decision.
   */
  code: string;
}
