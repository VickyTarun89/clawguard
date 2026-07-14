import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ActionRequest } from "./types.ts";

/**
 * Canonical JSON: recursively key-sorted, so the same params hash identically
 * regardless of the order an agent serialized them in.
 */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export const actionKey = (req: Pick<ActionRequest, "agent" | "tool" | "params">): string =>
  createHash("sha256")
    .update(canonicalJson({ agent: req.agent, tool: req.tool, params: req.params }))
    .digest("hex");

export interface RememberedRule {
  key: string;
  agent: string;
  tool: string;
  params: Record<string, unknown>;
  approver: string;
  createdAt: string;
}

interface StoreFile {
  version: number;
  rules: RememberedRule[];
}

/**
 * "Always allow this exact action" rules, persisted across restarts.
 *
 * Deliberately narrow by design:
 * - Exact match only — the SHA-256 of agent + tool + canonical params. The
 *   same tool with different params (another path, another command, other
 *   file content) still asks. No globs, no "similar" matching.
 * - Consulted ONLY when the policy verdict is "ask". A hard_deny or deny can
 *   never be remembered around — policy always evaluates first.
 * - Created only by an explicit human "always allow" decision, and every hit
 *   is audited like any other decision.
 *
 * To revoke: delete the entry (or the whole file) and restart the daemon.
 */
export class RememberedStore {
  #path: string;
  #byKey = new Map<string, RememberedRule>();

  constructor(path: string) {
    this.#path = path;
    if (!existsSync(path)) return;
    try {
      const raw = JSON.parse(readFileSync(path, "utf8")) as StoreFile;
      for (const rule of raw.rules ?? []) this.#byKey.set(rule.key, rule);
    } catch {
      // A corrupt store must not brick the daemon. Losing remembered allows
      // only means asking again — the safe direction. Quarantine the file so
      // nothing silently overwrites it.
      renameSync(path, `${path}.corrupt`);
      console.error(
        `[ClawGuard] remembered-rules file was unreadable — moved to ${path}.corrupt and starting with none (actions will ask again).`,
      );
    }
  }

  find(req: Pick<ActionRequest, "agent" | "tool" | "params">): RememberedRule | undefined {
    return this.#byKey.get(actionKey(req));
  }

  add(req: Pick<ActionRequest, "agent" | "tool" | "params">, approver: string): RememberedRule {
    const rule: RememberedRule = {
      key: actionKey(req),
      agent: req.agent,
      tool: req.tool,
      params: req.params,
      approver,
      createdAt: new Date().toISOString(),
    };
    this.#byKey.set(rule.key, rule);
    this.#persist();
    return rule;
  }

  get size(): number {
    return this.#byKey.size;
  }

  #persist(): void {
    mkdirSync(dirname(this.#path), { recursive: true });
    const file: StoreFile = { version: 1, rules: [...this.#byKey.values()] };
    // Write-then-rename so a crash mid-write can't leave a half-written store.
    writeFileSync(`${this.#path}.tmp`, `${JSON.stringify(file, null, 2)}\n`);
    renameSync(`${this.#path}.tmp`, this.#path);
  }
}
