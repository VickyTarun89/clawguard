import { timingSafeEqual } from "node:crypto";

/** Constant-time string comparison for secrets (API token, approver PINs). */
export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
}
