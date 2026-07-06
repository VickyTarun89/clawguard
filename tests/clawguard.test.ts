import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evaluate } from "../src/policy/engine.ts";
import { AuditLog } from "../src/audit/log.ts";
import type { ActionRequest, Policy } from "../src/types.ts";

const policy: Policy = {
  version: 1,
  defaults: { unmatched: "ask", ask_timeout_seconds: 120, on_timeout: "deny" },
  hard_deny: [
    { note: "destructive", tool: "*", command: ["*rm -rf*"] },
    { note: "secrets", tool: "*", params_contain: [".env", "id_rsa"] },
  ],
  allow: [
    { note: "safe git", tool: "exec*", command: ["git status", "git diff*"] },
    { note: "project reads", tool: "read*", path: ["D:/projects/**"] },
  ],
  ask: [{ note: "any exec", tool: "exec*" }],
};

const req = (tool: string, params: Record<string, unknown>): ActionRequest => ({
  id: "t1",
  agent: "test",
  tool,
  params,
  receivedAt: new Date().toISOString(),
});

test("allow-listed command flows", () => {
  assert.equal(evaluate(policy, req("exec_shell", { command: "git status" })).verdict, "allow");
  assert.equal(evaluate(policy, req("exec_shell", { command: "git diff --stat" })).verdict, "allow");
});

test("hard_deny beats allow", () => {
  const result = evaluate(policy, req("exec_shell", { command: "git status && rm -rf /" }));
  assert.equal(result.verdict, "deny");
  assert.equal(result.rule, "destructive");
});

test("secrets access is denied for any tool", () => {
  assert.equal(evaluate(policy, req("read_file", { path: "D:/projects/app/.env" })).verdict, "deny");
});

test("windows backslash paths match forward-slash globs", () => {
  assert.equal(evaluate(policy, req("read_file", { path: "D:\\projects\\app\\src\\main.ts" })).verdict, "allow");
});

test("unmatched actions fall through to ask, never allow", () => {
  assert.equal(evaluate(policy, req("browser_navigate", { url: "https://example.com" })).verdict, "ask");
  assert.equal(evaluate(policy, req("exec_shell", { command: "curl https://example.com" })).verdict, "ask");
});

test("command rules do not match requests without a command param", () => {
  assert.equal(evaluate(policy, req("exec_shell", {})).verdict, "ask");
});

test("audit log chain verifies and detects tampering", () => {
  const dir = mkdtempSync(join(tmpdir(), "clawguard-"));
  const file = join(dir, "audit.jsonl");

  const log = new AuditLog(file);
  log.append({ type: "a", n: 1 });
  log.append({ type: "b", n: 2 });
  log.append({ type: "c", n: 3 });
  assert.deepEqual(AuditLog.verify(file), { ok: true, entries: 3 });

  const lines = readFileSync(file, "utf8").trim().split("\n");
  const tampered = JSON.parse(lines[1]!);
  tampered.event.n = 999;
  lines[1] = JSON.stringify(tampered);
  writeFileSync(file, `${lines.join("\n")}\n`);

  const result = AuditLog.verify(file);
  assert.equal(result.ok, false);
  assert.equal(result.brokenAt, 2);
});

test("audit log resumes the chain across restarts", () => {
  const dir = mkdtempSync(join(tmpdir(), "clawguard-"));
  const file = join(dir, "audit.jsonl");

  new AuditLog(file).append({ type: "first" });
  new AuditLog(file).append({ type: "second" });
  assert.deepEqual(AuditLog.verify(file), { ok: true, entries: 2 });
});
