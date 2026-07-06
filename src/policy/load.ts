import { readFileSync } from "node:fs";
import { parse } from "yaml";
import type { Policy, PolicyRule } from "../types.ts";

function asRules(value: unknown, section: string): PolicyRule[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error(`policy: "${section}" must be a list of rules`);
  return value as PolicyRule[];
}

export function loadPolicy(path: string): Policy {
  const raw = parse(readFileSync(path, "utf8")) as Record<string, unknown> | null;
  const rawDefaults = (raw?.defaults ?? {}) as Record<string, unknown>;

  const unmatched = rawDefaults.unmatched ?? "ask";
  if (unmatched !== "ask" && unmatched !== "deny") {
    throw new Error(`policy: defaults.unmatched must be "ask" or "deny" — "allow" would defeat default-deny`);
  }
  const onTimeout = rawDefaults.on_timeout ?? "deny";
  if (onTimeout !== "deny") {
    throw new Error(`policy: defaults.on_timeout can only be "deny" — an unattended timeout must never approve`);
  }
  const askTimeout = Number(rawDefaults.ask_timeout_seconds ?? 120);
  if (!Number.isFinite(askTimeout) || askTimeout <= 0) {
    throw new Error("policy: defaults.ask_timeout_seconds must be a positive number");
  }

  return {
    version: Number(raw?.version ?? 1),
    defaults: { unmatched, ask_timeout_seconds: askTimeout, on_timeout: "deny" },
    hard_deny: asRules(raw?.hard_deny, "hard_deny"),
    allow: asRules(raw?.allow, "allow"),
    ask: asRules(raw?.ask, "ask"),
  };
}
