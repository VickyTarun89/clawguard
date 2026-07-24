import { existsSync, readFileSync } from "node:fs";
import { AuditLog } from "./log.ts";

/**
 * Human-readable view of the audit log: what the agent tried, and what
 * happened to it.
 *
 * The raw log is append-only and event-shaped — a request and its decision
 * are two separate entries — which is right for tamper-evidence but useless
 * to read. This joins them back into one row per action, and reports whether
 * the hash chain still verifies, so the page can say plainly whether the
 * record has been edited.
 */

export type HistoryKind = "gated" | "observed" | "remembered" | "started";

export interface HistoryRow {
  seq: number;
  ts: string;
  kind: HistoryKind;
  agent?: string;
  tool?: string;
  params?: Record<string, unknown>;
  /** Final verdict. Absent while an approval is still pending. */
  verdict?: "allow" | "deny";
  /** What the policy said before any human was asked. */
  evaluated?: "allow" | "deny" | "ask";
  decidedBy?: "policy" | "human" | "timeout" | "remembered";
  approver?: string;
  rule?: string;
  reason?: string;
  durationMs?: number;
}

export interface History {
  rows: HistoryRow[];
  /** Total rows available before the limit was applied. */
  total: number;
  chain: { ok: boolean; entries: number; brokenAt?: number };
}

interface RawEntry {
  seq: number;
  ts: string;
  event: Record<string, unknown>;
}

/**
 * Reads and joins the whole log, then returns the most recent `limit` rows.
 * Fine for personal-scale logs (a decision is ~2 short lines); a log big
 * enough to make this slow wants real pagination, not a bigger read.
 */
export function readHistory(path: string, limit = 100): History {
  if (!existsSync(path)) return { rows: [], total: 0, chain: { ok: true, entries: 0 } };

  const rows: HistoryRow[] = [];
  const byRequestId = new Map<string, HistoryRow>();

  for (const line of readFileSync(path, "utf8").trim().split("\n").filter(Boolean)) {
    let entry: RawEntry;
    try {
      entry = JSON.parse(line) as RawEntry;
    } catch {
      continue; // a truncated final line shouldn't break the whole view
    }
    const event = entry.event ?? {};
    const type = event.type as string | undefined;

    if (type === "action.requested") {
      const request = event.request as { id: string; agent: string; tool: string; params: Record<string, unknown> };
      const evaluation = (event.evaluation ?? {}) as { verdict?: HistoryRow["evaluated"]; rule?: string; reason?: string };
      const row: HistoryRow = {
        seq: entry.seq,
        ts: entry.ts,
        kind: "gated",
        agent: request?.agent,
        tool: request?.tool,
        params: request?.params,
        evaluated: evaluation.verdict,
        rule: evaluation.rule,
        reason: evaluation.reason,
      };
      rows.push(row);
      if (request?.id) byRequestId.set(request.id, row);
    } else if (type === "action.decided") {
      // Fold the decision back into its request row rather than showing two
      // lines for one action.
      const row = byRequestId.get(event.requestId as string);
      const decision = (event.decision ?? {}) as {
        verdict?: "allow" | "deny";
        decidedBy?: HistoryRow["decidedBy"];
        approver?: string;
        reason?: string;
        rule?: string;
      };
      if (row) {
        row.verdict = decision.verdict;
        row.decidedBy = decision.decidedBy;
        row.approver = decision.approver;
        row.reason = decision.reason ?? row.reason;
        if (decision.rule) row.rule = decision.rule;
      }
    } else if (type === "action.observed") {
      rows.push({
        seq: entry.seq,
        ts: entry.ts,
        kind: "observed",
        agent: event.agent as string,
        tool: event.tool as string,
        params: event.params as Record<string, unknown>,
        durationMs: event.durationMs as number | undefined,
      });
    } else if (type === "rule.remembered") {
      rows.push({
        seq: entry.seq,
        ts: entry.ts,
        kind: "remembered",
        agent: event.agent as string,
        tool: event.tool as string,
        params: event.params as Record<string, unknown>,
        approver: event.approver as string,
      });
    } else if (type === "gateway.started") {
      rows.push({ seq: entry.seq, ts: entry.ts, kind: "started" });
    }
  }

  return {
    rows: rows.slice(-Math.max(1, limit)).reverse(), // newest first
    total: rows.length,
    chain: AuditLog.verify(path),
  };
}
