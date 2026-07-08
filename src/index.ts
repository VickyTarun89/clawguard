import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { loadPolicy } from "./policy/load.ts";
import { ApprovalQueue } from "./approval/queue.ts";
import { AuditLog } from "./audit/log.ts";
import { Broker } from "./broker.ts";
import { startServer } from "./server.ts";
import { startConsoleChannel } from "./channels/console.ts";
import { WhatsAppChannel } from "./channels/whatsapp.ts";

const policyPath = process.argv[2] ?? "policy.yaml";
if (!existsSync(policyPath)) {
  console.error(`[ClawGuard] no policy at "${policyPath}". Start from the template:\n  copy policy.example.yaml policy.yaml`);
  process.exit(1);
}

const policy = loadPolicy(policyPath);
const audit = new AuditLog(process.env.CLAWGUARD_AUDIT_LOG ?? "data/audit.jsonl");
const queue = new ApprovalQueue();
const broker = new Broker(policy, queue, audit);

const token = process.env.CLAWGUARD_TOKEN ?? randomBytes(24).toString("hex");
const port = Number(process.env.CLAWGUARD_PORT ?? 4747);
startServer(broker, { port, token });

startConsoleChannel(queue);

const waToken = process.env.WA_ACCESS_TOKEN;
const waPhoneId = process.env.WA_PHONE_NUMBER_ID;
const waApprovers = (process.env.WA_APPROVERS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
if (waToken && waPhoneId && waApprovers.length > 0) {
  new WhatsAppChannel(
    {
      accessToken: waToken,
      phoneNumberId: waPhoneId,
      approvers: waApprovers,
      relayUrl: process.env.WA_RELAY_URL,
      relayToken: process.env.WA_RELAY_TOKEN,
    },
    queue,
  ).start();
  console.log(`[ClawGuard] WhatsApp channel on (${waApprovers.length} approver(s)${process.env.WA_RELAY_URL ? ", relay polling" : ", send-only"})`);
}

audit.append({ type: "gateway.started", policyPath, port });
console.log(
  `[ClawGuard] listening on 127.0.0.1:${port}\n` +
    `[ClawGuard] policy: ${policy.hard_deny.length} hard_deny / ${policy.allow.length} allow / ${policy.ask.length} ask, unmatched → ${policy.defaults.unmatched}\n` +
    `[ClawGuard] API token${process.env.CLAWGUARD_TOKEN ? " from CLAWGUARD_TOKEN" : " (generated — set CLAWGUARD_TOKEN to pin)"}: ${token}`,
);
