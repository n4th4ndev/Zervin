// Codex sessions through the official @openai/codex-sdk (it drives the codex CLI with `exec --experimental-json`).
// One thread per chat tile; events are forwarded to the renderer; history comes from ~/.codex/sessions rollouts.
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

let sdkPromise = null;
function loadSdk() {
  if (!sdkPromise) sdkPromise = import("@openai/codex-sdk").catch(error => { sdkPromise = null; throw new Error("The Codex SDK is not installed. Run `npm install` in the Zevrin folder. " + error.message); });
  return sdkPromise;
}

// Access modes, like the Codex extension: read-only chat, agent in the workspace, agent with full access.
const accessModes = {
  chat: { sandboxMode: "read-only", approvalPolicy: "never" },
  agent: { sandboxMode: "workspace-write", approvalPolicy: "never" },
  full: { sandboxMode: "danger-full-access", approvalPolicy: "never" },
};

class CodexSession {
  constructor({ id, cwd, webContents, codexPath, threadId, mode, model, effort }) {
    Object.assign(this, { id, cwd, webContents, codexPath, threadId: threadId || null, mode: accessModes[mode] ? mode : "agent", model: model || null, effort: effort || null });
    this.abort = null;
  }

  emit(event) { if (!this.webContents.isDestroyed()) this.webContents.send("zevrin:codex-event", this.id, event); }

  options() {
    return { workingDirectory: this.cwd, skipGitRepoCheck: true, ...accessModes[this.mode], ...(this.model ? { model: this.model } : {}), ...(this.effort ? { modelReasoningEffort: this.effort } : {}) };
  }

  async send(text, images = []) {
    if (this.abort) throw new Error("Codex is already working on this conversation.");
    const { Codex } = await loadSdk();
    const codex = new Codex(this.codexPath ? { codexPathOverride: this.codexPath } : {});
    const thread = this.threadId ? codex.resumeThread(this.threadId, this.options()) : codex.startThread(this.options());
    const input = images.length ? [{ type: "text", text }, ...images.map(file => ({ type: "local_image", path: file }))] : text;
    const controller = new AbortController();
    this.abort = controller;
    this.emit({ type: "zevrin.turn_started" });
    try {
      const { events } = await thread.runStreamed(input, { signal: controller.signal });
      for await (const event of events) {
        if (event.type === "thread.started") this.threadId = event.thread_id;
        this.emit(event);
      }
    } catch (error) {
      if (controller.signal.aborted) this.emit({ type: "zevrin.interrupted" });
      else this.emit({ type: "turn.failed", error: { message: String(error?.message || error) } });
    } finally {
      this.abort = null;
      this.emit({ type: "zevrin.turn_finished", threadId: this.threadId });
    }
  }

  interrupt() { if (this.abort) this.abort.abort(); }
}

function bundledCodexAvailable() {
  const triples = { darwin: { arm64: "darwin-arm64", x64: "darwin-x64" }, linux: { arm64: "linux-arm64", x64: "linux-x64" }, win32: { arm64: "win32-arm64", x64: "win32-x64" } };
  const triple = triples[process.platform]?.[process.arch];
  if (!triple) return false;
  try { require.resolve(`@openai/codex-${triple}/package.json`); return true; } catch { return false; }
}

class CodexBridge {
  constructor({ findCodex }) { this.sessions = new Map(); this.findCodex = findCodex; }

  async start({ id, cwd, webContents, threadId, mode, model, effort }) {
    const existing = this.sessions.get(id);
    if (existing) { existing.interrupt(); }
    const codexPath = await this.findCodex().catch(() => null);
    // The packaged app does not bundle the Codex binary (~150-370 MB): it uses the codex CLI installed on the Mac.
    if (!codexPath && !bundledCodexAvailable()) throw new Error("Codex was not found. Install it (`npm install -g @openai/codex` or `brew install codex`), sign in with `codex`, then try again.");
    const session = new CodexSession({ id, cwd, webContents, codexPath, threadId, mode, model, effort });
    this.sessions.set(id, session);
    return { threadId: session.threadId, codexPath: codexPath || "bundled" };
  }

  get(id) { const session = this.sessions.get(id); if (!session) throw new Error("This Codex conversation is not started."); return session; }
  configure(id, changes) { const session = this.get(id); if (changes.mode && accessModes[changes.mode]) session.mode = changes.mode; if ("model" in changes) session.model = changes.model || null; if ("effort" in changes) session.effort = changes.effort || null; if ("threadId" in changes) session.threadId = changes.threadId || null; return true; }
  stop(id) { const session = this.sessions.get(id); if (session) { session.interrupt(); this.sessions.delete(id); } }
  stopForWebContents(webContents) { for (const [id, session] of this.sessions) if (session.webContents === webContents) this.stop(id); }
  stopAll() { for (const id of [...this.sessions.keys()]) this.stop(id); }
}

// ----- History: ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl -----

function textOf(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map(part => (part && typeof part.text === "string" ? part.text : "")).join("");
}

const hiddenUserText = /^\s*<(environment_context|user_instructions|permissions|collaboration_mode)/;

// Reads one rollout file: id, cwd, time and the visible conversation (user and assistant messages).
function parseRollout(text) {
  const result = { id: null, cwd: null, timestamp: null, messages: [] };
  for (const line of String(text).split("\n")) {
    if (!line.trim()) continue;
    let record;
    try { record = JSON.parse(line); } catch { continue; }
    const payload = record.payload && typeof record.payload === "object" ? record.payload : record;
    if (record.type === "session_meta" || (payload.id && payload.cwd && !result.id)) { result.id = result.id || payload.id || null; result.cwd = result.cwd || payload.cwd || null; result.timestamp = result.timestamp || payload.timestamp || record.timestamp || null; continue; }
    if (payload.type === "user_message" && typeof payload.message === "string") { if (!hiddenUserText.test(payload.message)) result.messages.push({ role: "user", text: payload.message }); continue; }
    if (payload.type === "agent_message" && typeof payload.message === "string") { result.messages.push({ role: "assistant", text: payload.message }); continue; }
    if (record.type === "response_item" && payload.type === "message" && !result.messages.length) {
      const content = textOf(payload.content);
      if (payload.role === "user" && content && !hiddenUserText.test(content)) result.messages.push({ role: "user", text: content });
    }
  }
  // Rollouts carry both event_msg and response_item copies; keep consecutive duplicates once.
  result.messages = result.messages.filter((message, index, all) => index === 0 || message.role !== all[index - 1].role || message.text !== all[index - 1].text);
  return result;
}

async function listRolloutFiles(root, limit = 300) {
  const files = [];
  const walk = async (dir, depth) => {
    let entries;
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
    entries.sort((a, b) => b.name.localeCompare(a.name));
    for (const entry of entries) {
      if (files.length >= limit) return;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory() && depth < 3) await walk(full, depth + 1);
      else if (entry.isFile() && /^rollout-.*\.jsonl$/.test(entry.name)) files.push(full);
    }
  };
  await walk(root, 0);
  return files;
}

async function listCodexThreads(cwd, { home = os.homedir(), limit = 40 } = {}) {
  const root = path.join(process.env.CODEX_HOME || path.join(home, ".codex"), "sessions");
  const threads = [];
  for (const file of await listRolloutFiles(root)) {
    let head;
    try { const handle = await fsp.open(file, "r"); const buffer = Buffer.alloc(64 * 1024); const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0); await handle.close(); head = buffer.subarray(0, bytesRead).toString("utf8"); } catch { continue; }
    const parsed = parseRollout(head);
    if (!parsed.id || (cwd && parsed.cwd && path.resolve(parsed.cwd) !== path.resolve(cwd))) continue;
    const first = parsed.messages.find(message => message.role === "user");
    const stat = await fsp.stat(file).catch(() => null);
    threads.push({ threadId: parsed.id, summary: first ? first.text.split("\n")[0].slice(0, 100) : "Untitled", lastModified: stat ? stat.mtimeMs : Date.now(), file });
    if (threads.length >= limit) break;
  }
  return threads.sort((a, b) => b.lastModified - a.lastModified);
}

async function codexThreadMessages(file) {
  if (typeof file !== "string" || !file.endsWith(".jsonl")) return [];
  return parseRollout(await fsp.readFile(file, "utf8")).messages;
}

module.exports = { CodexBridge, accessModes, parseRollout, listCodexThreads, codexThreadMessages };
