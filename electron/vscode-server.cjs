// Runs a local VS Code server with the official Claude Code extension installed, so Zevrin can embed the real
// extension UI in a tile. Two server providers are supported: openvscode-server (gitpod-io) and code-server (coder).
// One server serves every open project; each tile loads ?folder=<project>.
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const net = require("node:net");
const http = require("node:http");
const https = require("node:https");
const { spawn, execFile } = require("node:child_process");
const { randomBytes } = require("node:crypto");

const claudeExtensionId = "anthropic.claude-code";
// Coding-agent extensions Zevrin can embed, each in its own chat-only tile.
const extensionAgents = {
  claude: { id: "claude", extensionId: "anthropic.claude-code", label: "Claude Code", publisher: "anthropic", name: "claude-code", cli: "claude", key: "ctrl+alt+shift+f10", names: ["claude"] },
  codex: { id: "codex", extensionId: "openai.chatgpt", label: "Codex", publisher: "openai", name: "chatgpt", cli: "codex", key: "ctrl+alt+shift+f7", names: ["codex", "chatgpt", "openai"] },
  gemini: { id: "gemini", extensionId: "google.geminicodeassist", label: "Gemini Code Assist", publisher: "google", name: "geminicodeassist", cli: "gemini", key: "ctrl+alt+shift+f8", names: ["gemini"] },
};
const marketplaceVsixFor = agent => `https://marketplace.visualstudio.com/_apis/public/gallery/publishers/${agent.publisher}/vsextensions/${agent.name}/latest/vspackage`;
const marketplaceVsix = marketplaceVsixFor(extensionAgents.claude);
const bootstrapId = "zevrin.zevrin-bootstrap";
const githubApi = "https://api.github.com";

// Platform tokens used in release asset names, most specific first, per provider.
const tokenTables = {
  openvscode: { "darwin-arm64": ["darwin-arm64"], "darwin-x64": ["darwin-x64", "darwin"], "linux-x64": ["linux-x64"], "linux-arm64": ["linux-arm64"], "win32-x64": ["win32-x64"] },
  codeserver: { "darwin-arm64": ["macos-arm64"], "darwin-x64": ["macos-amd64"], "linux-x64": ["linux-amd64"], "linux-arm64": ["linux-arm64"] },
};
function platformTokens(platform, arch, providerId = "openvscode") {
  return (tokenTables[providerId] || {})[`${platform}-${arch}`] || [];
}

// Server providers: how to name assets, where the binary lives, how to start and how to build URLs.
const providers = {
  openvscode: {
    id: "openvscode", label: "openvscode-server", repo: "gitpod-io/openvscode-server", knownVersions: ["1.109.5", "1.108.2", "1.106.3", "1.105.1", "1.103.1", "1.102.3", "1.101.2", "1.100.3", "1.99.3", "1.98.2"],
    assetName: (version, token) => `openvscode-server-v${version}-${token}.tar.gz`,
    assetUrl: (version, name) => `https://github.com/gitpod-io/openvscode-server/releases/download/openvscode-server-v${version}/${name}`,
    tagVersion: tag => (tag.match(/^openvscode-server-v(\d+\.\d+\.\d+)$/) || [])[1] || null,
    binary: platform => platform === "win32" ? "bin/openvscode-server.cmd" : "bin/openvscode-server",
    direct: root => ({ command: path.join(root, "node"), prefix: [path.join(root, "out", "server-main.js")] }),
    startArgs: ({ port, token, serverDataDir, userDataDir, extensionsDir }) => ["--host", "127.0.0.1", "--port", String(port), "--connection-token", token, "--accept-server-license-terms", "--disable-telemetry", "--server-data-dir", serverDataDir, "--user-data-dir", userDataDir, "--extensions-dir", extensionsDir],
    installArgs: ({ extensionsDir, target }) => ["--extensions-dir", extensionsDir, "--install-extension", target, "--force"],
    probeUrl: (port, token) => `http://127.0.0.1:${port}/?tkn=${token}`,
    folderUrl: (port, token, folder) => `http://127.0.0.1:${port}/?tkn=${encodeURIComponent(token)}&folder=${encodeURIComponent(folder)}`,
    workspaceUrl: (port, token, file) => `http://127.0.0.1:${port}/?tkn=${encodeURIComponent(token)}&workspace=${encodeURIComponent(file)}`,
  },
  codeserver: {
    id: "codeserver", label: "code-server", repo: "coder/code-server", knownVersions: ["4.104.3", "4.104.2", "4.104.1", "4.103.2", "4.102.3", "4.101.2", "4.100.3", "4.99.4", "4.98.2", "4.96.4"],
    assetName: (version, token) => `code-server-${version}-${token}.tar.gz`,
    assetUrl: (version, name) => `https://github.com/coder/code-server/releases/download/v${version}/${name}`,
    tagVersion: tag => (tag.match(/^v(\d+\.\d+\.\d+)$/) || [])[1] || null,
    binary: () => "bin/code-server",
    // The explicit entry file rather than the package folder: newer Node versions resolve a bare directory differently.
    direct: root => ({ command: path.join(root, "lib", "node"), prefix: [path.join(root, "out", "node", "entry.js")], libraryPath: path.join(root, "lib") }),
    startArgs: ({ port, token, userDataDir, extensionsDir }) => ["--bind-addr", `127.0.0.1:${port}`, "--auth", "none", "--disable-telemetry", "--disable-update-check", "--disable-workspace-trust", "--user-data-dir", userDataDir, "--extensions-dir", extensionsDir],
    installArgs: ({ extensionsDir, target }) => ["--extensions-dir", extensionsDir, "--install-extension", target, "--force"],
    probeUrl: port => `http://127.0.0.1:${port}/healthz`,
    folderUrl: (port, _token, folder) => `http://127.0.0.1:${port}/?folder=${encodeURIComponent(folder)}`,
    workspaceUrl: (port, _token, file) => `http://127.0.0.1:${port}/?workspace=${encodeURIComponent(file)}`,
  },
};

// Picks the newest release (from the GitHub releases API payload) that has an archive for this platform.
function pickRelease(releases, provider, platform = process.platform, arch = process.arch) {
  const tokens = platformTokens(platform, arch, provider.id);
  if (tokens.length === 0) return null;
  const candidates = (Array.isArray(releases) ? releases : []).filter(release => release && !release.draft && !release.prerelease && Array.isArray(release.assets));
  for (const release of candidates) {
    const version = provider.tagVersion(String(release.tag_name || ""));
    if (!version) continue;
    for (const token of tokens) {
      const name = provider.assetName(version, token);
      const asset = release.assets.find(item => item && item.name === name);
      if (asset) return { provider: provider.id, version, name, url: asset.browser_download_url || provider.assetUrl(version, name), size: asset.size || 0 };
    }
  }
  return null;
}

// Without the API (offline or rate-limited): the URLs to try for known versions, newest first.
function knownAssets(provider, platform = process.platform, arch = process.arch) {
  const tokens = platformTokens(platform, arch, provider.id);
  const list = [];
  for (const version of provider.knownVersions) for (const token of tokens) { const name = provider.assetName(version, token); list.push({ provider: provider.id, version, name, url: provider.assetUrl(version, name), size: 0 }); }
  return list;
}

function fetchJson(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error("Too many redirects for " + url));
    const request = https.get(url, { headers: { "User-Agent": "Zevrin", Accept: "application/vnd.github+json" } }, response => {
      if (response.statusCode && [301, 302, 303, 307, 308].includes(response.statusCode) && response.headers.location) { response.resume(); return fetchJson(new URL(response.headers.location, url).toString(), redirects + 1).then(resolve, reject); }
      let body = "";
      response.setEncoding("utf8");
      response.on("data", chunk => { body += chunk; if (body.length > 8 * 1024 * 1024) request.destroy(new Error("Response too large")); });
      response.on("end", () => { if (response.statusCode !== 200) return reject(new Error(`GitHub API answered ${response.statusCode} for ${url}`)); try { resolve(JSON.parse(body)); } catch (error) { reject(error); } });
      response.on("error", reject);
    });
    request.on("error", reject);
    request.setTimeout(20000, () => request.destroy(new Error("GitHub API timed out.")));
  });
}

function headOk(url, redirects = 0) {
  return new Promise(resolve => {
    if (redirects > 8) return resolve(false);
    const request = https.request(url, { method: "HEAD", headers: { "User-Agent": "Zevrin" } }, response => {
      response.resume();
      if (response.statusCode && [301, 302, 303, 307, 308].includes(response.statusCode) && response.headers.location) return headOk(new URL(response.headers.location, url).toString(), redirects + 1).then(resolve);
      resolve(response.statusCode === 200);
    });
    request.on("error", () => resolve(false));
    request.setTimeout(15000, () => request.destroy());
    request.end();
  });
}

// Settings that make the embedded VS Code look like a Claude panel rather than a full editor.
const defaultSettings = {
  "workbench.activityBar.location": "hidden",
  "workbench.statusBar.visible": false,
  "workbench.layoutControl.enabled": false,
  "window.commandCenter": false,
  "window.menuBarVisibility": "hidden",
  "workbench.startupEditor": "none",
  "workbench.editor.showTabs": "single",
  "workbench.editor.empty.hint": "hidden",
  "window.customTitleBarVisibility": "never",
  "workbench.secondarySideBar.showLabels": false,
  "workbench.panel.opensMaximized": "never",
  "workbench.sideBar.location": "left",
  "workbench.colorTheme": "Default Dark Modern",
  "workbench.tips.enabled": false,
  "workbench.welcomePage.walkthroughs.openOnInstall": false,
  "update.mode": "none",
  "telemetry.telemetryLevel": "off",
  "extensions.autoUpdate": false,
  "security.workspace.trust.enabled": false,
  "editor.minimap.enabled": false,
};

function mergeSettings(existing, defaults = defaultSettings) {
  const base = existing && typeof existing === "object" ? existing : {};
  const merged = { ...defaults, ...base };
  return { merged, changed: JSON.stringify(merged) !== JSON.stringify(base) };
}

// A tiny extension that opens the Claude Code view as soon as the workbench is ready.
// Chat-only mode. The bootstrap extension opens the Claude Code view and collapses everything else (editors, panel,
// the other side bar), then keeps the view maximized. Zevrin drives it through keybindings so it can react to the
// real layout it observes in the page (an approval diff opens an editor; once it closes, the chat fills the tile again).
const chatOnlyKeys = { chatOnly: "ctrl+alt+shift+f9", openClaude: "ctrl+alt+shift+f10", widen: "ctrl+alt+shift+f11", open: Object.fromEntries(Object.values(extensionAgents).map(agent => [agent.id, agent.key])) };

// One command file per tile: Zevrin writes { id, action, agent }, the bootstrap extension of that tile's
// session runs it. The session knows its tile through the name of the .code-workspace file it was opened with.
// `instance` separates several tiles of the same agent on the same folder: each gets its own workspace file, hence its
// own VS Code window, extension host, Claude session and layout.
function tileKey(agentId, folder, instance = "") {
  return `${agentId}-${require("node:crypto").createHash("sha1").update(folder + (instance ? "\0" + instance : "")).digest("hex").slice(0, 10)}`;
}

function bootstrapExtensionFiles(commandsDir = "") {
  const agents = Object.values(extensionAgents);
  const packageJson = {
    name: "zevrin-bootstrap", displayName: "Zevrin bootstrap", publisher: "zevrin", version: "0.3.0", private: true,
    engines: { vscode: "^1.90.0" }, main: "./extension.js", activationEvents: ["onStartupFinished"],
    contributes: { commands: [
      { command: "zevrin.chatOnly", title: "Zevrin: Show only the agent chat" },
      { command: "zevrin.widenSidebar", title: "Zevrin: Widen the agent side bar" },
      { command: "zevrin.openClaude", title: "Zevrin: Open Claude Code" },
      ...agents.map(agent => ({ command: "zevrin.open." + agent.id, title: "Zevrin: Open " + agent.label })),
    ], keybindings: [
      { command: "zevrin.chatOnly", key: chatOnlyKeys.chatOnly },
      { command: "zevrin.widenSidebar", key: chatOnlyKeys.widen },
      ...agents.map(agent => ({ command: "zevrin.open." + agent.id, key: agent.key })),
    ] },
  };
  const extensionJs = `const vscode = require("vscode");
const agents = ${JSON.stringify(Object.fromEntries(agents.map(agent => [agent.id, { extensionId: agent.extensionId, label: agent.label, names: agent.names }])))};
// The extension by id (any case), else by publisher/name/displayName mentioning the agent.
function findExtension(agent) {
  const wanted = agent.extensionId.toLowerCase();
  const pattern = new RegExp(agent.names.join("|"), "i");
  return vscode.extensions.all.find(item => item.id.toLowerCase() === wanted)
    || vscode.extensions.all.find(item => pattern.test(item.id) || pattern.test(item.packageJSON?.displayName || "") || pattern.test(item.packageJSON?.name || ""));
}
const fs = require("node:fs");
const path = require("node:path");
const commandsDir = ${JSON.stringify(commandsDir)};
const run = async (id, ...args) => { try { await vscode.commands.executeCommand(id, ...args); return true; } catch (error) { console.warn("Zevrin: " + id + " failed", error && error.message); return false; } };
// Opens an agent extension's view wherever it lives (its view container, a view, or an open/focus command).
async function openAgent(agentId) {
  const agent = agents[agentId] || agents.claude;
  const extension = findExtension(agent);
  if (!extension) { vscode.window.showWarningMessage("Zevrin: the " + agent.label + " extension (" + agent.extensionId + ") is not loaded in this VS Code server. Loaded: " + vscode.extensions.all.map(item => item.id).filter(id => !/^vscode\./.test(id)).join(", ")); return false; }
  try { if (!extension.isActive) await extension.activate(); } catch (error) { console.warn("Zevrin: activation failed", error); }
  const containers = (extension.packageJSON?.contributes?.viewsContainers?.activitybar || []).concat(extension.packageJSON?.contributes?.viewsContainers?.panel || []);
  for (const container of containers) { if (await run("workbench.view.extension." + container.id)) return true; }
  const views = Object.values(extension.packageJSON?.contributes?.views || {}).flat();
  for (const view of views) { if (await run(view.id + ".focus")) return true; }
  const commands = (extension.packageJSON?.contributes?.commands || []).map(command => command.command).filter(id => /open|focus|show/i.test(id));
  for (const id of commands) { if (await run(id)) return true; }
  return false;
}
// Collapse the workbench around the current side bar view: no editors, no panel, and the secondary side bar maximized.
async function chatOnly() {
  await run("workbench.action.closeAllEditors");
  await run("workbench.action.closePanel");
  await run("workbench.action.toggleMaximizedAuxiliaryBar");
}
async function widenSidebar() {
  await run("workbench.action.closeAuxiliaryBar");
  await run("workbench.action.closePanel");
  await run("workbench.action.focusSideBar");
  for (let step = 0; step < 40; step += 1) { if (!(await run("workbench.action.increaseViewWidth"))) break; }
}
function activate(context) {
  context.subscriptions.push(vscode.commands.registerCommand("zevrin.openClaude", () => openAgent("claude")));
  for (const id of Object.keys(agents)) context.subscriptions.push(vscode.commands.registerCommand("zevrin.open." + id, () => openAgent(id)));
  context.subscriptions.push(vscode.commands.registerCommand("zevrin.chatOnly", chatOnly));
  context.subscriptions.push(vscode.commands.registerCommand("zevrin.widenSidebar", widenSidebar));
  // Startup: clear editors and the panel, open this tile's agent when the workspace file names one.
  const key = vscode.workspace.workspaceFile ? path.basename(vscode.workspace.workspaceFile.path).replace(/\.code-workspace$/, "") : null;
  const tileAgent = key ? Object.keys(agents).find(id => key.startsWith(id + "-")) : null;
  setTimeout(async () => { await run("workbench.action.closeAllEditors"); await run("workbench.action.closePanel"); if (tileAgent) await openAgent(tileAgent); }, 400);
  // Command channel: Zevrin drops a JSON file for this tile; it is executed once and removed.
  if (commandsDir && key) {
    const file = path.join(commandsDir, key + ".json");
    let busy = false;
    const timer = setInterval(async () => {
      if (busy || !fs.existsSync(file)) return;
      busy = true;
      try {
        const command = JSON.parse(fs.readFileSync(file, "utf8"));
        try { fs.unlinkSync(file); } catch { /* already gone */ }
        if (command.action === "open") await openAgent(command.agent || tileAgent || "claude");
        else if (command.action === "chatOnly") { await openAgent(command.agent || tileAgent || "claude"); await chatOnly(); }
        else if (command.action === "widen") { await openAgent(command.agent || tileAgent || "claude"); await widenSidebar(); }
        else if (command.action === "closeEditors") await run("workbench.action.closeAllEditors");
        else if (command.action === "diagnose") {
          // What the agent's extension sees: host identity, its own state, and the views and commands it registered.
          const agent = agents[command.agent || tileAgent || "claude"];
          const extension = findExtension(agent);
          let activation = "not attempted";
          if (extension && !extension.isActive) { try { await extension.activate(); activation = "activated now"; } catch (error) { activation = "failed: " + (error && error.message); } }
          else if (extension) activation = "already active";
          const commands = (await vscode.commands.getCommands(true)).filter(id => new RegExp(agent.names.join("|"), "i").test(id)).slice(0, 40);
          const report = {
            host: { appName: vscode.env.appName, appHost: vscode.env.appHost, uiKind: vscode.env.uiKind === vscode.UIKind.Web ? "web" : "desktop", remoteName: vscode.env.remoteName || null, version: vscode.version, shell: vscode.env.shell },
            extension: extension ? { id: extension.id, version: extension.packageJSON?.version, isActive: extension.isActive, activation, extensionKind: extension.packageJSON?.extensionKind || null, engines: extension.packageJSON?.engines || null, main: extension.packageJSON?.main || null, browser: extension.packageJSON?.browser || null, viewsContainers: extension.packageJSON?.contributes?.viewsContainers || null, views: extension.packageJSON?.contributes?.views || null } : null,
            loadedExtensions: vscode.extensions.all.map(item => item.id).filter(id => !/^vscode\./.test(id)),
            commands,
            workspace: (vscode.workspace.workspaceFolders || []).map(folder => folder.uri.fsPath),
          };
          fs.writeFileSync(path.join(commandsDir, key + ".diag.json"), JSON.stringify(report, null, 2));
        }
        fs.writeFileSync(path.join(commandsDir, key + ".done"), JSON.stringify({ id: command.id, at: Date.now() }));
      } catch (error) { console.warn("Zevrin: command failed", error && error.message); }
      finally { busy = false; }
    }, 600);
    context.subscriptions.push({ dispose: () => clearInterval(timer) });
  }
}
module.exports = { activate, deactivate() {} };
`;
  return { "package.json": JSON.stringify(packageJson, null, 2) + "\n", "extension.js": extensionJs };
}

function portIsFree(port) {
  return new Promise(resolve => {
    const probe = net.createServer();
    probe.unref();
    probe.once("error", () => resolve(false));
    probe.listen({ port, host: "127.0.0.1" }, () => probe.close(() => resolve(true)));
  });
}

function download(url, destination, onProgress, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 8) return reject(new Error("Too many redirects while downloading " + url));
    const request = https.get(url, { headers: { "User-Agent": "Zevrin", Accept: "application/octet-stream" } }, response => {
      if (response.statusCode && [301, 302, 303, 307, 308].includes(response.statusCode) && response.headers.location) {
        response.resume();
        return download(new URL(response.headers.location, url).toString(), destination, onProgress, redirects + 1).then(resolve, reject);
      }
      if (response.statusCode !== 200) { response.resume(); return reject(new Error(`Download failed (${response.statusCode}) for ${url}`)); }
      const total = Number(response.headers["content-length"] || 0);
      let received = 0;
      const file = fs.createWriteStream(destination);
      response.on("data", chunk => { received += chunk.length; onProgress?.(received, total); });
      response.pipe(file);
      file.on("finish", () => file.close(() => resolve(destination)));
      file.on("error", reject);
      response.on("error", reject);
    });
    request.on("error", reject);
    request.setTimeout(120000, () => request.destroy(new Error("Download timed out.")));
  });
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { maxBuffer: 32 * 1024 * 1024, ...options }, (error, stdout, stderr) => {
      if (error) reject(new Error((stderr || stdout || error.message || "").toString().trim().slice(-2000) || `${command} failed`));
      else resolve({ stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

// The extension folders of local IDEs that may already have Claude Code installed.
function localExtensionDirs(home = os.homedir()) {
  return [".vscode/extensions", ".vscode-insiders/extensions", ".cursor/extensions", ".windsurf/extensions", ".vscode-oss/extensions"].map(dir => path.join(home, dir));
}

async function findInstalledExtension(extensionsDir, extensionId) {
  try {
    const entries = await fsp.readdir(extensionsDir, { withFileTypes: true });
    const matches = entries.filter(entry => entry.isDirectory() && entry.name.toLowerCase().startsWith(extensionId.toLowerCase() + "-")).map(entry => entry.name).sort();
    return matches.length ? path.join(extensionsDir, matches[matches.length - 1]) : null;
  } catch { return null; }
}
const findInstalledClaude = extensionsDir => findInstalledExtension(extensionsDir, claudeExtensionId);

// What an installed extension declares: can it run in a VS Code *server* (workspace/web kind), and where is its view?
async function inspectExtension(folder) {
  try {
    const manifest = JSON.parse(await fsp.readFile(path.join(folder, "package.json"), "utf8"));
    const kinds = Array.isArray(manifest.extensionKind) ? manifest.extensionKind : typeof manifest.extensionKind === "string" ? [manifest.extensionKind] : null;
    const runnable = !kinds || kinds.includes("workspace") || (kinds.includes("web") && manifest.browser);
    const containers = [].concat(manifest.contributes?.viewsContainers?.activitybar || [], manifest.contributes?.viewsContainers?.panel || [], manifest.contributes?.viewsContainers?.secondarySidebar || []);
    return { version: manifest.version || null, runnable, reason: runnable ? "" : `This extension only runs in the desktop VS Code UI (extensionKind ${JSON.stringify(kinds)}), not in a VS Code server.`, viewContainerId: containers[0]?.id ? "workbench.view.extension." + containers[0].id : null };
  } catch { return { version: null, runnable: true, reason: "", viewContainerId: null }; }
}
const agentFor = agentId => extensionAgents[agentId] || extensionAgents.claude;

const strippedEnvPrefixes = ["VSCODE_", "ELECTRON_", "CODE_SERVER_", "OPENVSCODE_"];
const strippedEnvKeys = new Set(["TERM_PROGRAM", "TERM_PROGRAM_VERSION", "GIT_ASKPASS", "NODE_OPTIONS", "NODE_CHANNEL_FD", "CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT"]);
function serverEnvironment(env = process.env, home = os.homedir()) {
  const clean = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined || strippedEnvKeys.has(key) || strippedEnvPrefixes.some(prefix => key.startsWith(prefix))) continue;
    clean[key] = value;
  }
  clean.PATH = extendedPath(env, home);
  clean.ZEVRIN = "1";
  return clean;
}

function extendedPath(env = process.env, home = os.homedir()) {
  const extra = [path.join(home, ".local/bin"), path.join(home, ".npm-global/bin"), path.join(home, ".bun/bin"), path.join(home, ".cargo/bin"), path.join(home, ".claude/local"), "/opt/homebrew/bin", "/usr/local/bin"];
  const current = (env.PATH || "").split(path.delimiter).filter(Boolean);
  return [...current, ...extra.filter(dir => !current.includes(dir))].join(path.delimiter);
}

class VscodeServer {
  constructor({ dataDir, ports, env = process.env, home = os.homedir(), log = () => {}, platform = process.platform, arch = process.arch }) {
    this.dataDir = dataDir;
    this.ports = ports;
    this.env = env;
    this.home = home;
    this.log = log;
    this.platform = platform;
    this.arch = arch;
    this.serverDir = path.join(dataDir, "server");
    this.extensionsDir = path.join(dataDir, "extensions");
    this.userDataDir = path.join(dataDir, "user-data");
    this.serverDataDir = path.join(dataDir, "server-data");
    this.installFile = path.join(dataDir, "server.json");
    this.process = null;
    this.port = null;
    this.token = null;
    this.starting = null;
    this.setupTask = null;
    this.progressListeners = new Set();
    this.lastError = null;
    this.extensionSource = null;
    this.extensionSources = {};
  }

  onProgress(listener) { this.progressListeners.add(listener); return () => this.progressListeners.delete(listener); }
  progress(step, message, fraction = null) { for (const listener of this.progressListeners) listener({ step, message, fraction }); this.log(`[vscode] ${step}: ${message}`); }

  // { provider, version } of the installed server, or null.
  installed() {
    try {
      const info = JSON.parse(fs.readFileSync(this.installFile, "utf8"));
      const provider = providers[info.provider];
      if (!provider || typeof info.version !== "string") return null;
      return fs.existsSync(path.join(this.serverDir, provider.binary(this.platform))) ? { provider: provider.id, version: info.version } : null;
    } catch { return null; }
  }

  provider() {
    const info = this.installed();
    return info ? providers[info.provider] : null;
  }

  binaryPath() {
    const provider = this.provider();
    return provider ? path.join(this.serverDir, provider.binary(this.platform)) : null;
  }

  serverInstalled() { return this.installed() !== null; }

  // How to launch the server: the bundled Node on the entry point when present (avoids wrapper-script surprises), else the script.
  launchCommand(args) {
    const provider = this.provider();
    if (!provider) return null;
    const direct = provider.direct ? provider.direct(this.serverDir) : null;
    if (direct && fs.existsSync(direct.command)) return { command: direct.command, args: [...direct.prefix, ...args], mode: "direct", libraryPath: direct.libraryPath };
    return { command: this.binaryPath(), args, mode: "script" };
  }

  // Everything useful when the server will not start: files, node version, a traced run of the wrapper script.
  async diagnostics() {
    const provider = this.provider();
    const lines = [];
    const root = this.serverDir;
    const check = async (label, command, args, options = {}) => {
      try { const result = await run(command, args, { env: this.serverEnv(), cwd: root, timeout: 20000, ...options }); lines.push(`${label}: ${(result.stdout + result.stderr).trim().slice(-400) || "(no output)"}`); }
      catch (error) { lines.push(`${label}: FAILED ${String(error.message).slice(0, 400)}`); }
    };
    try { lines.push("server dir: " + (await fsp.readdir(root)).join(", ")); } catch (error) { lines.push("server dir unreadable: " + error.message); }
    const direct = provider?.direct ? provider.direct(root) : null;
    if (direct) {
      lines.push(`bundled node: ${fs.existsSync(direct.command) ? "present" : "missing"} (${direct.command})`);
      if (fs.existsSync(direct.command)) { await check("node --version", direct.command, ["--version"]); await check("entry --version", direct.command, [...direct.prefix, "--version"]); }
    }
    if (direct && fs.existsSync(direct.command)) {
      // The same check with the output written to a file, in case pipe output is what gets lost.
      const probeFile = path.join(this.dataDir, "diagnostic.log");
      try {
        const fd = fs.openSync(probeFile, "w");
        const result = await new Promise(resolve => { let child; try { child = spawn(direct.command, [...direct.prefix, "--version"], { cwd: root, env: this.serverEnv(direct), stdio: ["ignore", fd, fd] }); } catch (error) { fs.closeSync(fd); resolve(`spawn failed: ${error.message}`); return; } fs.closeSync(fd); const timer = setTimeout(() => { child.kill(); resolve("timed out"); }, 20000); child.on("exit", (code, signal) => { clearTimeout(timer); resolve(`exit ${code}${signal ? " signal " + signal : ""}`); }); child.on("error", error => { clearTimeout(timer); resolve("error " + error.message); }); });
        lines.push(`entry --version (to file): ${result}; output: ${(await fsp.readFile(probeFile, "utf8").catch(() => "")).trim().slice(-400) || "(empty)"}`);
      } catch (error) { lines.push("entry --version (to file): FAILED " + error.message); }
    }
    const previous = await this.serverLogTail(600);
    if (previous) lines.push("server log tail: " + previous.replace(/\s+/g, " "));
    const script = this.binaryPath();
    if (script && fs.existsSync(script)) {
      try { lines.push("script head: " + (await fsp.readFile(script, "utf8")).split("\n").slice(0, 3).join(" | ")); } catch { /* ignore */ }
      await check("sh -x script --version", "sh", ["-x", script, "--version"]);
    }
    return lines.join("\n");
  }

  async status() {
    const info = this.installed();
    const extension = await findInstalledClaude(this.extensionsDir);
    const agents = {};
    for (const agent of Object.values(extensionAgents)) {
      const folder = await findInstalledExtension(this.extensionsDir, agent.extensionId);
      const details = folder ? await inspectExtension(folder) : { version: null, runnable: true, reason: "", viewContainerId: null };
      agents[agent.id] = { label: agent.label, extensionId: agent.extensionId, cli: agent.cli, installed: Boolean(folder), source: this.extensionSources[agent.id] || null, ...details };
    }
    return {
      agents,
      supported: platformTokens(this.platform, this.arch).length > 0 || platformTokens(this.platform, this.arch, "codeserver").length > 0, platform: `${this.platform}-${this.arch}`, serverVersion: info ? `${providers[info.provider].label} ${info.version}` : null,
      serverInstalled: Boolean(info), extensionInstalled: Boolean(extension), extensionSource: this.extensionSource,
      running: Boolean(this.process && this.port), url: this.process && this.port ? this.baseUrl() : null,
      busy: Boolean(this.setupTask), error: this.lastError,
    };
  }

  // Finds a downloadable server archive: GitHub releases API first (newest release with a build for this platform), then known URLs.
  async resolveDownload() {
    const attempts = [];
    for (const provider of [providers.openvscode, providers.codeserver]) {
      try {
        const releases = await fetchJson(`${githubApi}/repos/${provider.repo}/releases?per_page=30`);
        const picked = pickRelease(releases, provider, this.platform, this.arch);
        if (picked) return picked;
        attempts.push(`${provider.label}: no ${this.platform}-${this.arch} build in the last 30 releases`);
      } catch (error) {
        attempts.push(`${provider.label}: ${error.message}`);
        for (const candidate of knownAssets(provider, this.platform, this.arch)) {
          if (await headOk(candidate.url)) return candidate;
        }
      }
    }
    throw new Error("No VS Code server build could be found for " + `${this.platform}-${this.arch}` + ". " + attempts.join(" · "));
  }

  async ensureServer() {
    if (this.serverInstalled()) return;
    if (platformTokens(this.platform, this.arch).length === 0 && platformTokens(this.platform, this.arch, "codeserver").length === 0) throw new Error(`No VS Code server build for ${this.platform}-${this.arch}.`);
    if (this.platform === "win32") throw new Error("Windows is not supported yet for the embedded VS Code server.");
    await fsp.mkdir(this.dataDir, { recursive: true });
    this.progress("download", "Looking up the latest VS Code server release…", 0);
    const asset = await this.resolveDownload();
    const provider = providers[asset.provider];
    const archive = path.join(this.dataDir, asset.name);
    this.progress("download", `Downloading ${provider.label} ${asset.version}…`, 0);
    let lastPercent = -1;
    await download(asset.url, archive, (received, total) => {
      if (!total) return;
      const percent = Math.floor((received / total) * 100);
      if (percent === lastPercent) return;
      lastPercent = percent;
      this.progress("download", `Downloading ${provider.label} ${asset.version}… ${Math.round(received / 1048576)} / ${Math.round(total / 1048576)} MB`, received / total);
    });
    this.progress("extract", `Extracting ${provider.label}…`);
    await fsp.rm(this.serverDir, { recursive: true, force: true });
    await fsp.mkdir(this.serverDir, { recursive: true });
    await run("tar", ["-xzf", archive, "-C", this.serverDir, "--strip-components=1"]);
    await fsp.rm(archive, { force: true });
    if (!fs.existsSync(path.join(this.serverDir, provider.binary(this.platform)))) throw new Error(`The ${provider.label} archive did not contain the expected binary.`);
    await fsp.writeFile(this.installFile, JSON.stringify({ provider: provider.id, version: asset.version }));
  }

  // The server must not inherit an IDE terminal's variables: with VSCODE_IPC_HOOK_CLI set, code-server and
  // openvscode-server act as the `code` CLI (open the folder in the parent editor and exit 0 silently).
  serverEnv(launch = null) {
    const env = serverEnvironment(this.env, this.home);
    if (launch?.libraryPath) {
      const key = this.platform === "darwin" ? "DYLD_LIBRARY_PATH" : "LD_LIBRARY_PATH";
      env[key] = env[key] ? `${launch.libraryPath}${path.delimiter}${env[key]}` : launch.libraryPath;
    }
    return env;
  }

  // Where the running server's output goes. A file, not a pipe: pipe writes can fail or be lost when the parent is Electron.
  get serverLogFile() { return path.join(this.dataDir, "server.log"); }

  async serverLogTail(limit = 6000) {
    try { const text = await fsp.readFile(this.serverLogFile, "utf8"); return text.slice(-limit).trim(); } catch { return ""; }
  }

  async installVsix(vsixPath, agentId = "claude") {
    const agent = agentFor(agentId);
    const provider = this.provider();
    if (!provider) throw new Error("Install the VS Code server first.");
    await fsp.mkdir(this.extensionsDir, { recursive: true });
    const install = this.launchCommand(provider.installArgs({ extensionsDir: this.extensionsDir, target: vsixPath }));
    await run(install.command, install.args, { env: this.serverEnv(), cwd: this.serverDir });
    const installed = await findInstalledExtension(this.extensionsDir, agent.extensionId);
    if (!installed) throw new Error(`The extension installed but ${agent.label} was not found in the extensions folder.`);
    this.extensionSources[agent.id] = "vsix";
    if (agent.id === "claude") this.extensionSource = "vsix";
    return installed;
  }

  ensureClaudeExtension() { return this.ensureExtension("claude"); }

  // Installs an agent's extension: from a local IDE install, else Open VSX, else the Visual Studio Marketplace.
  async ensureExtension(agentId = "claude") {
    const agent = agentFor(agentId);
    const setSource = source => { this.extensionSources[agent.id] = source; if (agent.id === "claude") this.extensionSource = source; };
    await fsp.mkdir(this.extensionsDir, { recursive: true });
    if (await findInstalledExtension(this.extensionsDir, agent.extensionId)) { if (!this.extensionSources[agent.id]) setSource("installed"); return; }
    // 1. Copy from a local VS Code / Cursor / Windsurf install.
    for (const dir of localExtensionDirs(this.home)) {
      const found = await findInstalledExtension(dir, agent.extensionId);
      if (!found) continue;
      this.progress("extension", `Copying ${agent.label} from ${path.basename(path.dirname(dir))}…`);
      await fsp.cp(found, path.join(this.extensionsDir, path.basename(found)), { recursive: true });
      setSource("local");
      return;
    }
    const provider = this.provider();
    // 2. Open VSX (the default gallery of both servers).
    this.progress("extension", `Installing ${agent.label} from Open VSX…`);
    try {
      const install = this.launchCommand(provider.installArgs({ extensionsDir: this.extensionsDir, target: agent.extensionId }));
      await run(install.command, install.args, { env: this.serverEnv(), cwd: this.serverDir });
      if (await findInstalledExtension(this.extensionsDir, agent.extensionId)) { setSource("open-vsx"); return; }
    } catch (error) { this.log("Open VSX install failed: " + error.message); }
    // 3. Visual Studio Marketplace package.
    this.progress("extension", `Downloading ${agent.label} from the Visual Studio Marketplace…`);
    const vsix = path.join(this.dataDir, `${agent.id}.vsix`);
    await download(marketplaceVsixFor(agent), vsix, null);
    // The marketplace serves the package gzip-compressed for some clients; a VSIX is a zip, so unwrap if needed.
    const header = Buffer.alloc(2);
    const handle = await fsp.open(vsix, "r"); await handle.read(header, 0, 2, 0); await handle.close();
    if (header[0] === 0x1f && header[1] === 0x8b) { const zlib = require("node:zlib"); await fsp.writeFile(vsix + ".zip", zlib.gunzipSync(await fsp.readFile(vsix))); await fsp.rename(vsix + ".zip", vsix); }
    await this.installVsix(vsix, agent.id);
    setSource("marketplace");
  }

  get commandsDir() { return path.join(this.dataDir, "commands"); }
  get workspacesDir() { return path.join(this.dataDir, "workspaces"); }

  // The .code-workspace file a tile opens: it carries the tile's agent so the session can tell which tile it serves.
  workspaceFileFor(folder, agentId = "claude", instance = "") {
    const file = path.join(this.workspacesDir, tileKey(agentFor(agentId).id, folder, instance) + ".code-workspace");
    fs.mkdirSync(this.workspacesDir, { recursive: true });
    const contents = JSON.stringify({ folders: [{ path: folder }], settings: {} }, null, 2) + "\n";
    try { if (fs.readFileSync(file, "utf8") !== contents) fs.writeFileSync(file, contents); } catch { fs.writeFileSync(file, contents); }
    return file;
  }

  urlForTile(folder, agentId = "claude", instance = "") {
    const provider = this.provider();
    if (!this.port || !this.token || !provider) return null;
    return provider.workspaceUrl(this.port, this.token, this.workspaceFileFor(folder, agentId, instance));
  }

  // Drops a command for the tile's session; resolves once the bootstrap extension reports it done (or after a timeout).
  async readDiagnostic(folder, agentId, instance = "") {
    try { return JSON.parse(await fsp.readFile(path.join(this.commandsDir, tileKey(agentFor(agentId).id, folder, instance) + ".diag.json"), "utf8")); } catch { return null; }
  }

  async sendCommand(folder, agentId, action, timeout = 8000, instance = "") {
    const key = tileKey(agentFor(agentId).id, folder, instance);
    await fsp.mkdir(this.commandsDir, { recursive: true });
    const id = randomBytes(6).toString("hex");
    const done = path.join(this.commandsDir, key + ".done");
    await fsp.rm(done, { force: true });
    await fsp.writeFile(path.join(this.commandsDir, key + ".json"), JSON.stringify({ id, action, agent: agentFor(agentId).id, at: Date.now() }));
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeout) {
      try { const result = JSON.parse(await fsp.readFile(done, "utf8")); if (result.id === id) return true; } catch { /* not yet */ }
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    return false;
  }

  async writeBootstrap() {
    const files = bootstrapExtensionFiles(this.commandsDir);
    const version = JSON.parse(files["package.json"]).version;
    // Older bootstrap folders are removed so VS Code loads one copy only.
    try { for (const entry of await fsp.readdir(this.extensionsDir)) { if (entry.startsWith(bootstrapId + "-") && entry !== bootstrapId + "-" + version) await fsp.rm(path.join(this.extensionsDir, entry), { recursive: true, force: true }); } } catch { /* first run */ }
    const dir = path.join(this.extensionsDir, bootstrapId + "-" + version);
    await fsp.mkdir(dir, { recursive: true });
    for (const [name, contents] of Object.entries(files)) await fsp.writeFile(path.join(dir, name), contents);
    const settingsDir = path.join(this.userDataDir, "User");
    await fsp.mkdir(settingsDir, { recursive: true });
    const settingsPath = path.join(settingsDir, "settings.json");
    let existing = {};
    try { existing = JSON.parse(await fsp.readFile(settingsPath, "utf8")); } catch { existing = {}; }
    const { merged, changed } = mergeSettings(existing);
    if (changed) await fsp.writeFile(settingsPath, JSON.stringify(merged, null, 2) + "\n");
  }

  // Downloads, installs and starts everything. Safe to call repeatedly; concurrent calls share one task.
  setup(agentId = "claude") {
    if (this.setupTask) return this.setupTask;
    const agent = agentFor(agentId);
    this.lastError = null;
    this.setupTask = (async () => {
      try {
        await this.ensureServer();
        await this.ensureExtension(agent.id);
        await this.writeBootstrap();
        await this.start();
        this.progress("ready", `${agent.label} is ready.`, 1);
      } catch (error) {
        this.lastError = error.message;
        this.progress("error", error.message);
        throw error;
      } finally { this.setupTask = null; }
    })();
    return this.setupTask;
  }

  baseUrl() { return `http://127.0.0.1:${this.port}`; }

  urlForFolder(folder) {
    const provider = this.provider();
    if (!this.port || !this.token || !provider) return null;
    return provider.folderUrl(this.port, this.token, folder);
  }

  async start() {
    if (this.process && this.port) return this.baseUrl();
    if (this.starting) return this.starting;
    this.starting = (async () => {
      const provider = this.provider();
      if (!provider) throw new Error("The VS Code server is not installed.");
      // The bootstrap extension and settings are refreshed on every start, so an update never runs an old copy.
      await this.writeBootstrap();
      await fsp.mkdir(this.commandsDir, { recursive: true });
      let port = null;
      for (const candidate of this.ports) { if (await portIsFree(candidate)) { port = candidate; break; } }
      if (!port) throw new Error("No free port for the VS Code server.");
      this.token = randomBytes(18).toString("hex");
      await fsp.mkdir(this.userDataDir, { recursive: true });
      await fsp.mkdir(this.serverDataDir, { recursive: true });
      const args = provider.startArgs({ port, token: this.token, serverDataDir: this.serverDataDir, userDataDir: this.userDataDir, extensionsDir: this.extensionsDir });
      this.progress("start", `Starting ${provider.label}…`);
      const launch = this.launchCommand(args);
      const binary = launch.command;
      this.log(`[vscode] (${launch.mode}) ${binary} ${launch.args.join(" ")}`);
      await fsp.mkdir(this.dataDir, { recursive: true });
      await fsp.writeFile(this.serverLogFile, `# ${new Date().toISOString()} ${binary} ${launch.args.join(" ")}\n`);
      const logFd = fs.openSync(this.serverLogFile, "a");
      let child;
      try { child = spawn(binary, launch.args, { cwd: this.serverDir, env: this.serverEnv(launch), stdio: ["ignore", logFd, logFd] }); }
      finally { fs.closeSync(logFd); }
      let output = "";
      let closed = false;
      child.on("error", error => { output += "\n" + error.message; });
      child.on("close", () => { closed = true; });
      child.on("exit", async code => { const tail = await this.serverLogTail(800); this.log(`[vscode] server exited with ${code}${tail ? ": " + tail : ""}`); if (this.process === child) { this.process = null; this.port = null; } });
      this.process = child;
      const startedAt = Date.now();
      await new Promise((resolve, reject) => {
        const failed = async () => {
          if (!closed) await new Promise(done => setTimeout(done, 300));
          output = ((await this.serverLogTail(1200)) + "\n" + output).trim();
          const report = await this.diagnostics().catch(error => "diagnostics failed: " + error.message);
          reject(new Error(`The VS Code server stopped right after starting (exit ${child.exitCode}${child.signalCode ? ", signal " + child.signalCode : ""}). ${output ? "Output: " + output.slice(-900) : "No output."}\nCommand: ${binary} ${launch.args.join(" ")}\nLog file: ${this.serverLogFile}\n${report}`));
        };
        const probe = () => {
          if (child.exitCode !== null) return failed();
          const request = http.get(provider.probeUrl(port, this.token), response => { response.resume(); if (response.statusCode && response.statusCode < 500) resolve(); else setTimeout(probe, 300); });
          request.on("error", async () => { if (Date.now() - startedAt > 60000) reject(new Error("The VS Code server did not answer in time. " + (await this.serverLogTail(300)))); else setTimeout(probe, 300); });
          request.setTimeout(2000, () => request.destroy());
        };
        probe();
      });
      this.port = port;
      return this.baseUrl();
    })().finally(() => { this.starting = null; });
    return this.starting;
  }

  stop() {
    if (this.process) { this.process.kill(); this.process = null; }
    this.port = null;
  }
}

module.exports = { VscodeServer, chatOnlyKeys, extensionAgents, tileKey, inspectExtension, providers, pickRelease, knownAssets, platformTokens, mergeSettings, defaultSettings, bootstrapExtensionFiles, localExtensionDirs, extendedPath, serverEnvironment, claudeExtensionId };
