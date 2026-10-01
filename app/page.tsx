"use client";

import { ZevrinIcon } from "./zevrin-mark";
import { useEffect, useMemo, useState } from "react";
import type { AIToolInfo } from "../types/desktop";
import { Glyph, WorkspaceView, errorMessage, initials } from "./workspace-view";
import type { AppSettings, Dialog, Workspace } from "./workspace-view";

type SettingsSection = "General" | "Appearance" | "Terminal" | "Editor" | "AI & Integrations";

const storageKey = "zevrin-projects";
const openStorageKey = "zevrin-open";
const settingsStorageKey = "zevrin-settings";
const defaultSettings: AppSettings = { terminalFontSize: 13, editorFontSize: 14 };
const settingsSections: SettingsSection[] = ["General", "Appearance", "Terminal", "Editor", "AI & Integrations"];
const tints = ["#147d42", "#5429a3", "#0e7b75", "#b4542f", "#3659aa", "#8a2f6b"];

function newId() { return globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`; }

export default function Home() {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [openIds, setOpenIds] = useState<string[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [settingsSection, setSettingsSection] = useState<SettingsSection>("General");
  const [settings, setSettings] = useState<AppSettings>(defaultSettings);
  const [aiTools, setAiTools] = useState<AIToolInfo[]>([]);
  const [aiLoading, setAiLoading] = useState(false);
  const [aiError, setAiError] = useState("");
  const [cloneUrl, setCloneUrl] = useState("");
  const [folderPath, setFolderPath] = useState("");
  const [flowMode, setFlowMode] = useState(false);
  const [desktop, setDesktop] = useState(false);
  const [platform, setPlatform] = useState("");
  const [busy, setBusy] = useState(false);
  const [mcpInfo, setMcpInfo] = useState<{ url: string; command: string; token: string } | null>(null);
  const [mcpConnect, setMcpConnect] = useState("");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const api = window.zevrinDesktop;
    setDesktop(api?.isDesktop === true);
    setPlatform(api?.platform ?? navigator.platform);
    try {
      const saved = localStorage.getItem(storageKey);
      let list: Workspace[] = [];
      if (saved) {
        const parsed: unknown = JSON.parse(saved);
        if (Array.isArray(parsed)) list = parsed.filter((item): item is Workspace => !!item && typeof item === "object" && typeof (item as Workspace).id === "string" && typeof (item as Workspace).path === "string" && typeof (item as Workspace).name === "string").map(item => ({ ...item, tint: typeof item.tint === "string" ? item.tint : tints[0] }));
      }
      setWorkspaces(list);
      const open: unknown = JSON.parse(localStorage.getItem(openStorageKey) || "null");
      if (open && typeof open === "object" && Array.isArray((open as { ids?: unknown }).ids)) {
        const ids = ((open as { ids: unknown[] }).ids).filter((id): id is string => typeof id === "string" && list.some(item => item.id === id));
        setOpenIds(ids);
        const active = (open as { active?: unknown }).active;
        if (typeof active === "string" && ids.includes(active)) setActiveId(active);
      }
      const savedSettings = localStorage.getItem(settingsStorageKey);
      if (savedSettings) {
        const parsed = JSON.parse(savedSettings) as Partial<AppSettings>;
        setSettings({
          terminalFontSize: Number.isFinite(parsed.terminalFontSize) ? Math.min(24, Math.max(10, Number(parsed.terminalFontSize))) : defaultSettings.terminalFontSize,
          editorFontSize: Number.isFinite(parsed.editorFontSize) ? Math.min(24, Math.max(10, Number(parsed.editorFontSize))) : defaultSettings.editorFontSize,
        });
      }
    } catch { /* Ignore invalid local data. */ }
    setLoaded(true);
  }, []);

  useEffect(() => {
    const api = window.zevrinDesktop;
    if (!api) return;
    const remove = api.onAppCommand((requestId, command) => {
      if (command !== "list_workspaces") return;
      api.appCommandResult(requestId, { workspaces: openWorkspaces.map(workspace => ({ name: workspace.name, path: workspace.path, active: workspace.id === activeId })) });
    });
    return remove;
  });

  useEffect(() => {
    if (!desktop || !window.zevrinDesktop || dialog !== "settings") return;
    window.zevrinDesktop.mcpInfo().then(setMcpInfo).catch(() => setMcpInfo(null));
  }, [desktop, dialog]);

  useEffect(() => { window.zevrinDesktop?.setFlowMode?.(flowMode).catch(() => {}); }, [flowMode]);

  useEffect(() => {
    const api = window.zevrinDesktop;
    if (!api) return;
    const removeFlowListener = api.onToggleFlowMode(() => setFlowMode(value => !value));
    const removeFolderListener = api.onOpenFolder?.(() => setDialog("folder")) ?? (() => {});
    return () => { removeFlowListener(); removeFolderListener(); };
  }, []);

  useEffect(() => {
    if (!desktop || !window.zevrinDesktop) return;
    let cancelled = false;
    setAiLoading(true);
    window.zevrinDesktop.aiTools().then(tools => { if (!cancelled) setAiTools(tools); })
      .catch(error => { if (!cancelled) setAiError(errorMessage(error, "Could not detect AI command line tools.")); })
      .finally(() => { if (!cancelled) setAiLoading(false); });
    return () => { cancelled = true; };
  }, [desktop]);

  useEffect(() => { if (loaded) try { localStorage.setItem(storageKey, JSON.stringify(workspaces)); } catch { /* Storage may be unavailable. */ } }, [workspaces, loaded]);
  useEffect(() => { if (loaded) try { localStorage.setItem(openStorageKey, JSON.stringify({ ids: openIds, active: activeId })); } catch { /* Storage may be unavailable. */ } }, [openIds, activeId, loaded]);
  useEffect(() => { if (loaded) try { localStorage.setItem(settingsStorageKey, JSON.stringify(settings)); } catch { /* Storage may be unavailable. */ } }, [settings, loaded]);

  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key === ".") { event.preventDefault(); setFlowMode(value => !value); }
      if (event.key === "Escape") setDialog(null);
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "o" && !event.shiftKey) { event.preventDefault(); setDialog("folder"); }
      if ((event.metaKey || event.ctrlKey) && event.shiftKey && (event.key === "]" || event.key === "[")) {
        event.preventDefault();
        setActiveId(current => {
          if (openIds.length < 2) return current;
          const index = Math.max(0, openIds.indexOf(current ?? ""));
          return openIds[(index + (event.key === "]" ? 1 : openIds.length - 1)) % openIds.length];
        });
      }
    };
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, [openIds]);

  const openWorkspaces = useMemo(() => openIds.map(id => workspaces.find(item => item.id === id)).filter((item): item is Workspace => Boolean(item)), [openIds, workspaces]);
  const active = openWorkspaces.find(item => item.id === activeId) ?? null;

  function openWorkspace(workspace: Workspace) {
    setOpenIds(current => current.includes(workspace.id) ? current : [...current, workspace.id]);
    setActiveId(workspace.id);
    setDialog(null);
  }

  function addWorkspace(path: string, name?: string) {
    const existing = workspaces.find(item => item.path === path);
    if (existing) { openWorkspace(existing); return; }
    const displayName = name || path.split("/").filter(Boolean).pop() || "Workspace";
    const workspace: Workspace = { id: newId(), name: displayName, path, tint: tints[workspaces.length % tints.length] };
    setWorkspaces(current => [workspace, ...current]);
    openWorkspace(workspace);
  }

  function closeWorkspace(id: string) {
    setOpenIds(current => {
      const next = current.filter(item => item !== id);
      setActiveId(activeCurrent => activeCurrent === id ? next[Math.max(0, current.indexOf(id) - 1)] ?? null : activeCurrent);
      return next;
    });
  }

  function removeWorkspace(id: string) {
    setWorkspaces(current => current.filter(item => item.id !== id));
    closeWorkspace(id);
  }

  function forgetWorkspacePath(path: string) {
    const target = workspaces.find(item => item.path === path);
    if (target) removeWorkspace(target.id);
  }

  async function openFolder() {
    if (folderPath.trim()) { addWorkspace(folderPath.trim()); setFolderPath(""); }
    else if (desktop) {
      const selectedPath = await window.zevrinDesktop?.selectFolder();
      if (selectedPath) addWorkspace(selectedPath);
    } else window.alert("Enter a folder path, or open the desktop app to browse.");
  }

  async function cloneRepository() {
    const value = cloneUrl.trim();
    if (!value) return;
    if (!desktop || !window.zevrinDesktop) { window.alert("Cloning repositories is available in the Zevrin desktop app."); return; }
    setBusy(true);
    try {
      const result = await window.zevrinDesktop.cloneRepository(value);
      if (!result.success || !result.path) { window.alert(result.error || "Could not clone this repository."); return; }
      addWorkspace(result.path);
      setCloneUrl("");
    } finally { setBusy(false); }
  }

  const isMac = desktop && platform === "darwin";

  const tabs = <>
    {openWorkspaces.map(workspace => <div key={workspace.id} className={"workspace-tab" + (workspace.id === activeId ? " active" : "")}>
      <button className="workspace-tab-open" title={workspace.path} onClick={() => setActiveId(workspace.id)}><span className="workspace-badge small" style={{ background: workspace.tint }}>{initials(workspace.name)}</span><span className="workspace-tab-name">{workspace.name}</span></button>
      <button className="workspace-tab-close" title={`Close ${workspace.name}`} aria-label={`Close ${workspace.name}`} onClick={() => closeWorkspace(workspace.id)}>×</button>
    </div>)}
    <button className="workspace-tab-add" title="Open another project (⌘O)" aria-label="Open another project" onClick={() => setDialog("folder")}>＋</button>
  </>;

  return (
    <main className={`app-shell ${active ? "is-workspace" : "is-home"} ${flowMode ? "flow-enabled" : ""} ${isMac ? "is-mac" : ""}`}>
      <div className="wallpaper tech-backdrop" aria-hidden="true"><div className="backdrop-grid"/></div>

      {!active && <section className="welcome-card" aria-label="Zevrin welcome screen">
        <div className="brand-mark"><ZevrinIcon size={92} title="Zevrin"/></div>
        <h1>Zevrin</h1>
        <p className="tagline">The agent-native IDE</p>
        <div className="brand-stack" aria-label="Built in">{["Claude", "Codex", "Simulators", "Browser", "MCP"].map(item => <span key={item}>{item}</span>)}</div>
        <div className="welcome-actions">
          <button className="welcome-action" onClick={() => desktop ? openFolder() : setDialog("folder")}><Glyph name="folder" size={20}/><span>Open Folder</span></button>
          <button className="welcome-action" onClick={() => setDialog("clone")}><Glyph name="github" size={20}/><span>Clone Repository</span></button>
        </div>
        {workspaces.length === 0 && <section className="onboarding" aria-label="Getting started">
          <div className="section-title">Get started</div>
          <ol className="onboarding-steps">
            <li><span className="onboarding-step">1</span><div><strong>Open a project</strong><small>A folder on this Mac, or clone a repository. Each project gets its own tab.</small></div></li>
            <li><span className="onboarding-step">2</span><div><strong>Build your workspace</strong><small>Click or drag tiles from the sidebar: Claude, terminal, code, files, preview, canvas, Git.</small></div></li>
            <li><span className="onboarding-step">3</span><div><strong>Work with Claude</strong><small>The official Claude Code chat, plus "Ask Claude" from the editor, the browser and Git.</small></div></li>
          </ol>
        </section>}
        {workspaces.length > 0 && <section className="workspace-list">
          <div className="section-title">Workspaces</div>
          {workspaces.map(workspace => <div className={"workspace-row" + (openIds.includes(workspace.id) ? " open" : "")} key={workspace.id}>
            <button className="workspace-open" onClick={() => openWorkspace(workspace)}>
              <span className="workspace-badge" style={{ background: workspace.tint }}>{initials(workspace.name)}</span>
              <span className="workspace-copy"><strong>{workspace.name}{openIds.includes(workspace.id) && <em className="workspace-open-dot" title="Open"/>}</strong><small>{workspace.path}</small></span>
            </button>
            <button className="remove-workspace" title="Remove from workspaces" aria-label={`Remove ${workspace.name}`} onClick={() => removeWorkspace(workspace.id)}><Glyph name="close" size={15}/></button>
          </div>)}
        </section>}
        <p className="welcome-hint"><kbd>⌘ P</kbd> Command Center · <kbd>⌘ O</kbd> Open folder · <kbd>⌘ .</kbd> Flow Mode</p>
      </section>}

      {openWorkspaces.length > 0 && <section className={"ide-window" + (active ? "" : " ide-hidden")} hidden={!active}>
        {openWorkspaces.map(workspace => <WorkspaceView key={workspace.id} workspace={workspace} visible={workspace.id === activeId} desktop={desktop} platform={platform} settings={settings} aiTools={aiTools} aiLoading={aiLoading} aiError={aiError} flowMode={flowMode} tabs={tabs} onOpenWorkspace={addWorkspace} onForgetWorkspacePath={forgetWorkspacePath} onOpenDialog={setDialog} onToggleFlow={() => setFlowMode(value => !value)} onHome={() => setActiveId(null)}/>)}
      </section>}

      {dialog && <div className="scrim" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) setDialog(null); }}>
        <section className={"dialog" + (dialog === "settings" ? " settings-dialog" : "")} role="dialog" aria-modal="true" aria-labelledby="dialog-title">
          <button className="dialog-close" aria-label="Close" onClick={() => setDialog(null)}><Glyph name="close" size={17}/></button>
          {dialog === "folder" && <>
            <div className="dialog-icon"><Glyph name="folder" size={21}/></div><h2 id="dialog-title">Open Folder</h2><p>Choose a project folder. It opens in its own tab, next to the projects already open.</p>
            <label className="field-label" htmlFor="folder-path">Folder path</label><input id="folder-path" autoFocus placeholder="/Users/you/Projects/my-app" value={folderPath} onChange={event => setFolderPath(event.target.value)} onKeyDown={event => { if (event.key === "Enter") openFolder(); }}/>
            {workspaces.length > 0 && <><div className="field-label">Recent</div><div className="dialog-recent">{workspaces.slice(0, 6).map(workspace => <button key={workspace.id} type="button" onClick={() => openWorkspace(workspace)}><span className="workspace-badge small" style={{ background: workspace.tint }}>{initials(workspace.name)}</span>{workspace.name}</button>)}</div></>}
            <div className="dialog-footer">{desktop && <button className="subtle-button" onClick={() => { setFolderPath(""); openFolder(); }}>Browse…</button>}<button className="subtle-button" onClick={() => setDialog(null)}>Cancel</button><button className="primary-button" onClick={openFolder}>Open Folder</button></div>
          </>}
          {dialog === "clone" && <>
            <div className="dialog-icon"><Glyph name="github" size={21}/></div><h2 id="dialog-title">Clone Repository</h2><p>Clone a Git repository and open it as a workspace.</p>
            <label className="field-label" htmlFor="clone-url">Repository URL</label><input id="clone-url" autoFocus placeholder="user/repo or GitHub URL" value={cloneUrl} onChange={event => setCloneUrl(event.target.value)} onKeyDown={event => { if (event.key === "Enter") cloneRepository(); }}/>
            <div className="field-label">Destination</div><div className="destination-field"><span>~/Projects</span><span className="field-separator">/</span><span>{cloneUrl.split(/[/:]/).filter(Boolean).pop()?.replace(/\.git$/, "") || "repository"}</span></div>
            <div className="dialog-footer"><button className="subtle-button" onClick={() => setDialog(null)}>Cancel</button><button className="primary-button" disabled={!cloneUrl.trim() || busy} onClick={cloneRepository}>{busy ? "Cloning…" : "Clone Repository"}</button></div>
          </>}
          {dialog === "settings" && <>
            <div className="settings-heading"><h2 id="dialog-title">Settings</h2><p>Customize your workspace</p></div>
            <div className="settings-content"><aside aria-label="Settings sections">{settingsSections.map(section => <button key={section} className={settingsSection === section ? "settings-nav active" : "settings-nav"} aria-current={settingsSection === section ? "page" : undefined} onClick={() => setSettingsSection(section)}>{section}</button>)}</aside><div className="settings-form" key={settingsSection}>
              {settingsSection === "General" && <><div className="setting-row"><div><strong>Projects</strong><small>{openWorkspaces.length} open · {workspaces.length} remembered. ⌘⇧] and ⌘⇧[ switch between open projects.</small></div></div><div className="setting-row"><div><strong>Tiles</strong><small>Click a sidebar tile to show or hide it, drag it onto the workspace to place it. Layouts are saved per project.</small></div></div><div className="setting-row"><div><strong>Keyboard shortcuts</strong><small>⌘P Command Center · ⌘O open folder · ⌘. Flow Mode · ⌘S save · ⌘K clear terminal</small></div></div></>}
              {settingsSection === "Appearance" && <><div className="setting-row"><div><strong>Color theme</strong><small>Zevrin currently uses its dark theme</small></div><span className="setting-value">Dark</span></div><div className="setting-row"><div><strong>Reduced motion</strong><small>Animations follow your system accessibility setting</small></div><span className="setting-value">System</span></div></>}
              {settingsSection === "Terminal" && <><label className="setting-row"><span><strong>Font size</strong><small>Terminal text size in pixels</small></span><input type="number" min={10} max={24} value={settings.terminalFontSize} onChange={event => setSettings(current => ({ ...current, terminalFontSize: Math.min(24, Math.max(10, Number(event.target.value) || 10)) }))}/></label><div className="setting-note">Applies immediately to every terminal tile. Range: 10–24 px.</div></>}
              {settingsSection === "Editor" && <><label className="setting-row"><span><strong>Font size</strong><small>Editor text size in pixels</small></span><input type="number" min={10} max={24} value={settings.editorFontSize} onChange={event => setSettings(current => ({ ...current, editorFontSize: Math.min(24, Math.max(10, Number(event.target.value) || 10)) }))}/></label><div className="setting-note">Tab inserts two spaces. Range: 10–24 px.</div></>}
              {settingsSection === "AI & Integrations" && <>{!desktop ? <div className="setting-note">Open the Zevrin desktop app to use Claude Code and other agents.</div> : <>
                <div className="setting-row"><div><strong>Claude</strong><small>Native Claude Code chat (Claude Agent SDK) with your Claude Code sign-in, settings, CLAUDE.md and sessions. ⌘K in the editor uses it too.</small></div><span className={"setting-badge" + (aiTools.find(tool => tool.id === "claude")?.available ? " ok" : "")}>{aiTools.find(tool => tool.id === "claude")?.available ? "Ready" : "CLI not found"}</span></div>
                <div className="setting-row"><div><strong>Codex</strong><small>Native Codex chat (official Codex SDK) with your <code>codex</code> CLI sign-in, threads and modes.</small></div><span className={"setting-badge" + (aiTools.find(tool => tool.id === "codex")?.available ? " ok" : "")}>{aiTools.find(tool => tool.id === "codex")?.available ? "Ready" : "CLI not found"}</span></div>
                {aiLoading && <div className="setting-note">Checking installed assistants…</div>}
                {aiTools.filter(tool => tool.id !== "claude" && tool.id !== "codex").map(tool => <div className="setting-row ai-setting-row" key={tool.id}><div><strong>{tool.name}</strong><small>{tool.available ? "Opens as a terminal tile" : "CLI not found on this Mac"}</small></div><span className={"setting-badge" + (tool.available ? " ok" : "")}>{tool.available ? "Installed" : "Missing"}</span></div>)}
                <div className="setting-row"><div><strong>VS Code extension tiles</strong><small>Experimental: the official Claude Code, Codex and Gemini extensions in an embedded VS Code server, from the agents area +.</small></div><span className="setting-badge">Optional</span></div>
                {aiError && <div className="git-error" role="alert">{aiError}</div>}
                <div className="settings-subhead">Zevrin MCP server</div>
                <div className="setting-note">{mcpInfo ? <>Running at <code>{mcpInfo.url}</code>. Claude and Codex chats in Zevrin are connected automatically. Connect the Claude Code CLI (and the VS Code extension) so they can drive Zevrin too.</> : "Not running."}</div>
                {mcpInfo && <div className="mcp-command" title="The access token is hidden here; Copy copies the full command"><code>{mcpInfo.command.replace(/Bearer ([0-9a-f]{4})[0-9a-f]+([0-9a-f]{4})/i, "Bearer $1••••••••$2")}</code><button type="button" className="subtle-button" onClick={() => { navigator.clipboard?.writeText(mcpInfo.command).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }); }}>{copied ? "Copied" : "Copy"}</button></div>}
                {mcpInfo && <div className="mcp-connect"><button type="button" className="primary-button" onClick={async () => { try { await window.zevrinDesktop!.mcpConnectClaude(); setMcpConnect("Connected. Restart open Claude Code sessions to load the Zevrin tools."); } catch (error) { setMcpConnect((error instanceof Error ? error.message : String(error)).replace(/^Error invoking remote method '[^']+': (Error: )?/, "")); } }}>Connect to Claude Code</button>{mcpConnect && <span>{mcpConnect}</span>}</div>}
                <div className="setting-note">Tools: workspaces and files, the Preview browser (navigate, snapshot, click, type, scroll, network, console, screenshots, recordings), simulators (boot, screenshot, logs, dark mode, URLs), canvas notes, tiles and layouts, terminal commands, notifications. Claude asks before risky actions unless you change the mode in the chat.</div>
              </>}</>}
            </div></div>
            <div className="dialog-footer"><button className="primary-button" onClick={() => setDialog(null)}>Done</button></div>
          </>}
        </section>
      </div>}
    </main>
  );
}
