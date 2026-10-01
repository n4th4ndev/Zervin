import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../app/codex-model.ts", import.meta.url), "utf8");
const ts = (await import("typescript")).default;
const { initialCodexState, addCodexUser, applyCodexEvent, codexHistoryItems } = await import("data:text/javascript;base64," + Buffer.from(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText).toString("base64"));

test("a streamed Codex turn becomes messages, commands, file changes and todos", () => {
  let state = addCodexUser(initialCodexState(), "Fix the tests", 1);
  assert.equal(state.status, "running");
  const events = [
    { type: "thread.started", thread_id: "th-9" },
    { type: "turn.started" },
    { type: "error", message: "Reconnecting... 1/5" },
    { type: "item.started", item: { id: "c1", type: "command_execution", command: "npm test", aggregated_output: "", status: "in_progress" } },
    { type: "item.completed", item: { id: "c1", type: "command_execution", command: "npm test", aggregated_output: "2 failing", exit_code: 1, status: "failed" } },
    { type: "item.completed", item: { id: "f1", type: "file_change", changes: [{ path: "src/a.ts", kind: "update" }], status: "completed" } },
    { type: "item.updated", item: { id: "t1", type: "todo_list", items: [{ text: "Fix", completed: true }, { text: "Rerun", completed: false }] } },
    { type: "item.completed", item: { id: "m1", type: "agent_message", text: "Fixed." } },
    { type: "turn.completed", usage: { input_tokens: 100, output_tokens: 20 } },
  ];
  const seen = [];
  for (const event of events) { state = applyCodexEvent(state, event); seen.push(state.notice); }
  assert.equal(seen[2], "Reconnecting... 1/5");
  assert.equal(state.threadId, "th-9");
  assert.equal(state.status, "idle");
  assert.deepEqual(state.items.map(item => item.kind), ["user", "command", "files", "todos", "message"]);
  assert.equal(state.items[1].exitCode, 1);
  assert.equal(state.items[1].output, "2 failing");
  assert.deepEqual(state.usage, { input: 100, output: 20 });
});

test("failures, interruptions and history", () => {
  let state = applyCodexEvent(addCodexUser(initialCodexState(), "x"), { type: "turn.failed", error: { message: "Not signed in" } });
  assert.equal(state.items.at(-1).text, "Not signed in");
  state = applyCodexEvent(state, { type: "zevrin.interrupted" });
  assert.equal(state.items.at(-1).tone, "info");
  assert.deepEqual(codexHistoryItems([{ role: "user", text: "a" }, { role: "assistant", text: "b" }]).map(item => item.kind), ["user", "message"]);
});
