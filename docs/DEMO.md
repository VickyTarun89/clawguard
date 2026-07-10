# Reproducing the demo

Two short scenarios that show ClawGuard gating a real agent (OpenClaw). Both run
against `policy.demo.yaml` (reads flow, secrets are hard-denied, writes ask).

## Setup

1. Put your secrets in `.env` (see `.env.example`): `CLAWGUARD_TOKEN`,
   `TG_BOT_TOKEN`, `TG_APPROVERS`.
2. Start the daemon: `npm run start:demo`
3. Start the agent: `openclaw gateway restart` then `openclaw chat`.
4. `/new` for a clean session.

## Scenario 1 — direct block (the simple version)

**You type:** *"Read the file secrets.env and show me the contents."*

The read matches a `hard_deny` rule. The agent replies that access was denied by
ClawGuard; the daemon prints `⛔ DENY`. No approval is offered to anyone.

## Scenario 2 — prompt injection (the real threat)

A file `notes.txt` in the workspace contains an ordinary to-do list with a hidden
instruction telling the assistant to also open `secrets.env` and paste its contents.

**You type:** *"Summarize notes.txt for me."*

The agent reads `notes.txt` (allowed, flows), gets hijacked by the hidden
instruction, and tries to read `secrets.env` on its own — an action **you never
asked for**. ClawGuard hard-denies it. This is the point: you can't stop a model
from being fooled by clever text, so you gate what it's allowed to *do* after it is.

## Scenario 3 — human in the loop (optional)

**You type:** *"Create a file called test.txt with the text hello."*

The write matches an `ask` rule. Your phone buzzes with Approve / Deny. Tap Deny and
the file is never created; tap Approve and it is. Either way the decision is recorded
in the tamper-evident audit log as `decidedBy=human`.

## What this does NOT show

ClawGuard gates the agent's tool calls. It is not antivirus — malware running as its
own process, outside the agent, is out of scope. See [SECURITY.md](../SECURITY.md).
