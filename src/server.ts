import { createServer, type IncomingMessage, type Server } from "node:http";
import { timingSafeEqual } from "node:crypto";
import type { Broker } from "./broker.ts";

const MAX_BODY_BYTES = 1024 * 1024;

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new Error("body too large");
    chunks.push(chunk as Buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}

export function startServer(broker: Broker, opts: { port: number; token: string }): Server {
  const server = createServer(async (req, res) => {
    const send = (code: number, body: unknown): void => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };

    try {
      if (!safeEqual(req.headers.authorization ?? "", `Bearer ${opts.token}`)) {
        return send(401, { error: "unauthorized" });
      }
      const url = new URL(req.url ?? "/", "http://localhost");

      if (req.method === "GET" && url.pathname === "/v1/health") return send(200, { ok: true });

      if (req.method === "GET" && url.pathname === "/v1/pending") {
        return send(200, { pending: broker.queue.list() });
      }

      if (req.method === "POST" && url.pathname === "/v1/check") {
        const body = await readJson(req);
        if (typeof body.agent !== "string" || typeof body.tool !== "string") {
          return send(400, { error: "agent and tool are required strings" });
        }
        const decision = await broker.check({
          agent: body.agent,
          tool: body.tool,
          params: (body.params ?? {}) as Record<string, unknown>,
        });
        return send(200, decision);
      }

      if (req.method === "POST" && url.pathname === "/v1/events") {
        const body = await readJson(req);
        if (typeof body.agent !== "string" || typeof body.tool !== "string") {
          return send(400, { error: "agent and tool are required strings" });
        }
        broker.observe({
          agent: body.agent,
          tool: body.tool,
          params: (body.params ?? {}) as Record<string, unknown>,
          durationMs: typeof body.duration_ms === "number" ? body.duration_ms : undefined,
        });
        return send(200, { ok: true });
      }

      if (req.method === "POST" && url.pathname === "/v1/decisions") {
        const body = await readJson(req);
        const valid =
          typeof body.id === "string" && (body.verdict === "allow" || body.verdict === "deny");
        const ok = valid
          ? broker.queue.decide(body.id as string, body.verdict as "allow" | "deny", String(body.approver ?? "api"))
          : false;
        return send(ok ? 200 : 404, ok ? { ok: true } : { error: "no such pending approval" });
      }

      send(404, { error: "not found" });
    } catch {
      send(500, { error: "internal error" });
    }
  });

  // Loopback only — ClawGuard must never listen on an external interface.
  server.listen(opts.port, "127.0.0.1");
  return server;
}
