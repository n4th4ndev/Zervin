// Chat-only mode for the Claude Code extension tile: read the VS Code workbench layout inside the page and decide
// what to do so that only the Claude view is visible.
export type WorkbenchLayout = { width: number; editorsOpen: boolean; editorWidth: number; sidebarWidth: number; auxWidth: number; panelVisible: boolean; claudeIn: "sidebar" | "auxiliarybar" | "none"; workbench: boolean; maximizeButton: boolean };
export type ChatOnlyAction = "chatOnly" | "widen" | "openClaude";
export type ExtensionAgent = "claude" | "codex" | "gemini";
// Words that identify each agent's view in the workbench, and the bootstrap keybinding that opens it.
export const agentProfiles: Record<ExtensionAgent, { label: string; names: string[]; key: [string, number]; cli: string }> = {
  claude: { label: "Claude Code", names: ["claude"], key: ["F10", 121], cli: "claude" },
  codex: { label: "Codex", names: ["codex", "chatgpt", "openai"], key: ["F7", 118], cli: "codex" },
  gemini: { label: "Gemini Code Assist", names: ["gemini"], key: ["F8", 119], cli: "gemini" },
};

// Runs inside the code-server page. `names` identify the agent's view (its ids, labels or titles).
export function layoutProbeScript(names: string[] = agentProfiles.claude.names) {
  const pattern = names.map(name => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  return `(() => {
  const pattern = new RegExp(${JSON.stringify(pattern)}, "i");
  const part = name => document.querySelector(".monaco-workbench .part." + name);
  const width = node => (node && node.offsetParent !== null) ? node.getBoundingClientRect().width : 0;
  const workbench = document.querySelector(".monaco-workbench");
  if (!workbench) return { workbench: false, width: window.innerWidth, editorsOpen: false, editorWidth: 0, sidebarWidth: 0, auxWidth: 0, panelVisible: false, claudeIn: "none", maximizeButton: false };
  // The view container currently shown in a side bar: VS Code gives it an id such as
  // "workbench.view.extension.claude-code". Only that id (or the checked icon's label) counts, so a ".claude" folder in
  // the Explorer or a file name never passes for the agent's view.
  const mentions = node => {
    if (!node) return false;
    const shown = Array.from(node.querySelectorAll(".composite[id], .viewlet[id], .pane-composite-part > .content > [id]")).filter(item => item.offsetParent !== null && item.getBoundingClientRect().height > 0);
    if (shown.length) return shown.some(item => pattern.test(item.id) || pattern.test(item.getAttribute("aria-label") || ""));
    const active = node.querySelector(".composite-bar .action-item.checked");
    return !!active && (pattern.test(active.getAttribute("aria-label") || "") || pattern.test((active.querySelector("[aria-label]") || { getAttribute: () => "" }).getAttribute("aria-label") || ""));
  };
  const editorsOpen = !!document.querySelector(".monaco-workbench .part.editor .editor-group-container:not(.empty)");
  const aux = part("auxiliarybar");
  const maximizeButton = !!(aux && aux.querySelector('[aria-label*="maximize" i]:not([aria-label*="restore" i]), [title*="maximize" i]:not([title*="restore" i])'));
  return { workbench: true, width: window.innerWidth, editorsOpen, editorWidth: width(part("editor")), sidebarWidth: width(part("sidebar")), auxWidth: width(aux), panelVisible: width(part("panel")) > 0, claudeIn: mentions(aux) ? "auxiliarybar" : mentions(part("sidebar")) ? "sidebar" : "none", maximizeButton };
})()`;
}

// Performs an action inside the page: VS Code's own buttons when they exist, else the bootstrap extension's keybindings.
export function applyScript(action: ChatOnlyAction, agent: ExtensionAgent = "claude", clickOnly = false) {
  const key = action === "chatOnly" ? ["F9", 120] : action === "widen" ? ["F11", 122] : agentProfiles[agent].key;
  return `(() => {
    const target = document.querySelector(".monaco-workbench") || document.body;
    const press = () => target.dispatchEvent(new KeyboardEvent("keydown", { key: ${JSON.stringify(key[0])}, code: ${JSON.stringify(key[0])}, keyCode: ${key[1]}, which: ${key[1]}, ctrlKey: true, altKey: true, shiftKey: true, bubbles: true, cancelable: true, composed: true }));
    if (${JSON.stringify(action)} === "chatOnly") {
      const aux = document.querySelector(".monaco-workbench .part.auxiliarybar");
      const button = aux && aux.querySelector('[aria-label*="maximize" i]:not([aria-label*="restore" i]), [title*="maximize" i]:not([title*="restore" i])');
      const closeSidebar = document.querySelector('.monaco-workbench .part.sidebar [aria-label*="hide" i][aria-label*="side bar" i], .monaco-workbench .part.sidebar [aria-label*="close" i][aria-label*="side bar" i]');
      if (button) { if (closeSidebar) closeSidebar.click(); button.click(); return "clicked-maximize"; }
    }
    if (${clickOnly ? "true" : "false"}) return "no-button";
    press();
    return "pressed-" + ${JSON.stringify(key[0])};
  })()`;
}

// What to do, or null when the layout is already chat-only (or must be left alone).
export function chatOnlyDecision(layout: WorkbenchLayout): ChatOnlyAction | null {
  if (!layout.workbench || layout.width < 200) return null;
  if (layout.editorsOpen) return null; // an approval diff or a file the user opened: leave it
  if (layout.claudeIn === "none") return "openClaude";
  const host = layout.claudeIn === "auxiliarybar" ? layout.auxWidth : layout.sidebarWidth;
  const fills = host >= layout.width * 0.8 && !layout.panelVisible;
  if (fills) return null;
  return layout.claudeIn === "auxiliarybar" ? "chatOnly" : "widen";
}

export function describeLayout(layout: WorkbenchLayout | null, decision: ChatOnlyAction | null, agent: ExtensionAgent = "claude") {
  const label = agentProfiles[agent].label;
  if (!layout) return "Reading the layout…";
  if (!layout.workbench) return "Loading VS Code…";
  if (layout.editorsOpen) return `Showing an editor opened by ${label}`;
  if (layout.claudeIn === "none") return `Looking for the ${label} view…`;
  if (!decision) return "Chat only";
  return layout.claudeIn === "auxiliarybar" ? `Maximizing the ${label} view…` : `Widening the ${label} view…`;
}

// Moves a view container to the secondary side bar by writing the workbench's view customizations into its browser
// storage (IndexedDB, global state), then reloading. Runs inside the code-server page; returns what it did.
export function relocateScript(viewContainerId: string) {
  return `(async () => {
    const containerId = ${JSON.stringify(viewContainerId)};
    const flag = "zevrin.relocated." + containerId;
    try { if (localStorage.getItem(flag)) return "already"; } catch {}
    const open = () => new Promise((resolve, reject) => { const request = indexedDB.open("vscode-web-state-db-global"); request.onerror = () => reject(request.error); request.onsuccess = () => resolve(request.result); });
    const db = await open();
    if (!db.objectStoreNames.contains("ItemTable")) { db.close(); return "no-store"; }
    const read = () => new Promise((resolve, reject) => { const request = db.transaction("ItemTable", "readonly").objectStore("ItemTable").get("views.customizations"); request.onerror = () => reject(request.error); request.onsuccess = () => resolve(request.result); });
    let current = {};
    try { const raw = await read(); current = raw ? JSON.parse(raw) : {}; } catch { current = {}; }
    const next = { viewContainerLocations: { ...(current.viewContainerLocations || {}), [containerId]: 2 }, viewLocations: current.viewLocations || {}, viewContainerBadgeEnablementStates: current.viewContainerBadgeEnablementStates || {} };
    await new Promise((resolve, reject) => { const request = db.transaction("ItemTable", "readwrite").objectStore("ItemTable").put(JSON.stringify(next), "views.customizations"); request.onerror = () => reject(request.error); request.onsuccess = () => resolve(); });
    db.close();
    try { localStorage.setItem(flag, "1"); } catch {}
    setTimeout(() => location.reload(), 200);
    return "relocated";
  })()`;
}

// Forces a chat-only layout inside the page without asking VS Code to rearrange anything: the part that hosts the
// agent's view container and the overlay webview that renders its chat are stretched over the whole window with
// !important CSS (which beats the inline sizes the workbench writes), everything else is hidden. Returns a status.
export function forceChatOnlyScript(names: string[]) {
  const pattern = names.map(name => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  return `(() => {
  const pattern = new RegExp(${JSON.stringify(pattern)}, "i");
  const workbench = document.querySelector(".monaco-workbench");
  if (!workbench) return "no-workbench";
  const parts = ["sidebar", "auxiliarybar", "panel"];
  let host = null, composite = null;
  for (const name of parts) {
    const part = workbench.querySelector(".part." + name);
    if (!part) continue;
    const shown = Array.from(part.querySelectorAll(".composite[id], .viewlet[id], .pane-composite-part > .content > [id]")).find(item => pattern.test(item.id) || pattern.test(item.getAttribute("aria-label") || ""));
    if (shown) { host = name; composite = shown; break; }
  }
  if (!host) { const style = document.getElementById("zevrin-chat-only"); if (style) style.remove(); return "view-not-open"; }
  // The overlay webview that overlaps the view's body is the chat.
  const body = composite.querySelector(".pane-body, .webview-view, .monaco-pane-view") || composite;
  const rect = body.getBoundingClientRect();
  const overlays = Array.from(workbench.querySelectorAll(":scope > .webview, .webview-overlay .webview, .monaco-workbench > div > .webview")).concat(Array.from(document.querySelectorAll("iframe.webview")).map(node => node.parentElement)).filter(Boolean);
  const overlap = node => { const r = node.getBoundingClientRect(); const w = Math.max(0, Math.min(r.right, rect.right) - Math.max(r.left, rect.left)); const h = Math.max(0, Math.min(r.bottom, rect.bottom) - Math.max(r.top, rect.top)); return w * h; };
  let best = null, bestArea = 0;
  for (const node of new Set(overlays)) { const area = overlap(node); if (area > bestArea) { best = node; bestArea = area; } }
  document.querySelectorAll(".zevrin-chat-webview").forEach(node => { if (node !== best) node.classList.remove("zevrin-chat-webview"); });
  if (best) best.classList.add("zevrin-chat-webview");
  const css = \`
    .monaco-workbench .part.titlebar, .monaco-workbench .part.activitybar, .monaco-workbench .part.statusbar, .monaco-workbench .part.banner, .monaco-workbench .part.editor, .monaco-workbench .part.panel:not(.part.\${host}), .monaco-workbench .part.sidebar:not(.part.\${host}), .monaco-workbench .part.auxiliarybar:not(.part.\${host}), .monaco-workbench .monaco-sash, .monaco-workbench .notifications-toasts, .monaco-workbench .part.\${host} .composite-bar, .monaco-workbench .part.\${host} .composite.title, .monaco-workbench .part.\${host} .pane-header { visibility: hidden !important; pointer-events: none !important; }
    .monaco-workbench .part.\${host} { position: fixed !important; left: 0 !important; top: 0 !important; width: 100vw !important; height: 100vh !important; z-index: 60 !important; visibility: visible !important; }
    .monaco-workbench .part.\${host} > .content, .monaco-workbench .part.\${host} .composite[id], .monaco-workbench .part.\${host} .pane-composite-part, .monaco-workbench .part.\${host} .monaco-pane-view, .monaco-workbench .part.\${host} .split-view-container, .monaco-workbench .part.\${host} .split-view-view, .monaco-workbench .part.\${host} .pane, .monaco-workbench .part.\${host} .pane-body { position: absolute !important; left: 0 !important; top: 0 !important; width: 100vw !important; height: 100vh !important; max-height: none !important; }
    .monaco-workbench .part.\${host} .composite[id] { visibility: visible !important; }
    .monaco-workbench .part.\${host} .composite[id]:not(#\${CSS.escape(composite.id)}) { display: none !important; }
    .monaco-workbench .zevrin-chat-webview { position: fixed !important; left: 0 !important; top: 0 !important; width: 100vw !important; height: 100vh !important; z-index: 70 !important; visibility: visible !important; }
    .monaco-workbench .zevrin-chat-webview iframe { width: 100% !important; height: 100% !important; }
  \`;
  let style = document.getElementById("zevrin-chat-only");
  if (!style) { style = document.createElement("style"); style.id = "zevrin-chat-only"; document.head.appendChild(style); }
  if (style.textContent !== css) { style.textContent = css; window.dispatchEvent(new Event("resize")); }
  return best ? "forced:" + host : "forced-no-webview:" + host;
})()`;
}

export const releaseChatOnlyScript = `(() => { const style = document.getElementById("zevrin-chat-only"); if (style) style.remove(); document.querySelectorAll(".zevrin-chat-webview").forEach(node => node.classList.remove("zevrin-chat-webview")); window.dispatchEvent(new Event("resize")); return "released"; })()`;
