/**
 * ClawGuard WhatsApp relay — Cloudflare Worker (free tier).
 *
 * Meta's Cloud API needs a public webhook URL, and ClawGuard refuses to open
 * inbound ports on your machine. This Worker is the middle piece:
 *
 *   WhatsApp reply -> Meta webhook -> this Worker (verifies + queues in KV)
 *   ClawGuard daemon --outbound poll--> GET /messages?since=<ts>
 *
 * Security properties:
 * - Webhook POSTs are verified against Meta's X-Hub-Signature-256 (HMAC of the
 *   raw body with your App Secret). Unsigned/forged posts are rejected.
 * - GET /messages requires the RELAY_TOKEN bearer secret (timing-safe compare).
 * - Only sender, text body, and timestamp are stored - nothing else - and
 *   entries expire from KV after one hour.
 *
 * Secrets (set via `wrangler secret put <NAME>`):
 *   VERIFY_TOKEN     - any random string; also entered in Meta's webhook config
 *   META_APP_SECRET  - Meta app secret, for webhook signature verification
 *   RELAY_TOKEN      - shared bearer token the ClawGuard daemon polls with
 */

const MESSAGE_TTL_SECONDS = 3600;

const json = (status, body) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

function timingSafeEqual(a, b) {
  const ea = new TextEncoder().encode(a);
  const eb = new TextEncoder().encode(b);
  if (ea.length !== eb.length) return false;
  let diff = 0;
  for (let i = 0; i < ea.length; i++) diff |= ea[i] ^ eb[i];
  return diff === 0;
}

async function hmacHex(secret, body) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Meta webhook verification handshake (GET /webhook). */
function handleVerify(url, env) {
  const mode = url.searchParams.get("hub.mode");
  const token = url.searchParams.get("hub.verify_token");
  const challenge = url.searchParams.get("hub.challenge");
  if (mode === "subscribe" && token && timingSafeEqual(token, env.VERIFY_TOKEN)) {
    return new Response(challenge ?? "", { status: 200 });
  }
  return json(403, { error: "verification failed" });
}

/** Inbound WhatsApp events (POST /webhook). */
async function handleInbound(request, env) {
  const raw = await request.text();

  const signature = request.headers.get("x-hub-signature-256") ?? "";
  const expected = "sha256=" + (await hmacHex(env.META_APP_SECRET, raw));
  if (!timingSafeEqual(signature, expected)) {
    return json(401, { error: "bad signature" });
  }

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    return json(400, { error: "bad json" });
  }

  const writes = [];
  for (const entry of payload.entry ?? []) {
    for (const change of entry.changes ?? []) {
      for (const msg of change.value?.messages ?? []) {
        if (msg.type !== "text" || typeof msg.text?.body !== "string") continue;
        const ts = Number(msg.timestamp) * 1000 || Date.now();
        const key = `msg:${String(ts).padStart(15, "0")}:${crypto.randomUUID().slice(0, 8)}`;
        writes.push(
          env.MESSAGES.put(key, JSON.stringify({ from: msg.from, body: msg.text.body, ts }), {
            expirationTtl: MESSAGE_TTL_SECONDS,
          }),
        );
      }
    }
  }
  await Promise.all(writes);
  return json(200, { ok: true });
}

/** Daemon poll (GET /messages?since=<ms>). */
async function handlePoll(request, url, env) {
  const auth = request.headers.get("authorization") ?? "";
  if (!timingSafeEqual(auth, `Bearer ${env.RELAY_TOKEN}`)) {
    return json(401, { error: "unauthorized" });
  }

  const since = Number(url.searchParams.get("since") ?? 0);
  const list = await env.MESSAGES.list({ prefix: "msg:" });
  const messages = [];
  for (const { name } of list.keys) {
    const ts = Number(name.split(":")[1]);
    if (!Number.isFinite(ts) || ts <= since) continue;
    const value = await env.MESSAGES.get(name);
    if (value) messages.push(JSON.parse(value));
  }
  messages.sort((a, b) => a.ts - b.ts);
  return json(200, messages);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/webhook" && request.method === "GET") return handleVerify(url, env);
    if (url.pathname === "/webhook" && request.method === "POST") return handleInbound(request, env);
    if (url.pathname === "/messages" && request.method === "GET") return handlePoll(request, url, env);
    return json(404, { error: "not found" });
  },
};
