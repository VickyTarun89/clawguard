<p align="center">
  <img src="docs/assets/hero.png" alt="ClawGuard — the firewall for AI agents" width="100%" />
</p>

# 🛡️ ClawGuard

**The firewall for personal AI agents.** A default-deny action broker that sits between your agent (OpenClaw, Hermes, …) and your machine — with human approval over WhatsApp for anything risky, and a tamper-evident audit log of everything the agent did.

> OpenClaw shipped 138+ CVEs in its first months and its skill registry hosted 1,400+ confirmed malicious skills. Microsoft's guidance is to not run it on a personal machine at all. The agents aren't going away — the missing piece is the control layer. That's ClawGuard.

## How it works

<p align="center">
  <img src="docs/assets/architecture-flow.png" alt="Agent → ClawGuard policy gate → your machine" width="100%" />
</p>

1. A thin plugin inside the agent forwards every tool call to the ClawGuard daemon on `127.0.0.1`.
2. The policy engine evaluates it: `hard_deny` → blocked instantly, `allow` → flows, everything else → **asks a human** on WhatsApp (or the console) and auto-denies on timeout.
3. Every request and decision lands in an append-only, SHA-256 hash-chained audit log — edit one line and verification breaks.

Every action gets exactly one of three verdicts:

<p align="center">
  <img src="docs/assets/three-verdicts.png" alt="Allow, ask-a-human, or deny" width="100%" />
</p>

## Security model (the anti-OpenClaw)

- **Default-deny.** Unmatched actions can only `ask` or `deny` — the config format cannot express "allow by default".
- **Fail-closed.** Daemon unreachable? Tool call blocked. Timeout? Denied. No decision path ever ends in silent approval.
- **No inbound exposure.** The daemon binds loopback only; WhatsApp replies arrive via an outbound-polling relay, so your machine opens zero public ports.
- **Auth mandatory.** Every API call needs a bearer token; there is no "disable auth" flag.
- **Approver allowlist.** Only configured phone numbers can decide, and `hard_deny` actions can't be approved by anyone — including you at 2am.
- **Self-protection.** The example policy hard-denies the agent touching `policy.yaml` or ClawGuard itself.

## Quick start

```bash
npm install
copy policy.example.yaml policy.yaml   # then edit paths/commands for your machine
npm test
npm start                              # daemon on 127.0.0.1:4747, console approvals on
```

Wire up OpenClaw by installing the plugin in `integrations/openclaw/` and setting `CLAWGUARD_TOKEN`. For WhatsApp approvals set `WA_ACCESS_TOKEN`, `WA_PHONE_NUMBER_ID`, `WA_APPROVERS` (comma-separated E.164), and optionally `WA_RELAY_URL`.

Try it without an agent:

```bash
curl -s -X POST http://127.0.0.1:4747/v1/check \
  -H "Authorization: Bearer $CLAWGUARD_TOKEN" -H "Content-Type: application/json" \
  -d '{"agent":"demo","tool":"exec_shell","params":{"command":"curl https://evil.example"}}'
# → blocks, asks you, or allows — per your policy
```

## Status

`v0.1` — working core (policy engine, approval queue, audit chain, HTTP API, console + WhatsApp channels, OpenClaw plugin). Not yet independently audited; treat it as a second lock, not a vault. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the threat model and roadmap (pairing-code approver auth, universal LLM-proxy mode for any agent, Windows Sandbox execution tier).

## How attacks get stopped

A prompt-injected email or a malicious skill tells your agent to grab your secrets and send them off. The agent obeys — but the action still has to pass the gate, and key material is hard-denied for every tool:

<p align="center">
  <img src="docs/assets/prompt-injection.png" alt="A malicious message whispers to the agent; ClawGuard blocks the exfiltration" width="70%" />
</p>

MIT licensed. Built in public — follow along.
