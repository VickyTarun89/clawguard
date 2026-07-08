# ClawGuard WhatsApp Relay

A tiny Cloudflare Worker (free tier, $0) that receives Meta's WhatsApp webhook
and queues replies for the ClawGuard daemon to poll — so your machine never
opens an inbound port.

```
You reply "APPROVE <id>"  →  Meta Cloud API  →  this Worker (KV queue)
                                                      ↑ outbound poll only
                                            ClawGuard daemon on your machine
```

## 1. Deploy the Worker (~10 minutes)

Prereq: a free Cloudflare account.

```bash
cd relay
npx wrangler login                          # opens browser
npx wrangler kv namespace create MESSAGES   # copy the id it prints
# paste the id into wrangler.toml, then set the three secrets:
npx wrangler secret put VERIFY_TOKEN        # any random string, e.g. from: openssl rand -hex 16
npx wrangler secret put META_APP_SECRET     # from Meta app dashboard → App settings → Basic
npx wrangler secret put RELAY_TOKEN         # any random string; the daemon uses it to poll
npx wrangler deploy                         # prints your URL, e.g. https://clawguard-relay.<you>.workers.dev
```

## 2. Set up the Meta WhatsApp app (~15 minutes)

1. Go to [developers.facebook.com](https://developers.facebook.com) → **Create App** → type **Business**.
2. In the app dashboard, **Add product → WhatsApp**. You get a free **test phone number**, a **Phone number ID**, and a temporary **access token**.
3. Under **WhatsApp → API Setup**, add your personal number as a **recipient** (test numbers can message up to 5 verified recipients — plenty for personal use).
4. Under **WhatsApp → Configuration → Webhook**:
   - Callback URL: `https://<your-worker-url>/webhook`
   - Verify token: the `VERIFY_TOKEN` you set above
   - Click **Verify and save**, then **subscribe to the `messages` field**.
5. The temporary token expires in ~24h. For something durable, create a **System User** in Meta Business Settings and generate a permanent token with `whatsapp_business_messaging` permission.

## 3. Point ClawGuard at it

```bash
set WA_ACCESS_TOKEN=<token from step 2>
set WA_PHONE_NUMBER_ID=<phone number id from step 2>
set WA_APPROVERS=91XXXXXXXXXX          # your number, country code, no +
set WA_RELAY_URL=https://clawguard-relay.<you>.workers.dev
set WA_RELAY_TOKEN=<RELAY_TOKEN from step 1>
npm start
```

## 4. Open the messaging window, then test

WhatsApp rule: a business number can only send you free-form messages inside a
**24-hour window opened by you messaging it first**. So: **send "hi" to your
test number once**, then trigger something the policy asks about:

```bash
curl -s -X POST http://127.0.0.1:4747/v1/check \
  -H "Authorization: Bearer %CLAWGUARD_TOKEN%" -H "Content-Type: application/json" \
  -d "{\"agent\":\"demo\",\"tool\":\"exec_shell\",\"params\":{\"command\":\"curl https://example.com\"}}"
```

Your phone buzzes with the approval request. Reply `APPROVE <id>` or `DENY <id>`.
The blocked call resolves in your terminal. That's the loop.

## Security notes

- Webhook POSTs are HMAC-verified against your Meta App Secret — forged
  requests are rejected before anything is stored.
- `/messages` requires the `RELAY_TOKEN` bearer secret (timing-safe compare).
- The Worker stores only sender, text, and timestamp, and entries expire after
  1 hour. No message content is logged.
- Even a fully compromised relay can't approve anything by itself: the daemon
  still enforces the approver allowlist, and `hard_deny` rules can't be
  approved by anyone.

## Cost

Cloudflare Workers free tier: 100k requests/day (polling every 3s ≈ 29k/day).
KV free tier: comfortably within limits. Meta test number: free. Total: **$0**.
