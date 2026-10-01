import assert from "node:assert/strict";
import test from "node:test";
import { addUserMessage, applyAgentEvent, describeToolCall, initialChatState } from "../app/chat-model.ts";

const message = (payload) => ({ type: "message", message: payload });

test("init and result messages update session metadata and status", () => {
  let state = addUserMessage(initialChatState(), "Hello");
  assert.equal(state.status, "running");
  state = applyAgentEvent(state, message({ type: "system", subtype: "init", session_id: "s-1", model: "claude-opus-5", permissionMode: "acceptEdits", tools: ["Read", "Bash"] }));
  assert.equal(state.sessionId, "s-1");
  assert.equal(state.model, "claude-opus-5");
  assert.equal(state.permissionMode, "acceptEdits");
  assert.deepEqual(state.tools, ["Read", "Bash"]);
  state = applyAgentEvent(state, message({ type: "result", subtype: "success", is_error: false, total_cost_usd: 0.42, num_turns: 3, session_id: "s-1" }));
  assert.equal(state.status, "idle");
  assert.equal(state.costUsd, 0.42);
  assert.equal(state.turns, 3);
});

test("streamed text builds a draft that the final assistant message replaces", () => {
  let state = addUserMessage(initialChatState(), "Explain");
  state = applyAgentEvent(state, message({ type: "stream_event", parent_tool_use_id: null, event: { type: "content_block_start", content_block: { type: "text" } } }));
  state = applyAgentEvent(state, message({ type: "stream_event", parent_tool_use_id: null, event: { type: "content_block_delta", delta: { type: "text_delta", text: "Hel" } } }));
  state = applyAgentEvent(state, message({ type: "stream_event", parent_tool_use_id: null, event: { type: "content_block_delta", delta: { type: "text_delta", text: "lo" } } }));
  assert.equal(state.draft.text, "Hello");
  state = applyAgentEvent(state, message({ type: "assistant", parent_tool_use_id: null, message: { content: [{ type: "text", text: "Hello there" }] } }));
  assert.equal(state.draft, null);
  const last = state.items[state.items.length - 1];
  assert.equal(last.role, "assistant");
  assert.deepEqual(last.blocks, [{ type: "text", text: "Hello there" }]);
});

test("tool calls get their results attached and subagent frames are ignored", () => {
  let state = addUserMessage(initialChatState(), "List files");
  state = applyAgentEvent(state, message({ type: "assistant", parent_tool_use_id: null, message: { content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } }] } }));
  state = applyAgentEvent(state, message({ type: "assistant", parent_tool_use_id: "t1", message: { content: [{ type: "text", text: "inner" }] } }));
  state = applyAgentEvent(state, message({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "a.ts\nb.ts" }], is_error: false }] } }));
  const assistant = state.items.find(item => item.role === "assistant");
  assert.equal(assistant.blocks.length, 1);
  assert.deepEqual(assistant.blocks[0].result, { text: "a.ts\nb.ts", isError: false });
  // Duplicate tool_use delivery does not add a second card.
  state = applyAgentEvent(state, message({ type: "assistant", parent_tool_use_id: null, message: { content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } }] } }));
  assert.equal(state.items.find(item => item.role === "assistant").blocks.length, 1);
});

test("permission requests, errors and auth prompts are surfaced", () => {
  let state = addUserMessage(initialChatState(), "Edit");
  state = applyAgentEvent(state, { type: "permission", requestId: "p1", toolName: "Edit", input: { file_path: "a.ts" }, suggestions: [{ type: "addRules" }] });
  assert.equal(state.permission.requestId, "p1");
  state = applyAgentEvent(state, { type: "permission_resolved", requestId: "p1" });
  assert.equal(state.permission, null);
  state = applyAgentEvent(state, message({ type: "auth_status", isAuthenticating: true, output: ["Open https://claude.ai/login"] }));
  assert.equal(state.status, "auth");
  assert.deepEqual(state.authOutput, ["Open https://claude.ai/login"]);
  state = applyAgentEvent(state, message({ type: "result", subtype: "error_during_execution", is_error: true, errors: ["Boom"] }));
  assert.equal(state.status, "error");
  assert.equal(state.items[state.items.length - 1].text, "Boom");
  state = applyAgentEvent(state, { type: "error", message: "Claude Code could not start." });
  assert.equal(state.items[state.items.length - 1].tone, "error");
});

test("describes tool calls in one line", () => {
  assert.equal(describeToolCall("Bash", { command: "npm test" }), "npm test");
  assert.equal(describeToolCall("Edit", { file_path: "app/page.tsx" }), "app/page.tsx");
  assert.equal(describeToolCall("Grep", { pattern: "TODO", path: "src" }), "TODO  in  src");
  assert.equal(describeToolCall("mcp__x", { query: "hello" }), "query: hello");
  assert.equal(describeToolCall("Unknown", {}), "");
});

test("history replay and info events", async () => {
  const { applyHistoryMessage, todoEntries } = await import("../app/chat-model.ts");
  let state = initialChatState();
  state = applyHistoryMessage(state, { type: "user", parent_tool_use_id: null, message: { role: "user", content: "Earlier question" } });
  state = applyHistoryMessage(state, { type: "assistant", parent_tool_use_id: null, message: { content: [{ type: "text", text: "Earlier answer" }] } });
  state = applyHistoryMessage(state, { type: "user", parent_tool_use_id: null, message: { role: "user", content: [{ type: "image", source: {} }, { type: "text", text: "with image" }] } });
  assert.deepEqual(state.items.map(item => item.role), ["user", "assistant", "user"]);
  assert.equal(state.items[2].images, 1);
  assert.equal(state.status, "idle");
  state = applyAgentEvent(state, { type: "info", models: [{ value: "opus", displayName: "Opus", description: "" }], commands: [{ name: "compact", description: "", argumentHint: "" }], account: { email: "me@x.dev" }, mcp: [{ name: "zevrin", status: "connected" }], effort: "high" });
  assert.equal(state.models[0].value, "opus");
  assert.equal(state.commands[0].name, "compact");
  assert.equal(state.account.email, "me@x.dev");
  assert.equal(state.effort, "high");
  assert.deepEqual(todoEntries({ todos: [{ content: "A", status: "completed" }, { content: "B", status: "weird" }] }), [{ content: "A", status: "completed" }, { content: "B", status: "pending" }]);
  assert.equal(todoEntries({}), null);
  assert.equal(describeToolCall("TodoWrite", { todos: [{ content: "A", status: "completed" }, { content: "B", status: "pending" }] }), "1/2 done");
});
