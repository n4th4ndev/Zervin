import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import vscodeServer from "../electron/vscode-server.cjs";

const { VscodeServer, chatOnlyKeys, extensionAgents, tileKey, providers, pickRelease, knownAssets, platformTokens, mergeSettings, defaultSettings, bootstrapExtensionFiles, localExtensionDirs, extendedPath, serverEnvironment } = vscodeServer;

test("platform tokens cover macOS, Linux and Windows builds", () => {
  assert.deepEqual(platformTokens("darwin", "arm64"), ["darwin-arm64"]);
  assert.deepEqual(platformTokens("darwin", "arm64", "codeserver"), ["macos-arm64"]);
  assert.ok(platformTokens("darwin", "x64").includes("darwin"));
  assert.deepEqual(platformTokens("linux", "x64", "codeserver"), ["linux-amd64"]);
  assert.deepEqual(platformTokens("freebsd", "x64"), []);
});

test("pickRelease chooses the newest release that ships a build for the platform", () => {
  const releases = [
    { tag_name: "openvscode-server-v1.110.0", draft: true, prerelease: false, assets: [{ name: "openvscode-server-v1.110.0-darwin-arm64.tar.gz", browser_download_url: "https://x/draft" }] },
    { tag_name: "openvscode-server-v1.109.5", draft: false, prerelease: false, assets: [{ name: "openvscode-server-v1.109.5-linux-x64.tar.gz", browser_download_url: "https://x/linux" }] },
    { tag_name: "openvscode-server-v1.108.2", draft: false, prerelease: false, assets: [{ name: "openvscode-server-v1.108.2-darwin-arm64.tar.gz", browser_download_url: "https://x/mac", size: 123 }, { name: "openvscode-server-v1.108.2-linux-x64.tar.gz", browser_download_url: "https://x/linux2" }] },
  ];
  const mac = pickRelease(releases, providers.openvscode, "darwin", "arm64");
  assert.deepEqual(mac, { provider: "openvscode", version: "1.108.2", name: "openvscode-server-v1.108.2-darwin-arm64.tar.gz", url: "https://x/mac", size: 123 });
  assert.equal(pickRelease(releases, providers.openvscode, "linux", "x64").version, "1.109.5");
  assert.equal(pickRelease(releases, providers.openvscode, "win32", "x64"), null);
  const coder = [{ tag_name: "v4.104.3", draft: false, prerelease: false, assets: [{ name: "code-server-4.104.3-macos-arm64.tar.gz", browser_download_url: "https://x/cs" }] }];
  assert.equal(pickRelease(coder, providers.codeserver, "darwin", "arm64").url, "https://x/cs");
  assert.equal(pickRelease("junk", providers.codeserver, "darwin", "arm64"), null);
});

test("known assets give offline candidates newest first with the right names", () => {
  const list = knownAssets(providers.openvscode, "darwin", "arm64");
  assert.equal(list[0].url, `https://github.com/gitpod-io/openvscode-server/releases/download/openvscode-server-v${providers.openvscode.knownVersions[0]}/openvscode-server-v${providers.openvscode.knownVersions[0]}-darwin-arm64.tar.gz`);
  const coder = knownAssets(providers.codeserver, "darwin", "x64");
  assert.match(coder[0].url, /code-server\/releases\/download\/v[\d.]+\/code-server-[\d.]+-macos-amd64\.tar\.gz$/);
  assert.equal(providers.codeserver.folderUrl(1234, "t", "/Users/me/app"), "http://127.0.0.1:1234/?folder=%2FUsers%2Fme%2Fapp");
  assert.match(providers.openvscode.folderUrl(1234, "tok", "/a b"), /\?tkn=tok&folder=%2Fa%20b$/);
  assert.ok(providers.codeserver.startArgs({ port: 1, token: "t", userDataDir: "u", extensionsDir: "e", serverDataDir: "s" }).includes("--auth"));
  // The host keeps its real app name so extensions recognise the IDE they run in.
  assert.ok(!providers.codeserver.startArgs({ port: 1, token: "t", userDataDir: "u", extensionsDir: "e", serverDataDir: "s" }).includes("--app-name"));
});

test("merges hidden-chrome defaults without overriding user settings", () => {
  const { merged, changed } = mergeSettings({ "workbench.colorTheme": "Monokai", "editor.fontSize": 15 });
  assert.equal(changed, true);
  assert.equal(merged["workbench.colorTheme"], "Monokai");
  assert.equal(merged["editor.fontSize"], 15);
  assert.equal(merged["workbench.activityBar.location"], "hidden");
  assert.equal(mergeSettings({ ...defaultSettings }).changed, false);
});

test("bootstrap extension opens the Claude view on startup", () => {
  const files = bootstrapExtensionFiles();
  const manifest = JSON.parse(files["package.json"]);
  assert.equal(manifest.publisher, "zevrin");
  assert.deepEqual(manifest.activationEvents, ["onStartupFinished"]);
  assert.match(files["extension.js"], /anthropic\.claude-code/);
  assert.match(files["extension.js"], /workbench\.view\.extension\./);
  assert.match(files["extension.js"], /toggleMaximizedAuxiliaryBar/);
  assert.deepEqual(manifest.contributes.keybindings.map(item => item.command), ["zevrin.chatOnly", "zevrin.widenSidebar", "zevrin.open.claude", "zevrin.open.codex", "zevrin.open.gemini"]);
  assert.equal(manifest.contributes.keybindings[0].key, chatOnlyKeys.chatOnly);
  assert.equal(chatOnlyKeys.open.codex, "ctrl+alt+shift+f7");
  assert.match(files["extension.js"], /openai\.chatgpt/);
  assert.equal(extensionAgents.gemini.extensionId, "google.geminicodeassist");
});

test("looks for local IDE extension folders and extends PATH for the server", () => {
  const dirs = localExtensionDirs("/Users/me");
  assert.ok(dirs.includes("/Users/me/.vscode/extensions"));
  assert.ok(dirs.includes("/Users/me/.cursor/extensions"));
  const merged = extendedPath({ PATH: "/usr/bin" }, "/Users/me");
  assert.ok(merged.startsWith("/usr/bin"));
  assert.ok(merged.includes("/opt/homebrew/bin"));
});

test("status reflects the installed server record, extension and bootstrap files", async t => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "zevrin-vscode-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const server = new VscodeServer({ dataDir, ports: [0], home: dataDir, platform: "darwin", arch: "arm64" });
  await server.writeBootstrap();
  const settings = JSON.parse(await readFile(path.join(server.userDataDir, "User", "settings.json"), "utf8"));
  assert.equal(settings["workbench.statusBar.visible"], false);
  let status = await server.status();
  assert.equal(status.supported, true);
  assert.equal(status.serverInstalled, false);
  assert.equal(status.serverVersion, null);
  assert.equal(server.urlForFolder("/tmp/x"), null);
  // A recorded install with the binary present counts as installed, for either provider.
  await mkdir(path.join(server.serverDir, "bin"), { recursive: true });
  await writeFile(path.join(server.serverDir, "bin", "code-server"), "#!/bin/sh\n");
  await writeFile(server.installFile, JSON.stringify({ provider: "codeserver", version: "4.104.3" }));
  await mkdir(path.join(server.extensionsDir, "anthropic.claude-code-2.1.0"), { recursive: true });
  status = await server.status();
  assert.equal(status.serverInstalled, true);
  assert.equal(status.serverVersion, "code-server 4.104.3");
  assert.equal(status.extensionInstalled, true);
  assert.equal(status.agents.claude.installed, true);
  assert.equal(status.agents.codex.installed, false);
  await mkdir(path.join(server.extensionsDir, "openai.chatgpt-1.2.3"), { recursive: true });
  assert.equal((await server.status()).agents.codex.installed, true);
  assert.equal(server.binaryPath(), path.join(server.serverDir, "bin", "code-server"));
  // Without the bundled node the wrapper script is used; with it, node runs the entry directly.
  assert.deepEqual(server.launchCommand(["--version"]), { command: path.join(server.serverDir, "bin", "code-server"), args: ["--version"], mode: "script" });
  await mkdir(path.join(server.serverDir, "lib"), { recursive: true });
  await writeFile(path.join(server.serverDir, "lib", "node"), "");
  const launch = server.launchCommand(["--version"]);
  assert.deepEqual(launch, { command: path.join(server.serverDir, "lib", "node"), args: [path.join(server.serverDir, "out", "node", "entry.js"), "--version"], mode: "direct", libraryPath: path.join(server.serverDir, "lib") });
  assert.equal(server.serverEnv(launch).DYLD_LIBRARY_PATH, path.join(server.serverDir, "lib"));
  assert.equal(server.serverEnv().DYLD_LIBRARY_PATH, undefined);
  const report = await server.diagnostics();
  assert.match(report, /bundled node: present/);
  assert.match(report, /script head:/);
});

test("the server environment drops IDE terminal variables that turn the server into a CLI", () => {
  const env = serverEnvironment({ PATH: "/usr/bin", VSCODE_IPC_HOOK_CLI: "/tmp/sock", VSCODE_GIT_ASKPASS_MAIN: "x", ELECTRON_RUN_AS_NODE: "1", TERM_PROGRAM: "vscode", NODE_OPTIONS: "--inspect", HOME: "/Users/me", LANG: "fr_FR.UTF-8" }, "/Users/me");
  assert.equal(env.VSCODE_IPC_HOOK_CLI, undefined);
  assert.equal(env.VSCODE_GIT_ASKPASS_MAIN, undefined);
  assert.equal(env.ELECTRON_RUN_AS_NODE, undefined);
  assert.equal(env.TERM_PROGRAM, undefined);
  assert.equal(env.NODE_OPTIONS, undefined);
  assert.equal(env.HOME, "/Users/me");
  assert.equal(env.LANG, "fr_FR.UTF-8");
  assert.ok(env.PATH.startsWith("/usr/bin"));
  assert.equal(env.ZEVRIN, "1");
});

test("tiles open a .code-workspace named after their agent and get commands through files", async t => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "zevrin-vscode-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const server = new VscodeServer({ dataDir, ports: [0], home: dataDir, platform: "darwin", arch: "arm64" });
  const key = tileKey("codex", "/Users/me/app");
  assert.match(key, /^codex-[0-9a-f]{10}$/);
  assert.equal(tileKey("codex", "/Users/me/app"), key);
  assert.notEqual(tileKey("claude", "/Users/me/app"), key);
  // Two tiles of the same agent on the same folder get separate sessions.
  assert.notEqual(tileKey("claude", "/Users/me/app", "tile-a"), tileKey("claude", "/Users/me/app", "tile-b"));
  assert.match(tileKey("claude", "/Users/me/app", "tile-a"), /^claude-[0-9a-f]{10}$/);
  const file = server.workspaceFileFor("/Users/me/app", "codex");
  assert.equal(path.basename(file), key + ".code-workspace");
  assert.deepEqual(JSON.parse(await readFile(file, "utf8")).folders, [{ path: "/Users/me/app" }]);
  await mkdir(path.join(server.serverDir, "bin"), { recursive: true });
  await writeFile(path.join(server.serverDir, "bin", "code-server"), "#!/bin/sh\n");
  await writeFile(server.installFile, JSON.stringify({ provider: "codeserver", version: "4.104.3" }));
  server.port = 4321; server.token = "tok";
  assert.match(server.urlForTile("/Users/me/app", "codex"), /\?workspace=.*codex-[0-9a-f]{10}\.code-workspace$/);
  // A command is written for the tile and resolves once the extension writes the matching .done file.
  const pending = server.sendCommand("/Users/me/app", "codex", "chatOnly", 3000);
  await new Promise(resolve => setTimeout(resolve, 150));
  const command = JSON.parse(await readFile(path.join(server.commandsDir, key + ".json"), "utf8"));
  assert.equal(command.action, "chatOnly"); assert.equal(command.agent, "codex");
  await writeFile(path.join(server.commandsDir, key + ".done"), JSON.stringify({ id: command.id }));
  assert.equal(await pending, true);
  const files = bootstrapExtensionFiles(server.commandsDir);
  assert.match(files["extension.js"], /workspaceFile/);
  assert.match(files["extension.js"], /diag\.json/);
  assert.ok(files["extension.js"].includes(JSON.stringify(server.commandsDir)));
});
