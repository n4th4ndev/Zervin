"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ExtensionAgentId, VscodeProgress, VscodeStatus } from "../types/desktop";
import type { WebviewElement } from "../types/webview";
import { agentProfiles, forceChatOnlyScript, releaseChatOnlyScript, type ChatOnlyAction } from "./chat-only";

type Props = { workspacePath: string; desktop: boolean; visible: boolean; agent?: ExtensionAgentId; instance?: string; onOpenCli?: () => void };

function cleanError(error: unknown, fallback: string) {
  return (error instanceof Error ? error.message : "").replace(/^Error invoking remote method '[^']+': (Error: )?/, "") || fallback;
}

// An official coding-agent VS Code extension (Claude Code, Codex, Gemini), running in the local VS Code server embedded
// in the tile, shown chat-only. Each agent gets its own browser partition so its layout and sign-in are independent.
export function AgentExtension({ workspacePath, desktop, visible, agent = "claude", instance = "", onOpenCli }: Props) {
  const profile = agentProfiles[agent];
  const [status, setStatus] = useState<VscodeStatus | null>(null);
  const [progress, setProgress] = useState<VscodeProgress | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [layoutStatus, setLayoutStatus] = useState("");
  const statusRef = useRef<VscodeStatus | null>(null);
  const [chatOnly, setChatOnly] = useState(true);
  const chatOnlyRef = useRef(true);
  useEffect(() => { chatOnlyRef.current = chatOnly; }, [chatOnly]);
  const frameRef = useRef<HTMLElement | null>(null);

  const refresh = useCallback(async () => {
    const api = window.zevrinDesktop;
    if (!api) return null;
    try {
      const next = await api.vscodeStatus();
      setStatus(next); statusRef.current = next;
      if (next.serverInstalled && next.agents?.[agent]?.installed && next.agents?.[agent]?.runnable !== false && !next.busy) {
        const target = await api.vscodeUrl(workspacePath, agent, instance);
        setUrl(target);
      }
      return next;
    } catch (caught) { setError(cleanError(caught, "Could not read the VS Code server status.")); return null; }
  }, [workspacePath, agent, instance]);

  useEffect(() => {
    const api = window.zevrinDesktop;
    if (!desktop || !api) return;
    refresh();
    return api.onVscodeProgress(event => { setProgress(event); if (event.step === "ready" || event.step === "error") refresh(); });
  }, [desktop, refresh]);

  async function setup() {
    const api = window.zevrinDesktop;
    if (!api || busy) return;
    setBusy(true); setError("");
    try { await api.vscodeSetup(agent); await refresh(); }
    catch (caught) { setError(cleanError(caught, "The installation failed.")); }
    finally { setBusy(false); }
  }

  async function installVsix() {
    const api = window.zevrinDesktop;
    if (!api || busy) return;
    setBusy(true); setError("");
    try { const next = await api.vscodeInstallVsix(agent); if (next) { await api.vscodeSetup(agent).catch(() => {}); await refresh(); } }
    catch (caught) { setError(cleanError(caught, "The .vsix could not be installed.")); }
    finally { setBusy(false); }
  }

  async function restart() {
    const api = window.zevrinDesktop;
    if (!api) return;
    setBusy(true); setError("");
    try { await api.vscodeRestart(); await refresh(); setReloadKey(key => key + 1); }
    catch (caught) { setError(cleanError(caught, "The VS Code server could not restart.")); }
    finally { setBusy(false); }
  }

  // Chat-only mode: the page is forced into a chat-only layout (the agent's view and its webview stretched over the
  // window, the rest hidden). If the view is not open yet, the bootstrap extension is asked to open it.
  const runAction = useCallback(async (action: ChatOnlyAction) => {
    const api = window.zevrinDesktop;
    const frame = frameRef.current as WebviewElement | null;
    if (!api || !frame) return;
    if (action === "chatOnly") { try { await api.previewEval(frame.getWebContentsId(), forceChatOnlyScript(profile.names)); } catch { /* reloading */ } return; }
    try { await api.vscodeCommand(workspacePath, agent, action === "openClaude" ? "open" : action, instance); } catch { /* the session is not ready yet */ }
  }, [agent, workspacePath, profile.names, instance]);

  useEffect(() => {
    const api = window.zevrinDesktop;
    const frame = frameRef.current as WebviewElement | null;
    if (!desktop || !api || !frame || !url) return;
    let stopped = false;
    let ready = false;
    let lastOpen = 0;
    const tick = async () => {
      if (stopped || !ready) return;
      if (!chatOnlyRef.current) { try { await api.previewEval(frame.getWebContentsId(), releaseChatOnlyScript); } catch { /* reloading */ } setLayoutStatus("Full workbench"); return; }
      let result = "";
      try { result = String(await api.previewEval(frame.getWebContentsId(), forceChatOnlyScript(profile.names))); } catch { result = ""; }
      if (result === "no-workbench" || result === "") { setLayoutStatus("Loading VS Code…"); return; }
      if (result === "view-not-open") {
        setLayoutStatus(`Opening the ${profile.label} view…`);
        if (Date.now() - lastOpen > 4000) { lastOpen = Date.now(); try { await api.vscodeCommand(workspacePath, agent, "open", instance); } catch { /* not ready */ } }
        return;
      }
      setLayoutStatus(result.startsWith("forced:") ? "Chat only" : `Chat only · waiting for the ${profile.label} view to render`);
    };
    const onReady = () => { ready = true; setTimeout(tick, 800); };
    frame.addEventListener("dom-ready", onReady);
    const timer = setInterval(tick, 1500);
    return () => { stopped = true; clearInterval(timer); frame.removeEventListener("dom-ready", onReady); };
  }, [desktop, url, reloadKey, agent, profile.names, profile.label, workspacePath, instance]);

  const [diagnosing, setDiagnosing] = useState(false);
  const [diagnostic, setDiagnostic] = useState<string | null>(null);
  async function diagnose() {
    const api = window.zevrinDesktop;
    if (!api) return;
    setDiagnosing(true);
    try {
      const result = await api.vscodeDiagnose(workspacePath, agent, instance);
      const text = JSON.stringify({ agent, layout: layoutStatus, ...result }, null, 2);
      setDiagnostic(text);
      try { await navigator.clipboard.writeText(text); } catch { /* clipboard unavailable */ }
    } catch (caught) { setDiagnostic(cleanError(caught, "The diagnostic failed.")); }
    finally { setDiagnosing(false); }
  }

  if (!desktop) {
    return <div className="vscode-view"><div className="chat-empty"><div className="editor-logo">{profile.label[0]}</div><h2>{profile.label}</h2><p>Open the Zevrin desktop app to run the official {profile.label} extension in this workspace.</p></div></div>;
  }

  const agentStatus = status?.agents?.[agent];
  const ready = Boolean(url) && status?.serverInstalled && agentStatus?.installed;
  const working = busy || status?.busy || (progress && progress.step !== "ready" && progress.step !== "error");

  return <div className="vscode-view">
    {ready ? <>
      <div className="vscode-bar">
        <span className="vscode-status-dot" title={status?.running ? "VS Code server running" : "Starting…"}/>
        <span className="vscode-title">{profile.label} · {workspacePath.split("/").pop()}</span>
        <span className="vscode-layout-status" title="Layout inside the tile">{layoutStatus}</span>
        <span className="chat-spacer"/>
        <button className={"chat-icon-button" + (chatOnly ? " active" : "")} title={chatOnly ? "Chat only (click to show the full VS Code workbench)" : "Full workbench (click for chat only)"} aria-pressed={chatOnly} onClick={() => { setChatOnly(value => !value); if (!chatOnly) runAction("chatOnly"); }}>{chatOnly ? "▣" : "▦"}</button>
        <button className="chat-icon-button" title="Diagnostic: what the extension sees (copied to the clipboard)" aria-label="Diagnostic" onClick={diagnose} disabled={diagnosing}>{diagnosing ? "…" : "ⓘ"}</button>
        <button className="chat-icon-button" title="Re-apply chat only" aria-label="Re-apply chat only" onClick={() => runAction("chatOnly")}>⤢</button>
        <button className="chat-icon-button" title="Reload" aria-label="Reload" onClick={() => setReloadKey(key => key + 1)}>↻</button>
        <button className="chat-icon-button" title="Restart the VS Code server" aria-label="Restart the VS Code server" onClick={restart} disabled={busy}>⟳</button>
      </div>
      {diagnostic && <div className="vscode-diagnostic"><div><strong>Diagnostic</strong><span>Copied to the clipboard. Paste it in the conversation.</span><button className="chat-icon-button" aria-label="Close diagnostic" onClick={() => setDiagnostic(null)}>×</button></div><pre>{diagnostic}</pre></div>}
      <webview key={reloadKey} ref={frameRef as import("react").Ref<HTMLElement>} className="vscode-frame" src={url!} partition={agent === "claude" ? "persist:zevrin-vscode" : `persist:zevrin-vscode-${agent}`} {...({ allowpopups: "true" } as Record<string, string>)}/>
      {!visible && null}
    </> : <div className="vscode-setup">
      <div className="editor-logo">{profile.label[0]}</div>
      <h2>{profile.label}</h2>
      {status && !status.supported ? <p>The embedded VS Code server is not available for {status.platform}.</p>
        : <p>The official {profile.label} extension's chat, on its own, scoped to this project. Zevrin runs it in a local VS Code server kept out of sight (only the {profile.label} view is shown). The first setup downloads about 100 MB.</p>}
      <ul className="vscode-steps">
        <li className={status?.serverInstalled ? "done" : progress?.step === "download" || progress?.step === "extract" ? "active" : ""}><i/>{status?.serverInstalled ? `VS Code server · ${status.serverVersion}` : "VS Code server (latest release for " + (status?.platform ?? "this machine") + ")"}</li>
        <li className={agentStatus?.installed ? "done" : progress?.step === "extension" ? "active" : ""}><i/>{profile.label} extension{agentStatus?.installed ? ` · ${agentStatus.source === "local" ? "copied from your VS Code" : agentStatus.source === "open-vsx" ? "from Open VSX" : agentStatus.source === "marketplace" ? "from the Marketplace" : "installed"}` : ""}</li>
        <li className={status?.running ? "done" : progress?.step === "start" ? "active" : ""}><i/>Server running{status?.running ? " · " + status.url : ""}</li>
      </ul>
      {working && progress && <div className="vscode-progress"><span>{progress.message}</span>{typeof progress.fraction === "number" && <div className="vscode-progress-bar"><i style={{ width: `${Math.round(progress.fraction * 100)}%` }}/></div>}</div>}
      {agentStatus?.installed && agentStatus.runnable === false && <div className="git-error" role="alert">{profile.label} is installed but cannot run inside the embedded VS Code server: {agentStatus.reason}{onOpenCli && <> Use the <button className="link-button" onClick={onOpenCli}>{profile.label} CLI in a terminal tile</button> instead.</>}</div>}
      {(error || status?.error) && <div className="git-error" role="alert">{error || status?.error}</div>}
      <div className="vscode-actions">
        <button className="primary-button" disabled={!status?.supported || Boolean(working)} onClick={setup}>{working ? "Working…" : status?.serverInstalled && agentStatus?.installed ? "Start" : "Install and start"}</button>
        <button className="subtle-button" disabled={Boolean(working)} onClick={installVsix} title={`Pick the ${profile.label} .vsix file downloaded from the Marketplace`}>Install from .vsix…</button>
      </div>
      <p className="vscode-note">The extension uses the <code>{profile.cli}</code> CLI and your existing sign-in. Zevrin looks for the extension in your VS Code, Cursor or Windsurf install first, then Open VSX, then the Visual Studio Marketplace.</p>
    </div>}
  </div>;
}
