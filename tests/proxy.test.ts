import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { startProxy, parseToolArguments } from "../src/proxy/server.ts";
import { Broker } from "../src/broker.ts";
import { ApprovalQueue } from "../src/approval/queue.ts";
import { AuditLog } from "../src/audit/log.ts";
import { RememberedStore } from "../src/remember.ts";
import type { Policy } from "../src/types.ts";

const tmpFile = (name: string): string => join(mkdtempSync(join(tmpdir(), "clawguard-")), name);

const policy: Policy = {
  version: 1,
  defaults: { unmatched: "ask", ask_timeout_seconds: 1, on_timeout: "deny" },
  hard_deny: [{ note: "secrets", tool: "*", params_contain: [".env"] }],
  allow: [{ note: "reads", tool: "read*" }],
  ask: [],
};

const completionWith = (toolCalls: unknown[] | undefined, content: string | null = null) => ({
  id: "cmpl-1",
  object: "chat.completion",
  created: 1700000000,
  model: "fake-model",
  choices: [
    {
      index: 0,
      message: { role: "assistant", content, ...(toolCalls ? { tool_calls: toolCalls } : {}) },
      finish_reason: toolCalls ? "tool_calls" : "stop",
    },
  ],
  usage: { total_tokens: 42 },
});

/** Fake upstream that returns whatever `nextResponse` holds and records requests. */
function makeUpstream(): {
  server: Server;
  seen: { path: string; auth?: string; body?: Record<string, unknown> }[];
  setNext: (body: unknown) => void;
} {
  let next: unknown = completionWith(undefined, "hi");
  const seen: { path: string; auth?: string; body?: Record<string, unknown> }[] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString("utf8");
    seen.push({
      path: req.url ?? "",
      auth: req.headers.authorization,
      body: raw ? (JSON.parse(raw) as Record<string, unknown>) : undefined,
    });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(next));
  });
  return { server, seen, setNext: (body) => (next = body) };
}

async function setup(): Promise<{
  proxyUrl: string;
  upstream: ReturnType<typeof makeUpstream>;
  queue: ApprovalQueue;
  close: () => void;
}> {
  const upstream = makeUpstream();
  upstream.server.listen(0, "127.0.0.1");
  await once(upstream.server, "listening");
  const upstreamPort = (upstream.server.address() as AddressInfo).port;

  const queue = new ApprovalQueue();
  const broker = new Broker(policy, queue, new AuditLog(tmpFile("audit.jsonl")), new RememberedStore(tmpFile("remembered.json")));
  const proxy = startProxy(broker, { port: 0, upstream: `http://127.0.0.1:${upstreamPort}` });
  await once(proxy, "listening");
  const proxyPort = (proxy.address() as AddressInfo).port;

  return {
    proxyUrl: `http://127.0.0.1:${proxyPort}`,
    upstream,
    queue,
    close: () => {
      proxy.close();
      upstream.server.close();
    },
  };
}

const chat = (proxyUrl: string, body: Record<string, unknown>) =>
  fetch(`${proxyUrl}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer agent-key" },
    body: JSON.stringify(body),
  });

test("allowed tool calls pass through unchanged, with the agent's own auth forwarded", async () => {
  const { proxyUrl, upstream, close } = await setup();
  try {
    upstream.setNext(
      completionWith([{ id: "c1", type: "function", function: { name: "read_file", arguments: '{"path":"a.txt"}' } }]),
    );
    const res = await chat(proxyUrl, { model: "fake-model", messages: [] });
    const body = (await res.json()) as { choices: { message: { tool_calls?: unknown[] }; finish_reason: string }[] };
    assert.equal(res.status, 200);
    assert.equal(body.choices[0]!.finish_reason, "tool_calls");
    assert.equal(body.choices[0]!.message.tool_calls?.length, 1);
    assert.equal(upstream.seen[0]!.auth, "Bearer agent-key");
  } finally {
    close();
  }
});

test("a hard-denied tool call rewrites the whole response to a blocked notice", async () => {
  const { proxyUrl, upstream, close } = await setup();
  try {
    upstream.setNext(
      completionWith([
        { id: "c1", type: "function", function: { name: "read_file", arguments: '{"path":"ok.txt"}' } },
        { id: "c2", type: "function", function: { name: "read_file", arguments: '{"path":"app/.env"}' } },
      ]),
    );
    const res = await chat(proxyUrl, { model: "fake-model", messages: [] });
    const body = (await res.json()) as { choices: { message: { content: string; tool_calls?: unknown[] }; finish_reason: string }[] };
    assert.equal(body.choices[0]!.finish_reason, "stop");
    assert.equal(body.choices[0]!.message.tool_calls, undefined, "denied batch must carry no tool calls");
    assert.match(body.choices[0]!.message.content, /ClawGuard blocked 1 tool call/);
  } finally {
    close();
  }
});

test("an unmatched tool call asks and times out to a blocked notice (fail closed)", async () => {
  const { proxyUrl, upstream, close } = await setup();
  try {
    upstream.setNext(
      completionWith([{ id: "c1", type: "function", function: { name: "exec_shell", arguments: '{"command":"curl x"}' } }]),
    );
    const res = await chat(proxyUrl, { model: "fake-model", messages: [] });
    const body = (await res.json()) as { choices: { message: { content: string } }[] };
    assert.match(body.choices[0]!.message.content, /ClawGuard blocked/);
    assert.match(body.choices[0]!.message.content, /failing closed/);
  } finally {
    close();
  }
});

test("stream:true is served as a buffered SSE replay ending in [DONE]", async () => {
  const { proxyUrl, upstream, close } = await setup();
  try {
    upstream.setNext(completionWith(undefined, "hello there"));
    const res = await chat(proxyUrl, { model: "fake-model", messages: [], stream: true });
    assert.match(res.headers.get("content-type") ?? "", /text\/event-stream/);
    const text = await res.text();
    assert.match(text, /"content":"hello there"/);
    assert.match(text, /data: \[DONE\]/);
    // Upstream must have been called non-streaming so the gate sees whole responses.
    assert.equal(upstream.seen[0]!.body!.stream, false);
  } finally {
    close();
  }
});

test("non-chat endpoints pass through; unreachable upstream fails closed with 502", async () => {
  const { proxyUrl, upstream, close } = await setup();
  try {
    upstream.setNext({ data: [{ id: "fake-model" }] });
    const models = await fetch(`${proxyUrl}/v1/models`);
    assert.equal(models.status, 200);
    assert.match(await models.text(), /fake-model/);

    upstream.server.close();
    await once(upstream.server, "close");
    const res = await chat(proxyUrl, { model: "fake-model", messages: [] });
    assert.equal(res.status, 502);
    assert.match(await res.text(), /failing closed/);
  } finally {
    close();
  }
});

const anthropicMessageWith = (blocks: unknown[]) => ({
  id: "msg-1",
  type: "message",
  role: "assistant",
  model: "fake-claude",
  content: blocks,
  stop_reason: "tool_use",
  usage: { input_tokens: 10, output_tokens: 5 },
});

test("anthropic: allowed tool_use passes through, denied rewrites to a text notice", async () => {
  const { proxyUrl, upstream, close } = await setup();
  try {
    upstream.setNext(anthropicMessageWith([{ type: "tool_use", id: "t1", name: "read_file", input: { path: "ok.txt" } }]));
    const ok = await fetch(`${proxyUrl}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": "agent-key" },
      body: JSON.stringify({ model: "fake-claude", messages: [] }),
    });
    const okBody = (await ok.json()) as { content: { type: string }[]; stop_reason: string };
    assert.equal(okBody.stop_reason, "tool_use");
    assert.equal(okBody.content[0]!.type, "tool_use");

    upstream.setNext(anthropicMessageWith([{ type: "tool_use", id: "t2", name: "read_file", input: { path: "app/.env" } }]));
    const denied = await fetch(`${proxyUrl}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "fake-claude", messages: [] }),
    });
    const deniedBody = (await denied.json()) as { content: { type: string; text?: string }[]; stop_reason: string };
    assert.equal(deniedBody.stop_reason, "end_turn");
    assert.equal(deniedBody.content.length, 1);
    assert.match(deniedBody.content[0]!.text ?? "", /ClawGuard blocked 1 tool call/);
  } finally {
    close();
  }
});

test("anthropic: stream:true replays the SSE event sequence with input_json_delta", async () => {
  const { proxyUrl, upstream, close } = await setup();
  try {
    upstream.setNext(
      anthropicMessageWith([
        { type: "text", text: "let me check" },
        { type: "tool_use", id: "t1", name: "read_file", input: { path: "ok.txt" } },
      ]),
    );
    const res = await fetch(`${proxyUrl}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "fake-claude", messages: [], stream: true }),
    });
    assert.match(res.headers.get("content-type") ?? "", /text\/event-stream/);
    const text = await res.text();
    for (const event of ["message_start", "content_block_start", "input_json_delta", "message_delta", "message_stop"]) {
      assert.match(text, new RegExp(event), `missing ${event}`);
    }
    assert.equal(upstream.seen[0]!.body!.stream, false, "upstream must be called non-streaming");
  } finally {
    close();
  }
});

test("tool argument parsing survives malformed and non-object JSON", () => {
  assert.deepEqual(parseToolArguments('{"a":1}'), { a: 1 });
  assert.deepEqual(parseToolArguments("not json"), { raw: "not json" });
  assert.deepEqual(parseToolArguments("[1,2]"), { value: [1, 2] });
  assert.deepEqual(parseToolArguments(undefined), {});
  assert.deepEqual(parseToolArguments(""), {});
});
