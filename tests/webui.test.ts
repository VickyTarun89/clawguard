import test from "node:test";
import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import { once } from "node:events";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { startServer } from "../src/server.ts";
import { Broker } from "../src/broker.ts";
import { ApprovalQueue } from "../src/approval/queue.ts";
import { AuditLog } from "../src/audit/log.ts";
import { RememberedStore } from "../src/remember.ts";
import type { Policy } from "../src/types.ts";

const tmpFile = (name: string): string => join(mkdtempSync(join(tmpdir(), "clawguard-")), name);

const policy: Policy = {
  version: 1,
  defaults: { unmatched: "ask", ask_timeout_seconds: 5, on_timeout: "deny" },
  hard_deny: [],
  allow: [],
  ask: [],
};

const TOKEN = "test-token";

async function setup(): Promise<{ base: string; port: number; queue: ApprovalQueue; close: () => void }> {
  const queue = new ApprovalQueue();
  const broker = new Broker(policy, queue, new AuditLog(tmpFile("audit.jsonl")), new RememberedStore(tmpFile("remembered.json")));
  const server = startServer(broker, { port: 0, token: TOKEN });
  await once(server, "listening");
  const port = (server.address() as AddressInfo).port;
  return { base: `http://127.0.0.1:${port}`, port, queue, close: () => server.close() };
}

test("GET /ui serves the approval page without a bearer token", async () => {
  const { base, close } = await setup();
  try {
    const res = await fetch(`${base}/ui`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /text\/html/);
    const html = await res.text();
    assert.match(html, /ClawGuard/);
    assert.match(html, /Always allow this exact action/);
  } finally {
    close();
  }
});

test("a foreign Host header is refused everywhere (DNS-rebinding defense)", async () => {
  const { port, close } = await setup();
  try {
    // node:http lets us forge the Host header the way a rebinding browser would.
    const status = await new Promise<number>((resolve, reject) => {
      const req = httpRequest(
        { host: "127.0.0.1", port, path: "/ui", headers: { host: "evil.example.com" } },
        (res) => resolve(res.statusCode ?? 0),
      );
      req.on("error", reject);
      req.end();
    });
    assert.equal(status, 403);
  } finally {
    close();
  }
});

test("API still requires the bearer even though /ui does not", async () => {
  const { base, close } = await setup();
  try {
    assert.equal((await fetch(`${base}/v1/pending`)).status, 401);
    const authed = await fetch(`${base}/v1/pending`, { headers: { authorization: `Bearer ${TOKEN}` } });
    assert.equal(authed.status, 200);
  } finally {
    close();
  }
});

test("full web-ui flow: check → pending → decide always → allowed and remembered", async () => {
  const { base, close } = await setup();
  try {
    const headers = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };
    const checkPromise = fetch(`${base}/v1/check`, {
      method: "POST",
      headers,
      body: JSON.stringify({ agent: "web-test", tool: "write_file", params: { path: "t.txt" } }),
    });
    await new Promise((r) => setTimeout(r, 200)); // let the ask enqueue
    const pending = ((await (await fetch(`${base}/v1/pending`, { headers })).json()) as { pending: { request: { id: string } }[] }).pending;
    assert.equal(pending.length, 1);

    const decide = await fetch(`${base}/v1/decisions`, {
      method: "POST",
      headers,
      body: JSON.stringify({ id: pending[0]!.request.id, verdict: "allow", always: true, approver: "web-ui" }),
    });
    assert.equal(decide.status, 200);

    const decision = (await (await checkPromise).json()) as { verdict: string; decidedBy: string; approver: string };
    assert.equal(decision.verdict, "allow");
    assert.equal(decision.approver, "web-ui");

    // Identical action now auto-allows via the remembered rule.
    const again = (await (
      await fetch(`${base}/v1/check`, {
        method: "POST",
        headers,
        body: JSON.stringify({ agent: "web-test", tool: "write_file", params: { path: "t.txt" } }),
      })
    ).json()) as { decidedBy: string };
    assert.equal(again.decidedBy, "remembered");
  } finally {
    close();
  }
});
