import type { ActionRequest, Policy, PolicyRule, RuleVerdict } from "../types.ts";

export function globToRegExp(glob: string): RegExp {
  // A leading "**/" means "any number of leading path segments, including
  // none", so "**/.ssh/**" has to match the relative path ".ssh/id_rsa" as
  // well as "C:/Users/me/.ssh/id_rsa". Without this the leading segments are
  // mandatory, and a hard_deny rule silently fails to match relative paths —
  // the rule looks present but the action falls through to the ask tier.
  const anyLeadingSegments = glob.startsWith("**/");
  const rest = anyLeadingSegments ? glob.slice(3) : glob;
  const escaped = rest
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, "[\\s\\S]*")
    .replace(/\?/g, ".");
  return new RegExp(`^${anyLeadingSegments ? "(?:[\\s\\S]*/)?" : ""}${escaped}$`, "i");
}

function stringParam(params: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = params[key];
    if (typeof value === "string") return value;
  }
  return undefined;
}

const normalizeSlashes = (s: string): string => s.replace(/\\/g, "/");

export function matchesRule(rule: PolicyRule, req: ActionRequest): boolean {
  if (!globToRegExp(rule.tool ?? "*").test(req.tool)) return false;

  if (rule.command) {
    const command = stringParam(req.params, ["command", "cmd", "script"]);
    // A command matcher against a request with no command can't confirm a match;
    // the request falls through to stricter defaults instead.
    if (command === undefined) return false;
    if (!rule.command.some((g) => globToRegExp(g).test(command))) return false;
  }

  if (rule.path) {
    const path = stringParam(req.params, ["path", "file_path", "filePath", "filename"]);
    if (path === undefined) return false;
    const normalized = normalizeSlashes(path);
    if (!rule.path.some((g) => globToRegExp(normalizeSlashes(g)).test(normalized))) return false;
  }

  if (rule.params_contain) {
    const blob = JSON.stringify(req.params).toLowerCase();
    if (!rule.params_contain.some((s) => blob.includes(s.toLowerCase()))) return false;
  }

  return true;
}

export interface Evaluation {
  verdict: RuleVerdict;
  reason: string;
  rule?: string;
}

const describe = (rule: PolicyRule): string => rule.note ?? JSON.stringify(rule);

/** Precedence: hard_deny > allow > ask > defaults.unmatched. */
export function evaluate(policy: Policy, req: ActionRequest): Evaluation {
  const firstMatch = (rules: PolicyRule[]): PolicyRule | undefined =>
    rules.find((rule) => matchesRule(rule, req));

  const denied = firstMatch(policy.hard_deny);
  if (denied) return { verdict: "deny", reason: "matched hard_deny rule", rule: describe(denied) };

  const allowed = firstMatch(policy.allow);
  if (allowed) return { verdict: "allow", reason: "matched allow rule", rule: describe(allowed) };

  const asked = firstMatch(policy.ask);
  if (asked) return { verdict: "ask", reason: "matched ask rule", rule: describe(asked) };

  return { verdict: policy.defaults.unmatched, reason: "no rule matched — default applied" };
}
