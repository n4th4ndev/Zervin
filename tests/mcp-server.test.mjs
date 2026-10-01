import assert from "node:assert/strict";
import test from "node:test";
import mcp from "../electron/mcp-server.cjs";

const { handleJsonRpc, toolDefinitions, startMcpServer } = mcp;

test("initialize, ping and tools/list answer the MCP handshake", async () => {
  const init = await handleJsonRpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26" } }, async () => {});
  assert.equal(init.result.protocolVersion, "2025-03-26");
  assert.equal(init.result.serverInfo.name, "zevrin");
  assert.ok(init.result.capabilities.tools);
  assert.equal((await handleJsonRpc({ jsonrpc: "2.0", id: 2, method: "notifications/initialized" }, async () => {})), null);
  assert.deepEqual((await handleJsonRpc({ jsonrpc: "2.0", id: 3, method: "ping" }, async () => {})).result, {});
  const list = await handleJsonRpc({ jsonrpc: "2.0", id: 4, method: "tools/list" }, async () => {});
  assert.equal(list.result.tools.length, toolDefinitions.length);
  assert.ok(list.result.tools.every(tool => tool.name && tool.description && tool.inputSchema.type === "object"));
  assert.equal((await handleJsonRpc({ jsonrpc: "2.0", id: 5, method: "nope" }, async () => {})).error.code, -32601);
  assert.equal((await handleJsonRpc({ id: 6 }, async () => {})).error.code, -32600);
});

test("tools/call routes to the app with the workspace argument split out", async () => {
  const calls = [];
  const callApp = async (command, args, workspace) => { calls.push([command, args, workspace]); return { ok: true }; };
  const reply = await handleJsonRpc({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "open_file", arguments: { path: "app/page.tsx", line: 3, workspace: "/tmp/demo" } } }, callApp);
  assert.deepEqual(calls, [["open_file", { path: "app/page.tsx", line: 3 }, "/tmp/demo"]]);
  assert.equal(JSON.parse(reply.result.content[0].text).ok, true);
  const failure = await handleJsonRpc({ jsonrpc: "2.0", id: 8, method: "tools/call", params: { name: "notify", arguments: { title: "x" } } }, async () => { throw new Error("No workspace is open."); });
  assert.equal(failure.result.isError, true);
  assert.match(failure.result.content[0].text, /No workspace/);
  const unknown = await handleJsonRpc({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "missing" } }, callApp);
  assert.equal(unknown.error.code, -32602);
});

test("the HTTP endpoint requires the bearer token and forwards the workspace header", async t => {
  const calls = [];
  const server = await startMcpServer({ ports: [0], callApp: async (command, args, workspace) => { calls.push([command, workspace]); return "done"; } });
  t.after(() => server.close());
  const unauthorized = await fetch(server.url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }) });
  assert.equal(unauthorized.status, 401);
  const ok = await fetch(server.url, { method: "POST", headers: { "Content-Type": "application/json", ...server.headers(), "X-Zevrin-Workspace": "/tmp/demo" }, body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "show_preview", arguments: { url: "http://localhost:3000" } } }) });
  assert.equal(ok.status, 200);
  const body = await ok.json();
  assert.equal(body.result.content[0].text, "done");
  assert.deepEqual(calls, [["show_preview", "/tmp/demo"]]);
  const notification = await fetch(server.url, { method: "POST", headers: { "Content-Type": "application/json", ...server.headers() }, body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) });
  assert.equal(notification.status, 202);
  assert.match(server.claudeMcpAddCommand(), /^claude mcp add --transport http zevrin http:\/\/127\.0\.0\.1:\d+\/mcp --header "Authorization: Bearer /);
});
