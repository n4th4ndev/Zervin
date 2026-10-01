import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import codex from "../electron/codex-bridge.cjs";

const { parseRollout, listCodexThreads, accessModes } = codex;

const rollout = [
  { timestamp: "2026-09-27T10:00:00Z", type: "session_meta", payload: { id: "th-1", timestamp: "2026-09-27T10:00:00Z", cwd: "/Users/me/app" } },
  { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "<environment_context>cwd</environment_context>" }] } },
  { type: "event_msg", payload: { type: "user_message", message: "Fix the login bug" } },
  { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Fix the login bug" }] } },
  { type: "event_msg", payload: { type: "agent_message", message: "Done: the token was not refreshed." } },
].map(item => JSON.stringify(item)).join("\n");

test("rollouts give the thread id, folder and visible conversation", () => {
  const parsed = parseRollout(rollout + "\nnot json\n");
  assert.equal(parsed.id, "th-1");
  assert.equal(parsed.cwd, "/Users/me/app");
  assert.deepEqual(parsed.messages, [{ role: "user", text: "Fix the login bug" }, { role: "assistant", text: "Done: the token was not refreshed." }]);
  assert.deepEqual(Object.keys(accessModes), ["chat", "agent", "full"]);
  assert.equal(accessModes.chat.sandboxMode, "read-only");
});

test("threads are listed for the project folder only", async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), "zevrin-codex-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const dir = path.join(home, ".codex", "sessions", "2026", "09", "27");
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "rollout-2026-09-27T10-00-00-th-1.jsonl"), rollout);
  await writeFile(path.join(dir, "rollout-2026-09-27T11-00-00-th-2.jsonl"), rollout.replace("th-1", "th-2").replace("/Users/me/app", "/Users/me/other"));
  const saved = process.env.CODEX_HOME; delete process.env.CODEX_HOME;
  const threads = await listCodexThreads("/Users/me/app", { home });
  if (saved) process.env.CODEX_HOME = saved;
  assert.deepEqual(threads.map(item => [item.threadId, item.summary]), [["th-1", "Fix the login bug"]]);
});
