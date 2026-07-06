# ClawGuard Architecture

## Problem

Personal agents (OpenClaw, Hermes Agent) run with the user's full OS privileges and execute LLM-chosen tool calls. The 2026 OpenClaw record — 138+ CVEs, 1,400+ malicious registry skills, 40k+ exposed instances — shows the failure modes are architectural: auth off by default, skills inheriting full agent permissions, no boundary between "the model decided" and "the machine did". Vendors' answer ("run it on isolated hardware") abandons the actual use case. ClawGuard's answer: keep the agent, insert a control plane.

## Components

| Component | File | Role |
|---|---|---|
| Policy engine | `src/policy/engine.ts` | Pure evaluation: `hard_deny` > `allow` > `ask` > default (`ask`/`deny` only) |
| Broker | `src/broker.ts` | Orchestrates evaluate → (maybe) human approval → audit, returns verdict |
| Approval queue | `src/approval/queue.ts` | Pending decisions with TTL; timeout resolves to deny, never allow |
| Audit log | `src/audit/log.ts` | Append-only JSONL, each entry SHA-256-commits to the previous (tamper-evident) |
| HTTP API | `src/server.ts` | Loopback-only, bearer-token-only: `/v1/check`, `/v1/decisions`, `/v1/pending`, `/v1/health` |
| Console channel | `src/channels/console.ts` | Local stdin approvals for development |
| WhatsApp channel | `src/channels/whatsapp.ts` | Meta Cloud API outbound; inbound replies via outbound-polling relay |
| OpenClaw plugin | `integrations/openclaw/index.ts` | `before_tool_call` hook → `/v1/check`; blocks on anything but an explicit allow |
| Hermes plugin | `integrations/hermes/plugin.py` | `pre_tool_call` gate + `post_tool_call` execution reports to `/v1/events` for bypass detection (upstream hook can silently not fire: hermes-agent#44582) |

## Key decisions

**Interception at the agent's tool boundary, daemon out-of-process.** OpenClaw's typed hook `before_tool_call` supports blocking (`{ block: true }`) and parameter rewriting, so the in-agent footprint is ~50 lines. The policy brain lives in a separate process so (a) one ClawGuard governs many agents, (b) a compromised agent process can't rewrite policy in memory, (c) other agents integrate by hitting the same HTTP contract.

**Fail-closed everywhere.** Plugin can't reach the daemon → block. Non-200 → block. Approval timeout → deny. The type system enforces some of this: `defaults.unmatched` is `"ask" | "deny"` and `on_timeout` is `"deny"` — permissive defaults are unrepresentable, and the loader re-validates at runtime.

**WhatsApp as the human-in-the-loop, not an attack surface.** Inversion of the OpenClaw model (where the chat channel *drives* the agent). Here the channel only carries approval verdicts for already-summarized actions. Inbound uses a relay the daemon polls (Cloudflare Worker receiving the Cloud API webhook, queueing messages) — zero inbound ports on the user's machine. v0.1 authorization = sender allowlist; **known weakness:** WhatsApp sender identity is not proof of the human. v0.2 adds pairing codes (per-approver secret established out-of-band, quoted in each verdict) and per-decision nonces.

**Tamper-evident, not tamper-proof, audit.** Hash-chained JSONL detects modification but a root-privileged attacker can truncate-and-rebuild. Mitigation path: periodic chain-head checkpoints published off-machine (e.g., to the relay). Good enough for v0.1's honest claim: "you can trust the log wasn't quietly edited."

## Threat model (v0.1)

| Threat | Covered? | How |
|---|---|---|
| Prompt-injected agent runs destructive command | ✅ | `hard_deny` / `ask` gates execution before it happens |
| Malicious skill exfiltrates `.env` / SSH keys | ✅ | `params_contain` hard-deny on key material for *all* tools |
| Agent modifies its own guardrails | ✅ | Policy hard-denies touching `policy.yaml` / ClawGuard files |
| Attacker on LAN hits the daemon API | ✅ | Loopback bind + mandatory bearer token |
| Spoofed WhatsApp approval | ⚠️ | Sender allowlist only — pairing codes in v0.2 |
| Compromised OS user account | ❌ | Out of scope until the sandbox tier — ClawGuard runs as the same user |
| Agent bypasses the plugin entirely (raw syscalls) | ❌ | Requires OS-level enforcement — v0.4 sandbox tier |

The last two rows are why the roadmap ends at OS isolation: a policy broker inside the same trust boundary is a strong second lock, not a vault. We say so publicly; overclaiming is how OpenClaw got here.

## Roadmap

- **v0.2 — Approver authentication.** Pairing codes + per-decision nonces; "always allow this exact action" persisted rules; audit chain-head checkpointing to the relay.
- **v0.3 — Universal proxy mode.** An LLM-API proxy (Anthropic/OpenAI-compatible) that holds `tool_use` responses until approved — covers Hermes and any agent, no plugin needed.
- **v0.4 — Windows execution tier.** Route `ask`-class shell/file actions into Windows Sandbox / Hyper-V isolation instead of the host; macOS (Apple containers) next. This is the underserved flank — the ecosystem is Mac/Linux-first.
- **v0.5 — Skill scanner.** Static + LLM review of ClawHub/Hermes skills pre-install, flagging exfiltration and persistence patterns.

## Monetization (open-core)

Free: single agent, console + WhatsApp, local audit. Pro ($10/mo, first 30 days free): multi-agent/multi-device, skill scanning, off-machine audit checkpoints, retention. Team ($50+/seat): shared policies, central audit, SSO — sold to the security lead who currently says "no agents on work machines".
