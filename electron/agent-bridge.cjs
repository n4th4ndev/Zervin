// Bridges Claude Code (via the Claude Agent SDK) to renderer tiles. One session per agent tile.
const { randomUUID } = require("node:crypto");

let sdkPromise = null;
function loadSdk() {
  if (!sdkPromise) sdkPromise = import("@anthropic-ai/claude-agent-sdk").catch(error => { sdkPromise = null; throw error; });
  return sdkPromise;
}

// The SDK ships the Claude Code runtime as a per-platform package. The packaged app leaves it out (it is ~200 MB)
// and uses the claude CLI installed on the Mac instead; in development the bundled runtime is used when present.
let resolveInstalledClaude = async () => null;
function setClaudeResolver(resolver) { resolveInstalledClaude = resolver; }
function bundledClaudeAvailable() {
  for (const suffix of ["", "-musl"]) {
    try { require.resolve(`@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}${suffix}/package.json`); return true; } catch { /* not installed */ }
  }
  return false;
}
async function claudeExecutableOptions() {
  if (bundledClaudeAvailable()) return {};
  const installed = await resolveInstalledClaude().catch(() => null);
  if (!installed) throw new Error("Claude Code was not found. Install it (https://claude.com/claude-code, or `npm install -g @anthropic-ai/claude-code`), sign in with `claude`, then restart Zevrin.");
  return { pathToClaudeCodeExecutable: installed };
}

function sdkLoadMessage(error) {
  const text = error?.message || String(error);
  if (/Cannot find package|ERR_MODULE_NOT_FOUND|Cannot find module/.test(text)) {
    return "The Claude Agent SDK is not installed. Run `npm install` in the Zevrin folder (it adds @anthropic-ai/claude-agent-sdk and the Claude Code runtime for your platform), then restart Zevrin.";
  }
  return "The Claude Agent SDK could not be loaded: " + text;
}

// Async queue used as the SDK's streaming prompt so one process handles a whole conversation.
class MessageQueue {
  constructor() { this.items = []; this.waiters = []; this.closed = false; }
  push(item) {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value: item, done: false }); else this.items.push(item);
  }
  close() {
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) waiter({ value: undefined, done: true });
  }
  [Symbol.asyncIterator]() {
    return {
      next: () => {
        if (this.items.length > 0) return Promise.resolve({ value: this.items.shift(), done: false });
        if (this.closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise(resolve => this.waiters.push(resolve));
      },
      return: () => { this.close(); return Promise.resolve({ value: undefined, done: true }); },
    };
  }
}

const forwardedTypes = new Set(["system", "assistant", "user", "stream_event", "result", "auth_status", "tool_use_summary"]);
const maxStringLength = 60000;
const effortLevels = new Set(["low", "medium", "high", "xhigh", "max"]);

// Keeps IPC payloads bounded: tool results and file contents can be very large.
function trimValue(value, depth = 0) {
  if (typeof value === "string") return value.length > maxStringLength ? value.slice(0, maxStringLength) + `\n… [${value.length - maxStringLength} more characters]` : value;
  if (Array.isArray(value)) return depth > 12 ? [] : value.map(item => trimValue(item, depth + 1));
  if (value && typeof value === "object") {
    if (depth > 12) return {};
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      if (typeof item === "function" || key === "tool_use_result") continue;
      out[key] = trimValue(item, depth + 1);
    }
    return out;
  }
  return value;
}

// Validates a user message body coming from the renderer: a string, or text and image blocks.
function normalizeContent(content) {
  if (typeof content === "string") {
    if (!content.trim() || content.length > 200000) throw new Error("Enter a message.");
    return content;
  }
  if (!Array.isArray(content) || content.length === 0 || content.length > 20) throw new Error("Enter a message.");
  const blocks = content.map(block => {
    if (!block || typeof block !== "object") throw new Error("Invalid message block.");
    if (block.type === "text") {
      if (typeof block.text !== "string" || block.text.length > 200000) throw new Error("Invalid text block.");
      return { type: "text", text: block.text };
    }
    if (block.type === "image") {
      const source = block.source || {};
      if (source.type !== "base64" || !/^image\/(png|jpeg|gif|webp)$/.test(source.media_type || "") || typeof source.data !== "string" || source.data.length > 12 * 1024 * 1024) throw new Error("Invalid image block.");
      return { type: "image", source: { type: "base64", media_type: source.media_type, data: source.data } };
    }
    throw new Error("Unsupported message block: " + block.type);
  });
  if (!blocks.some(block => block.type === "image" || block.text.trim())) throw new Error("Enter a message.");
  return blocks;
}

class AgentSession {
  constructor({ id, cwd, webContents, permissionMode, resume, model, effort, mcpServers }) {
    this.id = id;
    this.cwd = cwd;
    this.webContents = webContents;
    this.permissionMode = permissionMode;
    this.resume = resume;
    this.model = model;
    this.effort = effort;
    this.mcpServers = mcpServers;
    this.queue = new MessageQueue();
    this.pending = new Map();
    this.abort = new AbortController();
    this.query = null;
    this.finished = false;
    this.infoSent = false;
  }

  emit(event) {
    if (!this.webContents.isDestroyed()) this.webContents.send("zevrin:agent-event", this.id, event);
  }

  async run() {
    let sdk;
    try { sdk = await loadSdk(); }
    catch (error) {
      this.emit({ type: "error", message: sdkLoadMessage(error) });
      this.emit({ type: "closed", reason: "sdk" });
      this.finished = true;
      return;
    }
    let executable;
    try { executable = await claudeExecutableOptions(); }
    catch (error) {
      this.emit({ type: "error", message: error.message });
      this.emit({ type: "closed", reason: "sdk" });
      this.finished = true;
      return;
    }
    const options = {
      ...executable,
      cwd: this.cwd,
      includePartialMessages: true,
      settingSources: ["user", "project", "local"],
      abortController: this.abort,
      canUseTool: (toolName, input, { signal, suggestions }) => this.askPermission(toolName, input, suggestions, signal),
    };
    if (this.permissionMode === "bypassPermissions") { options.permissionMode = "bypassPermissions"; options.allowDangerouslySkipPermissions = true; }
    else if (this.permissionMode) options.permissionMode = this.permissionMode;
    if (this.resume) options.resume = this.resume;
    if (this.model) options.model = this.model;
    if (this.effort) options.effort = this.effort;
    if (this.mcpServers) options.mcpServers = this.mcpServers;
    try {
      this.query = sdk.query({ prompt: this.queue, options });
      this.emit({ type: "started" });
      for await (const message of this.query) {
        if (!message || !forwardedTypes.has(message.type)) continue;
        this.emit({ type: "message", message: trimValue(message) });
        if (message.type === "system" && message.subtype === "init" && !this.infoSent) { this.infoSent = true; this.sendInfo(); }
      }
      this.emit({ type: "closed", reason: "ended" });
    } catch (error) {
      if (!this.abort.signal.aborted) this.emit({ type: "error", message: error?.message || String(error) });
      this.emit({ type: "closed", reason: this.abort.signal.aborted ? "stopped" : "error" });
    } finally {
      this.finished = true;
      for (const { resolve } of this.pending.values()) resolve({ behavior: "deny", message: "The session ended." });
      this.pending.clear();
    }
  }

  // Models, slash commands, account and MCP status: fetched once the process is initialised.
  async sendInfo() {
    if (!this.query) return;
    const safe = promise => promise.catch(() => undefined);
    const [models, commands, account, mcp] = await Promise.all([safe(this.query.supportedModels()), safe(this.query.supportedCommands()), safe(this.query.accountInfo()), safe(this.query.mcpServerStatus())]);
    this.emit({ type: "info", models: trimValue(models || []), commands: trimValue((commands || []).map(command => ({ name: command.name, description: command.description, argumentHint: command.argumentHint || "" }))), account: trimValue(account || {}), mcp: trimValue((mcp || []).map(server => ({ name: server.name, status: server.status, error: server.error }))), effort: this.effort || null });
  }

  askPermission(toolName, input, suggestions, signal) {
    return new Promise(resolve => {
      const requestId = randomUUID();
      const finish = result => { if (this.pending.delete(requestId)) { resolve(result); this.emit({ type: "permission_resolved", requestId }); } };
      this.pending.set(requestId, { resolve: finish, suggestions: suggestions || [] });
      signal?.addEventListener("abort", () => finish({ behavior: "deny", message: "The request was cancelled." }), { once: true });
      this.emit({ type: "permission", requestId, toolName, input: trimValue(input), suggestions: trimValue(suggestions || []) });
    });
  }

  respond(requestId, decision) {
    const pending = this.pending.get(requestId);
    if (!pending) return false;
    if (decision === "allow") pending.resolve({ behavior: "allow", updatedInput: undefined });
    else if (decision === "allow_always") pending.resolve({ behavior: "allow", updatedPermissions: pending.suggestions.length ? pending.suggestions : undefined });
    else pending.resolve({ behavior: "deny", message: "The user declined this action in Zevrin." });
    return true;
  }

  send(content) {
    if (this.finished) throw new Error("This agent session has ended. Start a new one.");
    this.queue.push({ type: "user", message: { role: "user", content: normalizeContent(content) }, parent_tool_use_id: null, session_id: this.resume || "" });
  }

  async interrupt() {
    if (this.query && !this.finished) await this.query.interrupt().catch(() => {});
  }

  async setPermissionMode(mode) {
    this.permissionMode = mode;
    if (this.query && !this.finished) await this.query.setPermissionMode(mode);
  }

  async setModel(model) {
    this.model = model || undefined;
    if (this.query && !this.finished) await this.query.setModel(model || undefined);
  }

  stop() {
    this.queue.close();
    this.abort.abort();
    for (const { resolve } of this.pending.values()) resolve({ behavior: "deny", message: "The session was stopped." });
    this.pending.clear();
  }
}

class AgentBridge {
  constructor() { this.sessions = new Map(); }

  start({ id, cwd, webContents, permissionMode, resume, model, effort, mcpServers }) {
    this.stop(id);
    const session = new AgentSession({ id, cwd, webContents, permissionMode, resume, model, effort: effortLevels.has(effort) ? effort : undefined, mcpServers });
    this.sessions.set(id, session);
    session.run().finally(() => { if (this.sessions.get(id) === session) this.sessions.delete(id); });
    return session;
  }

  get(id, webContents) {
    const session = this.sessions.get(id);
    if (!session || (webContents && session.webContents !== webContents)) return null;
    return session;
  }

  stop(id) {
    const session = this.sessions.get(id);
    if (!session) return false;
    session.stop();
    this.sessions.delete(id);
    return true;
  }

  stopAll() {
    for (const id of [...this.sessions.keys()]) this.stop(id);
  }

  stopForWebContents(webContents) {
    for (const [id, session] of [...this.sessions]) if (session.webContents === webContents) this.stop(id);
  }

  // Past conversations for a project, newest first.
  async listSessions(cwd, limit = 30) {
    const sdk = await loadSdk();
    const sessions = await sdk.listSessions({ dir: cwd, limit });
    return (sessions || []).map(session => ({ sessionId: session.sessionId, summary: session.customTitle || session.summary || "", lastModified: session.lastModified }));
  }

  // Transcript of a past conversation, trimmed for IPC. System messages are skipped.
  async sessionMessages(cwd, sessionId) {
    const sdk = await loadSdk();
    const messages = await sdk.getSessionMessages(sessionId, { dir: cwd });
    return (messages || []).filter(item => item && (item.type === "user" || item.type === "assistant")).map(item => trimValue({ type: item.type, message: item.message, parent_tool_use_id: item.parent_tool_use_id ?? null, uuid: item.uuid }));
  }
}

module.exports = { AgentBridge, MessageQueue, trimValue, normalizeContent, sdkLoadMessage, loadSdk, setClaudeResolver, claudeExecutableOptions };
