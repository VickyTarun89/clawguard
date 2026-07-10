# Security Policy

ClawGuard is a security tool, so we hold ourselves to the standard we ask of
the agents we gate: state the limits plainly, and never claim more than what
has been tested.

## Reporting a vulnerability

**Please do not open a public issue for security bugs.**

Report privately via GitHub's [Report a vulnerability](https://github.com/VickyTarun89/clawguard/security/advisories/new)
form (Security → Advisories). Include what you did, what happened, and what you
expected. A proof of concept helps.

Expect an acknowledgement within 72 hours and an assessment within 7 days. We
will credit you in the advisory unless you'd rather stay anonymous. There is no
bug bounty — this is an unfunded open-source project.

## Supported versions

`v0.1` is pre-1.0 and moves fast. Only the latest `master` receives fixes.

## What ClawGuard defends against

- A prompt-injected or misbehaving agent attempting a destructive command,
  a secrets read (`.env`, SSH keys, cloud credentials), or an action outside
  your allowed paths.
- A malicious agent plugin/skill running with the agent's permissions: its
  tool calls hit the same checkpoint.
- An agent attempting to disable ClawGuard or edit its own policy.
- Silent failure: the daemon being down, unreachable, or slow **blocks** tool
  calls, and an unanswered approval **denies** on timeout. No path ends in
  silent approval.
- Undetected tampering with the record: the audit log is a SHA-256 hash chain;
  editing any past entry breaks verification.

## What ClawGuard does NOT defend against

Stated explicitly, because overclaiming is how agent tooling got its bad
reputation. **ClawGuard is a second lock, not a vault.**

- **A compromised OS user account.** The daemon runs as the same user as the
  agent. An attacker with that account can stop it.
- **An agent that bypasses its own tool layer.** ClawGuard gates tool calls via
  the agent's plugin hooks. An agent making raw syscalls, or a plugin host with
  a hook bug, can route around it. This is why the Hermes and OpenClaw adapters
  also report *executed* calls, so the audit log surfaces a bypass rather than
  hiding it — and why OS-level sandboxing is on the roadmap (v0.4).
- **Content inspection.** Rules match tool-call parameters (paths, commands,
  strings), not file contents. A sensitive file inside a folder you `allow`
  will pass that allow rule. Keep `allow` globs narrow.
- **A hostile local process.** Any process running as your user can read
  `~/.clawguard/token` and call the API — exactly as it could read your
  environment variables.
- **Approver impersonation, partially.** v0.1 authorizes approvals by Telegram
  numeric user id or WhatsApp sender number. Per-device pairing codes and
  per-decision nonces are planned for v0.2.

## Audit status

ClawGuard has **not** had an independent security audit. It is verified by its
own test suite and by end-to-end testing against real agents. Treat it as
defense in depth, not as a guarantee.
