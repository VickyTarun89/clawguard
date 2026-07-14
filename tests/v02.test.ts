import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApprovalQueue } from "../src/approval/queue.ts";
import { RememberedStore, actionKey, canonicalJson } from "../src/remember.ts";
import { Broker } from "../src/broker.ts";
import { AuditLog } from "../src/audit/log.ts";
import { DECISION_RE, authorizeApprover } from "../src/channels/whatsapp.ts";
import type { PendingEvent, Policy } from "../src/types.ts";

const tmpFile = (name: string): string => join(mkdtempSync(join(tmpdir(), "clawguard-")), name);

// --- approval codes (per-decision nonces) ---

test("pending events carry a short code and decide-by-code works", async () => {
  const queue = new ApprovalQueue();
  const pending = new Promise<PendingEvent>((resolve) => queue.once("pending", resolve));
  const decision = queue.ask(
    { id: "req-1", agent: "t", tool: "x", params: {}, receivedAt: "" },
    "summary",
    5000,
  );
  const event = await pending;
  assert.match(event.code, /^[A-HJ-NP-Z2-9]{6}$/);
  assert.equal(queue.decide(event.code.toLowerCase(), "allow", "tester"), true);
  assert.equal((await decision).verdict, "allow");
});

test("a code is single-use: dead after the decision and after timeout", async () => {
  const queue = new ApprovalQueue();
  let event: PendingEvent | undefined;
  queue.once("pending", (e: PendingEvent) => (event = e));
  const first = queue.ask({ id: "req-1", agent: "t", tool: "x", params: {}, receivedAt: "" }, "s", 50);
  const code = event!.code;
  const timedOut = await first; // nobody answers
  assert.equal(timedOut.verdict, "deny");
  assert.equal(timedOut.decidedBy, "timeout");
  assert.equal(queue.decide(code, "allow", "tester"), false, "code must die with its decision");
});

test("'always' can only widen an allow — an always-deny is not remembered", async () => {
  const queue = new ApprovalQueue();
  let event: PendingEvent | undefined;
  queue.once("pending", (e: PendingEvent) => (event = e));
  const decision = queue.ask({ id: "r", agent: "t", tool: "x", params: {}, receivedAt: "" }, "s", 5000);
  queue.decide(event!.code, "deny", "tester", { always: true });
  const decided = await decision;
  assert.equal(decided.verdict, "deny");
  assert.notEqual(decided.remember, true);
});

// --- remembered exact-action rules ---

test("canonical hashing is stable under param key order", () => {
  const a = actionKey({ agent: "x", tool: "write", params: { path: "a.txt", content: "hi", opts: { m: 1, n: 2 } } });
  const b = actionKey({ agent: "x", tool: "write", params: { opts: { n: 2, m: 1 }, content: "hi", path: "a.txt" } });
  assert.equal(a, b);
  assert.equal(canonicalJson({ b: 1, a: [{ d: 2, c: 3 }] }), '{"a":[{"c":3,"d":2}],"b":1}');
});

test("remembered store: exact match only, persists across restarts", () => {
  const file = tmpFile("remembered.json");
  const store = new RememberedStore(file);
  store.add({ agent: "openclaw", tool: "write", params: { path: "t.txt", content: "hello" } }, "tester");

  const reloaded = new RememberedStore(file);
  assert.ok(reloaded.find({ agent: "openclaw", tool: "write", params: { content: "hello", path: "t.txt" } }));
  assert.equal(
    reloaded.find({ agent: "openclaw", tool: "write", params: { path: "t.txt", content: "hello!" } }),
    undefined,
    "different params must still ask",
  );
});

const policy: Policy = {
  version: 1,
  defaults: { unmatched: "ask", ask_timeout_seconds: 1, on_timeout: "deny" },
  hard_deny: [{ note: "secrets", tool: "*", params_contain: [".env"] }],
  allow: [],
  ask: [],
};

const makeBroker = (): { broker: Broker; queue: ApprovalQueue; store: RememberedStore } => {
  const queue = new ApprovalQueue();
  const store = new RememberedStore(tmpFile("remembered.json"));
  const broker = new Broker(policy, queue, new AuditLog(tmpFile("audit.jsonl")), store);
  return { broker, queue, store };
};

test("human 'always allow' persists the rule and the next identical action auto-allows", async () => {
  const { broker, queue } = makeBroker();
  queue.once("pending", (e: PendingEvent) => queue.decide(e.code, "allow", "tester", { always: true }));
  const first = await broker.check({ agent: "a", tool: "write", params: { path: "t.txt" } });
  assert.equal(first.verdict, "allow");
  assert.equal(first.decidedBy, "human");

  // Same exact action again: no pending event, decided by the remembered rule.
  queue.once("pending", () => assert.fail("must not ask again for a remembered exact action"));
  const second = await broker.check({ agent: "a", tool: "write", params: { path: "t.txt" } });
  assert.equal(second.verdict, "allow");
  assert.equal(second.decidedBy, "remembered");

  // A near-identical action (different params) asks again — and times out to deny.
  queue.removeAllListeners("pending");
  const third = await broker.check({ agent: "a", tool: "write", params: { path: "other.txt" } });
  assert.equal(third.verdict, "deny");
  assert.equal(third.decidedBy, "timeout");
});

test("a remembered rule can never override hard_deny", async () => {
  const { broker, store } = makeBroker();
  const params = { path: "app/.env" };
  store.add({ agent: "a", tool: "read", params }, "tester"); // even if it somehow got remembered
  const decision = await broker.check({ agent: "a", tool: "read", params });
  assert.equal(decision.verdict, "deny");
  assert.equal(decision.decidedBy, "policy");
});

// --- WhatsApp approver auth ---

test("whatsapp reply parsing accepts YES/NO/ALWAYS with optional PIN", () => {
  assert.deepEqual("YES K7M2QF".match(DECISION_RE)?.slice(1), ["YES", "K7M2QF", undefined]);
  assert.deepEqual("always k7m2qf 4832".match(DECISION_RE)?.slice(1), ["always", "k7m2qf", "4832"]);
  assert.equal("YES".match(DECISION_RE), null);
  assert.equal("sounds good".match(DECISION_RE), null);
});

test("pairing PINs: paired approvers must quote the right PIN", () => {
  const approvers = ["+911234567890", "+919876543210"];
  const pins = { "+911234567890": "4832" };
  assert.equal(authorizeApprover(approvers, pins, "+911234567890", "4832"), "ok");
  assert.equal(authorizeApprover(approvers, pins, "+911234567890", "0000"), "wrong-pin");
  assert.equal(authorizeApprover(approvers, pins, "+911234567890", undefined), "missing-pin");
  assert.equal(authorizeApprover(approvers, pins, "+919876543210", undefined), "ok", "unpaired → allowlist-only");
  assert.equal(authorizeApprover(approvers, pins, "+910000000000", "4832"), "not-approver");
});
