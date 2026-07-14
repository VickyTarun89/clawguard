import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Broker } from "../broker.ts";

/**
 * Universal proxy mode (v0.3, experimental): an OpenAI-compatible reverse
 * proxy that gates tool calls for ANY agent, no plugin required.
 *
 * The agent points its LLM base URL at this proxy. Requests are forwarded to
 * the configured upstream with the agent's own Authorization header — the
 * proxy stores no provider keys. When the model's response contains
 * `tool_calls` (the actions the agent would execute next), each one is run
 * through the same broker as plugin traffic: hard_deny blocks, allow flows,
 * everything else asks a human. If ANY call is denied, the whole response is
 * rewritten to a plain assistant message explaining the block — the agent
 * never sees the instruction it must not execute (all-or-nothing, fail
 * closed).
 *
 * Honest limitations, on purpose:
 * - `stream: true` is served as a buffered replay: the upstream is called
 *   non-streaming, gated, then emitted as a short SSE stream. Correct, but
 *   the agent sees the reply arrive all at once.
 * - Only chat-completions tool calls are gated. Other endpoints pass through
 *   unmodified to the same upstream the agent could reach directly.
 */

const MAX_BODY_BYTES = 20 * 1024 * 1024; // agent conversations get large

export interface ProxyOptions {
  port: number;
  /** Upstream base URL, e.g. https://api.openai.com or http://127.0.0.1:11434 */
  upstream: string;
}

interface ToolCall {
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
}

interface Choice {
  index?: number;
  message?: { role?: string; content?: string | null; tool_calls?: ToolCall[] };
  finish_reason?: string | null;
}

interface Completion {
  id?: string;
  object?: string;
  created?: number;
  model?: string;
  choices?: Choice[];
  usage?: unknown;
}

/** function.arguments is a JSON string per the OpenAI spec; keep unparseable input visible to rules as {raw}. */
export function parseToolArguments(raw: string | undefined): Record<string, unknown> {
  if (raw === undefined || raw === "") return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return { value: parsed };
  } catch {
    return { raw };
  }
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new Error("body too large");
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

/** Forwardable request headers: drop hop-by-hop and length/encoding we recompute. */
function forwardHeaders(req: IncomingMessage): Record<string, string> {
  const skip = new Set(["host", "connection", "content-length", "transfer-encoding", "accept-encoding", "keep-alive"]);
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(req.headers)) {
    if (skip.has(key.toLowerCase()) || value === undefined) continue;
    out[key] = Array.isArray(value) ? value.join(", ") : value;
  }
  return out;
}

/**
 * Gate every tool call in the completion. Returns the completion to send to
 * the agent: unchanged when everything is allowed, rewritten to a blocked
 * notice when anything is denied.
 */
export async function gateCompletion(broker: Broker, agent: string, completion: Completion): Promise<Completion> {
  const denials: string[] = [];
  for (const choice of completion.choices ?? []) {
    for (const call of choice.message?.tool_calls ?? []) {
      const tool = call.function?.name ?? "unknown";
      // Sequential on purpose: parallel calls would buzz the approver N times at once.
      const decision = await broker.check({ agent, tool, params: parseToolArguments(call.function?.arguments) });
      if (decision.verdict !== "allow") denials.push(`${tool}: ${decision.reason}`);
    }
  }
  if (denials.length === 0) return completion;

  // All-or-nothing: one denied call blocks the whole response, so a partially
  // approved batch can't smuggle the denied action through agent retry logic.
  const notice =
    `ClawGuard blocked ${denials.length} tool call(s):\n` +
    denials.map((d) => `- ${d}`).join("\n") +
    `\nDo not retry the blocked action.`;
  return {
    ...completion,
    choices: (completion.choices ?? [{}]).map((choice, index) => ({
      index: choice.index ?? index,
      message: { role: "assistant", content: notice },
      finish_reason: "stop",
    })),
  };
}

/** Replay a gated (non-streamed) completion as a minimal SSE stream. */
function writeAsSse(res: ServerResponse, completion: Completion): void {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  const base = {
    id: completion.id ?? "clawguard-proxy",
    object: "chat.completion.chunk",
    created: completion.created ?? Math.floor(Date.now() / 1000),
    model: completion.model ?? "unknown",
  };
  const contentChunks = (completion.choices ?? []).map((choice, index) => {
    const delta: Record<string, unknown> = { role: choice.message?.role ?? "assistant" };
    if (choice.message?.content != null) delta.content = choice.message.content;
    if (choice.message?.tool_calls?.length) {
      delta.tool_calls = choice.message.tool_calls.map((call, i) => ({ index: i, ...call }));
    }
    return { index: choice.index ?? index, delta, finish_reason: null };
  });
  res.write(`data: ${JSON.stringify({ ...base, choices: contentChunks })}\n\n`);
  const finishChunks = (completion.choices ?? []).map((choice, index) => ({
    index: choice.index ?? index,
    delta: {},
    finish_reason: choice.finish_reason ?? "stop",
  }));
  res.write(`data: ${JSON.stringify({ ...base, choices: finishChunks, usage: completion.usage })}\n\n`);
  res.write("data: [DONE]\n\n");
  res.end();
}

export function startProxy(broker: Broker, opts: ProxyOptions): Server {
  const upstream = opts.upstream.replace(/\/+$/, "");

  const server = createServer(async (req, res) => {
    const fail = (code: number, message: string): void => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message, type: "clawguard_proxy" } }));
    };

    try {
      const url = `${upstream}${req.url ?? "/"}`;
      const body = await readBody(req);
      const isChat = (req.url ?? "").endsWith("/chat/completions") && req.method === "POST";

      if (!isChat) {
        // Transparent passthrough — same upstream the agent could reach directly.
        const upstreamRes = await fetch(url, {
          method: req.method,
          headers: forwardHeaders(req),
          body: body.length > 0 ? Uint8Array.from(body) : undefined,
        });
        res.writeHead(upstreamRes.status, { "content-type": upstreamRes.headers.get("content-type") ?? "application/json" });
        res.end(Buffer.from(await upstreamRes.arrayBuffer()));
        return;
      }

      let request: Record<string, unknown>;
      try {
        request = JSON.parse(body.toString("utf8")) as Record<string, unknown>;
      } catch {
        return fail(400, "request body is not valid JSON");
      }
      const wantsStream = request.stream === true;
      const agent = typeof req.headers["x-clawguard-agent"] === "string" ? req.headers["x-clawguard-agent"] : "llm-proxy";

      // Always call upstream non-streaming: tool calls can only be gated once
      // the response is complete. Streamed requests get a buffered SSE replay.
      const upstreamRes = await fetch(url, {
        method: "POST",
        headers: { ...forwardHeaders(req), "content-type": "application/json" },
        body: JSON.stringify({ ...request, stream: false }),
      });
      if (!upstreamRes.ok) {
        // Fail closed and visibly: relay the provider's error, never invent a success.
        res.writeHead(upstreamRes.status, { "content-type": upstreamRes.headers.get("content-type") ?? "application/json" });
        res.end(Buffer.from(await upstreamRes.arrayBuffer()));
        return;
      }

      const completion = (await upstreamRes.json()) as Completion;
      const gated = await gateCompletion(broker, agent, completion);

      if (wantsStream) return writeAsSse(res, gated);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(gated));
    } catch (err) {
      // Upstream unreachable or body too large: block the turn, never guess.
      fail(502, `ClawGuard proxy could not complete the request — failing closed (${(err as Error).message})`);
    }
  });

  // Loopback only — same rule as the main API.
  server.listen(opts.port, "127.0.0.1");
  return server;
}
