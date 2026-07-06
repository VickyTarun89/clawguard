import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

const GENESIS = "0".repeat(64);

const hashEntry = (prevHash: string, body: string): string =>
  createHash("sha256").update(`${prevHash}\n${body}`).digest("hex");

/**
 * Append-only JSONL log where each entry commits to the previous one via a
 * SHA-256 chain, so editing or deleting any past line breaks verification.
 */
export class AuditLog {
  #path: string;
  #seq = 0;
  #lastHash = GENESIS;

  constructor(path: string) {
    this.#path = path;
    mkdirSync(dirname(path), { recursive: true });
    if (existsSync(path)) {
      const last = readFileSync(path, "utf8").trim().split("\n").filter(Boolean).at(-1);
      if (last) {
        const entry = JSON.parse(last) as { seq: number; hash: string };
        this.#seq = entry.seq;
        this.#lastHash = entry.hash;
      }
    }
  }

  append(event: Record<string, unknown>): void {
    const seq = ++this.#seq;
    const ts = new Date().toISOString();
    const body = JSON.stringify({ seq, ts, event });
    const hash = hashEntry(this.#lastHash, body);
    appendFileSync(this.#path, `${JSON.stringify({ seq, ts, event, prevHash: this.#lastHash, hash })}\n`);
    this.#lastHash = hash;
  }

  static verify(path: string): { ok: boolean; entries: number; brokenAt?: number } {
    let prev = GENESIS;
    let entries = 0;
    for (const line of readFileSync(path, "utf8").trim().split("\n").filter(Boolean)) {
      const e = JSON.parse(line) as { seq: number; ts: string; event: unknown; prevHash: string; hash: string };
      const expected = hashEntry(prev, JSON.stringify({ seq: e.seq, ts: e.ts, event: e.event }));
      if (e.prevHash !== prev || e.hash !== expected) return { ok: false, entries, brokenAt: e.seq };
      prev = e.hash;
      entries++;
    }
    return { ok: true, entries };
  }
}
