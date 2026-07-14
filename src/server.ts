import { createServer, type IncomingMessage, type Server } from "node:http";
import type { Broker } from "./broker.ts";
import { safeEqual } from "./util/safe-equal.ts";
import { renderApprovalsPage } from "./ui/page.ts";

const MAX_BODY_BYTES = 1024 * 1024;

// Loopback names only. Blocks DNS rebinding: a hostile site resolving its own
// domain to 127.0.0.1 sends its domain as Host and gets refused, so it can
// never read /ui (which embeds the token) or probe the API from a browser.
const LOOPBACK_HOST = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i;

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
      if (!LOOPBACK_HOST.test(req.headers.host ?? "")) {
        return send(403, { error: "forbidden host" });
      }
      const url = new URL(req.url ?? "/", "http://localhost");

      // The approval page needs no bearer: it is same-user trust, equivalent
      // to the token file it embeds (loopback bind + Host check above; see
      // src/ui/page.ts for the full reasoning).
      if (req.method === "GET" && url.pathname === "/ui") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        return void res.end(renderApprovalsPage(opts.token));
      }

      if (!safeEqual(req.headers.authorization ?? "", `Bearer ${opts.token}`)) {
        return send(401, { error: "unauthorized" });
      }

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
          ? broker.queue.decide(body.id as string, body.verdict as "allow" | "deny", String(body.approver ?? "api"), {
              always: body.always === true,
            })
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
