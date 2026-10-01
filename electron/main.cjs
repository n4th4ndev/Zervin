const { app, BrowserWindow, desktopCapturer, systemPreferences, utilityProcess, webContents: webContentsModule, Menu, ipcMain, dialog, shell } = require("electron");
const path = require("node:path");
const { FlowBackdrop } = require("./flow-backdrop.cjs");
const { migrateDataFolder, previousMcpServerName } = require("./legacy-migration.cjs");
const { CheckpointStore } = require("./checkpoints.cjs");
const os = require("node:os");
const fs = require("node:fs/promises");
const fsSync = require("node:fs");
const net = require("node:net");
const { spawn, execFile } = require("node:child_process");
const http = require("node:http");
const { randomUUID } = require("node:crypto");
const pty = require("node-pty");
const { parseGitWorktrees, worktreeSummary, finishWorktree, branchChanges, branchFile } = require("./git-worktrees.cjs");
const { parseStatusOutput, parseBranchList, parseLogOutput, isValidBranchName } = require("./git-status.cjs");
const { searchWorkspaceFiles, searchWorkspaceText } = require("./workspace-files.cjs");
const { AgentBridge, loadSdk: loadClaudeSdk, sdkLoadMessage, setClaudeResolver, claudeExecutableOptions } = require("./agent-bridge.cjs");
const { InlineEditor } = require("./inline-edit.cjs");
const { startMcpServer } = require("./mcp-server.cjs");
const { VscodeServer } = require("./vscode-server.cjs");
const { DeviceManager } = require("./devices.cjs");
const { previewSession } = require("./preview-agent.cjs");
const { CodexBridge, listCodexThreads, codexThreadMessages } = require("./codex-bridge.cjs");

app.setName("Zevrin");
migrateDataFolder(app);

// The local app service binds to 23779–23788 and falls back along that range when a port is busy.
const productionPorts = Array.from({ length: 10 }, (_, index) => 23779 + index);
const projectRoot = path.resolve(__dirname, "..");
let localServer = null;
let appUrl = process.env.ZEVRIN_DEV_URL || "";
const terminals = new Map();
const agents = new AgentBridge();
setClaudeResolver(() => findExecutable("claude"));
let mcpServer = null;
let vscodeServer = null;
const vscodePorts = Array.from({ length: 10 }, (_, index) => 23810 + index);
const mcpPorts = Array.from({ length: 10 }, (_, index) => 23789 + index);
const appCommands = new Map();
const appCommandTimeout = 20000;

// Runs an interface action (open a file, show a preview, …) in the renderer that owns `workspace` (or the visible one).
function callApp(command, args, workspace) {
  const windows = BrowserWindow.getAllWindows().filter(window => !window.isDestroyed());
  if (windows.length === 0) return Promise.reject(new Error("Zevrin has no open window."));
  return new Promise((resolve, reject) => {
    const requestId = randomUUID();
    const timer = setTimeout(() => { appCommands.delete(requestId); reject(new Error("Zevrin did not answer. Is the workspace open?")); }, appCommandTimeout);
    appCommands.set(requestId, { resolve: value => { clearTimeout(timer); appCommands.delete(requestId); resolve(value); }, reject: error => { clearTimeout(timer); appCommands.delete(requestId); reject(error); } });
    for (const window of windows) window.webContents.send("zevrin:app-command", requestId, command, args, workspace);
  });
}

function mcpTokenPath() {
  return path.join(app.getPath("userData"), "mcp-token");
}

async function loadOrCreateMcpToken() {
  try {
    const token = (await fs.readFile(mcpTokenPath(), "utf8")).trim();
    if (/^[0-9a-f]{32,}$/.test(token)) return token;
  } catch { /* First launch. */ }
  const token = require("node:crypto").randomBytes(24).toString("hex");
  await fs.mkdir(path.dirname(mcpTokenPath()), { recursive: true });
  await fs.writeFile(mcpTokenPath(), token, { mode: 0o600 });
  return token;
}

async function startZevrinMcp() {
  try {
    mcpServer = await startMcpServer({ token: await loadOrCreateMcpToken(), ports: mcpPorts, callApp, log: message => console.warn(message) });
  } catch (error) {
    console.warn("Zevrin MCP server not started:", error.message);
  }
}

function mcpServersForSession(cwd) {
  if (!mcpServer) return undefined;
  return { zevrin: { type: "http", url: mcpServer.url, headers: { ...mcpServer.headers(), "X-Zevrin-Workspace": cwd } } };
}
const permissionModes = new Set(["default", "acceptEdits", "plan", "bypassPermissions", "dontAsk", "auto"]);
const aiCommands = { claude: "Claude Code", gemini: "Gemini CLI", codex: "Codex CLI", opencode: "OpenCode" };

async function findExecutable(command) {
  const home = os.homedir();
  const windows = process.platform === "win32";
  const directories = new Set([
    ...(process.env.PATH || "").split(path.delimiter).filter(Boolean),
    path.join(home, ".local/bin"), path.join(home, ".npm-global/bin"), path.join(home, ".bun/bin"), path.join(home, ".cargo/bin"),
    ...(windows
      ? [process.env.APPDATA && path.join(process.env.APPDATA, "npm"), process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Programs"), path.join(home, "scoop", "shims")].filter(Boolean)
      : ["/opt/homebrew/bin", "/usr/local/bin"]),
  ]);
  // Windows has no executable bit: look for the usual extensions, native binaries first.
  const names = windows ? [command + ".exe", command + ".cmd", command + ".bat", command] : [command];
  for (const directory of directories) {
    for (const name of names) {
      const candidate = path.join(directory, name);
      try {
        const stat = await fs.stat(candidate);
        if (stat.isFile() && (windows || stat.mode & 0o111)) return candidate;
      } catch { /* Continue through the user's PATH and common CLI install locations. */ }
    }
  }
  return null;
}

function shellQuote(value) {
  return "'" + value.replaceAll("'", "'\\''") + "'";
}

function portIsFree(port) {
  return new Promise(resolve => {
    const probe = net.createServer();
    probe.unref();
    probe.once("error", () => resolve(false));
    probe.listen({ port, host: "127.0.0.1" }, () => probe.close(() => resolve(true)));
  });
}

async function findFreePort() {
  for (const port of productionPorts) if (await portIsFree(port)) return port;
  throw new Error(`Ports ${productionPorts[0]}–${productionPorts.at(-1)} are all in use. Close another Zevrin window or free a port.`);
}

// A production build (`next build`) is served with `next start`; otherwise the dev server runs. ZEVRIN_DEV=1 forces dev mode.
function useProductionBuild() {
  if (process.env.ZEVRIN_DEV === "1") return false;
  return app.isPackaged || fsSync.existsSync(path.join(projectRoot, ".next", "BUILD_ID")) || fsSync.existsSync(path.join(projectRoot, ".next", "standalone", "server.js"));
}

async function startLocalServer() {
  if (appUrl) return;
  try { await launchLocalServer(true); }
  catch (error) {
    // Fallback: the app binary in Node mode (works everywhere, but macOS shows it as a second Dock icon).
    console.warn("[zevrin] utility process server failed, falling back:", error.message);
    stopLocalServer();
    await launchLocalServer(false);
  }
}

async function launchLocalServer(useUtility) {
  const port = await findFreePort();
  const production = useProductionBuild();
  // Production uses the self-contained server of `next build` (output: "standalone"), which is all the packaged app
  // ships; otherwise `next start` / `next dev` from the project's node_modules.
  const standaloneServer = path.join(projectRoot, ".next", "standalone", "server.js");
  const useStandalone = production && fsSync.existsSync(standaloneServer);
  const nextBin = useStandalone ? standaloneServer : require.resolve("next/dist/bin/next", { paths: [projectRoot] });
  const args = useStandalone ? [] : [production ? "start" : "dev", "-H", "127.0.0.1", "-p", String(port)];
  const env = { ...process.env, NODE_ENV: production ? "production" : "development", NEXT_TELEMETRY_DISABLED: "1", ...(useStandalone ? { PORT: String(port), HOSTNAME: "127.0.0.1" } : {}) };
  const cwd = useStandalone ? path.dirname(standaloneServer) : projectRoot;
  let serverError = "";
  if (useUtility && utilityProcess) {
    // A utility process (Electron's helper binary) runs Next.js without a second icon in the macOS Dock.
    const child = utilityProcess.fork(nextBin, args, { cwd, env, stdio: "pipe", serviceName: "Zevrin Server" });
    child.exitCode = null;
    child.on("exit", code => { child.exitCode = code ?? 0; });
    localServer = child;
  } else {
    localServer = spawn(process.execPath, [nextBin, ...args], { cwd, env: { ...env, ELECTRON_RUN_AS_NODE: "1" }, stdio: ["ignore", "pipe", "pipe"] });
  }
  const server = localServer;
  server.stderr?.on("data", chunk => { serverError = (serverError + chunk.toString()).slice(-6000); });
  server.stdout?.on("data", () => {});
  const url = `http://127.0.0.1:${port}`;
  await new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const probe = () => {
      if (server.exitCode !== null) return reject(new Error(serverError || `Next.js exited with code ${server.exitCode}.`));
      const request = http.get(url, response => {
        response.resume();
        if (response.statusCode && response.statusCode < 500) resolve();
        else setTimeout(probe, 300);
      });
      request.on("error", () => {
        if (Date.now() - startedAt > 90000) reject(new Error(serverError || "Timed out starting the local app server."));
        else setTimeout(probe, 300);
      });
      request.setTimeout(1000, () => request.destroy());
    };
    probe();
  });
  appUrl = url;
}

function stopLocalServer() {
  if (localServer && localServer.exitCode === null) localServer.kill();
  localServer = null;
}

async function resolveWorkspacePath(root, relativePath = "") {
  const absoluteRoot = await fs.realpath(root);
  const target = path.resolve(absoluteRoot, relativePath);
  if (target !== absoluteRoot && !target.startsWith(`${absoluteRoot}${path.sep}`)) throw new Error("Path is outside the selected workspace.");
  const realTarget = await fs.realpath(target);
  if (realTarget !== absoluteRoot && !realTarget.startsWith(`${absoluteRoot}${path.sep}`)) throw new Error("Path is outside the selected workspace.");
  return realTarget;
}

async function workspaceDirectory(root) {
  if (typeof root !== "string" || !path.isAbsolute(root)) throw new Error("Select a valid workspace first.");
  const cwd = await fs.realpath(root);
  if (!(await fs.stat(cwd)).isDirectory()) throw new Error("The workspace path is not a directory.");
  return cwd;
}

ipcMain.handle("zevrin:list-files", async (_event, root, relativePath = "") => {
  if (typeof root !== "string" || !path.isAbsolute(root)) throw new Error("Select a valid workspace first.");
  const target = await resolveWorkspacePath(root, relativePath);
  const entries = await fs.readdir(target, { withFileTypes: true });
  return entries.filter(entry => ![".git", "node_modules", ".next", "dist", "build"].includes(entry.name))
    .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
    .map(entry => ({ name: entry.name, path: path.relative(root, path.join(target, entry.name)), directory: entry.isDirectory() }));
});

ipcMain.handle("zevrin:search-files", async (_event, root, query) => {
  const cwd = await workspaceDirectory(root);
  if (typeof query !== "string" || query.length > 200) throw new Error("Enter a shorter search query.");
  return searchWorkspaceFiles(cwd, query, { limit: 40 });
});

ipcMain.handle("zevrin:search-text", async (_event, root, query, options) => {
  const cwd = await workspaceDirectory(root);
  if (typeof query !== "string" || query.length < 2 || query.length > 200) throw new Error("Enter at least two characters.");
  return searchWorkspaceText(cwd, query, { limit: 300, caseSensitive: Boolean(options && options.caseSensitive) });
});

ipcMain.handle("zevrin:read-file", async (_event, root, relativePath) => {
  if (typeof root !== "string" || !path.isAbsolute(root) || typeof relativePath !== "string") throw new Error("Select a valid workspace file.");
  const target = await resolveWorkspacePath(root, relativePath);
  const stat = await fs.stat(target);
  if (!stat.isFile() || stat.size > 1024 * 1024) throw new Error("This file is not a supported text file (maximum 1 MB).");
  return fs.readFile(target, "utf8");
});

ipcMain.handle("zevrin:write-file", async (_event, root, relativePath, contents) => {
  if (typeof root !== "string" || !path.isAbsolute(root) || typeof relativePath !== "string" || typeof contents !== "string") throw new Error("Invalid file update.");
  const target = await resolveWorkspacePath(root, relativePath);
  const stat = await fs.stat(target);
  if (!stat.isFile() || Buffer.byteLength(contents, "utf8") > 1024 * 1024) throw new Error("This file cannot be saved (maximum 1 MB).");
  await fs.writeFile(target, contents, "utf8");
  return true;
});

ipcMain.handle("zevrin:terminal-create", async (event, root) => {
  const cwd = await workspaceDirectory(root);
  const id = randomUUID();
  const shell = process.env.SHELL || (process.platform === "win32" ? "powershell.exe" : "/bin/zsh");
  const processHandle = pty.spawn(shell, [], {
    name: "xterm-256color",
    cols: 100,
    rows: 28,
    cwd,
    env: { ...process.env, TERM: "xterm-256color", COLORTERM: "truecolor", ZEVRIN: "1" },
  });
  terminals.set(id, { process: processHandle, webContents: event.sender, cwd });
  processHandle.onData(data => {
    if (!event.sender.isDestroyed()) event.sender.send("zevrin:terminal-data", id, data);
  });
  processHandle.onExit(({ exitCode }) => {
    terminals.delete(id);
    if (!event.sender.isDestroyed()) event.sender.send("zevrin:terminal-exit", id, exitCode);
  });
  return id;
});

ipcMain.handle("zevrin:ai-tools", async () => Promise.all(Object.entries(aiCommands).map(async ([id, name]) => ({ id, name, available: Boolean(await findExecutable(id)) }))));

ipcMain.handle("zevrin:ai-launch", async (event, root, id, terminalId) => {
  const name = Object.hasOwn(aiCommands, id) ? aiCommands[id] : null;
  if (!name || typeof terminalId !== "string") throw new Error("Select a supported AI assistant.");
  const cwd = await workspaceDirectory(root);
  const terminal = terminals.get(terminalId);
  if (!terminal || terminal.webContents !== event.sender || terminal.cwd !== cwd) throw new Error("Open the project terminal before starting an AI assistant.");
  const executable = await findExecutable(id);
  if (!executable) throw new Error(name + " was not found. Install its CLI and reopen Zevrin.");
  terminal.process.write(shellQuote(executable) + "\r");
  return true;
});

// ----- Agent chat sessions (Claude Code via the Claude Agent SDK) -----
// ----- Codex chat sessions (official @openai/codex-sdk, driving the user's codex CLI) -----
const codexAgents = new CodexBridge({ findCodex: () => findExecutable("codex") });
const codexTile = value => typeof value === "string" && /^[A-Za-z0-9-]{1,120}$/.test(value) ? value : null;
const codexOptions = options => ({
  threadId: typeof options?.threadId === "string" && /^[A-Za-z0-9-]{8,80}$/.test(options.threadId) ? options.threadId : null,
  mode: ["chat", "agent", "full"].includes(options?.mode) ? options.mode : "agent",
  model: typeof options?.model === "string" && /^[A-Za-z0-9._:-]{1,60}$/.test(options.model) ? options.model : null,
  effort: ["minimal", "low", "medium", "high", "xhigh", "max"].includes(options?.effort) ? options.effort : null,
});
ipcMain.handle("zevrin:codex-start", async (event, id, root, options) => {
  const tile = codexTile(id); if (!tile) throw new Error("Invalid Codex tile.");
  const cwd = await workspaceDirectory(root);
  return codexAgents.start({ id: tile, cwd, webContents: event.sender, ...codexOptions(options) });
});
ipcMain.handle("zevrin:codex-send", async (_event, id, text, images) => {
  const session = codexAgents.get(codexTile(id));
  if (typeof text !== "string" || text.length > 200000) throw new Error("Message too long.");
  const files = [];
  for (const image of Array.isArray(images) ? images.slice(0, 6) : []) {
    if (!image || typeof image.data !== "string") continue;
    const ext = String(image.mediaType || "").includes("jpeg") ? "jpg" : "png";
    const file = path.join(os.tmpdir(), `zevrin-codex-${Date.now()}-${files.length}.${ext}`);
    await fs.writeFile(file, Buffer.from(image.data, "base64"));
    files.push(file);
  }
  session.send(text, files).finally(() => files.forEach(file => fs.unlink(file).catch(() => {})));
  return true;
});
ipcMain.handle("zevrin:codex-interrupt", (_event, id) => { codexAgents.get(codexTile(id)).interrupt(); return true; });
ipcMain.handle("zevrin:codex-configure", (_event, id, changes) => { const clean = {}; if (changes && typeof changes === "object") { const options = codexOptions({ ...changes, mode: changes.mode ?? "agent" }); if ("mode" in changes) clean.mode = options.mode; if ("model" in changes) clean.model = options.model; if ("effort" in changes) clean.effort = options.effort; if ("threadId" in changes) clean.threadId = options.threadId; } return codexAgents.configure(codexTile(id), clean); });
ipcMain.handle("zevrin:codex-stop", (_event, id) => { codexAgents.stop(codexTile(id)); return true; });
ipcMain.handle("zevrin:codex-threads", async (_event, root) => listCodexThreads(await workspaceDirectory(root)));
ipcMain.handle("zevrin:codex-thread-messages", async (_event, root, threadId) => {
  const threads = await listCodexThreads(await workspaceDirectory(root), { limit: 200 });
  const thread = threads.find(item => item.threadId === threadId);
  return thread ? codexThreadMessages(thread.file) : [];
});

ipcMain.handle("zevrin:agent-start", async (event, id, root, options = {}) => {
  if (typeof id !== "string" || !id || id.length > 120) throw new Error("Invalid agent tile.");
  const cwd = await workspaceDirectory(root);
  const permissionMode = permissionModes.has(options.permissionMode) ? options.permissionMode : "default";
  const resume = typeof options.resume === "string" && /^[0-9a-f-]{8,64}$/i.test(options.resume) ? options.resume : undefined;
  const model = typeof options.model === "string" && /^[a-z0-9.\[\]-]{1,60}$/i.test(options.model) ? options.model : undefined;
  const effort = typeof options.effort === "string" ? options.effort : undefined;
  agents.start({ id, cwd, webContents: event.sender, permissionMode, resume, model, effort, mcpServers: mcpServersForSession(cwd) });
  return true;
});

ipcMain.handle("zevrin:agent-set-model", async (event, id, model) => {
  const session = agents.get(id, event.sender);
  if (!session) return false;
  if (model !== null && (typeof model !== "string" || !/^[a-z0-9.\[\]-]{1,60}$/i.test(model))) throw new Error("Invalid model.");
  await session.setModel(model || undefined);
  return true;
});

ipcMain.handle("zevrin:agent-sessions", async (_event, root) => {
  const cwd = await workspaceDirectory(root);
  return agents.listSessions(cwd);
});

ipcMain.handle("zevrin:agent-history", async (_event, root, sessionId) => {
  const cwd = await workspaceDirectory(root);
  if (typeof sessionId !== "string" || !/^[0-9a-f-]{8,64}$/i.test(sessionId)) throw new Error("Invalid session.");
  return agents.sessionMessages(cwd, sessionId);
});

// ----- Embedded VS Code server with the official Claude Code extension -----
function getVscodeServer() {
  if (!vscodeServer) {
    vscodeServer = new VscodeServer({ dataDir: path.join(app.getPath("userData"), "vscode"), ports: vscodePorts, log: message => console.log(message) });
    vscodeServer.onProgress(event => { for (const window of BrowserWindow.getAllWindows()) if (!window.isDestroyed()) window.webContents.send("zevrin:vscode-progress", event); });
  }
  return vscodeServer;
}

ipcMain.handle("zevrin:vscode-status", async () => getVscodeServer().status());

const agentId = value => typeof value === "string" && /^[a-z]{2,20}$/.test(value) ? value : "claude";
const tileInstance = value => typeof value === "string" && /^[A-Za-z0-9-]{1,80}$/.test(value) ? value : "";
ipcMain.handle("zevrin:vscode-setup", async (_event, agent) => {
  const server = getVscodeServer();
  await server.setup(agentId(agent));
  return server.status();
});

ipcMain.handle("zevrin:vscode-url", async (_event, root, agent, instance) => {
  const cwd = await workspaceDirectory(root);
  const server = getVscodeServer();
  if (!server.serverInstalled()) return null;
  await server.start();
  return server.urlForTile(cwd, agentId(agent), tileInstance(instance));
});

ipcMain.handle("zevrin:vscode-command", async (_event, root, agent, action, instance) => {
  const cwd = await workspaceDirectory(root);
  if (!["open", "chatOnly", "widen", "closeEditors", "diagnose"].includes(action)) throw new Error("Unknown command.");
  return getVscodeServer().sendCommand(cwd, agentId(agent), action, 8000, tileInstance(instance));
});

ipcMain.handle("zevrin:vscode-diagnose", async (_event, root, agent, instance) => {
  const cwd = await workspaceDirectory(root);
  const server = getVscodeServer();
  const answered = await server.sendCommand(cwd, agentId(agent), "diagnose", 12000, tileInstance(instance));
  const report = await server.readDiagnostic(cwd, agentId(agent), tileInstance(instance));
  return { answered, report, serverLog: (await server.serverLogTail(3000)) || null };
});

ipcMain.handle("zevrin:vscode-install-vsix", async (event, agent) => {
  const parent = BrowserWindow.fromWebContents(event.sender);
  const result = await dialog.showOpenDialog(parent, { title: "Choose the extension's .vsix", properties: ["openFile"], filters: [{ name: "VS Code extension", extensions: ["vsix"] }] });
  if (result.canceled || !result.filePaths[0]) return null;
  const server = getVscodeServer();
  await server.ensureServer();
  await server.installVsix(result.filePaths[0], agentId(agent));
  await server.writeBootstrap();
  return server.status();
});

ipcMain.handle("zevrin:vscode-restart", async () => {
  const server = getVscodeServer();
  server.stop();
  await server.start();
  return server.status();
});

ipcMain.handle("zevrin:mcp-info", async () => mcpServer ? { url: mcpServer.url, command: mcpServer.claudeMcpAddCommand(), token: mcpServer.token } : null);

ipcMain.handle("zevrin:app-command-result", async (_event, requestId, result, error) => {
  const pending = appCommands.get(requestId);
  if (!pending) return false;
  if (error) pending.reject(new Error(typeof error === "string" ? error : "The command failed.")); else pending.resolve(result);
  return true;
});

ipcMain.handle("zevrin:agent-send", async (event, id, text) => {
  const session = agents.get(id, event.sender);
  if (!session) throw new Error("This agent session is not running.");
  session.send(text);
  return true;
});

ipcMain.handle("zevrin:agent-respond", async (event, id, requestId, decision) => {
  const session = agents.get(id, event.sender);
  if (!session || typeof requestId !== "string") return false;
  return session.respond(requestId, decision === "allow" || decision === "allow_always" ? decision : "deny");
});

ipcMain.handle("zevrin:agent-interrupt", async (event, id) => {
  const session = agents.get(id, event.sender);
  if (session) await session.interrupt();
  return Boolean(session);
});

ipcMain.handle("zevrin:agent-set-mode", async (event, id, mode) => {
  const session = agents.get(id, event.sender);
  if (!session || !permissionModes.has(mode) || mode === "bypassPermissions") return false;
  await session.setPermissionMode(mode);
  return true;
});

ipcMain.handle("zevrin:agent-stop", async (event, id) => {
  const session = agents.get(id, event.sender);
  return session ? agents.stop(id) : false;
});

ipcMain.on("zevrin:terminal-write", (event, id, data) => {
  const terminal = terminals.get(id);
  if (terminal?.webContents === event.sender && typeof data === "string" && data.length <= 65536) terminal.process.write(data);
});

ipcMain.on("zevrin:terminal-resize", (event, id, cols, rows) => {
  const terminal = terminals.get(id);
  if (terminal?.webContents === event.sender && Number.isInteger(cols) && Number.isInteger(rows)) {
    terminal.process.resize(Math.max(20, Math.min(cols, 500)), Math.max(5, Math.min(rows, 200)));
  }
});

ipcMain.on("zevrin:terminal-close", (event, id) => {
  const terminal = terminals.get(id);
  if (terminal?.webContents === event.sender) { terminal.process.kill(); terminals.delete(id); }
});

function runGit(cwd, args, okCodes = [0]) {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" } }, (error, stdout, stderr) => {
      const code = error ? (typeof error.code === "number" ? error.code : -1) : 0;
      if (okCodes.includes(code)) resolve(stdout);
      else reject(new Error(stderr.trim() || error?.message || `git exited with code ${code}`));
    });
  });
}

async function gitWorkspace(root) {
  return workspaceDirectory(root);
}

async function gitRepository(root) {
  const cwd = await gitWorkspace(root);
  const inside = await runGit(cwd, ["rev-parse", "--is-inside-work-tree"], [0, 128]).catch(() => "");
  if (inside.trim() !== "true") throw new Error("This folder is not a Git repository.");
  return cwd;
}

// Deleted files cannot be realpath'd, so git paths are checked lexically; git itself also refuses paths outside the repository.
function gitPaths(cwd, paths) {
  if (!Array.isArray(paths) || paths.length === 0 || paths.length > 5000) throw new Error("Select at least one file.");
  return paths.map(item => {
    if (typeof item !== "string" || !item || item.startsWith("-") || path.isAbsolute(item)) throw new Error("Invalid file path.");
    const target = path.resolve(cwd, item);
    if (!target.startsWith(`${cwd}${path.sep}`)) throw new Error("Path is outside the selected workspace.");
    return item;
  });
}

function branchName(branch) {
  if (!isValidBranchName(branch)) throw new Error("Enter a valid branch name.");
  return branch;
}

ipcMain.handle("zevrin:git-status", async (_event, root) => {
  const cwd = await gitWorkspace(root);
  const inside = await runGit(cwd, ["rev-parse", "--is-inside-work-tree"], [0, 128]).catch(() => "");
  if (inside.trim() !== "true") return { isRepo: false, branch: null, upstream: null, ahead: 0, behind: 0, unborn: false, changes: [] };
  const output = await runGit(cwd, ["status", "--porcelain=v1", "--branch", "--untracked-files=all", "-z"]);
  return parseStatusOutput(output);
});

ipcMain.handle("zevrin:git-diff", async (_event, root, file, staged) => {
  const cwd = await gitWorkspace(root);
  const [target] = gitPaths(cwd, [file]);
  if (staged) return runGit(cwd, ["diff", "--no-color", "--no-ext-diff", "--cached", "--", target]);
  const tracked = await runGit(cwd, ["ls-files", "--error-unmatch", "--", target], [0, 1]).then(output => output.trim() !== "");
  if (tracked) return runGit(cwd, ["diff", "--no-color", "--no-ext-diff", "--", target]);
  const stat = await fs.stat(path.join(cwd, target));
  if (stat.size > 1024 * 1024) return "Untracked file is larger than 1 MB; diff not shown.";
  return runGit(cwd, ["diff", "--no-color", "--no-ext-diff", "--no-index", "--", "/dev/null", target], [0, 1]);
});

// Original and modified contents of a file for a side-by-side diff. Unstaged: index vs working tree; staged: HEAD vs index.
ipcMain.handle("zevrin:git-file-versions", async (_event, root, file, staged) => {
  const cwd = await gitRepository(root);
  const [target] = gitPaths(cwd, [file]);
  const show = async ref => { try { return await runGit(cwd, ["show", ref + ":" + target]); } catch { return null; } };
  const readWorking = async () => { try { const stat = await fs.stat(path.join(cwd, target)); if (!stat.isFile() || stat.size > 2 * 1024 * 1024) return null; return await fs.readFile(path.join(cwd, target), "utf8"); } catch { return null; } };
  if (staged) {
    const hasHead = await runGit(cwd, ["rev-parse", "--verify", "--quiet", "HEAD"], [0, 1]).then(output => output.trim() !== "");
    return { original: hasHead ? (await show("HEAD")) ?? "" : "", modified: (await show("")) ?? "" };
  }
  const tracked = await runGit(cwd, ["ls-files", "--error-unmatch", "--", target], [0, 1]).then(output => output.trim() !== "");
  return { original: tracked ? (await show("")) ?? "" : "", modified: (await readWorking()) ?? "" };
});

ipcMain.handle("zevrin:git-stage", async (_event, root, paths) => {
  const cwd = await gitWorkspace(root);
  await runGit(cwd, ["add", "--all", "--", ...gitPaths(cwd, paths)]);
  return true;
});

ipcMain.handle("zevrin:git-unstage", async (_event, root, paths) => {
  const cwd = await gitWorkspace(root);
  const targets = gitPaths(cwd, paths);
  const hasHead = await runGit(cwd, ["rev-parse", "--verify", "--quiet", "HEAD"], [0, 1]).then(output => output.trim() !== "");
  await runGit(cwd, hasHead ? ["restore", "--staged", "--", ...targets] : ["rm", "--cached", "-r", "--quiet", "--", ...targets]);
  return true;
});

// Discards working-tree changes: tracked files return to their index version, untracked files are deleted.
ipcMain.handle("zevrin:git-discard", async (_event, root, paths) => {
  const cwd = await gitRepository(root);
  const targets = gitPaths(cwd, paths);
  const trackedOutput = await runGit(cwd, ["ls-files", "-z", "--", ...targets]);
  const tracked = new Set(trackedOutput.split("\0").filter(Boolean));
  const trackedTargets = targets.filter(target => tracked.has(target));
  const untrackedTargets = targets.filter(target => !tracked.has(target));
  if (trackedTargets.length > 0) await runGit(cwd, ["checkout", "--", ...trackedTargets]);
  if (untrackedTargets.length > 0) await runGit(cwd, ["clean", "-f", "-q", "--", ...untrackedTargets]);
  return true;
});

ipcMain.handle("zevrin:git-commit", async (_event, root, message) => {
  const cwd = await gitWorkspace(root);
  if (typeof message !== "string" || !message.trim() || message.length > 20000) throw new Error("Enter a commit message.");
  await runGit(cwd, ["commit", "-m", message.trim()]);
  return true;
});

ipcMain.handle("zevrin:git-init", async (_event, root) => {
  const cwd = await gitWorkspace(root);
  await runGit(cwd, ["init"]);
  return true;
});

ipcMain.handle("zevrin:git-branches", async (_event, root) => {
  const cwd = await gitRepository(root);
  const output = await runGit(cwd, ["for-each-ref", "--sort=-committerdate", "--format=%(refname:short)%00%(HEAD)%00%(upstream:short)", "refs/heads"]);
  return parseBranchList(output);
});

ipcMain.handle("zevrin:git-checkout", async (_event, root, branch, create) => {
  const cwd = await gitRepository(root);
  const name = branchName(branch);
  await runGit(cwd, create === true ? ["checkout", "-b", name] : ["checkout", name]);
  return true;
});

ipcMain.handle("zevrin:git-log", async (_event, root) => {
  const cwd = await gitRepository(root);
  const hasHead = await runGit(cwd, ["rev-parse", "--verify", "--quiet", "HEAD"], [0, 1]).then(output => output.trim() !== "");
  if (!hasHead) return [];
  return parseLogOutput(await runGit(cwd, ["log", "-n", "40", "--format=%H%x00%h%x00%s%x00%an%x00%cr"]));
});

ipcMain.handle("zevrin:git-fetch", async (_event, root) => {
  const cwd = await gitRepository(root);
  await runGit(cwd, ["fetch", "--prune"]);
  return true;
});

ipcMain.handle("zevrin:git-pull", async (_event, root) => {
  const cwd = await gitRepository(root);
  await runGit(cwd, ["pull", "--ff-only"]);
  return true;
});

ipcMain.handle("zevrin:git-push", async (_event, root) => {
  const cwd = await gitRepository(root);
  const branch = (await runGit(cwd, ["branch", "--show-current"])).trim();
  if (!branch) throw new Error("Check out a branch before pushing.");
  const upstream = (await runGit(cwd, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"], [0, 128])).trim();
  if (upstream && !upstream.includes("@{")) { await runGit(cwd, ["push"]); return true; }
  const remotes = (await runGit(cwd, ["remote"])).split(/\r?\n/).filter(Boolean);
  if (remotes.length === 0) throw new Error("This repository has no remote. Add one with `git remote add origin <url>` first.");
  await runGit(cwd, ["push", "-u", remotes.includes("origin") ? "origin" : remotes[0], branch]);
  return true;
});

ipcMain.handle("zevrin:git-worktrees", async (_event, root) => {
  const cwd = await gitWorkspace(root);
  const inside = await runGit(cwd, ["rev-parse", "--is-inside-work-tree"], [0, 128]).catch(() => "");
  if (inside.trim() !== "true") return [];
  const output = await runGit(cwd, ["worktree", "list", "--porcelain"]);
  return parseGitWorktrees(output, cwd);
});

ipcMain.handle("zevrin:git-worktree-create", async (_event, root, branch) => {
  const cwd = await gitRepository(root);
  const name = branchName(branch);
  const checkedBranch = (await runGit(cwd, ["check-ref-format", "--branch", name])).trim();
  if (checkedBranch !== name) throw new Error("Enter a valid worktree branch name.");
  const worktreeRoot = path.join(path.dirname(cwd), path.basename(cwd) + "-worktrees");
  const destination = path.join(worktreeRoot, ...name.split("/"));
  await fs.mkdir(path.dirname(destination), { recursive: true });
  try {
    await fs.lstat(destination);
    throw new Error("A worktree folder already exists at " + destination + ".");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  await runGit(cwd, ["worktree", "add", "-b", name, "--", destination, "HEAD"]);
  return { path: destination, branch: name };
});

ipcMain.handle("zevrin:git-worktree-remove", async (_event, root, worktreePath, force) => {
  const cwd = await gitRepository(root);
  if (typeof worktreePath !== "string" || !path.isAbsolute(worktreePath)) throw new Error("Select a worktree to remove.");
  const worktrees = parseGitWorktrees(await runGit(cwd, ["worktree", "list", "--porcelain"]), cwd);
  const worktree = worktrees.find(item => item.path === worktreePath);
  if (!worktree) throw new Error("This worktree is no longer registered.");
  if (worktree.current) throw new Error("Open another workspace before removing the current worktree.");
  if (worktree.bare) throw new Error("The main repository cannot be removed.");
  await runGit(cwd, ["worktree", "remove", ...(force === true ? ["--force"] : []), "--", worktreePath]);
  await runGit(cwd, ["worktree", "prune"]);
  return true;
});

// What an agent's worktree holds compared with the project: uncommitted files, commits ahead, changed lines.
ipcMain.handle("zevrin:git-worktree-summary", async (_event, root, worktreePath, branch) => {
  const cwd = await gitRepository(root);
  if (typeof worktreePath !== "string" || !path.isAbsolute(worktreePath)) throw new Error("Select a worktree.");
  return worktreeSummary(runGit, cwd, worktreePath, branchName(branch));
});

// Ends an agent's worktree: merge its branch into the project's current branch, keep the branch, or discard all.
ipcMain.handle("zevrin:git-worktree-finish", async (_event, root, worktreePath, branch, mode) => {
  const cwd = await gitRepository(root);
  if (typeof worktreePath !== "string" || !path.isAbsolute(worktreePath)) throw new Error("Select a worktree.");
  const worktrees = parseGitWorktrees(await runGit(cwd, ["worktree", "list", "--porcelain"]), cwd);
  if (!worktrees.some(item => item.path === worktreePath && !item.current && !item.bare)) throw new Error("This worktree is no longer registered.");
  return finishWorktree(runGit, cwd, worktreePath, branchName(branch), mode);
});

ipcMain.handle("zevrin:git-branch-changes", async (_event, root, branch, worktreePath) => {
  const cwd = await gitRepository(root);
  const tree = typeof worktreePath === "string" && path.isAbsolute(worktreePath) ? worktreePath : null;
  return branchChanges(runGit, cwd, branchName(branch), tree);
});

ipcMain.handle("zevrin:git-branch-file", async (_event, root, branch, file, worktreePath, uncommitted) => {
  const cwd = await gitRepository(root);
  if (typeof file !== "string" || !file || file.includes("\0") || path.isAbsolute(file) || file.split(/[\\/]/).includes("..")) throw new Error("Select a file.");
  const tree = typeof worktreePath === "string" && path.isAbsolute(worktreePath) ? worktreePath : null;
  const readFile = async (dir, relative) => { const target = path.join(dir, relative); const stat = await fs.stat(target); if (stat.size > 2 * 1024 * 1024) return ""; return fs.readFile(target, "utf8"); };
  return branchFile(runGit, cwd, branchName(branch), file, tree, uncommitted === true, readFile);
});

ipcMain.handle("zevrin:select-folder", async event => {
  const parent = BrowserWindow.fromWebContents(event.sender);
  const result = await dialog.showOpenDialog(parent, {
    properties: ["openDirectory", "createDirectory"],
    title: "Select Project Folder",
    buttonLabel: "Open",
  });
  return result.canceled ? null : result.filePaths[0] || null;
});

ipcMain.handle("zevrin:reveal-path", async (_event, root, relativePath = "") => {
  const target = await resolveWorkspacePath(root, relativePath);
  shell.showItemInFolder(target);
  return true;
});

ipcMain.handle("zevrin:open-external", async (_event, url) => {
  if (typeof url !== "string" || !/^https?:\/\//i.test(url) || url.length > 2048) throw new Error("Only http(s) links can be opened.");
  await shell.openExternal(url);
  return true;
});

ipcMain.handle("zevrin:clone-repository", async (_event, repoUrl) => {
  if (typeof repoUrl !== "string" || !repoUrl.trim() || repoUrl.length > 2048 || repoUrl.startsWith("-")) {
    return { success: false, error: "Enter a valid repository URL." };
  }
  const projectsDir = path.join(app.getPath("home"), "Projects");
  const normalizedUrl = repoUrl.trim();
  const cloneSource = /^[^/:]+\/[^/:]+$/.test(normalizedUrl)
    ? `https://github.com/${normalizedUrl.replace(/\.git$/i, "")}.git`
    : normalizedUrl;
  const repoName = cloneSource.replace(/\.git$/i, "").replace(/\/$/, "").split(/[/:]/).filter(Boolean).pop();
  if (!repoName || repoName === "." || repoName === "..") return { success: false, error: "Could not determine the repository name." };
  const destination = path.join(projectsDir, repoName);
  try {
    await fs.mkdir(projectsDir, { recursive: true });
    await fs.access(destination);
    return { success: false, error: `A folder named ${repoName} already exists in ~/Projects.` };
  } catch (error) {
    if (error.code !== "ENOENT") return { success: false, error: error.message };
  }

  return new Promise(resolve => {
    const child = spawn("git", ["clone", "--", cloneSource, destination], { stdio: ["ignore", "ignore", "pipe"], env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
    let stderr = "";
    child.stderr.on("data", chunk => { stderr = (stderr + chunk.toString()).slice(-12000); });
    child.on("error", error => resolve({ success: false, error: error.message }));
    child.on("close", code => resolve(code === 0
      ? { success: true, path: destination }
      : { success: false, error: stderr.trim() || `git clone exited with code ${code}` }));
  });
});


// ----- Devices (iOS simulators, Android emulators) -----
const deviceManager = new DeviceManager({ log: message => console.log(message) });
const devicePlatform = value => value === "ios" || value === "android" ? value : null;
const deviceId = value => typeof value === "string" && /^[A-Za-z0-9_.-]{1,80}$/.test(value) ? value : null;
const deviceSerial = value => typeof value === "string" && /^emulator-\d{4,5}$/.test(value) ? value : null;
ipcMain.handle("zevrin:devices-list", () => deviceManager.list());
ipcMain.handle("zevrin:device-boot", (_event, platform, id) => { const p = devicePlatform(platform), i = deviceId(id); if (!p || !i) throw new Error("Unknown device."); return deviceManager.boot(p, i); });
ipcMain.handle("zevrin:device-shutdown", (_event, platform, id, serial) => { const p = devicePlatform(platform), i = deviceId(id); if (!p || !i) throw new Error("Unknown device."); return deviceManager.shutdown(p, i, deviceSerial(serial)); });
ipcMain.handle("zevrin:device-focus", (_event, platform) => { const p = devicePlatform(platform); if (!p) throw new Error("Unknown device."); return deviceManager.focus(p); });
ipcMain.handle("zevrin:device-screenshot", async (_event, platform, id, serial) => { const p = devicePlatform(platform), i = deviceId(id); if (!p || !i) throw new Error("Unknown device."); const png = await deviceManager.screenshot(p, i, deviceSerial(serial)); return { mimeType: "image/png", data: png.toString("base64") }; });
ipcMain.handle("zevrin:device-open-url", (_event, platform, id, serial, url) => { const p = devicePlatform(platform), i = deviceId(id); if (!p || !i || typeof url !== "string" || url.length > 2000) throw new Error("Unknown device or URL."); return deviceManager.openUrl(p, i, deviceSerial(serial), url); });
// ----- ⌘K inline edits in the editor -----
const inlineEditor = new InlineEditor({ loadSdk: loadClaudeSdk, executableOptions: claudeExecutableOptions });
ipcMain.handle("zevrin:inline-edit", async (event, id, root, request) => {
  if (typeof id !== "string" || !request || typeof request !== "object" || typeof request.instruction !== "string" || !request.instruction.trim()) throw new Error("Type what to change.");
  const cwd = await checkpointRoot(root).catch(() => os.homedir());
  const text = (value, limit) => typeof value === "string" ? value.slice(0, limit) : "";
  try {
    return await inlineEditor.edit(event.sender.id + ":" + id.slice(0, 80), cwd, { path: text(request.path, 500), language: text(request.language, 40), before: text(request.before, 200000), selection: text(request.selection, 100000), after: text(request.after, 200000), instruction: request.instruction.slice(0, 4000), model: /^[\w.\-\[\]]{1,80}$/.test(request.model || "") ? request.model : undefined });
  } catch (error) { throw new Error(/Cannot find package|ERR_MODULE_NOT_FOUND|Cannot find module/.test(error.message) ? sdkLoadMessage(error) : error.message); }
});
ipcMain.handle("zevrin:inline-edit-cancel", (event, id) => inlineEditor.cancel(event.sender.id + ":" + String(id).slice(0, 80)));

// ----- Checkpoints: a snapshot before each agent turn, to review its changes hunk by hunk and undo them -----
let checkpointStore = null;
const checkpoints = () => checkpointStore || (checkpointStore = new CheckpointStore({ dataDir: path.join(app.getPath("userData"), "checkpoints") }));
async function checkpointRoot(root) {
  if (typeof root !== "string" || !path.isAbsolute(root)) throw new Error("Unknown project.");
  const real = await fs.realpath(root);
  if (!(await fs.stat(real)).isDirectory()) throw new Error("Unknown project.");
  if (real === os.homedir() || real === path.parse(real).root) throw new Error("Checkpoints need a project folder, not the home folder.");
  return real;
}
const checkpointId = id => { if (typeof id !== "string" || !/^[0-9a-f]{40}$/.test(id)) throw new Error("Unknown checkpoint."); return id; };
const checkpointFile = file => { if (typeof file !== "string" || !file || file.length > 1000 || path.isAbsolute(file) || file.split(/[\\/]/).includes("..")) throw new Error("Invalid path."); return file; };
ipcMain.handle("zevrin:checkpoint-create", async (_event, root, label) => checkpoints().create(await checkpointRoot(root), typeof label === "string" ? label.slice(0, 200) : ""));
ipcMain.handle("zevrin:checkpoint-changes", async (_event, root, id) => checkpoints().changes(await checkpointRoot(root), checkpointId(id)));
ipcMain.handle("zevrin:checkpoint-revert-hunk", async (_event, root, id, file, index) => checkpoints().revertHunk(await checkpointRoot(root), checkpointId(id), checkpointFile(file), Math.max(0, Number(index) || 0)));
ipcMain.handle("zevrin:checkpoint-revert-file", async (_event, root, id, file) => checkpoints().revertFile(await checkpointRoot(root), checkpointId(id), checkpointFile(file)));
ipcMain.handle("zevrin:checkpoint-restore", async (_event, root, id) => checkpoints().restore(await checkpointRoot(root), checkpointId(id)));

ipcMain.handle("zevrin:device-logs", (_event, platform, id, serial, options) => {
  const p = devicePlatform(platform), i = deviceId(id);
  if (!p || !i) throw new Error("Unknown device.");
  const o = options && typeof options === "object" ? options : {};
  return deviceManager.logs(p, i, deviceSerial(serial), { minutes: Number(o.minutes) || 2, errorsOnly: o.errorsOnly === true, filter: typeof o.filter === "string" ? o.filter.slice(0, 120) : "", lines: Number(o.lines) || 300 });
});
ipcMain.handle("zevrin:device-appearance", (_event, platform, id, serial, mode) => {
  const p = devicePlatform(platform), i = deviceId(id);
  if (!p || !i) throw new Error("Unknown device.");
  return deviceManager.appearance(p, i, deviceSerial(serial), mode === "dark" || mode === "light" ? mode : null);
});
ipcMain.handle("zevrin:device-record-start", (_event, platform, id, serial) => {
  const p = devicePlatform(platform), i = deviceId(id);
  if (!p || !i) throw new Error("Unknown device.");
  return deviceManager.startRecording(p, i, deviceSerial(serial), path.join(app.getPath("userData"), "recordings"));
});
ipcMain.handle("zevrin:device-record-stop", (_event, platform, id) => {
  const p = devicePlatform(platform), i = deviceId(id);
  if (!p || !i) throw new Error("Unknown device.");
  return deviceManager.stopRecording(p, i);
});
ipcMain.handle("zevrin:device-reveal-recording", (_event, file) => {
  const folder = path.join(app.getPath("userData"), "recordings");
  const target = path.resolve(folder, path.basename(String(file || "")));
  if (!target.startsWith(folder + path.sep)) throw new Error("Unknown recording.");
  shell.showItemInFolder(target);
  return true;
});
ipcMain.handle("zevrin:device-mirror-start", (event, platform, id, serial, fps) => {
  const p = devicePlatform(platform), i = deviceId(id);
  if (!p || !i) throw new Error("Unknown device.");
  const sender = event.sender;
  const key = sender.id + ":" + p + ":" + i;
  sender.once("destroyed", () => deviceManager.stopMirror(key));
  return deviceManager.startMirror(key, p, i, deviceSerial(serial), Math.max(1, Math.min(30, Number(fps) || 10)), frame => { if (!sender.isDestroyed()) sender.send("zevrin:device-frame", p, i, frame); }, message => { if (!sender.isDestroyed()) sender.send("zevrin:device-frame-error", p, i, message); });
});
ipcMain.handle("zevrin:device-stream-start", (event, platform, id, serial) => {
  const p = devicePlatform(platform), i = deviceId(id);
  if (!p || !i) throw new Error("Unknown device.");
  const sender = event.sender;
  const key = sender.id + ":" + p + ":" + i;
  sender.once("destroyed", () => deviceManager.stopStream(key));
  return deviceManager.startStream(key, p, i, deviceSerial(serial), chunk => { if (!sender.isDestroyed()) sender.send("zevrin:device-stream-data", p, i, chunk); }, message => { if (!sender.isDestroyed()) sender.send("zevrin:device-stream-error", p, i, message); });
});
ipcMain.handle("zevrin:device-stream-stop", (event, platform, id) => deviceManager.stopStream(event.sender.id + ":" + platform + ":" + id));
ipcMain.handle("zevrin:open-screen-recording-settings", () => {
  if (process.platform !== "darwin") return false;
  // Asking for the window list makes macOS register Zevrin in the Screen Recording list, then the pane opens.
  desktopCapturer.getSources({ types: ["window"], thumbnailSize: { width: 0, height: 0 } }).catch(() => {});
  shell.openExternal("x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture");
  return true;
});
ipcMain.handle("zevrin:device-mirror-stop", (event, platform, id) => deviceManager.stopMirror(event.sender.id + ":" + platform + ":" + id));
// The device's own window (Simulator.app, Android emulator) as a desktop capture source, so the tile shows the real
// window live at full frame rate. Needs the macOS Screen Recording permission.
async function findDeviceWindow(platform, name, id, serial) {
  const sources = await desktopCapturer.getSources({ types: ["window"], thumbnailSize: { width: 0, height: 0 }, fetchWindowIcons: false });
  const lower = value => String(value || "").toLowerCase();
  const candidates = sources.filter(source => !/zevrin/i.test(source.name));
  if (platform === "android") {
    const port = /emulator-(\d+)/.exec(serial || "")?.[1];
    return candidates.find(source => /android emulator/i.test(source.name) && (lower(source.name).includes(lower(id)) || (port && source.name.includes(":" + port))))
      || candidates.find(source => /android emulator/i.test(source.name)) || null;
  }
  const wanted = lower(name);
  return candidates.find(source => lower(source.name) === wanted || lower(source.name).startsWith(wanted + " ") || lower(source.name).startsWith(wanted + " –") || lower(source.name).startsWith(wanted + " -"))
    || candidates.find(source => lower(source.name).includes(wanted)) || null;
}
ipcMain.handle("zevrin:device-window-source", async (_event, platform, name, id, serial) => {
  if (process.platform !== "darwin") return { id: null, name: null, permission: "unsupported" };
  const p = devicePlatform(platform);
  if (!p || typeof name !== "string" || !name) return { id: null, name: null, permission: "unknown" };
  const permission = systemPreferences.getMediaAccessStatus("screen");
  let match = await findDeviceWindow(p, name, deviceId(id), deviceSerial(serial));
  if (!match && p === "ios") {
    // The Simulator app may be closed while the device runs: open it and wait for its window.
    await deviceManager.openSimulatorApp(deviceId(id)).catch(() => {});
    for (let attempt = 0; attempt < 8 && !match; attempt += 1) { await new Promise(resolve => setTimeout(resolve, 500)); match = await findDeviceWindow(p, name, deviceId(id), deviceSerial(serial)); }
  }
  return { id: match ? match.id : null, name: match ? match.name : null, permission: systemPreferences.getMediaAccessStatus("screen") || permission };
});
ipcMain.handle("zevrin:device-window-input", async (event, platform, name, input) => {
  const p = devicePlatform(platform);
  if (!p || !input || typeof input !== "object") throw new Error("Unknown input.");
  const number = value => typeof value === "number" && Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
  const clean = input.type === "tap" ? { type: "tap", x: number(input.x), y: number(input.y) } : input.type === "swipe" ? { type: "swipe", x1: number(input.x1), y1: number(input.y1), x2: number(input.x2), y2: number(input.y2), duration: typeof input.duration === "number" ? Math.min(2000, Math.max(80, input.duration)) : 250 } : null;
  if (!clean) throw new Error("Unknown input.");
  try { return await deviceManager.windowInput(p, typeof name === "string" ? name.slice(0, 120) : "", clean); }
  finally {
    // The click had to bring the device window forward; give the focus back to Zevrin.
    const window = BrowserWindow.fromWebContents(event.sender);
    if (window && !window.isDestroyed()) { window.focus(); if (process.platform === "darwin") app.focus({ steal: true }); }
  }
});
ipcMain.handle("zevrin:device-input", (_event, platform, id, serial, input) => {
  const p = devicePlatform(platform), i = deviceId(id);
  if (!p || !i || !input || typeof input !== "object") throw new Error("Unknown device or input.");
  const number = value => typeof value === "number" && Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
  const clean = input.type === "tap" ? { type: "tap", x: number(input.x), y: number(input.y) }
    : input.type === "swipe" ? { type: "swipe", x1: number(input.x1), y1: number(input.y1), x2: number(input.x2), y2: number(input.y2), duration: typeof input.duration === "number" ? input.duration : 250 }
    : input.type === "text" ? { type: "text", text: String(input.text || "").slice(0, 2000) }
    : input.type === "key" ? { type: "key", key: String(input.key || "").slice(0, 20) } : null;
  if (!clean) throw new Error("Unknown input.");
  return deviceManager.input(p, i, deviceSerial(serial), clean);
});

ipcMain.handle("zevrin:device-install", async (event, platform, id, serial) => {
  const p = devicePlatform(platform), i = deviceId(id);
  if (!p || !i) throw new Error("Unknown device.");
  const window = BrowserWindow.fromWebContents(event.sender);
  const result = await dialog.showOpenDialog(window, { title: p === "ios" ? "Choose an .app bundle built for the simulator" : "Choose an .apk", properties: p === "ios" ? ["openDirectory", "openFile"] : ["openFile"], filters: p === "ios" ? [{ name: "App bundle", extensions: ["app"] }] : [{ name: "Android package", extensions: ["apk"] }] });
  if (result.canceled || !result.filePaths[0]) return null;
  return deviceManager.install(p, i, deviceSerial(serial), result.filePaths[0]);
});

// ----- Preview tile (embedded browser) -----

// Only <webview> guests hosted by a Zevrin window may be inspected or scripted from the renderer.
function previewContents(id) {
  const contents = Number.isInteger(id) ? webContentsModule.fromId(id) : null;
  if (!contents || contents.isDestroyed() || !contents.hostWebContents || BrowserWindow.fromWebContents(contents.hostWebContents) === null) throw new Error("The preview is not open.");
  return contents;
}

ipcMain.handle("zevrin:preview-capture", async (_event, id) => {
  const contents = previewContents(id);
  const image = await contents.capturePage();
  const size = image.getSize();
  const scaled = size.width > 1600 ? image.resize({ width: 1600 }) : image;
  return { mimeType: "image/png", data: scaled.toPNG().toString("base64"), width: size.width, height: size.height };
});
ipcMain.handle("zevrin:preview-eval", (_event, id, script) => {
  if (typeof script !== "string" || script.length > 200000) throw new Error("script is required.");
  return Promise.race([previewContents(id).executeJavaScript(script, true), new Promise((_, reject) => setTimeout(() => reject(new Error("The page did not answer in time.")), 15000))]);
});
// Network log, recording and real input for the Preview page (Chrome DevTools Protocol on the guest).
ipcMain.handle("zevrin:preview-attach", async (_event, id) => { await previewSession(previewContents(id)); return true; });
ipcMain.handle("zevrin:preview-network", async (_event, id) => (await previewSession(previewContents(id))).network());
ipcMain.handle("zevrin:preview-record-start", async (_event, id) => { await (await previewSession(previewContents(id))).startRecording(); return true; });
ipcMain.handle("zevrin:preview-record-stop", async (_event, id) => (await previewSession(previewContents(id))).stopRecording());
ipcMain.handle("zevrin:preview-input", async (_event, id, input) => {
  if (!input || typeof input !== "object" || !["click", "type", "key", "scroll"].includes(input.type)) throw new Error("Unknown input.");
  const number = value => typeof value === "number" && Number.isFinite(value) ? value : 0;
  const clean = input.type === "click" ? { type: "click", x: number(input.x), y: number(input.y) }
    : input.type === "type" ? { type: "type", text: String(input.text || "").slice(0, 5000) }
    : input.type === "key" ? { type: "key", key: String(input.key || "").slice(0, 20) }
    : { type: "scroll", x: number(input.x), y: number(input.y), deltaX: number(input.deltaX), deltaY: number(input.deltaY) };
  return (await previewSession(previewContents(id))).input(clean);
});
// Writes a generated file (recording, screenshot, context) under <workspace>/.zevrin/ and returns its path.
ipcMain.handle("zevrin:save-artifact", async (_event, root, name, base64, text) => {
  const cwd = await workspaceDirectory(root);
  if (typeof name !== "string" || !/^[A-Za-z0-9._-]{1,120}$/.test(name)) throw new Error("Invalid file name.");
  const dir = path.join(cwd, ".zevrin", "context");
  await fs.mkdir(dir, { recursive: true });
  try { const ignore = path.join(cwd, ".zevrin", ".gitignore"); await fs.writeFile(ignore, "*\n", { flag: "wx" }); } catch { /* exists */ }
  const target = path.join(dir, name);
  if (typeof base64 === "string") await fs.writeFile(target, Buffer.from(base64, "base64"));
  else await fs.writeFile(target, String(text ?? ""), "utf8");
  return { path: target, relative: path.relative(cwd, target) };
});
// Adds the Zevrin MCP server to the Claude Code CLI (user scope), so the CLI and the extension can drive Zevrin.
ipcMain.handle("zevrin:mcp-connect-claude", async () => {
  if (!mcpServer) throw new Error("The Zevrin MCP server is not running.");
  const claude = await findExecutable("claude");
  if (!claude) throw new Error("The claude CLI was not found.");
  const run = args => new Promise((resolve, reject) => execFile(claude, args, { env: process.env, timeout: 20000 }, (error, stdout, stderr) => error ? reject(new Error(String(stderr || stdout || error.message).trim())) : resolve(String(stdout))));
  for (const name of [previousMcpServerName, "zevrin"]) await run(["mcp", "remove", "-s", "user", name]).catch(() => {});
  await run(["mcp", "add", "-s", "user", "--transport", "http", "zevrin", mcpServer.url, "--header", `Authorization: Bearer ${mcpServer.token}`]);
  return true;
});

ipcMain.handle("zevrin:preview-devtools", (_event, id) => { const contents = previewContents(id); if (contents.isDevToolsOpened()) contents.closeDevTools(); else contents.openDevTools({ mode: "detach" }); return true; });

// Flow Mode: Zevrin stays sharp while a blurred veil covers the other apps' windows behind it (see flow-backdrop).
// The window itself stays opaque; this also clears the vibrancy older versions set on it.
const flowBackdrops = new Map();
ipcMain.handle("zevrin:set-flow-mode", (event, enabled) => {
  const window = BrowserWindow.fromWebContents(event.sender);
  if (!window || window.isDestroyed()) return false;
  try {
    if (process.platform === "darwin") window.setVibrancy(null);
    window.setBackgroundColor("#09090b");
    flowBackdrops.get(window.id)?.setEnabled(Boolean(enabled));
    return true;
  } catch (error) { console.warn("[zevrin] flow mode:", error.message); return false; }
});

function createWindow() {
  const window = new BrowserWindow({
    width: 1600,
    height: 1000,
    minWidth: 900,
    minHeight: 700,
    title: "Zevrin",
    backgroundColor: "#09090b",
    show: false,
    ...(process.platform === "darwin" ? { titleBarStyle: "hiddenInset", trafficLightPosition: { x: 14, y: 14 } } : {}),
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
      webviewTag: true,
    },
  });
  window.once("ready-to-show", () => window.show());
  const windowId = window.id;
  flowBackdrops.set(windowId, new FlowBackdrop(window));
  window.on("closed", () => flowBackdrops.delete(windowId));
  window.webContents.on("destroyed", () => { agents.stopForWebContents(window.webContents); codexAgents.stopForWebContents(window.webContents); });
  // Preview panes and links stay inside the app; everything else opens in the system browser.
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event, url) => {
    if (!url.startsWith(appUrl)) { event.preventDefault(); if (/^https?:\/\//i.test(url)) shell.openExternal(url); }
  });
  window.loadURL(appUrl);
  return window;
}

function sendToFocusedWindow(channel) {
  (BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0])?.webContents.send(channel);
}

app.whenReady().then(async () => {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(process.platform === "darwin" ? [{ label: app.name, submenu: [{ role: "about" }, { type: "separator" }, { role: "hide" }, { role: "hideOthers" }, { role: "unhide" }, { type: "separator" }, { role: "quit" }] }] : []),
    { label: "File", submenu: [
      { label: "New Window", accelerator: "CmdOrCtrl+Shift+N", click: createWindow },
      { label: "Open Folder…", accelerator: "CmdOrCtrl+O", click: () => sendToFocusedWindow("zevrin:open-folder") },
      { type: "separator" }, { role: "close" },
    ] },
    { label: "Edit", submenu: [{ role: "undo" }, { role: "redo" }, { type: "separator" }, { role: "cut" }, { role: "copy" }, { role: "paste" }, { role: "selectAll" }] },
    { label: "View", submenu: [
      { label: "Command Center", accelerator: "CmdOrCtrl+P", click: () => sendToFocusedWindow("zevrin:toggle-command-center") },
      { label: "Toggle Flow Mode", accelerator: "CmdOrCtrl+.", click: () => sendToFocusedWindow("zevrin:toggle-flow-mode") },
      { type: "separator" }, { role: "reload" }, { role: "toggleDevTools" }, { type: "separator" }, { role: "togglefullscreen" },
    ] },
    { label: "Window", submenu: [{ role: "minimize" }, { role: "zoom" }, ...(process.platform === "darwin" ? [{ type: "separator" }, { role: "front" }] : [])] },
  ]));
  // In development the Dock shows Electron's icon; use Zevrin's (the packaged app has it in its bundle).
  if (process.platform === "darwin" && !app.isPackaged && app.dock) { const icon = path.join(projectRoot, "build", "icon.png"); if (fsSync.existsSync(icon)) app.dock.setIcon(icon); }
  try { await Promise.all([startLocalServer(), startZevrinMcp()]); createWindow(); }
  catch (error) { dialog.showErrorBox("Zevrin could not start", error.message); stopLocalServer(); app.quit(); }
  app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0 && appUrl) createWindow(); });
});

app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
app.on("before-quit", () => {
  stopLocalServer();
  agents.stopAll();
  codexAgents.stopAll();
  deviceManager.stopAllRecordings();
  deviceManager.stopAllStreams();
  if (mcpServer) mcpServer.close();
  if (vscodeServer) vscodeServer.stop();
  for (const terminal of terminals.values()) terminal.process.kill();
  terminals.clear();
});
