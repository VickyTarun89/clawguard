import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuditLog } from "../src/audit/log.ts";
import { readHistory } from "../src/audit/history.ts";

const tmpFile = (): string => join(mkdtempSync(join(tmpdir(), "clawguard-")), "audit.jsonl");

/** Writes the same event shapes the broker does. */
function seed(file: string): AuditLog {
  const log = new AuditLog(file);
  log.append({ type: "gateway.started", policyPath: "policy.yaml", port: 4747 });

  log.append({
    type: "action.requested",
    request: { id: "r1", agent: "openclaw", tool: "read", params: { path: "notes.txt" }, receivedAt: "" },
    evaluation: { verdict: "allow", reason: "matched allow rule", rule: "project reads" },
  });
  log.append({
    type: "action.decided",
    requestId: "r1",
    decision: { verdict: "allow", reason: "matched allow rule", decidedBy: "policy" },
  });

  log.append({
    type: "action.requested",
    request: { id: "r2", agent: "openclaw", tool: "read", params: { path: "secrets.env" }, receivedAt: "" },
    evaluation: { verdict: "deny", reason: "matched hard_deny rule", rule: "secrets" },
  });
  log.append({
    type: "action.decided",
    requestId: "r2",
    decision: { verdict: "deny", reason: "matched hard_deny rule", decidedBy: "policy" },
  });

  log.append({
    type: "action.requested",
    request: { id: "r3", agent: "openclaw", tool: "write", params: { path: "t.txt" }, receivedAt: "" },
    evaluation: { verdict: "ask", reason: "matched ask rule" },
  });
  log.append({
    type: "action.decided",
    requestId: "r3",
    decision: { verdict: "deny", reason: "decided by telegram:1", decidedBy: "human", approver: "telegram:1" },
  });
  return log;
}

test("history joins each request with its decision into one row", () => {
  const file = tmpFile();
  seed(file);
  const h = readHistory(file);

  // 3 gated actions + 1 gateway.started — decisions folded in, not listed separately.
  assert.equal(h.total, 4);
  const gated = h.rows.filter((r) => r.kind === "gated");
  assert.equal(gated.length, 3);

  const byTool = (path: string) => gated.find((r) => (r.params as { path?: string })?.path === path);
  assert.equal(byTool("notes.txt")?.verdict, "allow");
  assert.equal(byTool("notes.txt")?.decidedBy, "policy");
  assert.equal(byTool("secrets.env")?.verdict, "deny");
  assert.equal(byTool("secrets.env")?.rule, "secrets");
  assert.equal(byTool("t.txt")?.evaluated, "ask", "keeps what the policy said before asking");
  assert.equal(byTool("t.txt")?.verdict, "deny");
  assert.equal(byTool("t.txt")?.decidedBy, "human");
  assert.equal(byTool("t.txt")?.approver, "telegram:1");
});

test("history is newest-first and honours the limit", () => {
  const file = tmpFile();
  const log = seed(file);
  for (let i = 0; i < 20; i++) {
    log.append({
      type: "action.requested",
      request: { id: `x${i}`, agent: "a", tool: "read", params: { path: `f${i}.txt` }, receivedAt: "" },
      evaluation: { verdict: "allow", reason: "ok" },
    });
  }
  const h = readHistory(file, 5);
  assert.equal(h.rows.length, 5);
  assert.equal(h.total, 24);
  assert.equal((h.rows[0]!.params as { path: string }).path, "f19.txt", "newest first");
  assert.ok(h.rows[0]!.seq > h.rows[4]!.seq);
});

test("a pending action shows with no verdict yet", () => {
  const file = tmpFile();
  const log = new AuditLog(file);
  log.append({
    type: "action.requested",
    request: { id: "p1", agent: "a", tool: "write", params: {}, receivedAt: "" },
    evaluation: { verdict: "ask", reason: "matched ask rule" },
  });
  const row = readHistory(file).rows[0]!;
  assert.equal(row.evaluated, "ask");
  assert.equal(row.verdict, undefined);
});

test("history surfaces observed calls and remembered rules", () => {
  const file = tmpFile();
  const log = new AuditLog(file);
  log.append({ type: "action.observed", agent: "openclaw", tool: "read", params: { path: "a.txt" }, durationMs: 12 });
  log.append({ type: "rule.remembered", key: "abc", agent: "openclaw", tool: "write", params: {}, approver: "console" });
  const kinds = readHistory(file).rows.map((r) => r.kind);
  assert.ok(kinds.includes("observed"));
  assert.ok(kinds.includes("remembered"));
});

test("history reports a broken chain instead of hiding it", () => {
  const file = tmpFile();
  seed(file);
  assert.equal(readHistory(file).chain.ok, true);

  const lines = readFileSync(file, "utf8").trim().split("\n");
  const tampered = JSON.parse(lines[3]!) as { event: { request: { params: { path: string } } } };
  tampered.event.request.params.path = "innocent.txt"; // hide the secrets read
  lines[3] = JSON.stringify(tampered);
  writeFileSync(file, `${lines.join("\n")}\n`);

  const h = readHistory(file);
  assert.equal(h.chain.ok, false, "editing a past entry must be visible in the view");
  assert.ok(typeof h.chain.brokenAt === "number");
});

test("a missing log reads as empty, not an error", () => {
  const h = readHistory(join(mkdtempSync(join(tmpdir(), "clawguard-")), "nope.jsonl"));
  assert.deepEqual(h.rows, []);
  assert.equal(h.total, 0);
  assert.equal(h.chain.ok, true);
});
