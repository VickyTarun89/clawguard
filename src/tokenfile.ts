import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * Where the daemon publishes its API token for same-user local agents to
 * discover. Lets an OpenClaw/Hermes plugin authenticate without the operator
 * having to inject CLAWGUARD_TOKEN into a background gateway's environment.
 *
 * Same-user readable only (0600). This is no weaker than an env var: any
 * process running as this user could read either. The daemon's auth exists to
 * stop *other* users and the network, not this user's own agents.
 */
export function tokenFilePath(): string {
  return process.env.CLAWGUARD_TOKEN_FILE ?? join(homedir(), ".clawguard", "token");
}

export function publishToken(token: string): string {
  const path = tokenFilePath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, token, { encoding: "utf8", mode: 0o600 });
  try {
    chmodSync(path, 0o600); // no-op on Windows, enforced on POSIX
  } catch {
    /* best effort */
  }
  return path;
}
