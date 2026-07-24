import test from "node:test";
import assert from "node:assert/strict";
import { globToRegExp, evaluate } from "../src/policy/engine.ts";
import type { Policy } from "../src/types.ts";

const matches = (glob: string, path: string): boolean => globToRegExp(glob).test(path);

test("a leading **/ matches zero leading segments (bare paths)", () => {
  assert.equal(matches("**/notes.txt", "notes.txt"), true);
  assert.equal(matches("**/notes.txt", "a/notes.txt"), true);
  assert.equal(matches("**/notes.txt", "a/b/c/notes.txt"), true);
  assert.equal(matches("**/notes.txt", "other.txt"), false);
  assert.equal(matches("**/notes.txt", "notes.txt.bak"), false);
});

test("**/.ssh/** covers both relative and absolute key paths", () => {
  assert.equal(matches("**/.ssh/**", ".ssh/id_rsa"), true);
  assert.equal(matches("**/.ssh/**", "C:/Users/me/.ssh/id_rsa"), true);
  assert.equal(matches("**/.ssh/**", "home/u/.ssh/keys/id_ed25519"), true);
  assert.equal(matches("**/.ssh/**", "sshconfig"), false);
});

test("existing glob shapes are unchanged", () => {
  assert.equal(matches("D:/projects/**", "D:/projects/app/src/main.ts"), true);
  assert.equal(matches("D:/projects/**", "C:/other/app.ts"), false);
  assert.equal(matches("*.md", "README.md"), true);
  assert.equal(matches("*.md", "readme.MD"), true, "matching stays case-insensitive");
  assert.equal(matches("*notes.txt", "notes.txt"), true);
  assert.equal(matches("exec*", "exec_shell"), true);
  assert.equal(matches("*", "anything/at/all"), true);
  assert.equal(matches("read?", "reads"), true);
  assert.equal(matches("read?", "reading"), false);
});

test("a hard_deny rule with **/ now blocks a relative key path", () => {
  const policy: Policy = {
    version: 1,
    defaults: { unmatched: "ask", ask_timeout_seconds: 120, on_timeout: "deny" },
    hard_deny: [{ note: "ssh keys", tool: "*", path: ["**/.ssh/**"] }],
    allow: [],
    ask: [],
  };
  const req = (path: string) => ({ id: "t", agent: "a", tool: "read", params: { path }, receivedAt: "" });

  // The regression: before the fix this fell through to "ask" despite the rule.
  assert.equal(evaluate(policy, req(".ssh/id_rsa")).verdict, "deny");
  assert.equal(evaluate(policy, req("C:/Users/me/.ssh/id_rsa")).verdict, "deny");
  assert.equal(evaluate(policy, req("notes.txt")).verdict, "ask");
});
