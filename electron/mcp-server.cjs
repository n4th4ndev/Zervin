// Zevrin MCP server: a local Streamable-HTTP endpoint (JSON-RPC 2.0) that lets Claude Code, the in-app Claude chat,
// or any MCP client drive the Zevrin interface: open files, show previews, add canvas notes, run terminal commands, etc.
const http = require("node:http");
const net = require("node:net");
const { randomBytes } = require("node:crypto");

const protocolVersions = ["2025-06-18", "2025-03-26", "2024-11-05"];
const serverInfo = { name: "zevrin", version: "0.2.0" };
const instructions = "Zevrin is the desktop IDE the user is working in. Use these tools to show results in the interface (open files in the Code tile, show a URL in the Preview tile, add notes to the Canvas, run commands in a terminal tile, notify the user) and to look at the embedded browser (Preview tile): read the page, take a screenshot, read its console, run JavaScript in it; and to drive iOS simulators and Android emulators (list, boot, screenshot, open a URL). Prefer the workspace the user is looking at unless a tool call names another one.";

const workspaceParam = { type: "string", description: "Absolute path of the Zevrin workspace to target. Defaults to the workspace the user is currently looking at." };

// Tool definitions. `command` is the app-side action name handled by the renderer.
const toolDefinitions = [
  { name: "list_workspaces", command: "list_workspaces", description: "List the projects currently open in Zevrin with their paths, and which one is active.", inputSchema: { type: "object", properties: {}, additionalProperties: false } },
  { name: "get_workspace_state", command: "get_workspace_state", description: "Describe a workspace as the user sees it: open tiles, the file in the editor, the preview URL, Git branch and changed files.", inputSchema: { type: "object", properties: { workspace: workspaceParam }, additionalProperties: false } },
  { name: "open_file", command: "open_file", description: "Open a file from the workspace in the Code tile so the user can see it. Optionally scroll to a line.", inputSchema: { type: "object", properties: { path: { type: "string", description: "Path relative to the workspace root." }, line: { type: "integer", minimum: 1 }, workspace: workspaceParam }, required: ["path"], additionalProperties: false } },
  { name: "show_preview", command: "show_preview", description: "Show a URL (for example the local dev server) in the Preview tile.", inputSchema: { type: "object", properties: { url: { type: "string" }, workspace: workspaceParam }, required: ["url"], additionalProperties: false } },
  { name: "add_canvas_note", command: "add_canvas_note", description: "Add a sticky note, card, diamond or text item to the Canvas tile. Use it to leave plans, diagrams or reminders for the user.", inputSchema: { type: "object", properties: { text: { type: "string", maxLength: 2000 }, kind: { type: "string", enum: ["note", "rectangle", "diamond", "text"], default: "note" }, x: { type: "integer" }, y: { type: "integer" }, workspace: workspaceParam }, required: ["text"], additionalProperties: false } },
  { name: "get_canvas", command: "get_canvas", description: "Read every item on the Canvas tile (notes, cards, diamonds, text and connectors).", inputSchema: { type: "object", properties: { workspace: workspaceParam }, additionalProperties: false } },
  { name: "open_tile", command: "open_tile", description: "Show a tile in the workspace (terminal, agent, editor, files, preview, canvas or git). Terminals and agents are added; the other tiles are shown if hidden.", inputSchema: { type: "object", properties: { tile: { type: "string", enum: ["terminal", "agent", "vscode", "editor", "files", "preview", "canvas", "git", "devices"] }, workspace: workspaceParam }, required: ["tile"], additionalProperties: false } },
  { name: "close_tile", command: "close_tile", description: "Hide a tile type from the workspace.", inputSchema: { type: "object", properties: { tile: { type: "string", enum: ["vscode", "editor", "files", "preview", "canvas", "git", "devices"] }, workspace: workspaceParam }, required: ["tile"], additionalProperties: false } },
  { name: "apply_layout", command: "apply_layout", description: "Apply one of Zevrin's layout presets.", inputSchema: { type: "object", properties: { preset: { type: "string", enum: ["default", "agent-code", "code-preview", "canvas-code", "grid", "fibonacci", "focus"] }, workspace: workspaceParam }, required: ["preset"], additionalProperties: false } },
  { name: "run_in_terminal", command: "run_in_terminal", description: "Type a command into the workspace's terminal tile and press Enter, so the user sees it run (for example starting a dev server). Opens a terminal tile if none exists. Does not return the output.", inputSchema: { type: "object", properties: { command: { type: "string", maxLength: 4000 }, workspace: workspaceParam }, required: ["command"], additionalProperties: false } },
  { name: "get_preview_page", command: "get_preview_page", description: "Read the page shown in the Preview tile (embedded browser): URL, title, selected text, headings and visible text. Use it to see what the user sees, or to check a dev server's output.", inputSchema: { type: "object", properties: { selector: { type: "string", description: "Optional CSS selector; when given, returns the outer HTML of the first match instead of the page text.", maxLength: 500 }, workspace: workspaceParam }, additionalProperties: false } },
  { name: "preview_screenshot", command: "preview_screenshot", description: "Take a screenshot of the page shown in the Preview tile and return it as an image.", inputSchema: { type: "object", properties: { workspace: workspaceParam }, additionalProperties: false } },
  { name: "get_preview_console", command: "get_preview_console", description: "Read the browser console of the Preview tile (console.log/warn/error, uncaught errors and failed loads) since the page was opened.", inputSchema: { type: "object", properties: { errorsOnly: { type: "boolean", default: false }, limit: { type: "integer", minimum: 1, maximum: 200, default: 60 }, workspace: workspaceParam }, additionalProperties: false } },
  { name: "run_in_preview", command: "run_in_preview", description: "Run JavaScript inside the page shown in the Preview tile and return its JSON result. Use it to click, type, scroll, or inspect the DOM (for example document.querySelector('button').click()).", inputSchema: { type: "object", properties: { script: { type: "string", maxLength: 20000 }, workspace: workspaceParam }, required: ["script"], additionalProperties: false } },
  { name: "preview_navigate", command: "preview_navigate", description: "Open a URL in the Preview tile (the embedded browser the user sees).", inputSchema: { type: "object", properties: { url: { type: "string" }, workspace: workspaceParam }, required: ["url"], additionalProperties: false } },
  { name: "preview_snapshot", command: "preview_snapshot", description: "List the interactive elements of the page in the Preview tile with short refs (e1, e2…), plus title, URL, headings and scroll position. Call it before preview_click / preview_type and again after the page changes.", inputSchema: { type: "object", properties: { workspace: workspaceParam }, additionalProperties: false } },
  { name: "preview_click", command: "preview_click", description: "Click an element in the Preview tile with a real mouse click. Target it by ref (from preview_snapshot), CSS selector, or visible text (target_text).", inputSchema: { type: "object", properties: { ref: { type: "string" }, selector: { type: "string" }, target_text: { type: "string" }, workspace: workspaceParam }, additionalProperties: false } },
  { name: "preview_type", command: "preview_type", description: "Type text into the Preview page like a user. Optionally click an element first (ref, selector or target_text) to focus it, and press Enter afterwards with submit.", inputSchema: { type: "object", properties: { text: { type: "string" }, ref: { type: "string" }, selector: { type: "string" }, target_text: { type: "string" }, submit: { type: "boolean" }, workspace: workspaceParam }, required: ["text"], additionalProperties: false } },
  { name: "preview_press_key", command: "preview_press_key", description: "Press a key in the Preview page: Enter, Tab, Escape, Backspace, ArrowUp, ArrowDown, ArrowLeft, ArrowRight.", inputSchema: { type: "object", properties: { key: { type: "string", enum: ["Enter", "Tab", "Escape", "Backspace", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"] }, workspace: workspaceParam }, required: ["key"], additionalProperties: false } },
  { name: "preview_scroll", command: "preview_scroll", description: "Scroll the Preview page up or down.", inputSchema: { type: "object", properties: { direction: { type: "string", enum: ["up", "down"] }, amount: { type: "integer", minimum: 50, maximum: 5000 }, workspace: workspaceParam }, required: ["direction"], additionalProperties: false } },
  { name: "preview_wait_for", command: "preview_wait_for", description: "Wait until some text or a CSS selector appears in the Preview page (for example after a click that loads data).", inputSchema: { type: "object", properties: { text: { type: "string" }, selector: { type: "string" }, timeoutMs: { type: "integer", minimum: 100, maximum: 30000 }, workspace: workspaceParam }, additionalProperties: false } },
  { name: "preview_network", command: "preview_network", description: "Read the network requests of the Preview page (method, URL, status, duration, failures).", inputSchema: { type: "object", properties: { failuresOnly: { type: "boolean" }, workspace: workspaceParam }, additionalProperties: false } },
  { name: "preview_record", command: "preview_record", description: "Record the Preview page for a few seconds (for animations, loading states, flicker) and return key frames as images with the console and failed requests seen meanwhile.", inputSchema: { type: "object", properties: { seconds: { type: "integer", minimum: 1, maximum: 20 }, workspace: workspaceParam }, additionalProperties: false } },
  { name: "list_devices", command: "list_devices", description: "List the iOS simulators and Android emulators available on this machine with their state (booted or shutdown), and whether the tooling (Xcode, Android SDK) is installed.", inputSchema: { type: "object", properties: { workspace: workspaceParam }, additionalProperties: false } },
  { name: "boot_device", command: "boot_device", description: "Boot an iOS simulator or Android emulator (by id from list_devices) and show it in the Devices tile with a live screen mirror.", inputSchema: { type: "object", properties: { platform: { type: "string", enum: ["ios", "android"] }, id: { type: "string" }, workspace: workspaceParam }, required: ["platform", "id"], additionalProperties: false } },
  { name: "device_screenshot", command: "device_screenshot", description: "Take a screenshot of a booted simulator or emulator and return it as an image. Without an id, the device mirrored in the Devices tile is used.", inputSchema: { type: "object", properties: { platform: { type: "string", enum: ["ios", "android"] }, id: { type: "string" }, workspace: workspaceParam }, additionalProperties: false } },
  { name: "open_url_on_device", command: "open_url_on_device", description: "Open a URL or deep link (http://…, myapp://…) on a booted simulator or emulator. Without an id, the device mirrored in the Devices tile is used.", inputSchema: { type: "object", properties: { url: { type: "string" }, platform: { type: "string", enum: ["ios", "android"] }, id: { type: "string" }, workspace: workspaceParam }, required: ["url"], additionalProperties: false } },
  { name: "device_logs", command: "device_logs", description: "Read the recent logs of a booted simulator or emulator (iOS unified log, Android logcat), to debug a crash or an error in the app running on it. Without an id, the device mirrored in the Devices tile is used.", inputSchema: { type: "object", properties: { platform: { type: "string", enum: ["ios", "android"] }, id: { type: "string" }, minutes: { type: "number", minimum: 1, maximum: 30 }, errorsOnly: { type: "boolean" }, filter: { type: "string", description: "Keep only lines containing this text (an app name, a tag)." }, lines: { type: "number", minimum: 20, maximum: 2000 }, workspace: workspaceParam }, additionalProperties: false } },
  { name: "set_device_appearance", command: "set_device_appearance", description: "Switch a booted simulator or emulator to dark or light mode (to check both themes of the app). Without an id, the device mirrored in the Devices tile is used.", inputSchema: { type: "object", properties: { mode: { type: "string", enum: ["dark", "light"] }, platform: { type: "string", enum: ["ios", "android"] }, id: { type: "string" }, workspace: workspaceParam }, required: ["mode"], additionalProperties: false } },
  { name: "notify", command: "notify", description: "Show a short notification banner to the user inside Zevrin.", inputSchema: { type: "object", properties: { title: { type: "string", maxLength: 120 }, body: { type: "string", maxLength: 500 }, tone: { type: "string", enum: ["info", "success", "warning"], default: "info" }, workspace: workspaceParam }, required: ["title"], additionalProperties: false } },
];

function jsonRpcError(id, code, message, data) {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message, ...(data === undefined ? {} : { data }) } };
}

function textResult(value, isError = false) {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return { content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) };
}

// Handles one JSON-RPC message. `callApp(command, args, workspace)` performs the action in the interface.
async function handleJsonRpc(message, callApp) {
  if (!message || typeof message !== "object" || message.jsonrpc !== "2.0" || typeof message.method !== "string") return jsonRpcError(message?.id, -32600, "Invalid request");
  const { id, method, params = {} } = message;
  const isNotification = id === undefined || id === null;
  if (method === "notifications/initialized" || method.startsWith("notifications/")) return null;
  if (isNotification) return null;
  if (method === "initialize") {
    const requested = typeof params.protocolVersion === "string" ? params.protocolVersion : protocolVersions[0];
    return { jsonrpc: "2.0", id, result: { protocolVersion: protocolVersions.includes(requested) ? requested : protocolVersions[0], capabilities: { tools: { listChanged: false } }, serverInfo, instructions } };
  }
  if (method === "ping") return { jsonrpc: "2.0", id, result: {} };
  if (method === "tools/list") return { jsonrpc: "2.0", id, result: { tools: toolDefinitions.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) } };
  if (method === "tools/call") {
    const definition = toolDefinitions.find(item => item.name === params.name);
    if (!definition) return jsonRpcError(id, -32602, `Unknown tool: ${params.name}`);
    const args = params.arguments && typeof params.arguments === "object" ? params.arguments : {};
    const { workspace, ...rest } = args;
    try {
      const result = await callApp(definition.command, rest, typeof workspace === "string" ? workspace : null);
      const passthrough = result && typeof result === "object" && Array.isArray(result.content);
      return { jsonrpc: "2.0", id, result: passthrough ? result : textResult(result) };
    } catch (error) {
      return { jsonrpc: "2.0", id, result: textResult(error?.message || String(error), true) };
    }
  }
  return jsonRpcError(id, -32601, `Method not found: ${method}`);
}

function readBody(request, limit = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    request.on("data", chunk => { size += chunk.length; if (size > limit) { reject(new Error("Request body too large")); request.destroy(); } else chunks.push(chunk); });
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

function portIsFree(port) {
  return new Promise(resolve => {
    const probe = net.createServer();
    probe.unref();
    probe.once("error", () => resolve(false));
    probe.listen({ port, host: "127.0.0.1" }, () => probe.close(() => resolve(true)));
  });
}

async function startMcpServer({ token, ports, callApp, log = () => {} }) {
  const secret = token || randomBytes(24).toString("hex");
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url || "/", "http://127.0.0.1");
    response.setHeader("Cache-Control", "no-store");
    if (url.pathname !== "/mcp") { response.writeHead(404); response.end(); return; }
    const authorization = request.headers.authorization || "";
    if (authorization !== `Bearer ${secret}`) { response.writeHead(401, { "Content-Type": "application/json" }); response.end(JSON.stringify(jsonRpcError(null, -32001, "Unauthorized"))); return; }
    if (request.method === "GET") { response.writeHead(405, { Allow: "POST, DELETE" }); response.end(); return; }
    if (request.method === "DELETE") { response.writeHead(200); response.end(); return; }
    if (request.method !== "POST") { response.writeHead(405); response.end(); return; }
    let payload;
    try { payload = JSON.parse(await readBody(request)); }
    catch (error) { response.writeHead(400, { "Content-Type": "application/json" }); response.end(JSON.stringify(jsonRpcError(null, -32700, "Parse error", error.message))); return; }
    const workspaceHeader = request.headers["x-zevrin-workspace"];
    const scopedCallApp = (command, args, workspace) => callApp(command, args, workspace ?? (typeof workspaceHeader === "string" && workspaceHeader ? workspaceHeader : null));
    const messages = Array.isArray(payload) ? payload : [payload];
    const results = (await Promise.all(messages.map(item => handleJsonRpc(item, scopedCallApp)))).filter(Boolean);
    if (results.length === 0) { response.writeHead(202); response.end(); return; }
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify(Array.isArray(payload) ? results : results[0]));
  });
  server.on("error", error => log("MCP server error: " + error.message));
  let port = null;
  for (const candidate of ports) {
    if (!(await portIsFree(candidate))) continue;
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen({ port: candidate, host: "127.0.0.1" }, () => { server.off("error", reject); resolve(); }); }).then(() => { port = server.address().port; }).catch(() => {});
    if (port) break;
  }
  if (!port) throw new Error("No free port for the Zevrin MCP server.");
  const url = `http://127.0.0.1:${port}/mcp`;
  return {
    url,
    token: secret,
    port,
    headers: () => ({ Authorization: `Bearer ${secret}` }),
    claudeMcpAddCommand: () => `claude mcp add --transport http zevrin ${url} --header "Authorization: Bearer ${secret}"`,
    close: () => new Promise(resolve => server.close(() => resolve())),
  };
}

module.exports = { toolDefinitions, handleJsonRpc, startMcpServer, serverInfo };
