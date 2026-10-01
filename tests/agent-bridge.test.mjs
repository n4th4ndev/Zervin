import assert from "node:assert/strict";
import test from "node:test";
import agentBridge from "../electron/agent-bridge.cjs";

const { MessageQueue, trimValue } = agentBridge;

test("message queue delivers pushed items in order and ends when closed", async () => {
  const queue = new MessageQueue();
  const received = [];
  const consumer = (async () => { for await (const item of queue) received.push(item); })();
  queue.push("a");
  await new Promise(resolve => setTimeout(resolve, 5));
  queue.push("b");
  queue.close();
  await consumer;
  assert.deepEqual(received, ["a", "b"]);
  queue.push("ignored after close");
  assert.deepEqual(received, ["a", "b"]);
});

test("trimValue bounds long strings and drops raw tool output objects", () => {
  const long = "x".repeat(70000);
  const trimmed = trimValue({ type: "user", tool_use_result: { huge: long }, message: { content: [{ type: "text", text: long }] }, fn: () => 1 });
  assert.equal("tool_use_result" in trimmed, false);
  assert.equal("fn" in trimmed, false);
  assert.ok(trimmed.message.content[0].text.length < 61000);
  assert.match(trimmed.message.content[0].text, /more characters\]$/);
  assert.deepEqual(trimValue([1, "two", null]), [1, "two", null]);
});
