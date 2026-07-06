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
  decidedBy: "policy" | "human" | "timeout";
  approver?: string;
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
}
