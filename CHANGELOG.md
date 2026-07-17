# Changelog

## Unreleased (v0.3-dev)

- **LLM proxy mode (experimental).** Set `CLAWGUARD_PROXY_UPSTREAM` and point
  any agent's base URL at `127.0.0.1:4750`: the proxy gates the tool calls in
  every model response through the same policy engine — no plugin required.
  Speaks both OpenAI chat-completions (`tool_calls`) and Anthropic Messages
  (`tool_use` blocks). One denied call blocks the whole response (fail
  closed); streamed requests are served as a buffered replay; the agent's own
  API key passes through and is never stored. A POST to any non-gated endpoint
  is refused rather than passed through, so a native-protocol agent can't
  route around the gate.

  Verified against a real model (Qwen3.5-9B on Ollama) with **no plugin
  installed**: a model tool call reaching for a `.env` file was hard-denied
  and stripped from the response; a benign `read_file` passed through intact.
  OpenClaw connects through the proxy (provider routes correctly), but driving
  a full multi-step agent turn needs a stronger tool-capable model than the
  local 9B — full agent-loop verification is still pending.
- **Approval web UI.** `http://127.0.0.1:<port>/ui` — pending approvals with
  live countdowns and Approve / Deny / Always-allow buttons, served straight
  from the daemon, zero dependencies. Verified end-to-end in a real browser.
  Same-user trust boundary as the token file; DNS rebinding blocked by
  Host-header validation, which now protects the whole API.

## v0.2.0 — 2026-07-12

Approver authentication + approval fatigue relief. The theme: make the human
approval un-fakeable, and make the firewall pleasant enough to keep running.

### Added
- **Single-use approval codes.** Every pending request gets a 6-character code
  (`YES K7M2QF` instead of typing a UUID). A code is a per-decision nonce: it
  dies with the decision, so replaying an old approval does nothing.
- **WhatsApp pairing PINs** (`WA_APPROVER_PINS`). A paired approver must quote
  their PIN in every reply — a spoofed or SIM-swapped sender number alone can
  no longer approve. Compared in constant time, never logged. Without PINs the
  daemon warns at startup and stays allowlist-only.
- **"Always allow this exact action."** Console `aa <code>`, Telegram 📌
  button, WhatsApp `ALWAYS <code> <pin>`. Exact-match only (SHA-256 over
  agent + tool + canonically-ordered params), consulted only when the policy
  verdict would be *ask* — a `hard_deny` can never be remembered around.
  Persisted to `data/remembered.json`; delete an entry to revoke. Every hit is
  audited as `decidedBy: "remembered"`.

### Fixed
- **Daemon restarts no longer strand a running agent.** The OpenClaw and
  Hermes plugins re-read `~/.clawguard/token` on a 401 and retry once, instead
  of caching the token forever at load.

### Hardening
- Remembered-rules store: write-then-rename persistence; a corrupt file is
  quarantined to `.corrupt` and the daemon starts with none (actions simply
  ask again) instead of failing to boot.
- Approver phone numbers are masked in console output.

Tests: 17 (9 new). All verdict paths, code-based approval, remembered-rule
persistence, timeout auto-deny, and the Hermes 401-retry were exercised
against a live daemon.

## v0.1.0 — 2026-07-07

Initial public release: default-deny policy engine (`hard_deny` > `allow` >
`ask`), fail-closed approval queue, SHA-256 hash-chained audit log,
loopback-only HTTP API, console + Telegram + WhatsApp channels, OpenClaw and
Hermes plugins with bypass detection. Verified end-to-end against OpenClaw
2026.6.11 on native Windows.
