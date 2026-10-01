"use client";

import { ZevrinMark } from "./zevrin-mark";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { TextSearchResult, AIToolId, AIToolInfo, AppCommandName, FileMatch, GitBranch, GitChange, GitCommit, GitStatus, GitWorktree } from "../types/desktop";
import type { WebviewElement } from "../types/webview";
import { AgentChat } from "./agent-chat";
import { AgentExtension } from "./agent-extension";
import { CodexChat } from "./codex-chat";
import { CodeDiff, CodeEditor, type EditorApi } from "./code-editor";
import { postCompose } from "./compose-bus";
import { DevicesTile, type DevicesApi } from "./devices-tile";
import { consoleLevel, formatConsole, formatElementContext, formatNetwork, formatPageContext, formatSnapshot, locateScript, pickerCancelScript, pickerInstallScript, pickerPollScript, pickKeyframes, snapshotRefsScript, snapshotScript, waitForScript, type ConsoleEntry, type LocateTarget, type PageSnapshot, type PickedElement } from "./preview-context";
import type { ChatState } from "./chat-model";
import { canvasConnectionPath, loadCanvasItems, removeCanvasItems } from "./canvas-model";
import type { CanvasItem } from "./canvas-model";
import { appendTile, defaultLayout, dropSideFor, findTile, hasTile, insertBeside, layoutPresets, mapTiles, moveNode, normalizeLayout, removeNode, tile, tiles, updateRatio, updateTile } from "./layout-model";
import type { DropSide, LayoutNode, SplitDirection, TileNode, TileType } from "./layout-model";

export type Workspace = { id: string; name: string; path: string; tint: string };
type FileEntry = { name: string; path: string; directory: boolean };
export type Dialog = "folder" | "clone" | "settings" | null;
export type AppSettings = { terminalFontSize: number; editorFontSize: number };
type CanvasTool = "select" | "pan" | "note" | "rectangle" | "diamond" | "connector" | "text";
type Zone = "left" | "center" | "right" | "bottom";
type OpenFile = { path: string; contents: string; saved: string };
type DiffState = { path: string; staged: boolean; text: string; original?: string; modified?: string; branch?: string; uncommitted?: boolean };
type TerminalStatus = "starting" | "ready" | "error" | "exited";
type TerminalSessionInfo = { id: string; name: string; assistant: AIToolId | null; status: TerminalStatus };
type PaletteItem = { id: string; kind: "command" | "file"; title: string; detail?: string; action: () => void };
type DragSource = { kind: "new"; type: TileType; assistant?: AIToolId; name?: string } | { kind: "move"; id: string };
type DropTarget = { id: string | null; side: DropSide };

const dragMime = "application/x-zevrin-tile";
const tileLabels: Record<TileType, string> = { terminal: "Terminal", agent: "Claude chat", vscode: "Claude", editor: "Code", files: "Files", preview: "Preview", canvas: "Canvas", git: "Source Control", devices: "Devices" };
const tileGlyphs: Record<TileType, string> = { terminal: "terminal", agent: "claude", vscode: "chat", editor: "code", files: "folder", preview: "globe", canvas: "canvas", git: "git", devices: "phone" };
const toggleTiles: TileType[] = ["vscode", "editor", "files", "preview", "canvas", "git", "devices"];
const presetLabels: Array<[string, string]> = [["default", "Default"], ["agent-code", "Agent + Code"], ["code-preview", "Code + Preview"], ["canvas-code", "Canvas + Code"], ["grid", "Grid 2 × 2"], ["fibonacci", "Fibonacci"], ["focus", "Focus"]];
export const aiNames: Record<AIToolId, string> = { claude: "Claude", gemini: "Gemini", codex: "Codex", opencode: "OpenCode" };

export function Glyph({ name, size = 18 }: { name: string; size?: number }) {
  const common = { width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.7, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, "aria-hidden": true as const };
  if (name === "folder") return <svg {...common}><path d="M3 7.5A2.5 2.5 0 0 1 5.5 5H10l2 2h6.5A2.5 2.5 0 0 1 21 9.5v8a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17.5z"/><path d="M3 10h18"/></svg>;
  if (name === "github") return <svg {...common}><path d="M9 19c-4.3 1.4-4.3-2.5-6-3m12 6v-3.9a3.4 3.4 0 0 0-.9-2.7c3 0 6.2-1.5 6.2-6.7a5.2 5.2 0 0 0-1.4-3.6 4.8 4.8 0 0 0-.1-3.6s-1.2-.4-3.8 1.4a13 13 0 0 0-7 0C5.4 1.1 4.2 1.5 4.2 1.5a4.8 4.8 0 0 0-.1 3.6 5.2 5.2 0 0 0-1.4 3.6c0 5.2 3.2 6.7 6.2 6.7A3.4 3.4 0 0 0 8 18.1V22"/></svg>;
  if (name === "terminal") return <svg {...common}><path d="m4 5 6 6-6 6M12 17h8"/></svg>;
  if (name === "code") return <svg {...common}><path d="m8 8-4 4 4 4m8-8 4 4-4 4m-2-11-4 14"/></svg>;
  if (name === "globe") return <svg {...common}><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/></svg>;
  if (name === "canvas") return <svg {...common}><rect x="4" y="4" width="16" height="16" rx="2"/><path d="m7 15 3-3 2 2 4-5 2 3"/></svg>;
  if (name === "file") return <svg {...common}><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/></svg>;
  if (name === "git") return <svg {...common}><circle cx="6" cy="5" r="2.2"/><circle cx="6" cy="19" r="2.2"/><circle cx="18" cy="9" r="2.2"/><path d="M6 7.2v9.6M18 11.2c0 3-3 4-6 4.4-2.5.3-4 1-6 1.2"/></svg>;
  if (name === "sparkle") return <svg {...common}><path d="M12 3v3M12 18v3M3 12h3M18 12h3M12 8l1.6 2.4L16 12l-2.4 1.6L12 16l-1.6-2.4L8 12l2.4-1.6z"/></svg>;
  if (name === "claude") return <svg {...common} stroke="none">{Array.from({ length: 12 }, (_, index) => <rect key={index} x="11.1" y="2" width="1.8" height="8.2" rx=".9" fill="#d97757" transform={`rotate(${index * 30} 12 12)`}/>)}</svg>;
  if (name === "chat") return <svg {...common}><path d="M5 5.5h14a1.5 1.5 0 0 1 1.5 1.5v8.5a1.5 1.5 0 0 1-1.5 1.5H10l-4 3.5V17H5a1.5 1.5 0 0 1-1.5-1.5V7A1.5 1.5 0 0 1 5 5.5z"/></svg>;
  if (name === "target") return <svg {...common}><circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="2.2"/><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3"/></svg>;
  if (name === "record") return <svg {...common}><circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3.5" fill="currentColor"/></svg>;
  if (name === "plus") return <svg {...common}><path d="M12 5v14M5 12h14"/></svg>;
  if (name === "branch") return <svg {...common}><circle cx="6" cy="6" r="2"/><circle cx="6" cy="18" r="2"/><circle cx="18" cy="8" r="2"/><path d="M6 8v8M18 10c0 4-6 3-11.5 6.5"/></svg>;
  if (name === "codex") return <svg {...common}><circle cx="12" cy="12" r="8.5"/><path d="M12 3.5c3 2.5 3 14.5 0 17M12 3.5c-3 2.5-3 14.5 0 17M3.5 12h17"/></svg>;
  if (name === "gemini") return <svg {...common}><path d="M12 3c.6 5 4 8.4 9 9-5 .6-8.4 4-9 9-.6-5-4-8.4-9-9 5-.6 8.4-4 9-9z"/></svg>;
  if (name === "phone") return <svg {...common}><rect x="7" y="2.5" width="10" height="19" rx="2.5"/><path d="M10.5 18.5h3"/></svg>;
  if (name === "tablet") return <svg {...common}><rect x="4" y="3" width="16" height="18" rx="2.5"/><path d="M11 18h2"/></svg>;
  if (name === "watch") return <svg {...common}><rect x="7" y="7" width="10" height="10" rx="3"/><path d="M9.5 7V3.5h5V7M9.5 17v3.5h5V17"/></svg>;
  if (name === "search") return <svg {...common}><circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.3-4.3"/></svg>;
  if (name === "grip") return <svg {...common}><circle cx="9" cy="6" r="1"/><circle cx="15" cy="6" r="1"/><circle cx="9" cy="12" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="9" cy="18" r="1"/><circle cx="15" cy="18" r="1"/></svg>;
  if (name === "settings") return <svg {...common}><circle cx="12" cy="12" r="3"/><path d="m19.4 15 .1.1a1.7 1.7 0 1 1-2.4 2.4l-.1-.1a1.7 1.7 0 0 0-2.9 1.2v.4a1.7 1.7 0 1 1-3.4 0v-.2A1.7 1.7 0 0 0 7.8 17l-.1.1a1.7 1.7 0 1 1-2.4-2.4l.1-.1a1.7 1.7 0 0 0-1.2-2.9h-.4a1.7 1.7 0 1 1 0-3.4h.2A1.7 1.7 0 0 0 5.2 5l-.1-.1a1.7 1.7 0 1 1 2.4-2.4l.1.1a1.7 1.7 0 0 0 2.9-1.2v-.4a1.7 1.7 0 1 1 3.4 0v.2A1.7 1.7 0 0 0 16.8 3l.1-.1a1.7 1.7 0 1 1 2.4 2.4l-.1.1a1.7 1.7 0 0 0 1.2 2.9h.4a1.7 1.7 0 1 1 0 3.4h-.2a1.7 1.7 0 0 0-1.3 3.3Z" transform="translate(1 1) scale(.92)"/></svg>;
  return <svg {...common}><path d="M18 6 6 18M6 6l12 12"/></svg>;
}

function newId() { return globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`; }

export function initials(name: string) {
  return name.split(/[^A-Za-z0-9]+/).filter(Boolean).slice(0, 2).map(part => part[0]).join("").toUpperCase() || "BB";
}

export function errorMessage(error: unknown, fallback: string) {
  return (error instanceof Error ? error.message : "").replace(/^Error invoking remote method '[^']+': (Error: )?/, "") || fallback;
}

function changeLetter(code: string) {
  return code === "?" ? "U" : code === "U" ? "!" : code;
}

function parentDirectory(path: string) {
  return path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
}

function tileTitle(node: TileNode) {
  if (node.name) return node.name;
  if (node.type === "vscode" && node.branch) return (node.assistant && node.assistant !== "claude" ? aiNames[node.assistant] : "Claude") + " · " + node.branch;
  if (node.type === "vscode") return node.assistant && node.assistant !== "claude" ? aiNames[node.assistant] : "Claude";
  return node.assistant ? aiNames[node.assistant] : tileLabels[node.type];
}

function nextTerminalName(layout: LayoutNode | null, assistant: AIToolId | null, type: "terminal" | "agent" = "terminal") {
  const base = assistant ? aiNames[assistant] : "Terminal";
  const count = tiles(layout).filter(item => item.type === type && (item.assistant ?? null) === assistant).length;
  return count === 0 ? base : `${base} ${count + 1}`;
}

function ChangeRow({ change, staged, selected, onOpen, onToggle, onDiscard }: { change: GitChange; staged: boolean; selected: boolean; onOpen: () => void; onToggle: () => void; onDiscard?: () => void }) {
  const code = staged ? change.index : change.worktree === " " ? change.index : change.worktree;
  const name = change.path.split("/").pop() || change.path;
  const folder = change.path.slice(0, change.path.length - name.length).replace(/\/$/, "");
  return <div className={selected ? "change-row selected" : "change-row"}>
    <button className="change-open" title={change.from ? `${change.from} → ${change.path}` : change.path} onClick={onOpen}><span className="change-name">{name}</span>{folder && <span className="change-folder">{folder}</span>}</button>
    {onDiscard && <button className="change-action" title="Discard changes" aria-label={`Discard changes in ${change.path}`} onClick={onDiscard}>↺</button>}
    <button className="change-action" title={staged ? "Unstage" : "Stage"} aria-label={`${staged ? "Unstage" : "Stage"} ${change.path}`} onClick={onToggle}>{staged ? "−" : "+"}</button>
    <span className={`change-letter letter-${changeLetter(code)}`}>{changeLetter(code)}</span>
  </div>;
}

function DiffView({ diff }: { diff: DiffState }) {
  const lines = diff.text.split("\n");
  const start = lines.findIndex(line => line.startsWith("@@"));
  const body = start === -1 ? lines : lines.slice(start);
  return <div className="diff-view">
    {diff.text.trim() === "" ? <div className="diff-empty">No textual changes (binary file or mode change).</div>
      : body.map((line, index) => <div key={index} className={line.startsWith("@@") ? "diff-line hunk" : line.startsWith("+") ? "diff-line added" : line.startsWith("-") ? "diff-line removed" : "diff-line"}>{line || " "}</div>)}
  </div>;
}

function TerminalPane({ workspacePath, session, fontSize, onStatus, onTerminalId }: { workspacePath: string; session: TerminalSessionInfo; fontSize: number; onStatus: (id: string, status: TerminalStatus, message?: string) => void; onTerminalId?: (tileId: string, terminalId: string | null) => void }) {
  const mountRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<import("@xterm/xterm").Terminal | undefined>(undefined);
  const fitRef = useRef<import("@xterm/addon-fit").FitAddon | undefined>(undefined);
  const terminalIdRef = useRef<string | null>(null);
  const statusRef = useRef(onStatus);

  useEffect(() => { statusRef.current = onStatus; }, [onStatus]);
  useEffect(() => {
    if (!terminalRef.current) return;
    terminalRef.current.options.fontSize = fontSize;
    fitRef.current?.fit();
    if (terminalIdRef.current) window.zevrinDesktop?.resizeTerminal(terminalIdRef.current, terminalRef.current.cols, terminalRef.current.rows);
  }, [fontSize]);

  useEffect(() => {
    const api = window.zevrinDesktop;
    const mount = mountRef.current;
    if (!api || !mount) return;
    let disposed = false;
    let terminalId: string | null = null;
    let pendingOutput: Array<[string, string]> = [];
    let removeOutputListener = () => {};
    let removeExitListener = () => {};
    let observer: ResizeObserver | undefined;
    let terminal: import("@xterm/xterm").Terminal | undefined;
    let fit: import("@xterm/addon-fit").FitAddon | undefined;

    const start = async () => {
      const [{ Terminal }, { FitAddon }] = await Promise.all([import("@xterm/xterm"), import("@xterm/addon-fit")]);
      if (disposed) return;
      terminal = new Terminal({ cursorBlink: true, fontSize, fontFamily: "Geist Mono, Menlo, monospace", allowProposedApi: true, scrollback: 5000, theme: { background: "#101010", foreground: "#e5e5e5", cursor: "#fafafa", selectionBackground: "#5969f566" } });
      terminalRef.current = terminal;
      fit = new FitAddon();
      fitRef.current = fit;
      terminal.loadAddon(fit);
      terminal.open(mount);
      fit.fit();
      removeOutputListener = api.onTerminalData((id, data) => {
        if (id === terminalId) terminal?.write(data);
        else if (!terminalId) {
          pendingOutput.push([id, data]);
          if (pendingOutput.length > 64) pendingOutput.shift();
        }
      });
      removeExitListener = api.onTerminalExit((id, exitCode) => {
        if (id !== terminalId) return;
        terminal?.write(`\r\n\x1b[90m[session ended with code ${exitCode}]\x1b[0m\r\n`);
        statusRef.current(session.id, "exited");
      });
      terminalId = await api.createTerminal(workspacePath);
      terminalIdRef.current = terminalId;
      onTerminalId?.(session.id, terminalId);
      for (const [id, data] of pendingOutput) if (id === terminalId) terminal.write(data);
      pendingOutput = [];
      if (disposed) { api.closeTerminal(terminalId); return; }
      terminal.onData(data => { if (terminalId) api.writeTerminal(terminalId, data); });
      terminal.attachCustomKeyEventHandler(event => {
        if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k" && event.type === "keydown") { terminal?.clear(); return false; }
        return true;
      });
      if (session.assistant) await api.launchAI(workspacePath, session.assistant, terminalId);
      statusRef.current(session.id, "ready");
      observer = new ResizeObserver(() => {
        if (mount.clientWidth === 0 || mount.clientHeight === 0) return;
        fit?.fit();
        if (terminalId && terminal) api.resizeTerminal(terminalId, terminal.cols, terminal.rows);
      });
      observer.observe(mount);
      api.resizeTerminal(terminalId, terminal.cols, terminal.rows);
      terminal.focus();
    };

    start().catch(error => {
      const message = errorMessage(error, "Could not start this terminal session.");
      statusRef.current(session.id, "error", message);
      if (!disposed) mount.textContent = message;
    });
    return () => {
      disposed = true;
      observer?.disconnect();
      removeOutputListener();
      removeExitListener();
      if (terminalId) api.closeTerminal(terminalId);
      onTerminalId?.(session.id, null);
      terminal?.dispose();
      terminalRef.current = undefined;
      fitRef.current = undefined;
      terminalIdRef.current = null;
    };
  }, [workspacePath, session.id, session.assistant]); // eslint-disable-line react-hooks/exhaustive-deps

  return <div className="terminal-surface" ref={mountRef}/>;
}

type PreviewFrameProps = { url: string; desktop: boolean; reloadKey: number; onNavigate: (url: string) => void; onConsole: (entry: ConsoleEntry | null) => void; frameRef: import("react").MutableRefObject<WebviewElement | null> };

function PreviewFrame({ url, desktop, reloadKey, onNavigate, onConsole, frameRef }: PreviewFrameProps) {
  const localRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const element = localRef.current as WebviewElement | null;
    if (!desktop || !element) return;
    frameRef.current = element;
    const handler = (event: Event) => { const target = (event as Event & { url?: string }).url; if (typeof target === "string") onNavigate(target); };
    const consoleHandler = (event: Event) => { const detail = event as Event & { level?: unknown; message?: string; line?: number; sourceId?: string }; onConsole({ level: consoleLevel(detail.level), message: String(detail.message ?? ""), line: detail.line, source: detail.sourceId, at: Date.now() }); };
    const failHandler = (event: Event) => { const detail = event as Event & { errorDescription?: string; validatedURL?: string; isMainFrame?: boolean; errorCode?: number }; if (detail.errorCode === -3) return; onConsole({ level: "error", message: `Failed to load ${detail.validatedURL ?? url}: ${detail.errorDescription ?? "unknown error"}`, at: Date.now() }); };
    const resetHandler = (event: Event) => { const detail = event as Event & { isMainFrame?: boolean }; if (detail.isMainFrame !== false) onConsole(null); handler(event); };
    element.addEventListener("did-navigate", resetHandler);
    element.addEventListener("did-navigate-in-page", handler);
    element.addEventListener("console-message", consoleHandler);
    element.addEventListener("did-fail-load", failHandler);
    return () => { element.removeEventListener("did-navigate", resetHandler); element.removeEventListener("did-navigate-in-page", handler); element.removeEventListener("console-message", consoleHandler); element.removeEventListener("did-fail-load", failHandler); if (frameRef.current === element) frameRef.current = null; };
  }, [desktop, frameRef, onNavigate, onConsole, reloadKey, url]);
  if (desktop) return <webview key={reloadKey} ref={localRef as import("react").Ref<HTMLElement>} className="preview-frame" src={url} {...({ allowpopups: "true" } as Record<string, string>)}/>;
  return <iframe key={url + ":" + reloadKey} className="preview-frame" title="Local project preview" src={url}/>;
}

type Toast = { id: string; title: string; body?: string; tone: "info" | "success" | "warning" };

export type WorkspaceViewProps = {
  workspace: Workspace;
  visible: boolean;
  desktop: boolean;
  platform: string;
  settings: AppSettings;
  aiTools: AIToolInfo[];
  aiLoading: boolean;
  aiError: string;
  flowMode: boolean;
  tabs: import("react").ReactNode;
  onOpenWorkspace: (path: string, name?: string) => void;
  onForgetWorkspacePath: (path: string) => void;
  onOpenDialog: (dialog: Exclude<Dialog, null>) => void;
  onToggleFlow: () => void;
  onHome: () => void;
};

export function WorkspaceView(props: WorkspaceViewProps) {
  const { workspace: active, visible, desktop, settings, aiTools, aiLoading, flowMode } = props;
  const isMac = props.platform === "darwin";
  const [layout, setLayout] = useState<LayoutNode | null>(null);
  const [layoutLoadedKey, setLayoutLoadedKey] = useState("");
  const [focusedTileId, setFocusedTileId] = useState<string | null>(null);
  const [terminalStatus, setTerminalStatus] = useState<Record<string, TerminalStatus>>({});
  const [dragSource, setDragSource] = useState<DragSource | null>(null);
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null);
  const [canvasItems, setCanvasItems] = useState<CanvasItem[]>([]);
  const [canvasLoadedKey, setCanvasLoadedKey] = useState("");
  const [canvasTool, setCanvasTool] = useState<CanvasTool>("select");
  const [selectedCanvasId, setSelectedCanvasId] = useState<string | null>(null);
  const [connectionStartId, setConnectionStartId] = useState<string | null>(null);
  const [editingCanvasId, setEditingCanvasId] = useState<string | null>(null);
  const [canvasZoom, setCanvasZoom] = useState(1);
  const [canvasPan, setCanvasPan] = useState({ x: 0, y: 0 });
  const [commandOpen, setCommandOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [paletteIndex, setPaletteIndex] = useState(0);
  const [fileMatches, setFileMatches] = useState<FileMatch[]>([]);
  const [fileSearching, setFileSearching] = useState(false);
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [textQuery, setTextQuery] = useState("");
  const [textResults, setTextResults] = useState<TextSearchResult | null>(null);
  const [textSearching, setTextSearching] = useState(false);
  const [filesMode, setFilesMode] = useState<"tree" | "search">("tree");
  const textSearchInputRef = useRef<HTMLInputElement>(null);
  const [openFilesLoadedKey, setOpenFilesLoadedKey] = useState("");
  const [currentDirectory, setCurrentDirectory] = useState("");
  // Files open in the Code tile (tabs) and the one shown.
  const [openFiles, setOpenFiles] = useState<OpenFile[]>([]);
  const [activePath, setActivePath] = useState<string | null>(null);
  const activeFile = openFiles.find(file => file.path === activePath) ?? null;
  const editorApiRef = useRef<EditorApi | null>(null);
  const devicesApiRef = useRef<DevicesApi | null>(null);
  // Updates the shown file in place; null closes it.
  function setActiveFile(update: OpenFile | null | ((current: OpenFile | null) => OpenFile | null)) {
    setOpenFiles(current => {
      const shown = current.find(file => file.path === activePathRef.current) ?? null;
      const next = typeof update === "function" ? update(shown) : update;
      if (!next) { const rest = current.filter(file => file !== shown); setActivePath(rest[rest.length - 1]?.path ?? null); return rest; }
      setActivePath(next.path);
      const index = current.findIndex(file => file.path === next.path);
      if (index >= 0) return current.map((file, position) => position === index ? next : file);
      return shown && shown.path !== next.path ? current.map(file => file === shown ? next : file) : [...current, next];
    });
  }
  const activePathRef = useRef<string | null>(null);
  useEffect(() => { activePathRef.current = activePath; }, [activePath]);
  const [previewUrl, setPreviewUrl] = useState("");
  const [previewLocation, setPreviewLocation] = useState("");
  const [previewHistory, setPreviewHistory] = useState<string[]>([]);
  const [previewHistoryIndex, setPreviewHistoryIndex] = useState(-1);
  const [previewReloadKey, setPreviewReloadKey] = useState(0);
  const [git, setGit] = useState<GitStatus | null>(null);
  const [worktrees, setWorktrees] = useState<GitWorktree[]>([]);
  const [branches, setBranches] = useState<GitBranch[]>([]);
  const [commits, setCommits] = useState<GitCommit[]>([]);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [worktreeBranch, setWorktreeBranch] = useState("");
  const [worktreeFormOpen, setWorktreeFormOpen] = useState(false);
  const [worktreeBusy, setWorktreeBusy] = useState(false);
  const [branchFormOpen, setBranchFormOpen] = useState(false);
  const [newBranchName, setNewBranchName] = useState("");
  const [syncAction, setSyncAction] = useState<"fetch" | "pull" | "push" | null>(null);
  const [gitBusy, setGitBusy] = useState(false);
  const [gitError, setGitError] = useState("");
  const [gitNotice, setGitNotice] = useState("");
  const [commitMessage, setCommitMessage] = useState("");
  const [diff, setDiff] = useState<DiffState | null>(null);
  const paletteListRef = useRef<HTMLDivElement>(null);
  const dropTargetRef = useRef<DropTarget | null>(null);
  const canvasDragRef = useRef<{ id: string; pointerId: number; x: number; y: number; left: number; top: number } | null>(null);
  const canvasPanRef = useRef<{ pointerId: number; x: number; y: number; left: number; top: number } | null>(null);
  const [agentStatus, setAgentStatus] = useState<Record<string, ChatState["status"]>>({});
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [pendingLine, setPendingLine] = useState<number | null>(null);
  const terminalIdsRef = useRef<Map<string, string>>(new Map());
  const previewFrameRef = useRef<WebviewElement | null>(null);
  const previewConsoleRef = useRef<ConsoleEntry[]>([]);
  const [previewIssues, setPreviewIssues] = useState(0);
  const [previewMenuOpen, setPreviewMenuOpen] = useState(false);
  const [previewBusy, setPreviewBusy] = useState("");
  const [sendTarget, setSendTarget] = useState<string>("auto");
  const [picking, setPicking] = useState(false);
  const [recording, setRecording] = useState<{ startedAt: number } | null>(null);
  const [recordElapsed, setRecordElapsed] = useState(0);
  const [railExpanded, setRailExpanded] = useState(false);
  const [railLoaded, setRailLoaded] = useState(false);
  const [aiError, setAiError] = useState("");
  const canvasStorageKey = `zevrin-canvas:${active.id}`;
  const layoutStorageKey = `zevrin-tiles:${active.id}`;

  // Tile layout: loaded per workspace, saved whenever it changes.
  useEffect(() => {
    setLayoutLoadedKey("");
    let restored: LayoutNode | null = null;
    try { restored = normalizeLayout(JSON.parse(localStorage.getItem(layoutStorageKey) || "null")); } catch { restored = null; }
    // One-time switch from the embedded VS Code extension tiles to the native Claude chat and the Codex / Gemini CLIs.
    const migrationKey = "zevrin-native-agents:" + layoutStorageKey;
    try {
      if (restored && !localStorage.getItem(migrationKey)) {
        restored = mapTiles(restored, node => node.type !== "vscode" ? node
          : !node.assistant || node.assistant === "claude" ? { ...node, type: "agent", assistant: "claude", name: node.branch ? "Claude · " + node.branch.split("/").pop() : undefined }
          : { ...node, type: "terminal", name: aiNames[node.assistant] });
        localStorage.setItem(migrationKey, "1");
      }
    } catch { /* storage unavailable */ }
    const codexKey = "zevrin-native-codex:" + layoutStorageKey;
    try {
      if (restored && !localStorage.getItem(codexKey)) {
        restored = mapTiles(restored, node => node.type === "terminal" && node.assistant === "codex" ? { ...node, type: "agent", name: node.name ?? "Codex" } : node);
        localStorage.setItem(codexKey, "1");
      }
    } catch { /* storage unavailable */ }
    setLayout(restored ?? defaultLayout());
    setFocusedTileId(null);
    setTerminalStatus({});
    setLayoutLoadedKey(layoutStorageKey);
  }, [layoutStorageKey]);

  useEffect(() => {
    if (layoutLoadedKey !== layoutStorageKey) return;
    try { localStorage.setItem(layoutStorageKey, JSON.stringify(layout)); } catch { /* Storage may be unavailable. */ }
  }, [layout, layoutLoadedKey, layoutStorageKey]);

  useEffect(() => {
    setSelectedCanvasId(null); setEditingCanvasId(null); setConnectionStartId(null); setCanvasTool("select"); setCanvasZoom(1); setCanvasPan({ x: 0, y: 0 });
    canvasDragRef.current = null; canvasPanRef.current = null;
  }, [canvasStorageKey]);

  useEffect(() => {
    setCanvasLoadedKey("");
    try {
      const saved = localStorage.getItem(canvasStorageKey);
      const parsed: unknown = saved ? JSON.parse(saved) : [];
      setCanvasItems(loadCanvasItems(parsed));
    } catch { setCanvasItems([]); }
    setCanvasLoadedKey(canvasStorageKey);
  }, [canvasStorageKey]);

  useEffect(() => {
    if (canvasLoadedKey !== canvasStorageKey) return;
    try { localStorage.setItem(canvasStorageKey, JSON.stringify(canvasItems)); } catch { /* Keep the board usable if browser storage is full or unavailable. */ }
  }, [canvasItems, canvasLoadedKey, canvasStorageKey]);

  useEffect(() => {
    setCurrentDirectory(""); setOpenFiles([]); setActivePath(null); setTextQuery(""); setFilesMode("tree");
    setGit(null); setDiff(null); setGitError(""); setGitNotice(""); setCommitMessage("");
    setBranches([]); setCommits([]); setWorktrees([]); setBranchFormOpen(false); setWorktreeFormOpen(false);
  }, [active?.id]);

  // Full-text search in the Files tile (⌘⇧F).
  useEffect(() => {
    const api = window.zevrinDesktop;
    const needle = textQuery.trim();
    if (!desktop || !api || !active || needle.length < 2) { setTextResults(null); setTextSearching(false); return; }
    let cancelled = false;
    setTextSearching(true);
    const timer = setTimeout(() => {
      api.searchText(active.path, needle).then(result => { if (!cancelled) { setTextResults(result); setTextSearching(false); } }).catch(() => { if (!cancelled) { setTextResults({ matches: [], truncated: false, filesSearched: 0 }); setTextSearching(false); } });
    }, 180);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [desktop, active, textQuery]);

  // Open tabs are remembered per project and reopened from disk.
  const openFilesStorageKey = `zevrin-open-files:${active.id}`;
  useEffect(() => {
    const api = window.zevrinDesktop;
    let cancelled = false;
    (async () => {
      let saved: { paths?: string[]; active?: string | null } = {};
      try { saved = JSON.parse(localStorage.getItem(openFilesStorageKey) || "{}"); } catch { saved = {}; }
      const paths = Array.isArray(saved.paths) ? saved.paths.filter(item => typeof item === "string").slice(0, 12) : [];
      if (api && paths.length) {
        const loaded = await Promise.all(paths.map(async path => { const contents = await api.readFile(active.path, path).catch(() => null); return contents === null ? null : { path, contents, saved: contents }; }));
        if (cancelled) return;
        const restored = loaded.filter((item): item is OpenFile => item !== null);
        setOpenFiles(restored);
        setActivePath(restored.some(item => item.path === saved.active) ? saved.active ?? null : restored[restored.length - 1]?.path ?? null);
      }
      if (!cancelled) setOpenFilesLoadedKey(openFilesStorageKey);
    })();
    return () => { cancelled = true; };
  }, [openFilesStorageKey, active.path]);
  useEffect(() => {
    if (openFilesLoadedKey !== openFilesStorageKey) return;
    try { localStorage.setItem(openFilesStorageKey, JSON.stringify({ paths: openFiles.map(file => file.path), active: activePath })); } catch { /* Storage may be unavailable. */ }
  }, [openFiles, activePath, openFilesLoadedKey, openFilesStorageKey]);

  const updateTerminalStatus = useCallback((id: string, status: TerminalStatus, message?: string) => {
    setTerminalStatus(current => current[id] === status ? current : { ...current, [id]: status });
    if (message) setAiError(message);
  }, []);

  const refreshGit = useCallback(async () => {
    const api = window.zevrinDesktop;
    if (!desktop || !active || !api) return null;
    try {
      const status = await api.gitStatus(active.path);
      setGit(status); setGitError("");
      if (status.isRepo) {
        const [trees, heads, log] = await Promise.all([api.gitWorktrees(active.path), api.gitBranches(active.path).catch(() => []), api.gitLog(active.path).catch(() => [])]);
        setWorktrees(trees); setBranches(heads); setCommits(log);
      } else { setWorktrees([]); setBranches([]); setCommits([]); }
      return status;
    } catch (error) {
      setGitError(errorMessage(error, "Could not read the Git status."));
      setWorktrees([]);
      return null;
    }
  }, [desktop, active]);

  useEffect(() => {
    refreshGit();
    window.addEventListener("focus", refreshGit);
    return () => window.removeEventListener("focus", refreshGit);
  }, [refreshGit]);

  const filesVisible = hasTile(layout, "files");
  const gitVisible = hasTile(layout, "git");
  const canvasVisible = hasTile(layout, "canvas");

  useEffect(() => { if (gitVisible) refreshGit(); }, [gitVisible, refreshGit]);

  useEffect(() => {
    if (!desktop || !active || !filesVisible || !window.zevrinDesktop) return;
    let cancelled = false;
    window.zevrinDesktop.listFiles(active.path, currentDirectory).then(entries => { if (!cancelled) setFiles(entries); }).catch(error => { if (!cancelled) setFiles([]); console.warn("Could not read workspace files:", error); });
    return () => { cancelled = true; };
  }, [desktop, active, filesVisible, currentDirectory]);

  useEffect(() => {
    try { setRailExpanded(localStorage.getItem("zevrin-rail") === "expanded"); } catch { /* Storage may be unavailable. */ }
    setRailLoaded(true);
  }, []);
  useEffect(() => {
    if (!railLoaded) return;
    try { localStorage.setItem("zevrin-rail", railExpanded ? "expanded" : "compact"); } catch { /* Storage may be unavailable. */ }
  }, [railExpanded, railLoaded]);

  useEffect(() => {
    if (!visible) return;
    const listener = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "p") {
        event.preventDefault(); setCommandOpen(value => !value); setQuery("");
      }
      if ((event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey && /^[1-8]$/.test(event.key)) {
        const shortcut: Array<() => void> = [() => focusOrAddClaude(), () => addTerminal(null), () => toggleTile("editor"), () => toggleTile("files"), () => toggleTile("preview"), () => toggleTile("canvas"), () => toggleTile("git"), () => toggleTile("devices")];
        event.preventDefault(); shortcut[Number(event.key) - 1]();
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "b" && !event.shiftKey) { event.preventDefault(); setRailExpanded(value => !value); }
      if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === "f") { event.preventDefault(); ensureTile("files"); setFilesMode("search"); setTimeout(() => textSearchInputRef.current?.focus(), 50); }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "w" && !event.shiftKey && activePath && (event.target as HTMLElement | null)?.closest?.(".tile-editor")) { event.preventDefault(); closeOpenFile(activePath); }
      else if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "w" && !event.shiftKey && layoutMode === "docked" && focusedTileId) { event.preventDefault(); closeTile(focusedTileId); }
      if (event.ctrlKey && event.key === "Tab" && layoutMode === "docked") {
        const current = focusedTileId ? findTile(layout, item => item.id === focusedTileId) : null;
        const zone = current ? zoneOf(current) : "center";
        const items = tiles(layout).filter(item => zoneOf(item) === zone);
        if (items.length > 1) { event.preventDefault(); const index = Math.max(0, items.findIndex(item => item.id === (zoneActive[zone] ?? focusedTileId))); const next = items[(index + (event.shiftKey ? items.length - 1 : 1)) % items.length]; setFocusedTileId(next.id); }
      }
      if (event.key === "Escape") { setCommandOpen(false); setDragSource(null); setDropTarget(null); }
    };
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }); // Re-subscribes every render so shortcuts see the current layout.

  useEffect(() => {
    const api = window.zevrinDesktop;
    const needle = query.trim();
    if (!commandOpen || !desktop || !active || !api || !needle) { setFileMatches([]); setFileSearching(false); return; }
    let cancelled = false;
    setFileSearching(true);
    const timer = setTimeout(() => {
      api.searchFiles(active.path, needle).then(matches => { if (!cancelled) setFileMatches(matches); })
        .catch(() => { if (!cancelled) setFileMatches([]); })
        .finally(() => { if (!cancelled) setFileSearching(false); });
    }, 120);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [commandOpen, desktop, active, query]);

  useEffect(() => { if (!commandOpen) { setQuery(""); setFileMatches([]); } }, [commandOpen]);

  // ----- Docked layout: fixed zones with tabs -----
  // Every tile lives in a zone chosen by its type (or where the user dragged its tab). Zones are resizable, inactive
  // tabs stay mounted (hidden) so terminals, chats and extension sessions keep running.
  const [layoutMode, setLayoutMode] = useState<"docked" | "free">("docked");
  const [zoneOverrides, setZoneOverrides] = useState<Record<string, Zone>>({});
  const [zoneActive, setZoneActive] = useState<Partial<Record<Zone, string>>>({});
  const [zoneSizes, setZoneSizes] = useState({ left: 260, right: 440, bottom: 240 });
  const [zonesLoadedKey, setZonesLoadedKey] = useState("");
  const [agentMenuOpen, setAgentMenuOpen] = useState(false);
  const [tabMenu, setTabMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const [isolateAgent, setIsolateAgent] = useState(false);
  const [agentBusy, setAgentBusy] = useState(false);
  const zonesStorageKey = `zevrin-zones:${active.id}`;
  useEffect(() => {
    try { const mode = localStorage.getItem("zevrin-layout-mode"); if (mode === "free" || mode === "docked") setLayoutMode(mode); } catch { /* storage unavailable */ }
    try { const sizes = JSON.parse(localStorage.getItem("zevrin-zone-sizes") || "null"); if (sizes && typeof sizes.left === "number") setZoneSizes(current => ({ ...current, ...sizes })); } catch { /* ignore */ }
  }, []);
  useEffect(() => { try { localStorage.setItem("zevrin-layout-mode", layoutMode); } catch { /* ignore */ } }, [layoutMode]);
  useEffect(() => { try { localStorage.setItem("zevrin-zone-sizes", JSON.stringify(zoneSizes)); } catch { /* ignore */ } }, [zoneSizes]);
  useEffect(() => {
    try { const saved = JSON.parse(localStorage.getItem(zonesStorageKey) || "{}"); setZoneOverrides(saved.overrides && typeof saved.overrides === "object" ? saved.overrides : {}); setZoneActive(saved.active && typeof saved.active === "object" ? saved.active : {}); } catch { setZoneOverrides({}); setZoneActive({}); }
    setZonesLoadedKey(zonesStorageKey);
  }, [zonesStorageKey]);
  useEffect(() => {
    if (zonesLoadedKey !== zonesStorageKey) return;
    try { localStorage.setItem(zonesStorageKey, JSON.stringify({ overrides: zoneOverrides, active: zoneActive })); } catch { /* ignore */ }
  }, [zoneOverrides, zoneActive, zonesLoadedKey, zonesStorageKey]);

  const layoutModeRef = useRef(layoutMode);
  const zoneActiveRef = useRef(zoneActive);
  const focusedTileIdRef = useRef(focusedTileId);
  const zoneOfRef = useRef<(node: TileNode) => Zone>(() => "center");
  useEffect(() => { layoutModeRef.current = layoutMode; zoneActiveRef.current = zoneActive; focusedTileIdRef.current = focusedTileId; zoneOfRef.current = zoneOf; });

  function zoneOf(node: TileNode): Zone {
    const override = zoneOverrides[node.id];
    if (override) return override;
    if (node.type === "files" || node.type === "git") return "left";
    if (node.type === "vscode" || node.type === "agent" || (node.type === "terminal" && node.assistant)) return "right";
    if (node.type === "terminal") return "bottom";
    return "center";
  }

  // A tile that gets focus (added, clicked, opened by a command) becomes the visible tab of its zone.
  useEffect(() => {
    if (!focusedTileId) return;
    const node = findTile(layout, item => item.id === focusedTileId);
    if (!node) return;
    const zone = zoneOf(node);
    setZoneActive(current => current[zone] === node.id ? current : { ...current, [zone]: node.id });
  }, [focusedTileId, layout]); // eslint-disable-line react-hooks/exhaustive-deps

  function moveToZone(id: string, zone: Zone) {
    setZoneOverrides(current => ({ ...current, [id]: zone }));
    setZoneActive(current => ({ ...current, [zone]: id }));
    setFocusedTileId(id);
  }

  // New agent session, optionally in its own Git worktree so parallel agents never edit the same files.
  async function newAgentSession(kind: "claude" | "codex" | "gemini" | "chat" | "codex-chat") {
    setAgentMenuOpen(false);
    const api = window.zevrinDesktop;
    let cwd: string | undefined;
    let branch: string | undefined;
    if (isolateAgent) {
      if (!api || !git?.isRepo) { pushToast("Agents", "Isolation needs a Git repository.", "warning"); return; }
      setAgentBusy(true);
      try {
        const stamp = new Date().toISOString().slice(5, 16).replace(/[-:T]/g, "");
        const created = await api.gitWorktreeCreate(active.path, `agent/${kind}-${stamp}`);
        cwd = created.path; branch = created.branch;
        refreshGit();
      } catch (error) { pushToast("Agents", errorMessage(error, "The worktree could not be created."), "warning"); setAgentBusy(false); return; }
      setAgentBusy(false);
    }
    const node = kind === "codex-chat"
      ? tile("agent", { assistant: "codex", name: (branch ? "Codex · " + branch.split("/").pop() : nextTerminalName(layout, "codex", "agent")), cwd, branch })
      : kind === "chat"
      ? tile("agent", { assistant: "claude", name: (branch ? "Claude · " + branch.split("/").pop() : nextTerminalName(layout, "claude", "agent")), cwd, branch })
      : tile("vscode", { ...(kind === "claude" ? {} : { assistant: kind }), cwd, branch });
    addTile(node);
    setZoneOverrides(current => ({ ...current, [node.id]: "right" }));
    if (branch) pushToast("Agents", `New ${kind === "chat" ? "Claude" : kind === "codex-chat" ? "Codex" : aiNames[kind]} session on its own branch ${branch}.`, "success");
  }

  // ----- Tile layout actions -----

  function addTile(node: TileNode, side: DropSide = "right", targetId: string | null = focusedTileId) {
    setLayout(current => {
      if (!current) return node;
      const target = targetId && tiles(current).some(item => item.id === targetId) ? targetId : null;
      return target ? insertBeside(current, target, node, side) : appendTile(current, node, side);
    });
    setFocusedTileId(node.id);
  }

  // Tiles fade out before leaving the layout.
  const [closingIds, setClosingIds] = useState<string[]>([]);
  function closeTile(id: string) {
    const node = findTile(layout, item => item.id === id);
    if (node?.cwd && node.branch && (node.type === "agent" || node.type === "vscode" || node.type === "terminal") && window.zevrinDesktop) { askFinishWorktree(node); return; }
    closeTileNow(id);
  }
  function closeTileNow(id: string) {
    if (closingIds.includes(id)) return;
    setClosingIds(current => [...current, id]);
    const reduced = typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    setTimeout(() => {
      setClosingIds(current => current.filter(item => item !== id));
      setLayout(current => removeNode(current, id));
      setTerminalStatus(current => { if (!(id in current)) return current; const next = { ...current }; delete next[id]; return next; });
      setFocusedTileId(current => current === id ? null : current);
    }, reduced ? 0 : 170);
  }

  function toggleTile(type: TileType) {
    const existing = findTile(layout, item => item.type === type && !item.assistant);
    // Docked: a first click brings a hidden tab to the front, a second one closes it.
    if (existing && layoutMode === "docked" && focusedTileId !== existing.id) { setFocusedTileId(existing.id); return; }
    if (existing) closeTile(existing.id); else addTile(tile(type));
  }

  // Extension-agent tiles (Claude Code, Codex, Gemini): one per agent, keyed by the assistant field.
  function findExtensionTile(agent: "claude" | "codex" | "gemini") {
    return findTile(layout, item => item.type === "vscode" && (item.assistant ?? "claude") === agent);
  }
  function toggleExtensionTile(agent: "claude" | "codex" | "gemini") {
    const existing = findExtensionTile(agent);
    if (existing && layoutMode === "docked" && focusedTileId !== existing.id) { setFocusedTileId(existing.id); return; }
    if (existing) closeTile(existing.id); else addTile(tile("vscode", agent === "claude" ? {} : { assistant: agent }));
  }

  // Claude opens as the native chat (same engine as the Claude Code extension). A click shows the chat, a click on an
  // already visible chat opens another session.
  function focusOrAddClaude() {
    const chats = tiles(layout).filter(item => item.type === "agent");
    const shown = chats.find(item => item.id === focusedTileId || Object.values(zoneActive).includes(item.id));
    if (chats.length && !(shown && shown.id === focusedTileId)) { setFocusedTileId((shown ?? chats[chats.length - 1]).id); return; }
    addAgent();
  }
  function focusOrAddCodex() {
    const chats = tiles(layout).filter(item => item.type === "agent" && item.assistant === "codex");
    const shown = chats.find(item => item.id === focusedTileId || Object.values(zoneActive).includes(item.id));
    if (chats.length && !(shown && shown.id === focusedTileId)) { setFocusedTileId((shown ?? chats[chats.length - 1]).id); return; }
    addTile(tile("agent", { assistant: "codex", name: nextTerminalName(layout, "codex", "agent") }));
  }
  function focusOrAddCli(id: AIToolId) {
    const existing = tiles(layout).find(item => item.type === "terminal" && item.assistant === id);
    if (existing && existing.id !== focusedTileId) { setFocusedTileId(existing.id); return; }
    addTerminal(id);
  }

  function ensureTile(type: TileType) {
    const existing = findTile(layout, item => item.type === type && !item.assistant);
    if (existing) { setFocusedTileId(existing.id); return; }
    addTile(tile(type));
  }

  function addTerminal(assistant: AIToolId | null = null, side: DropSide = "right", targetId: string | null = focusedTileId) {
    if (assistant && !window.zevrinDesktop) return;
    setAiError("");
    addTile(tile("terminal", { assistant: assistant ?? undefined, name: nextTerminalName(layout, assistant) }), side, targetId);
  }

  function addAgent(side: DropSide = "right", targetId: string | null = focusedTileId) {
    addTile(tile("agent", { assistant: "claude", name: nextTerminalName(layout, "claude", "agent") }), side, targetId);
  }

  const rememberAgentSession = useCallback((id: string, sessionId: string | undefined) => {
    setLayout(current => current ? updateTile(current, id, { session: sessionId }) : current);
  }, []);

  const rememberAgentStatus = useCallback((id: string, status: ChatState["status"]) => {
    setAgentStatus(current => current[id] === status ? current : { ...current, [id]: status });
  }, []);

  // ----- Agent attention: which background agents finished or wait for an answer -----
  const [agentWaiting, setAgentWaiting] = useState<Record<string, boolean>>({});
  const [agentUnseen, setAgentUnseen] = useState<Record<string, boolean>>({});
  const previousStatusRef = useRef<Record<string, ChatState["status"]>>({});
  const rememberAgentWaiting = useCallback((id: string, waiting: boolean) => {
    setAgentWaiting(current => Boolean(current[id]) === waiting ? current : { ...current, [id]: waiting });
  }, []);
  const tileIsSeen = useCallback((id: string) => {
    if (!visible || (typeof document !== "undefined" && !document.hasFocus())) return false;
    if (layoutModeRef.current === "free") return true;
    const node = findTile(layoutRef.current, item => item.id === id);
    if (!node) return true;
    return zoneActiveRef.current[zoneOfRef.current(node)] === id || focusedTileIdRef.current === id;
  }, [visible]);
  function notifyAgent(id: string, title: string, body: string) {
    const node = findTile(layoutRef.current, item => item.id === id);
    const label = node ? tileTitle(node) : "Agent";
    pushToast(`${label} · ${title}`, body, "info");
    try {
      if (typeof Notification !== "undefined" && !document.hasFocus()) {
        const show = () => { const notification = new Notification(`${label} · ${title}`, { body: `${active.name} — ${body}`, silent: false }); notification.onclick = () => { window.focus(); setFocusedTileId(id); }; };
        if (Notification.permission === "granted") show(); else if (Notification.permission !== "denied") Notification.requestPermission().then(permission => { if (permission === "granted") show(); });
      }
    } catch { /* notifications unavailable */ }
  }
  useEffect(() => {
    for (const [id, status] of Object.entries(agentStatus)) {
      const before = previousStatusRef.current[id];
      if (before === "running" && status === "idle" && !tileIsSeen(id)) { setAgentUnseen(current => ({ ...current, [id]: true })); notifyAgent(id, "done", "The agent finished its task."); }
      if (before === "running" && status === "error" && !tileIsSeen(id)) { setAgentUnseen(current => ({ ...current, [id]: true })); notifyAgent(id, "error", "The agent stopped with an error."); }
    }
    previousStatusRef.current = { ...agentStatus };
  }, [agentStatus]); // eslint-disable-line react-hooks/exhaustive-deps
  const previousWaitingRef = useRef<Record<string, boolean>>({});
  useEffect(() => {
    for (const [id, waiting] of Object.entries(agentWaiting)) {
      if (waiting && !previousWaitingRef.current[id] && !tileIsSeen(id)) notifyAgent(id, "needs you", "The agent is waiting for your approval.");
    }
    previousWaitingRef.current = { ...agentWaiting };
  }, [agentWaiting]); // eslint-disable-line react-hooks/exhaustive-deps

  // A tab that becomes visible clears its "finished, not seen" dot.
  useEffect(() => {
    const seen = [...Object.values(zoneActive), focusedTileId].filter(Boolean) as string[];
    if (seen.some(id => agentUnseen[id])) setAgentUnseen(current => { const next = { ...current }; for (const id of seen) delete next[id]; return next; });
  }, [zoneActive, focusedTileId, agentUnseen]);

  // ----- Ending an agent that runs in its own worktree -----
  const [finishing, setFinishing] = useState<{ node: TileNode; summary: { dirty: number; ahead: number; stat: string; target: string } | null; busy: boolean; error: string } | null>(null);
  async function askFinishWorktree(node: TileNode) {
    const api = window.zevrinDesktop;
    if (!api || !node.cwd || !node.branch) return false;
    setFinishing({ node, summary: null, busy: false, error: "" });
    try { const summary = await api.gitWorktreeSummary(active.path, node.cwd, node.branch); setFinishing(current => current && current.node.id === node.id ? { ...current, summary } : current); }
    catch (error) { setFinishing(current => current && current.node.id === node.id ? { ...current, error: errorMessage(error, "The worktree could not be read.") } : current); }
    return true;
  }
  // ----- Reviewing an agent's branch -----
  const [review, setReview] = useState<{ node: TileNode; changes: Array<{ status: string; path: string; uncommitted: boolean }> | null; error: string } | null>(null);
  const [reviewOpen, setReviewOpen] = useState(false);
  async function openReview(node: TileNode) {
    const api = window.zevrinDesktop;
    if (!api || !node.branch) return;
    setReview({ node, changes: null, error: "" }); setReviewOpen(true);
    try { const changes = await api.gitBranchChanges(active.path, node.branch, node.cwd ?? null); setReview(current => current && current.node.id === node.id ? { ...current, changes } : current); }
    catch (error) { setReview(current => current && current.node.id === node.id ? { ...current, error: errorMessage(error, "The changes could not be read.") } : current); }
  }
  async function openReviewFile(change: { status: string; path: string; uncommitted: boolean }) {
    const api = window.zevrinDesktop;
    if (!api || !review?.node.branch) return;
    try {
      const versions = await api.gitBranchFile(active.path, review.node.branch, change.path, review.node.cwd ?? null, change.uncommitted);
      setDiff({ path: change.path, staged: false, text: "", branch: review.node.branch, uncommitted: change.uncommitted, ...versions });
      setReviewOpen(false); ensureTile("editor");
    } catch (error) { pushToast("Review", errorMessage(error, "The file could not be read."), "warning"); }
  }

  async function finishWorktree(mode: "merge" | "remove" | "discard" | "keep") {
    const api = window.zevrinDesktop;
    const current = finishing;
    if (!current) return;
    if (mode === "keep") { setFinishing(null); closeTileNow(current.node.id); return; }
    if (mode === "discard" && !window.confirm(`Delete the branch ${current.node.branch} and its folder? The agent's work there is lost.`)) return;
    setFinishing({ ...current, busy: true, error: "" });
    try {
      await api!.gitWorktreeFinish(active.path, current.node.cwd!, current.node.branch!, mode);
      setFinishing(null);
      closeTileNow(current.node.id);
      refreshGit();
      pushToast("Agents", mode === "merge" ? `Merged ${current.node.branch} into ${current.summary?.target ?? "the current branch"}.` : mode === "remove" ? `Removed the folder, kept the branch ${current.node.branch}.` : `Deleted ${current.node.branch}.`, "success");
    } catch (error) { setFinishing({ ...current, busy: false, error: errorMessage(error, "The action failed.") }); }
  }

  const rememberTerminalId = useCallback((tileId: string, terminalId: string | null) => {
    if (terminalId) terminalIdsRef.current.set(tileId, terminalId); else terminalIdsRef.current.delete(tileId);
  }, []);

  function pushToast(title: string, body?: string, tone: Toast["tone"] = "info") {
    const id = newId();
    setToasts(current => [...current, { id, title, body, tone }].slice(-4));
    setTimeout(() => setToasts(current => current.filter(toast => toast.id !== id)), tone === "warning" ? 7000 : 4000);
  }

  function applyPreset(name: string) {
    const build = layoutPresets[name];
    if (!build) return;
    setLayout(build());
    setTerminalStatus({});
    setFocusedTileId(null);
  }

  function splitTile(id: string, direction: SplitDirection) {
    const source = findTile(layout, item => item.id === id);
    if (!source) return;
    const incoming = source.type === "terminal" ? tile("terminal", { assistant: source.assistant, name: nextTerminalName(layout, source.assistant ?? null) }) : source.type === "agent" ? tile("agent", { assistant: source.assistant === "codex" ? "codex" : "claude", name: nextTerminalName(layout, source.assistant === "codex" ? "codex" : "claude", "agent") }) : tile(toggleTiles.find(type => !hasTile(layout, type) && type !== source.type) ?? "terminal");
    setLayout(current => insertBeside(current, id, incoming, direction === "columns" ? "right" : "bottom"));
    setFocusedTileId(incoming.id);
  }

  function beginDrag(event: import("react").DragEvent, source: DragSource) {
    event.dataTransfer.setData(dragMime, JSON.stringify(source));
    event.dataTransfer.setData("text/plain", source.kind === "new" ? tileLabels[source.type] : "tile");
    event.dataTransfer.effectAllowed = source.kind === "new" ? "copy" : "move";
    setDragSource(source);
  }

  function endDrag() {
    setDragSource(null);
    setDropTarget(null);
    dropTargetRef.current = null;
  }

  function dragOverTile(event: import("react").DragEvent<HTMLElement>, id: string | null) {
    if (!dragSource && !event.dataTransfer.types.includes(dragMime)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = dragSource?.kind === "move" ? "move" : "copy";
    const bounds = event.currentTarget.getBoundingClientRect();
    const side = id === null ? "center" : dropSideFor(event.clientX - bounds.left, event.clientY - bounds.top, bounds.width, bounds.height);
    const current = dropTargetRef.current;
    if (current && current.id === id && current.side === side) return;
    const next = { id, side };
    dropTargetRef.current = next;
    setDropTarget(next);
  }

  function dragLeaveTile(event: import("react").DragEvent<HTMLElement>) {
    if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return;
    dropTargetRef.current = null;
    setDropTarget(null);
  }

  function dropOnTile(event: import("react").DragEvent<HTMLElement>, id: string | null) {
    event.preventDefault();
    event.stopPropagation();
    let source = dragSource;
    if (!source) {
      try { source = JSON.parse(event.dataTransfer.getData(dragMime)) as DragSource; } catch { source = null; }
    }
    const target = dropTargetRef.current && dropTargetRef.current.id === id ? dropTargetRef.current : { id, side: "center" as DropSide };
    endDrag();
    if (!source) return;
    if (source.kind === "new") {
      const type = source.type;
      const singleton = type !== "terminal" && type !== "agent" ? findTile(layout, item => item.type === type && (type === "vscode" ? (item.assistant ?? "claude") === (source.assistant ?? "claude") : !item.assistant)) : null;
      if (singleton) {
        if (id === null || singleton.id === id) { setFocusedTileId(singleton.id); return; }
        setLayout(current => moveNode(current, singleton.id, id, target.side));
        setFocusedTileId(singleton.id);
        return;
      }
      const node = type === "terminal" ? tile("terminal", { assistant: source.assistant, name: nextTerminalName(layout, source.assistant ?? null) }) : type === "agent" ? tile("agent", { assistant: "claude", name: nextTerminalName(layout, "claude", "agent") }) : type === "vscode" && source.assistant && source.assistant !== "claude" ? tile("vscode", { assistant: source.assistant }) : tile(type);
      setLayout(current => id === null ? appendTile(current, node, "right") : insertBeside(current, id, node, target.side));
      setFocusedTileId(node.id);
      return;
    }
    const movingId = source.id;
    if (id === null || id === movingId) return;
    setLayout(current => moveNode(current, movingId, id, target.side));
    setFocusedTileId(movingId);
  }

  // ----- Workspace actions -----

  function confirmDiscardUnsaved() {
    const unsaved = openFiles.filter(file => file.contents !== file.saved);
    return unsaved.length === 0 || window.confirm(`Discard unsaved changes to ${unsaved.map(file => file.path).join(", ")}?`);
  }

  // Re-reads every open file from disk (after a checkout or a discard); files that disappeared are closed.
  async function reloadOpenFiles(only?: string[]) {
    const api = window.zevrinDesktop;
    if (!api || !active) return;
    const targets = openFiles.filter(file => !only || only.includes(file.path));
    const fresh = await Promise.all(targets.map(async file => ({ path: file.path, contents: await api.readFile(active.path, file.path).catch(() => null) })));
    setOpenFiles(current => current.flatMap(file => { const next = fresh.find(item => item.path === file.path); if (!next) return [file]; return next.contents === null ? [] : [{ path: file.path, contents: next.contents, saved: next.contents }]; }));
  }

  async function openFilePath(path: string, line?: number) {
    if (!window.zevrinDesktop || !active) return false;
    const open = openFiles.find(file => file.path === path);
    if (open) { setActivePath(path); setDiff(null); setPendingLine(line && line > 0 ? line : null); ensureTile("editor"); return true; }
    try {
      const contents = await window.zevrinDesktop.readFile(active.path, path);
      setOpenFiles(current => [...current, { path, contents, saved: contents }]); setActivePath(path); setDiff(null);
      setCurrentDirectory(parentDirectory(path));
      setPendingLine(line && line > 0 ? line : null);
      ensureTile("editor");
      return true;
    } catch (error) { window.alert(errorMessage(error, "Could not open this file.")); return false; }
  }



  async function openFile(entry: FileEntry) {
    if (entry.directory) { setCurrentDirectory(entry.path); return; }
    await openFilePath(entry.path);
  }

  async function saveFile() {
    if (!window.zevrinDesktop || !active || !activeFile) return;
    try { await window.zevrinDesktop.writeFile(active.path, activeFile.path, activeFile.contents); setActiveFile(file => file ? { ...file, saved: file.contents } : file); refreshGit(); }
    catch (error) { window.alert(errorMessage(error, "Could not save this file.")); }
  }

  function insertEditorTab(event: import("react").KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== "Tab" || event.metaKey || event.ctrlKey || event.altKey) return;
    event.preventDefault();
    const element = event.currentTarget;
    const start = element.selectionStart;
    const end = element.selectionEnd;
    const next = element.value.slice(0, start) + "  " + element.value.slice(end);
    setActiveFile(file => file ? { ...file, contents: next } : file);
    requestAnimationFrame(() => { element.selectionStart = element.selectionEnd = start + 2; });
  }

  function closeOpenFile(path: string) {
    const file = openFiles.find(item => item.path === path);
    if (!file) return;
    if (file.contents !== file.saved && !window.confirm(`Discard unsaved changes to ${path}?`)) return;
    const rest = openFiles.filter(item => item.path !== path);
    setOpenFiles(rest);
    if (activePath === path) { const index = openFiles.indexOf(file); setActivePath((rest[index] ?? rest[index - 1])?.path ?? null); }
  }

  // "Ask Claude" from the editor: the selection with its file and lines, or the whole file when nothing is selected.
  function sendEditorToClaude() {
    if (!activeFile) return;
    const selection = editorApiRef.current?.selection() ?? null;
    const language = activeFile.path.split(".").pop() ?? "";
    if (selection) composeForClaude({ text: `In \`${activeFile.path}\` (lines ${selection.startLine}–${selection.endLine}):\n\`\`\`${language}\n${selection.text}\n\`\`\`\n` });
    else composeForClaude({ text: `About \`${activeFile.path}\`${activeFile.contents !== activeFile.saved ? " (unsaved edits in the editor)" : ""}:\n` });
  }

  function sendGitToClaude() {
    if (!git) return;
    const list = git.changes.map(change => `- ${change.index}${change.worktree} ${change.path}`).join("\n");
    composeForClaude({ text: `Review my uncommitted changes on \`${git.branch}\` (run git diff to read them):\n${list || "- (no changes)"}\n\n` });
  }

  async function openDiff(change: GitChange, staged: boolean) {
    if (!window.zevrinDesktop || !active) return;
    try {
      const [text, versions] = await Promise.all([window.zevrinDesktop.gitDiff(active.path, change.path, staged), window.zevrinDesktop.gitFileVersions(active.path, change.path, staged).catch(() => null)]);
      setDiff({ path: change.path, staged, text, ...(versions ?? {}) }); setActiveFile(null); ensureTile("editor");
    }
    catch (error) { setGitError(errorMessage(error, "Could not load this diff.")); }
  }

  async function runGitAction(action: () => Promise<unknown>, notice?: string) {
    setGitBusy(true); setGitError(""); setGitNotice("");
    try {
      await action();
      const status = await refreshGit();
      if (notice) setGitNotice(notice);
      if (diff && status) {
        const change = status.changes.find(item => item.path === diff.path);
        const stillThere = change && (diff.staged ? change.index !== " " && change.index !== "?" : change.worktree !== " ");
        if (stillThere) openDiff(change, diff.staged); else setDiff(null);
      }
      return true;
    } catch (error) { setGitError(errorMessage(error, "Git command failed.")); return false; }
    finally { setGitBusy(false); }
  }

  function toggleStage(paths: string[], staged: boolean) {
    const api = window.zevrinDesktop;
    if (!api || !active || paths.length === 0) return;
    runGitAction(() => staged ? api.gitUnstage(active.path, paths) : api.gitStage(active.path, paths));
  }

  function discardChanges(paths: string[]) {
    const api = window.zevrinDesktop;
    if (!api || !active || paths.length === 0) return;
    const label = paths.length === 1 ? paths[0] : `${paths.length} files`;
    if (!window.confirm(`Discard working tree changes in ${label}? Untracked files will be deleted. This cannot be undone.`)) return;
    runGitAction(async () => {
      await api.gitDiscard(active.path, paths);
      await reloadOpenFiles(paths);
    });
  }

  function commit() {
    const api = window.zevrinDesktop;
    if (!api || !active || !commitMessage.trim() || stagedChanges.length === 0) return;
    runGitAction(async () => { await api.gitCommit(active.path, commitMessage); setCommitMessage(""); setDiff(null); }, "Committed.");
  }

  function runSync(action: "fetch" | "pull" | "push") {
    const api = window.zevrinDesktop;
    if (!api || !active || syncAction) return;
    setSyncAction(action);
    const notice = action === "fetch" ? "Fetched from remote." : action === "pull" ? "Pulled latest changes." : "Pushed to remote.";
    runGitAction(() => action === "fetch" ? api.gitFetch(active.path) : action === "pull" ? api.gitPull(active.path) : api.gitPush(active.path), notice).finally(() => setSyncAction(null));
  }

  function checkoutBranch(name: string, create = false) {
    const api = window.zevrinDesktop;
    if (!api || !active || !name) return;
    if (!confirmDiscardUnsaved()) return;
    runGitAction(async () => {
      await api.gitCheckout(active.path, name, create);
      setBranchFormOpen(false); setNewBranchName(""); setDiff(null);
      await reloadOpenFiles();
    }, create ? `Created and switched to ${name}.` : `Switched to ${name}.`);
  }

  async function createWorktree() {
    const api = window.zevrinDesktop;
    const branch = worktreeBranch.trim();
    if (!api || !active || !branch || worktreeBusy) return;
    setWorktreeBusy(true); setGitError("");
    try {
      const created = await api.gitWorktreeCreate(active.path, branch);
      setWorktreeFormOpen(false); setWorktreeBranch("");
      props.onOpenWorkspace(created.path, branch);
    } catch (error) {
      setGitError(errorMessage(error, "Could not create the Git worktree."));
    } finally {
      setWorktreeBusy(false);
    }
  }

  function openWorktree(worktree: GitWorktree) {
    if (worktree.current) return;
    props.onOpenWorkspace(worktree.path, worktree.branch || worktree.path.split("/").filter(Boolean).pop() || "Worktree");
  }

  function removeWorktree(worktree: GitWorktree) {
    const api = window.zevrinDesktop;
    if (!api || !active || worktree.current || worktree.bare) return;
    if (!window.confirm(`Remove the worktree at ${worktree.path}?\nThe branch ${worktree.branch || ""} is kept.`)) return;
    runGitAction(async () => {
      try { await api.gitWorktreeRemove(active.path, worktree.path); }
      catch (error) {
        const message = errorMessage(error, "");
        if (!/modified|untracked|use --force/i.test(message) || !window.confirm(`${message}\n\nRemove it anyway and lose those changes?`)) throw error;
        await api.gitWorktreeRemove(active.path, worktree.path, true);
      }
      props.onForgetWorkspacePath(worktree.path);
    }, "Worktree removed.");
  }

  function navigatePreview(value: string) {
    const input = value.trim();
    if (!input) return;
    const url = input.toLowerCase().startsWith("http://") || input.toLowerCase().startsWith("https://") ? input : "http://" + input;
    if (url === previewLocation) { setPreviewReloadKey(key => key + 1); return; }
    const history = [...previewHistory.slice(0, previewHistoryIndex + 1), url];
    setPreviewHistory(history); setPreviewHistoryIndex(history.length - 1);
    setPreviewUrl(url); setPreviewLocation(url);
  }

  function movePreviewHistory(index: number) {
    const frame = previewFrameRef.current;
    if (desktop && frame) {
      if (index < previewHistoryIndex && frame.canGoBack()) { frame.goBack(); return; }
      if (index > previewHistoryIndex && frame.canGoForward()) { frame.goForward(); return; }
    }
    const url = previewHistory[index];
    if (!url) return;
    setPreviewHistoryIndex(index); setPreviewUrl(url); setPreviewLocation(url);
  }

  const onPreviewNavigated = useCallback((url: string) => { setPreviewUrl(url); }, []);

  function reloadPreview() {
    const frame = previewFrameRef.current;
    if (desktop && frame) frame.reload(); else setPreviewReloadKey(key => key + 1);
  }

  // Attach the network recorder as soon as a page is shown, so the log covers the whole load.
  useEffect(() => {
    const api = window.zevrinDesktop;
    if (!desktop || !api || !previewLocation) return;
    const timer = setTimeout(() => { try { api.previewAttach(previewContentsId()).catch(() => {}); } catch { /* not ready */ } }, 600);
    return () => clearTimeout(timer);
  }, [desktop, previewLocation, previewReloadKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const onPreviewConsole = useCallback((entry: ConsoleEntry | null) => {
    if (!entry) { previewConsoleRef.current = []; setPreviewIssues(0); return; }
    previewConsoleRef.current = [...previewConsoleRef.current.slice(-399), entry];
    if (entry.level === "error" || entry.level === "warning") setPreviewIssues(count => count + 1);
  }, []);

  function previewContentsId() {
    const frame = previewFrameRef.current;
    if (!desktop || !frame || !previewLocation) throw new Error("The Preview tile is not showing a page.");
    try { return frame.getWebContentsId(); } catch { throw new Error("The preview is still loading."); }
  }

  async function readPreviewPage(): Promise<PageSnapshot> {
    const api = window.zevrinDesktop!;
    const result = await api.previewEval(previewContentsId(), snapshotScript) as Partial<PageSnapshot> | null;
    return { url: result?.url || previewLocation, title: result?.title || "", selection: result?.selection || "", text: result?.text || "", headings: Array.isArray(result?.headings) ? result!.headings!.map(String) : [], description: result?.description || "", forms: result?.forms, links: result?.links };
  }

  // Sends context to the first Claude chat tile (creating one when needed): the chat picks it up in its composer.
  type AgentPayload = { text: string; images?: Array<{ name: string; mediaType: string; data: string }> };
  // Agents that can receive context: chat tiles, extension tiles and CLI agents in terminals.
  function agentTargets() {
    return tiles(layoutRef.current).filter(item => item.type === "agent" || item.type === "vscode" || (item.type === "terminal" && item.assistant));
  }
  function composeForClaude(payload: AgentPayload) { void deliverToAgent(payload); }
  // Sends context to the chosen agent. Chats get it in their composer (images attached); CLI agents get it pasted in
  // their prompt (images saved under .zevrin/context and referenced by path); extension chats get a context file
  // whose @path is copied to the clipboard.
  async function deliverToAgent(payload: AgentPayload) {
    const api = window.zevrinDesktop;
    const all = agentTargets();
    let target = all.find(item => item.id === sendTarget) ?? (sendTarget === "new" ? null : all.find(item => item.type === "agent") ?? null);
    if (!target) {
      target = tile("agent", { assistant: "claude", name: nextTerminalName(layoutRef.current, "claude", "agent") });
      addTile(target, "left", findTile(layoutRef.current, item => item.type === "preview")?.id ?? focusedTileId);
      setSendTarget(target.id);
    } else setFocusedTileId(target.id);
    if (target.type === "agent" || !api) { postCompose(target.id, payload); return; }
    const root = target.cwd ?? active.path;
    const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
    const saved: string[] = [];
    for (const [index, image] of (payload.images ?? []).entries()) {
      try { const ext = image.mediaType.includes("jpeg") ? "jpg" : "png"; const file = await api.saveArtifact(root, `browser-${stamp}-${index + 1}.${ext}`, image.data); saved.push(file.relative); } catch { /* keep going */ }
    }
    const text = payload.text.trim() + (saved.length ? "\n\nImages: " + saved.map(file => "@" + file).join(" ") : "");
    if (target.type === "terminal") {
      const ptyId = terminalIdsRef.current.get(target.id);
      if (!ptyId) { pushToast("Agents", "That terminal is not ready yet.", "warning"); return; }
      api.writeTerminal(ptyId, "\x1b[200~" + text + "\x1b[201~");
      return;
    }
    try {
      const file = await api.saveArtifact(root, `browser-${stamp}.md`, null, text + "\n");
      await navigator.clipboard.writeText("@" + file.relative + " ");
      pushToast(tileTitle(target), `Context saved to ${file.relative}. Paste it into the chat (⌘V).`, "success");
    } catch (error) { pushToast("Agents", errorMessage(error, "The context could not be saved."), "warning"); }
  }

  // ----- Browser: element picker and screen recording -----
  async function cropImage(dataUrl: string, rect: { x: number; y: number; width: number; height: number }, viewportWidth: number) {
    const image = new Image();
    await new Promise((resolve, reject) => { image.onload = resolve; image.onerror = reject; image.src = dataUrl; });
    const scale = image.naturalWidth / Math.max(1, viewportWidth);
    const pad = 12;
    const x = Math.max(0, (rect.x - pad) * scale), y = Math.max(0, (rect.y - pad) * scale);
    const width = Math.min(image.naturalWidth - x, (rect.width + pad * 2) * scale), height = Math.min(image.naturalHeight - y, (rect.height + pad * 2) * scale);
    if (width < 4 || height < 4) return null;
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(width); canvas.height = Math.round(height);
    canvas.getContext("2d")!.drawImage(image, x, y, width, height, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/png").split(",")[1];
  }

  async function startPicking() {
    const api = window.zevrinDesktop;
    if (!api) return;
    if (picking) { try { await api.previewEval(previewContentsId(), pickerCancelScript); } catch { /* ignore */ } setPicking(false); return; }
    setPreviewMenuOpen(false);
    try { await api.previewEval(previewContentsId(), pickerInstallScript); } catch (error) { pushToast("Preview", errorMessage(error, "The picker could not start."), "warning"); return; }
    setPicking(true);
    const startedAt = Date.now();
    while (Date.now() - startedAt < 120000) {
      await new Promise(resolve => setTimeout(resolve, 250));
      let result: { state: string; value?: PickedElement | null } | null = null;
      try { result = await api.previewEval(previewContentsId(), pickerPollScript) as { state: string; value?: PickedElement | null }; } catch { result = null; }
      if (!result || result.state === "picking") continue;
      setPicking(false);
      if (result.state !== "done" || !result.value) return;
      const element = result.value;
      let image: string | null = null;
      try { const shot = await api.previewCapture(previewContentsId()); image = await cropImage(`data:${shot.mimeType};base64,${shot.data}`, element.rect, element.viewport.width); } catch { image = null; }
      await deliverToAgent({ text: formatElementContext(element) + "\n\n", images: image ? [{ name: "element.png", mediaType: "image/png", data: image }] : [] });
      return;
    }
    setPicking(false);
  }

  useEffect(() => {
    if (!recording) return;
    const timer = setInterval(() => { const elapsed = Date.now() - recording.startedAt; setRecordElapsed(elapsed); if (elapsed > 60000) void toggleRecording(); }, 250);
    return () => clearInterval(timer);
  }, [recording]); // eslint-disable-line react-hooks/exhaustive-deps

  // Encodes screencast frames (JPEG, with timestamps) into a WebM for the user; played at most 30 s.
  async function encodeWebm(frames: Array<{ data: string; t: number }>) {
    if (frames.length === 0 || typeof MediaRecorder === "undefined") return null;
    const load = (data: string) => new Promise<HTMLImageElement>((resolve, reject) => { const image = new Image(); image.onload = () => resolve(image); image.onerror = reject; image.src = "data:image/jpeg;base64," + data; });
    const first = await load(frames[0].data);
    const canvas = document.createElement("canvas");
    canvas.width = first.naturalWidth; canvas.height = first.naturalHeight;
    const context = canvas.getContext("2d")!;
    const stream = canvas.captureStream(30);
    const type = MediaRecorder.isTypeSupported("video/webm;codecs=vp9") ? "video/webm;codecs=vp9" : "video/webm";
    const recorder = new MediaRecorder(stream, { mimeType: type, videoBitsPerSecond: 2_500_000 });
    const chunks: Blob[] = [];
    recorder.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
    const stopped = new Promise(resolve => { recorder.onstop = resolve; });
    const total = Math.max(0.001, frames[frames.length - 1].t - frames[0].t);
    const speed = total > 30 ? total / 30 : 1;
    recorder.start();
    for (let index = 0; index < frames.length; index += 1) {
      const image = index === 0 ? first : await load(frames[index].data);
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      const next = frames[index + 1];
      await new Promise(resolve => setTimeout(resolve, next ? Math.min(1000, Math.max(16, (next.t - frames[index].t) * 1000 / speed)) : 300));
    }
    recorder.stop();
    await stopped;
    const blob = new Blob(chunks, { type: "video/webm" });
    return await new Promise<string>(resolve => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(",")[1] ?? ""); reader.readAsDataURL(blob); });
  }

  async function toggleRecording() {
    const api = window.zevrinDesktop;
    if (!api) return;
    if (!recording) {
      setPreviewMenuOpen(false);
      try { await api.previewRecordStart(previewContentsId()); setRecording({ startedAt: Date.now() }); setRecordElapsed(0); }
      catch (error) { pushToast("Preview", errorMessage(error, "Recording could not start."), "warning"); }
      return;
    }
    const startedAt = recording.startedAt;
    setRecording(null);
    setPreviewBusy("record");
    try {
      const result = await api.previewRecordStop(previewContentsId());
      const keyframes = pickKeyframes(result.frames, 6);
      let saved: string | null = null;
      try { const video = await encodeWebm(result.frames); if (video) saved = (await api.saveArtifact(active.path, `recording-${new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14)}.webm`, video)).relative; } catch { saved = null; }
      const consoleDuring = previewConsoleRef.current.filter(entry => entry.at >= startedAt);
      const failures = result.network.filter(item => item.failed || (item.status ?? 0) >= 400);
      const lines = [`Screen recording of ${previewLocation} (${(result.durationMs / 1000).toFixed(1)} s, ${keyframes.length} key frames attached in order${saved ? `, video saved to ${saved}` : ""}).`];
      if (consoleDuring.length) lines.push("", "Console during the recording:", "```", formatConsole(consoleDuring, { limit: 40 }), "```");
      if (failures.length) lines.push("", "Failed requests during the recording:", "```", formatNetwork(failures, { limit: 30 }), "```");
      await deliverToAgent({ text: lines.join("\n") + "\n\n", images: keyframes.map((frame, index) => ({ name: `frame-${index + 1}.jpg`, mediaType: "image/jpeg", data: frame.data })) });
    } catch (error) { pushToast("Preview", errorMessage(error, "The recording could not be read."), "warning"); }
    finally { setPreviewBusy(""); }
  }

  // Everything an agent needs about the page at once: content, screenshot, console problems, failed requests.
  async function sendFullContext() {
    const api = window.zevrinDesktop!;
    const page = await readPreviewPage();
    const shot = await api.previewCapture(previewContentsId());
    const network = await api.previewNetwork(previewContentsId()).catch(() => []);
    const problems = previewConsoleRef.current.filter(entry => entry.level === "error" || entry.level === "warning");
    const failures = network.filter(item => item.failed || (item.status ?? 0) >= 400);
    const text = [formatPageContext(page, { maxText: 3000 }), "", "Console errors and warnings:", "```", formatConsole(problems, { limit: 30 }), "```", "", "Failed requests:", "```", formatNetwork(failures, { limit: 30 }), "```"].join("\n");
    await deliverToAgent({ text: text + "\n\n", images: [{ name: "page.png", mediaType: shot.mimeType, data: shot.data }] });
  }

  async function sendPreviewToClaude(kind: "page" | "selection" | "screenshot" | "console" | "url" | "network" | "full") {
    const api = window.zevrinDesktop;
    setPreviewMenuOpen(false);
    if (!api) { composeForClaude({ text: `Preview URL: ${previewLocation}\n` }); return; }
    setPreviewBusy(kind);
    try {
      if (kind === "full") await sendFullContext();
      else if (kind === "network") { const network = await api.previewNetwork(previewContentsId()); const failures = network.filter(item => item.failed || (item.status ?? 0) >= 400); composeForClaude({ text: `Network activity of ${previewLocation}${failures.length ? ` (${failures.length} failed)` : ""}:\n\`\`\`\n${formatNetwork(failures.length ? [...failures, ...network.filter(item => !failures.includes(item)).slice(-20)] : network, { limit: 60 })}\n\`\`\`\n` }); }
      else if (kind === "url") composeForClaude({ text: `Look at the page shown in the Preview tile: ${previewLocation}\n` });
      else if (kind === "console") composeForClaude({ text: `Console of the page ${previewLocation}:\n\`\`\`\n${formatConsole(previewConsoleRef.current, { errorsOnly: previewConsoleRef.current.some(entry => entry.level === "error" || entry.level === "warning") })}\n\`\`\`\n` });
      else if (kind === "screenshot") { const shot = await api.previewCapture(previewContentsId()); composeForClaude({ text: `Screenshot of ${previewLocation} (${shot.width}×${shot.height}):\n`, images: [{ name: "preview.png", mediaType: shot.mimeType, data: shot.data }] }); }
      else { const page = await readPreviewPage(); composeForClaude({ text: formatPageContext(page, { selectionOnly: kind === "selection" }) + "\n\n" }); }
    } catch (error) { pushToast("Preview", errorMessage(error, "Could not read the preview."), "warning"); }
    finally { setPreviewBusy(""); }
  }

  // ----- Canvas -----

  function addCanvasItem(event: import("react").PointerEvent<HTMLDivElement>) {
    if ((event.target as HTMLElement).closest(".canvas-item")) return;
    if (canvasTool === "select") { setSelectedCanvasId(null); setEditingCanvasId(null); return; }
    if (canvasTool === "pan") return;
    if (canvasTool === "connector") { setConnectionStartId(null); return; }
    const bounds = event.currentTarget.getBoundingClientRect();
    const x = Math.max(12, Math.round((event.clientX - bounds.left - canvasPan.x) / canvasZoom));
    const y = Math.max(68, Math.round((event.clientY - bounds.top - canvasPan.y) / canvasZoom));
    const item: CanvasItem = { id: newId(), type: canvasTool, x, y, text: canvasTool === "note" ? "New idea" : canvasTool === "rectangle" ? "Card" : canvasTool === "text" ? "Text" : "" };
    setCanvasItems(items => [...items, item]);
    setSelectedCanvasId(item.id);
    setCanvasTool("select");
  }

  function startCanvasDrag(event: import("react").PointerEvent<HTMLDivElement>, item: CanvasItem) {
    event.stopPropagation();
    setSelectedCanvasId(item.id);
    if (canvasTool === "connector" && item.type !== "connector") {
      if (!connectionStartId) { setConnectionStartId(item.id); return; }
      if (connectionStartId === item.id) { setConnectionStartId(null); setSelectedCanvasId(null); return; }
      const connection: CanvasItem = { id: newId(), type: "connector", x: 0, y: 0, text: "", from: connectionStartId, to: item.id };
      setCanvasItems(items => [...items, connection]);
      setConnectionStartId(null); setCanvasTool("select"); setSelectedCanvasId(connection.id);
      return;
    }
    if (canvasTool !== "select" || (event.target as HTMLElement).closest("textarea")) return;
    canvasDragRef.current = { id: item.id, pointerId: event.pointerId, x: event.clientX, y: event.clientY, left: item.x, top: item.y };
    (event.currentTarget.closest(".canvas-grid") as HTMLDivElement | null)?.setPointerCapture(event.pointerId);
  }

  function beginCanvasPan(event: import("react").PointerEvent<HTMLDivElement>) {
    if (canvasTool !== "pan" || (event.target as HTMLElement).closest(".canvas-item")) return;
    canvasPanRef.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, left: canvasPan.x, top: canvasPan.y };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function moveCanvasItem(event: import("react").PointerEvent<HTMLDivElement>) {
    const pan = canvasPanRef.current;
    if (pan && pan.pointerId === event.pointerId) {
      setCanvasPan({ x: pan.left + event.clientX - pan.x, y: pan.top + event.clientY - pan.y });
      return;
    }
    const drag = canvasDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const x = Math.max(8, Math.round(drag.left + (event.clientX - drag.x) / canvasZoom));
    const y = Math.max(54, Math.round(drag.top + (event.clientY - drag.y) / canvasZoom));
    setCanvasItems(items => items.map(item => item.id === drag.id ? { ...item, x, y } : item));
  }

  function stopCanvasDrag(event: import("react").PointerEvent<HTMLDivElement>) {
    if (canvasDragRef.current?.pointerId === event.pointerId) canvasDragRef.current = null;
    if (canvasPanRef.current?.pointerId === event.pointerId) canvasPanRef.current = null;
  }

  function updateCanvasText(id: string, text: string) {
    setCanvasItems(items => items.map(item => item.id === id ? { ...item, text: text.slice(0, 2000) } : item));
  }

  function removeCanvasItem(id: string) {
    setCanvasItems(items => removeCanvasItems(items, id));
    setSelectedCanvasId(null); setEditingCanvasId(null); setConnectionStartId(null);
  }

  function zoomCanvas(delta: number) {
    setCanvasZoom(value => Math.min(2, Math.max(0.5, Math.round((value + delta) * 10) / 10)));
  }

  function renderCanvasConnections() {
    const nodes = new Map(canvasItems.filter(item => item.type !== "connector").map(item => [item.id, item]));
    return <svg className="canvas-connections" role="group" aria-label="Canvas connections">{canvasItems.filter(item => item.type === "connector" && item.from && item.to).map(connection => {
      const source = nodes.get(connection.from!); const target = nodes.get(connection.to!);
      if (!source || !target) return null;
      const path = canvasConnectionPath(source, target);
      return <path key={connection.id} className={selectedCanvasId === connection.id ? "canvas-connection selected" : "canvas-connection"} d={path} role="button" tabIndex={0} aria-label={`Select connection from ${source.text || "item"} to ${target.text || "item"}`} onPointerDown={event => { event.stopPropagation(); setSelectedCanvasId(connection.id); }} onKeyDown={event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setSelectedCanvasId(connection.id); } }} />;
    })}</svg>;
  }

  useEffect(() => {
    if (!canvasVisible || !active) return;
    const listener = (event: KeyboardEvent) => {
      if (event.key === "Escape") { setCanvasTool("select"); setEditingCanvasId(null); setConnectionStartId(null); }
      if ((event.key === "Backspace" || event.key === "Delete") && selectedCanvasId && !(event.target instanceof HTMLTextAreaElement) && !(event.target instanceof HTMLInputElement)) {
        event.preventDefault();
        removeCanvasItem(selectedCanvasId);
      }
    };
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, [canvasVisible, active, selectedCanvasId]);

  // ----- App commands (Zevrin MCP tools) -----

  const layoutRef = useRef(layout);
  useEffect(() => { layoutRef.current = layout; }, [layout]);

  useEffect(() => {
    const api = window.zevrinDesktop;
    if (!desktop || !api) return;
    const remove = api.onAppCommand(async (requestId, command: AppCommandName, args, workspace) => {
      if (command === "list_workspaces") return;
      if (workspace ? workspace !== active.path && !tiles(layoutRef.current).some(item => item.cwd === workspace) : !visible) return;
      const run = async (): Promise<unknown> => {
        const text = (value: unknown, max = 4000) => typeof value === "string" ? value.slice(0, max) : "";
        if (command === "get_workspace_state") {
          return { workspace: active.path, name: active.name, tiles: tiles(layoutRef.current).map(item => ({ type: item.type, title: tileTitle(item) })), activeFile: activeFile ? { path: activeFile.path, unsaved: activeFile.contents !== activeFile.saved } : null, openFiles: openFiles.map(file => file.path), previewUrl: previewLocation || null, git: git ? { branch: git.branch, ahead: git.ahead, behind: git.behind, changes: git.changes.map(change => `${change.index}${change.worktree} ${change.path}`) } : null };
        }
        if (command === "open_file") {
          const path = text(args.path, 1000).replace(/^\.?\//, "");
          if (!path) throw new Error("path is required.");
          const opened = await openFilePath(path, typeof args.line === "number" ? args.line : undefined);
          if (!opened) throw new Error("The file could not be opened.");
          return `Opened ${path} in the Code tile.`;
        }
        if (command === "show_preview") {
          const url = text(args.url, 2000);
          if (!url) throw new Error("url is required.");
          ensureTile("preview"); navigatePreview(url);
          return `Preview now shows ${url}.`;
        }
        if (command === "add_canvas_note") {
          const body = text(args.text, 2000);
          if (!body) throw new Error("text is required.");
          const kind = args.kind === "rectangle" || args.kind === "diamond" || args.kind === "text" ? args.kind : "note";
          const existing = canvasItems.length;
          const item: CanvasItem = { id: newId(), type: kind, x: typeof args.x === "number" ? Math.max(8, args.x) : 40 + (existing % 5) * 180, y: typeof args.y === "number" ? Math.max(54, args.y) : 80 + Math.floor(existing / 5) * 130, text: body };
          setCanvasItems(items => [...items, item]);
          ensureTile("canvas");
          return { added: item.id };
        }
        if (command === "get_canvas") return { items: canvasItems };
        if (command === "open_tile") {
          const type = String(args.tile) as TileType;
          if (type === "terminal") addTerminal(null); else if (type === "agent") addAgent(); else if (toggleTiles.includes(type)) ensureTile(type); else throw new Error("Unknown tile.");
          return `${tileLabels[type]} tile is open.`;
        }
        if (command === "close_tile") {
          const type = String(args.tile) as TileType;
          const existing = findTile(layoutRef.current, item => item.type === type && !item.assistant);
          if (existing) closeTile(existing.id);
          return existing ? `${tileLabels[type]} tile closed.` : `${tileLabels[type]} tile was not open.`;
        }
        if (command === "apply_layout") {
          const preset = text(args.preset, 40);
          if (!layoutPresets[preset]) throw new Error("Unknown preset.");
          applyPreset(preset);
          return `Applied the ${preset} layout.`;
        }
        if (command === "run_in_terminal") {
          const commandText = text(args.command, 4000);
          if (!commandText) throw new Error("command is required.");
          let target = tiles(layoutRef.current).find(item => item.type === "terminal" && !item.assistant);
          if (!target) { addTerminal(null); }
          for (let attempt = 0; attempt < 40; attempt += 1) {
            target = tiles(layoutRef.current).find(item => item.type === "terminal" && !item.assistant);
            const ptyId = target ? terminalIdsRef.current.get(target.id) : undefined;
            if (target && ptyId) { api.writeTerminal(ptyId, commandText.replace(/\r?\n$/, "") + "\r"); setFocusedTileId(target.id); return `Sent to the ${tileTitle(target)} tile: ${commandText}`; }
            await new Promise(resolve => setTimeout(resolve, 200));
          }
          throw new Error("No terminal became ready.");
        }
        if (command === "get_preview_page") {
          const selector = text(args.selector, 500);
          if (selector) {
            const html = await api.previewEval(previewContentsId(), `(() => { const node = document.querySelector(${JSON.stringify(selector)}); return node ? node.outerHTML.slice(0, 20000) : null; })()`);
            return html === null ? `No element matches ${selector}.` : String(html);
          }
          return formatPageContext(await readPreviewPage(), { maxText: 12000 });
        }
        if (command === "preview_screenshot") {
          const shot = await api.previewCapture(previewContentsId());
          return { content: [{ type: "image", data: shot.data, mimeType: shot.mimeType }, { type: "text", text: `Screenshot of ${previewLocation} (${shot.width}×${shot.height}).` }] };
        }
        if (command === "get_preview_console") {
          if (!previewLocation) throw new Error("The Preview tile is not showing a page.");
          return formatConsole(previewConsoleRef.current, { errorsOnly: args.errorsOnly === true, limit: typeof args.limit === "number" ? args.limit : 60 });
        }
        if (command === "preview_navigate") {
          const url = text(args.url, 2000);
          if (!url) throw new Error("url is required.");
          ensureTile("preview"); navigatePreview(url);
          await new Promise(resolve => setTimeout(resolve, 1500));
          return `Navigating to ${url}. Use preview_snapshot to see the page.`;
        }
        if (command === "preview_snapshot") {
          const snapshot = await api.previewEval(previewContentsId(), snapshotRefsScript) as Parameters<typeof formatSnapshot>[0];
          return formatSnapshot(snapshot);
        }
        if (command === "preview_click" || command === "preview_type") {
          const target: LocateTarget = { ref: text(args.ref, 20) || undefined, selector: text(args.selector, 500) || undefined, text: text(args.target_text ?? args.text_match, 200) || undefined };
          const typed = command === "preview_type" ? text(args.text, 5000) : "";
          if (command === "preview_type" && !typed) throw new Error("text is required.");
          type Located = { x: number; y: number; tag: string; label: string; error?: string };
          let where: Located | null = null;
          if (target.ref || target.selector || target.text) {
            const found = await api.previewEval(previewContentsId(), locateScript(target)) as Located | null;
            if (!found || found.error) throw new Error(found?.error || "No element matches.");
            where = found;
            await api.previewInput(previewContentsId(), { type: "click", x: found.x, y: found.y });
          } else if (command === "preview_click") throw new Error("Give a ref (from preview_snapshot), a selector or target_text.");
          if (typed) { await api.previewInput(previewContentsId(), { type: "type", text: typed }); if (args.submit === true) await api.previewInput(previewContentsId(), { type: "key", key: "Enter" }); }
          await new Promise(resolve => setTimeout(resolve, 500));
          const title = await api.previewEval(previewContentsId(), "document.title + ' — ' + location.href").catch(() => "");
          const located = where as Located | null;
          return `${command === "preview_click" ? "Clicked" : "Typed into"} ${located ? `<${located.tag}> "${located.label}"` : "the focused element"}${args.submit === true ? " and pressed Enter" : ""}. Now: ${title}`;
        }
        if (command === "preview_press_key") { const key = text(args.key, 20); await api.previewInput(previewContentsId(), { type: "key", key }); await new Promise(resolve => setTimeout(resolve, 300)); return `Pressed ${key}.`; }
        if (command === "preview_scroll") { const amount = typeof args.amount === "number" ? args.amount : 600; await api.previewInput(previewContentsId(), { type: "scroll", deltaY: args.direction === "up" ? -amount : amount }); await new Promise(resolve => setTimeout(resolve, 300)); return `Scrolled ${args.direction === "up" ? "up" : "down"} ${amount}px.`; }
        if (command === "preview_wait_for") {
          const timeout = Math.min(30000, typeof args.timeoutMs === "number" ? args.timeoutMs : 8000);
          const target = { text: text(args.text, 200) || undefined, selector: text(args.selector, 500) || undefined };
          const until = Date.now() + timeout;
          while (Date.now() < until) { if (await api.previewEval(previewContentsId(), waitForScript(target)).catch(() => false)) return `Found ${target.selector ?? `"${target.text}"`}.`; await new Promise(resolve => setTimeout(resolve, 300)); }
          throw new Error(`Timed out after ${timeout} ms waiting for ${target.selector ?? `"${target.text}"`}.`);
        }
        if (command === "preview_network") { const network = await api.previewNetwork(previewContentsId()); return formatNetwork(network, { failuresOnly: args.failuresOnly === true, limit: 80 }); }
        if (command === "preview_record") {
          const seconds = Math.max(1, Math.min(20, typeof args.seconds === "number" ? args.seconds : 5));
          const startedAt = Date.now();
          await api.previewRecordStart(previewContentsId());
          await new Promise(resolve => setTimeout(resolve, seconds * 1000));
          const result = await api.previewRecordStop(previewContentsId());
          const keyframes = pickKeyframes(result.frames, 6);
          const consoleDuring = previewConsoleRef.current.filter(entry => entry.at >= startedAt);
          const failures = result.network.filter(item => item.failed || (item.status ?? 0) >= 400);
          return { content: [...keyframes.map(frame => ({ type: "image", data: frame.data, mimeType: "image/jpeg" })), { type: "text", text: `${keyframes.length} key frames over ${(result.durationMs / 1000).toFixed(1)} s (in order).\nConsole:\n${formatConsole(consoleDuring, { limit: 30 })}\nFailed requests:\n${formatNetwork(failures, { limit: 30 })}` }] };
        }
        if (command === "run_in_preview") {
          const script = text(args.script, 20000);
          if (!script) throw new Error("script is required.");
          const result = await api.previewEval(previewContentsId(), script);
          return result === undefined ? "undefined" : result;
        }
        if (command === "list_devices") {
          const result = await api.devicesList();
          return { support: result.support, devices: result.devices.map(device => ({ platform: device.platform, id: device.id, name: device.name, runtime: device.runtime, state: device.state })), errors: result.errors };
        }
        if (command === "boot_device") {
          const platform = args.platform === "android" ? "android" : "ios";
          const id = text(args.id, 80);
          if (!id) throw new Error("id is required (see list_devices).");
          ensureTile("devices");
          await api.deviceBoot(platform, id);
          devicesApiRef.current?.refresh();
          return `${platform === "ios" ? "Simulator" : "Emulator"} ${id} is booting; it is shown in the Devices tile.`;
        }
        if (command === "device_screenshot" || command === "open_url_on_device" || command === "device_logs" || command === "set_device_appearance") {
          const wanted = text(args.id, 80);
          let device = wanted ? (await api.devicesList()).devices.find(item => item.id === wanted && (!args.platform || item.platform === args.platform)) ?? null : devicesApiRef.current?.mirrored() ?? null;
          if (!device && !wanted) { const all = await api.devicesList(); device = all.devices.find(item => item.state === "booted") ?? null; }
          if (!device) throw new Error("No booted device. Boot one with boot_device first.");
          if (device.state !== "booted") throw new Error(`${device.name} is ${device.state}; boot it first.`);
          if (command === "open_url_on_device") {
            const url = text(args.url, 2000);
            if (!url) throw new Error("url is required.");
            await api.deviceOpenUrl(device.platform, device.id, device.serial, device.platform === "android" ? url.replace(/\/\/(localhost|127\.0\.0\.1)/, "//10.0.2.2") : url);
            return `Opened ${url} on ${device.name}.`;
          }
          if (command === "device_logs") {
            const logs = await api.deviceLogs(device.platform, device.id, device.serial, { minutes: typeof args.minutes === "number" ? args.minutes : 2, errorsOnly: args.errorsOnly === true, filter: text(args.filter, 120), lines: typeof args.lines === "number" ? args.lines : 300 });
            return logs.trim() ? `Logs of ${device.name} (${device.runtime}):\n${logs}` : `No matching logs on ${device.name}.`;
          }
          if (command === "set_device_appearance") {
            const mode = args.mode === "light" ? "light" : "dark";
            return `${device.name} is now in ${await api.deviceAppearance(device.platform, device.id, device.serial, mode)} mode.`;
          }
          const shot = await api.deviceScreenshot(device.platform, device.id, device.serial);
          return { content: [{ type: "image", data: shot.data, mimeType: shot.mimeType }, { type: "text", text: `Screenshot of ${device.name} (${device.runtime}).` }] };
        }
        if (command === "notify") {
          const title = text(args.title, 120);
          if (!title) throw new Error("title is required.");
          pushToast(title, text(args.body, 500) || undefined, args.tone === "success" || args.tone === "warning" ? args.tone : "info");
          return "Notification shown.";
        }
        throw new Error("Unknown command: " + command);
      };
      try { await api.appCommandResult(requestId, await run()); }
      catch (error) { await api.appCommandResult(requestId, null, error instanceof Error ? error.message : String(error)); }
    });
    return remove;
  }); // Re-subscribes every render so the handler sees the latest state; the preload removes the previous listener.

  // ----- Command Center -----

  const commands = useMemo<PaletteItem[]>(() => [
    { id: "new-terminal", kind: "command", title: "New Terminal", action: () => { setCommandOpen(false); addTerminal(null); } },
    { id: "new-claude", kind: "command", title: "New Claude chat", action: () => { setCommandOpen(false); addAgent(); } },
    { id: "search-text", kind: "command", title: "Search in files (⌘⇧F)", action: () => { setCommandOpen(false); ensureTile("files"); setFilesMode("search"); setTimeout(() => textSearchInputRef.current?.focus(), 50); } },
    ...aiTools.filter(tool => tool.available).map(tool => ({ id: `agent-${tool.id}`, kind: "command" as const, title: `New ${tool.name} terminal session`, action: () => { setCommandOpen(false); addTerminal(tool.id); } })),
    ...toggleTiles.map(type => ({ id: `toggle-${type}`, kind: "command" as const, title: `${hasTile(layout, type) ? "Close" : "Open"} ${tileLabels[type]}`, action: () => { setCommandOpen(false); toggleTile(type); } })),
    ...presetLabels.map(([name, label]) => ({ id: `preset-${name}`, kind: "command" as const, title: `Layout: ${label}`, action: () => { setCommandOpen(false); applyPreset(name); } })),
    { id: "close-all", kind: "command", title: "Close All Tiles", action: () => { setCommandOpen(false); setLayout(null); setTerminalStatus({}); } },
    { id: "open-folder", kind: "command", title: "Open Folder…", action: () => { setCommandOpen(false); props.onOpenDialog("folder"); } },
    { id: "clone", kind: "command", title: "Clone Repository…", action: () => { setCommandOpen(false); props.onOpenDialog("clone"); } },
    { id: "settings", kind: "command", title: "Settings", action: () => { setCommandOpen(false); props.onOpenDialog("settings"); } },
    { id: "flow", kind: "command", title: flowMode ? "Disable Flow Mode" : "Enable Flow Mode", action: () => { props.onToggleFlow(); setCommandOpen(false); } },
    { id: "home", kind: "command", title: "All Workspaces", action: () => { setCommandOpen(false); props.onHome(); } },
  ], [aiTools, layout, flowMode, focusedTileId]); // eslint-disable-line react-hooks/exhaustive-deps

  const paletteItems = useMemo<PaletteItem[]>(() => {
    const needle = query.trim().toLowerCase();
    const fileItems: PaletteItem[] = needle ? fileMatches.map(match => ({ id: `file-${match.path}`, kind: "file", title: match.name, detail: match.path, action: () => { setCommandOpen(false); openFilePath(match.path); } })) : [];
    return [...fileItems, ...commands.filter(item => item.title.toLowerCase().includes(needle))];
  }, [query, fileMatches, commands]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { setPaletteIndex(0); }, [query, paletteItems.length]);
  useEffect(() => {
    paletteListRef.current?.querySelector<HTMLElement>(`[data-index="${paletteIndex}"]`)?.scrollIntoView({ block: "nearest" });
  }, [paletteIndex]);

  function onPaletteKeyDown(event: import("react").KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown") { event.preventDefault(); setPaletteIndex(index => paletteItems.length ? (index + 1) % paletteItems.length : 0); }
    else if (event.key === "ArrowUp") { event.preventDefault(); setPaletteIndex(index => paletteItems.length ? (index - 1 + paletteItems.length) % paletteItems.length : 0); }
    else if (event.key === "Enter") { event.preventDefault(); paletteItems[paletteIndex]?.action(); }
  }

  const stagedChanges = git?.changes.filter(change => change.index !== " " && change.index !== "?") ?? [];
  const unstagedChanges = git?.changes.filter(change => change.worktree !== " ") ?? [];
  const allTiles = tiles(layout);
  const terminalTiles = allTiles.filter(item => item.type === "terminal");
  const focusedTile = allTiles.find(item => item.id === focusedTileId) ?? null;
  const focusedTerminal = focusedTile?.type === "terminal" ? focusedTile : terminalTiles.find(item => item.type === "terminal") ?? null;
  const focusedTerminalStatus: TerminalStatus | null = focusedTerminal ? terminalStatus[focusedTerminal.id] ?? "starting" : null;

  // ----- Tile bodies -----

  function renderFiles() {
    const grouped = new Map<string, TextSearchResult["matches"]>();
    for (const match of textResults?.matches ?? []) grouped.set(match.path, [...(grouped.get(match.path) ?? []), match]);
    const needle = textQuery.trim().toLowerCase();
    const highlight = (text: string) => { const index = text.toLowerCase().indexOf(needle); return index < 0 ? text : <>{text.slice(0, index)}<mark>{text.slice(index, index + needle.length)}</mark>{text.slice(index + needle.length)}</>; };
    return <div className="file-sidebar tile-files">
      <div className="files-modes" role="tablist">
        <button role="tab" aria-selected={filesMode === "tree"} className={filesMode === "tree" ? "active" : ""} onClick={() => setFilesMode("tree")}><Glyph name="folder" size={13}/>Explorer</button>
        <button role="tab" aria-selected={filesMode === "search"} className={filesMode === "search" ? "active" : ""} onClick={() => { setFilesMode("search"); setTimeout(() => textSearchInputRef.current?.focus(), 30); }}><Glyph name="search" size={13}/>Search<kbd>⌘⇧F</kbd></button>
      </div>
      {filesMode === "search" ? <div className="text-search">
        <div className="text-search-field"><Glyph name="search" size={13}/><input ref={textSearchInputRef} aria-label="Search in files" placeholder="Search in files…" value={textQuery} onChange={event => setTextQuery(event.target.value)} onKeyDown={event => { if (event.key === "Escape") { setTextQuery(""); } }}/>{textQuery && <button aria-label="Clear search" onClick={() => setTextQuery("")}>×</button>}</div>
        {!desktop && <div className="empty-files"><span>Open the desktop app to search local files.</span></div>}
        {desktop && textQuery.trim().length < 2 && <div className="empty-files compact"><span>Type at least two characters.</span></div>}
        {desktop && textResults && !textSearching && textResults.matches.length === 0 && textQuery.trim().length >= 2 && <div className="empty-files compact"><span>No results in {textResults.filesSearched} file{textResults.filesSearched === 1 ? "" : "s"}.</span></div>}
        {textResults && textResults.matches.length > 0 && <div className="text-search-summary">{textResults.matches.length}{textResults.truncated ? "+" : ""} result{textResults.matches.length === 1 ? "" : "s"} in {grouped.size} file{grouped.size === 1 ? "" : "s"}{textSearching ? " · searching…" : ""}</div>}
        <div className="text-search-results">
          {[...grouped.entries()].map(([path, matches]) => <div key={path} className="text-search-file">
            <button className="text-search-path" title={path} onClick={() => openFilePath(path, matches[0].line)}><span className="file-glyph">◈</span><span>{path.split("/").pop()}</span><small>{path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : ""}</small><i>{matches.length}</i></button>
            {matches.slice(0, 30).map(match => <button key={match.line + ":" + match.column} className="text-search-match" title={`${path}:${match.line}:${match.column}`} onClick={() => openFilePath(path, match.line)}><span className="text-search-line">{match.line}</span><span className="text-search-text">{highlight(match.text)}</span></button>)}
            {matches.length > 30 && <div className="text-search-more">{matches.length - 30} more in this file</div>}
          </div>)}
        </div>
      </div> : <>
        <div className="folder-label" title={active?.path} onClick={() => setCurrentDirectory("")}>⌄ &nbsp;{active?.name.toUpperCase()}<button className="folder-home" title="Project root" aria-label="Go to project root" onClick={event => { event.stopPropagation(); setCurrentDirectory(""); }}>⌂</button></div>
        {currentDirectory && <button className="file-entry folder-entry" onClick={() => setCurrentDirectory(parentDirectory(currentDirectory))}>↩ &nbsp; ..</button>}
        {files.map(file => <button key={file.path} className={"file-entry " + (file.directory ? "folder-entry" : "") + (activeFile?.path === file.path ? " active" : "") + (openFiles.some(item => item.path === file.path) ? " open" : "")} title={file.path} onClick={() => openFile(file)}>{file.directory ? "▸" : "·"} &nbsp;{file.name}{openFiles.some(item => item.path === file.path && item.contents !== item.saved) && <i className="unsaved-dot"/>}</button>)}
        {!desktop && <div className="empty-files"><span>Open the desktop app to browse local files.</span></div>}
        {desktop && files.length === 0 && <div className="empty-files compact"><span>Empty folder.</span></div>}
      </>}
    </div>;
  }

  function renderGit() {
    return <div className="file-sidebar git-sidebar tile-git">
      {!desktop ? <div className="empty-files"><span>Open the desktop app to use Git.</span></div>
        : !git ? <div className="empty-files"><span>{gitError || "Reading repository…"}</span></div>
        : !git.isRepo ? <div className="empty-files"><span>This folder is not a Git repository.</span><button className="git-primary" disabled={gitBusy} onClick={() => active && runGitAction(() => window.zevrinDesktop!.gitInit(active.path), "Repository initialized.")}>Initialize Repository</button></div>
        : <>
          <div className="branch-bar">
            <label className="branch-select-wrap" title="Switch branch"><span aria-hidden="true">⑂</span>
              <select className="branch-select" aria-label="Current branch" value={git.branch === "detached" || branchFormOpen ? "" : git.branch || ""} disabled={gitBusy || git.unborn} onChange={event => { const value = event.target.value; if (value === "__new__") { setBranchFormOpen(true); setNewBranchName(""); } else if (value) checkoutBranch(value); }}>
                {(git.branch === "detached" || branchFormOpen) && <option value="">{git.branch === "detached" ? "Detached HEAD" : "New branch…"}</option>}
                {branches.map(branch => <option key={branch.name} value={branch.name}>{branch.name}{branch.upstream ? "" : " (local)"}</option>)}
                {!branches.some(branch => branch.name === git.branch) && git.branch && git.branch !== "detached" && <option value={git.branch}>{git.branch}</option>}
                <option value="__new__">＋ New branch…</option>
              </select>
            </label>
            <div className="sync-actions">
              <button title="Fetch from remote" aria-label="Fetch" disabled={gitBusy || !!syncAction} onClick={() => runSync("fetch")}>{syncAction === "fetch" ? "…" : "⟳"}</button>
              <button title={git.upstream ? `Pull from ${git.upstream}` : "No upstream branch"} aria-label="Pull" disabled={gitBusy || !!syncAction || !git.upstream} onClick={() => runSync("pull")}>{syncAction === "pull" ? "…" : `↓${git.behind || ""}`}</button>
              <button title={git.upstream ? `Push to ${git.upstream}` : "Publish branch"} aria-label="Push" disabled={gitBusy || !!syncAction || git.unborn} onClick={() => runSync("push")}>{syncAction === "push" ? "…" : `↑${git.ahead || ""}`}</button>
              <button title="Refresh" aria-label="Refresh Git status" disabled={gitBusy} onClick={() => refreshGit()}>↻</button>
              <button className="sync-claude" title="Review these changes with Claude" aria-label="Review with Claude" disabled={git.changes.length === 0} onClick={sendGitToClaude}><Glyph name="chat" size={13}/></button>
            </div>
          </div>
          {branchFormOpen && <form className="worktree-form" onSubmit={event => { event.preventDefault(); checkoutBranch(newBranchName.trim(), true); }}><input aria-label="New branch name" placeholder="feature/my-change" value={newBranchName} onChange={event => setNewBranchName(event.target.value)} autoFocus/><button type="submit" disabled={gitBusy || !newBranchName.trim()}>Create</button><button type="button" aria-label="Cancel branch creation" onClick={() => setBranchFormOpen(false)}>×</button></form>}
          <div className="commit-box">
            <textarea aria-label="Commit message" placeholder={`Message (⌘↵ to commit on "${git.branch}")`} value={commitMessage} onChange={event => setCommitMessage(event.target.value)} onKeyDown={event => { if ((event.metaKey || event.ctrlKey) && event.key === "Enter") { event.preventDefault(); commit(); } }}/>
            <button className="git-primary" disabled={gitBusy || !commitMessage.trim() || stagedChanges.length === 0} onClick={commit}>{gitBusy ? "Working…" : `Commit${stagedChanges.length ? ` (${stagedChanges.length})` : ""}`}</button>
            {git.upstream ? <div className="sync-note">{git.ahead > 0 && `↑${git.ahead} `}{git.behind > 0 && `↓${git.behind} `}{git.ahead === 0 && git.behind === 0 && "In sync with "}{git.ahead + git.behind > 0 && "vs "}{git.upstream}</div> : !git.unborn && <div className="sync-note">No upstream · push to publish this branch</div>}
          </div>
          {gitError && <div className="git-error" role="alert">{gitError}</div>}
          {gitNotice && !gitError && <div className="git-notice" role="status">{gitNotice}</div>}
          <div className="change-list">
            {stagedChanges.length > 0 && <>
              <div className="change-group">Staged Changes <span>{stagedChanges.length}</span><button title="Unstage all" aria-label="Unstage all" onClick={() => toggleStage(stagedChanges.map(change => change.path), true)}>−</button></div>
              {stagedChanges.map(change => <ChangeRow key={`s-${change.path}`} change={change} staged selected={diff?.path === change.path && diff.staged} onOpen={() => openDiff(change, true)} onToggle={() => toggleStage([change.path], true)}/>)}
            </>}
            <div className="change-group">Changes <span>{unstagedChanges.length}</span>{unstagedChanges.length > 0 && <><button title="Discard all changes" aria-label="Discard all changes" onClick={() => discardChanges(unstagedChanges.map(change => change.path))}>↺</button><button title="Stage all" aria-label="Stage all" onClick={() => toggleStage(unstagedChanges.map(change => change.path), false)}>+</button></>}</div>
            {unstagedChanges.map(change => <ChangeRow key={`u-${change.path}`} change={change} staged={false} selected={diff?.path === change.path && !diff.staged} onOpen={() => openDiff(change, false)} onToggle={() => toggleStage([change.path], false)} onDiscard={() => discardChanges([change.path])}/>)}
            {git.changes.length === 0 && <div className="empty-files compact"><span>No changes. Working tree clean.</span></div>}
            <section className="worktree-section" aria-label="Git worktrees">
              <div className="worktree-heading"><span>WORKTREES <i>{worktrees.length}</i></span><button title="Create worktree" aria-label="Create worktree" onClick={() => setWorktreeFormOpen(value => !value)}>＋</button></div>
              {worktreeFormOpen && <form className="worktree-form" onSubmit={event => { event.preventDefault(); createWorktree(); }}><input aria-label="New worktree branch" placeholder="feature/my-change" value={worktreeBranch} onChange={event => setWorktreeBranch(event.target.value)} autoFocus/><button type="submit" disabled={worktreeBusy || !worktreeBranch.trim()}>{worktreeBusy ? "…" : "Create"}</button><button type="button" aria-label="Cancel worktree creation" onClick={() => setWorktreeFormOpen(false)}>×</button></form>}
              <div className="worktree-list">{worktrees.map(worktree => <div key={worktree.path} className={worktree.current ? "worktree-row current" : "worktree-row"}>
                <button className="worktree-open" disabled={worktree.current || worktree.prunable} onClick={() => openWorktree(worktree)}><span>{worktree.branch || (worktree.detached ? "Detached HEAD" : "Bare repository")}</span><small>{worktree.current ? "Current workspace" : worktree.path.split("/").slice(-2).join("/")}{worktree.locked ? " · Locked" : worktree.prunable ? " · Prunable" : ""}</small></button>
                {!worktree.current && !worktree.bare && <button className="worktree-remove" title="Remove worktree" aria-label={`Remove worktree ${worktree.branch || worktree.path}`} disabled={gitBusy} onClick={() => removeWorktree(worktree)}>×</button>}
              </div>)}</div>
            </section>
            <section className="history-section" aria-label="Commit history">
              <button className="worktree-heading history-toggle" aria-expanded={historyOpen} onClick={() => setHistoryOpen(value => !value)}><span>HISTORY <i>{commits.length}</i></span><span aria-hidden="true">{historyOpen ? "⌄" : "›"}</span></button>
              {historyOpen && <div className="history-list">{commits.length === 0 ? <div className="empty-files compact"><span>No commits yet.</span></div> : commits.map(commit => <div key={commit.hash} className="history-row" title={`${commit.hash}\n${commit.author}`}><code>{commit.short}</code><span>{commit.subject}</span><small>{commit.date}</small></div>)}</div>}
            </section>
          </div>
        </>}
    </div>;
  }

  function renderEditor() {
    const tabs = openFiles.length > 0 && <div className="editor-tabs" role="tablist">
      {openFiles.map(file => <div key={file.path} role="tab" aria-selected={!diff && file.path === activePath} className={"editor-file-tab" + (!diff && file.path === activePath ? " active" : "") + (file.contents !== file.saved ? " unsaved" : "")} title={file.path} onClick={() => { setActivePath(file.path); setDiff(null); }} onAuxClick={event => { if (event.button === 1) closeOpenFile(file.path); }}>
        <span className="file-glyph">◈</span><span>{file.path.split("/").pop()}</span>{file.contents !== file.saved && <i className="unsaved-dot" title="Unsaved changes"/>}
        <button aria-label={`Close ${file.path}`} title="Close" onClick={event => { event.stopPropagation(); closeOpenFile(file.path); }}>×</button>
      </div>)}
      {diff && <div role="tab" aria-selected className="editor-file-tab active diff-tab" title={diff.path}><span className="file-glyph">±</span><span>{diff.path.split("/").pop()}</span><button aria-label="Close diff" title="Close" onClick={() => setDiff(null)}>×</button></div>}
    </div>;
    return <div className="editor-canvas tile-editor">{tabs}{diff ? <><div className="editor-tab"><span className="file-glyph">±</span><span className="editor-tab-title" title={diff.path}>{diff.path}</span><span className="diff-kind">{diff.branch ? (diff.uncommitted ? `${diff.branch} · uncommitted` : diff.branch) : diff.staged ? "Staged" : "Working Tree"}</span>{diff.branch && review && <button onClick={() => setReviewOpen(true)} title="Back to the list of changes">Changes</button>}<button className="ask-claude-button" onClick={() => composeForClaude({ text: `Explain the ${diff.staged ? "staged" : "working tree"} diff of \`${diff.path}\` (run git diff${diff.staged ? " --cached" : ""} -- ${diff.path}):\n` })} title="Ask Claude about this diff"><Glyph name="chat" size={12}/>Ask Claude</button><button onClick={() => setDiff(null)}>Close</button></div>{typeof diff.original === "string" && typeof diff.modified === "string" && (diff.original || diff.modified) ? <CodeDiff path={diff.path} original={diff.original} modified={diff.modified} fontSize={settings.editorFontSize}/> : <DiffView diff={diff}/>}</> : activeFile ? <><div className="editor-tab"><span className="file-glyph">◈</span><span className="editor-tab-title" title={activeFile.path}>{activeFile.path}{activeFile.contents !== activeFile.saved && <i className="unsaved-dot" title="Unsaved changes"/>}</span>{desktop && <button className="ask-claude-button inline-edit-trigger" onClick={() => editorApiRef.current?.inlineEdit()} title="Edit the selection with Claude, in place (⌘K)">✦ Edit <kbd>⌘K</kbd></button>}<button className="ask-claude-button" onClick={sendEditorToClaude} title="Send the selection (or this file) to Claude"><Glyph name="chat" size={12}/>Ask Claude</button><button disabled={activeFile.contents === activeFile.saved} onClick={saveFile}>Save</button></div><CodeEditor path={activeFile.path} value={activeFile.contents} fontSize={settings.editorFontSize} revealLine={pendingLine} onRevealed={() => setPendingLine(null)} onChange={next => setActiveFile(file => file ? { ...file, contents: next } : file)} onSave={saveFile} apiRef={editorApiRef} onInlineEdit={desktop && window.zevrinDesktop?.inlineEdit ? request => window.zevrinDesktop!.inlineEdit("editor", active.path, request) : undefined} onInlineEditCancel={() => { window.zevrinDesktop?.inlineEditCancel?.("editor").catch(() => {}); }}/></> : <div className="editor-welcome"><div className="editor-logo brand"><ZevrinMark size={28}/></div><h2>Welcome to Zevrin</h2><p>{desktop ? filesVisible ? "Select a file in the Files tile or press ⌘P to search" : "Open the Files tile from the sidebar or press ⌘P to search" : "Open this project in the desktop app to browse files"}</p>{desktop && !filesVisible && <button onClick={() => ensureTile("files")}>Show Files</button>}{!desktop && <button onClick={() => props.onOpenDialog("folder")}>Open Folder</button>}</div>}</div>;
  }

  function renderPreview() {
    return <div className="preview-view"><form className="browser-bar" onSubmit={event => { event.preventDefault(); navigatePreview(previewUrl); }}><button type="button" aria-label="Back" title="Back" disabled={previewHistoryIndex <= 0} onClick={() => movePreviewHistory(previewHistoryIndex - 1)}>‹</button><button type="button" aria-label="Forward" title="Forward" disabled={previewHistoryIndex < 0 || previewHistoryIndex >= previewHistory.length - 1} onClick={() => movePreviewHistory(previewHistoryIndex + 1)}>›</button><button type="button" aria-label="Reload" title="Reload" disabled={!previewLocation} onClick={reloadPreview}>↻</button><input className="url-field" aria-label="Preview URL" placeholder="http://localhost:3000" value={previewUrl} onChange={event => setPreviewUrl(event.target.value)} /><button type="submit" aria-label="Go">↵</button>
      <span className="browser-divider"/>
      {desktop && <button type="button" className={"browser-tool" + (picking ? " active" : "")} aria-pressed={picking} disabled={!previewLocation} title={picking ? "Picking: click an element in the page (Esc to cancel)" : "Pick an element and send it to the agent"} onClick={startPicking}><Glyph name="target" size={14}/></button>}
      {desktop && <button type="button" className={"browser-tool" + (recording ? " recording" : "")} aria-pressed={Boolean(recording)} disabled={!previewLocation || previewBusy === "record"} title={recording ? "Stop and send the recording to the agent" : "Record the page (up to 60 s) and send it to the agent"} onClick={toggleRecording}>{recording ? <><i className="rec-dot"/>{Math.floor(recordElapsed / 1000)}s</> : previewBusy === "record" ? "…" : <Glyph name="record" size={14}/>}</button>}
      <select className="browser-target" aria-label="Send to" title="Where browser context goes" value={agentTargets().some(item => item.id === sendTarget) || sendTarget === "new" ? sendTarget : "auto"} onChange={event => setSendTarget(event.target.value)}>
        <option value="auto">→ First chat</option>
        {agentTargets().map(item => <option key={item.id} value={item.id}>→ {tileTitle(item)}</option>)}
        <option value="new">→ New Claude chat</option>
      </select>
      <div className={"browser-send" + (previewMenuOpen ? " open" : "")}>
        <button type="button" className={"browser-send-button" + (previewBusy ? " busy" : "")} disabled={!previewLocation} aria-haspopup="menu" aria-expanded={previewMenuOpen} title="Send this page to Claude" onClick={() => setPreviewMenuOpen(open => !open)}><Glyph name="chat" size={14}/><span>{previewBusy ? "Sending…" : "Ask Claude"}</span><i>▾</i></button>
        {previewMenuOpen && <div className="browser-menu" role="menu" onMouseLeave={() => setPreviewMenuOpen(false)}>
          <button role="menuitem" onClick={() => sendPreviewToClaude("full")} disabled={!desktop}><Glyph name="chat" size={14}/><span>Full context<small>Page, screenshot, console errors, failed requests</small></span></button>
          <button role="menuitem" onClick={startPicking} disabled={!desktop}><Glyph name="target" size={14}/><span>Pick an element<small>HTML, styles, component and source, cropped image</small></span></button>
          <button role="menuitem" onClick={toggleRecording} disabled={!desktop}><Glyph name="record" size={14}/><span>{recording ? "Stop recording" : "Record the page"}<small>Video + key frames + console and network during it</small></span></button>
          <div className="menu-separator"/>
          <button role="menuitem" onClick={() => sendPreviewToClaude("page")}><Glyph name="globe" size={14}/><span>Page content<small>Title, headings and visible text</small></span></button>
          <button role="menuitem" onClick={() => sendPreviewToClaude("selection")}><Glyph name="file" size={14}/><span>Selected text<small>What you highlighted in the page</small></span></button>
          <button role="menuitem" onClick={() => sendPreviewToClaude("screenshot")} disabled={!desktop}><Glyph name="canvas" size={14}/><span>Screenshot<small>Attach an image of the page</small></span></button>
          <button role="menuitem" onClick={() => sendPreviewToClaude("console")} disabled={!desktop}><Glyph name="terminal" size={14}/><span><span>Console{previewIssues > 0 && <b className="browser-menu-badge">{previewIssues}</b>}</span><small>Errors, warnings and logs</small></span></button>
          <button role="menuitem" onClick={() => sendPreviewToClaude("network")} disabled={!desktop}><Glyph name="globe" size={14}/><span>Network<small>Requests, statuses, failures</small></span></button>
          <button role="menuitem" onClick={() => sendPreviewToClaude("url")}><Glyph name="search" size={14}/><span>Just the URL<small>Claude reads it with its browser tools</small></span></button>
        </div>}
      </div>
      {desktop && <button type="button" className={"browser-console" + (previewIssues > 0 ? " has-issues" : "")} aria-label="Console" title={previewIssues > 0 ? `${previewIssues} console issue${previewIssues === 1 ? "" : "s"} · open DevTools` : "Open DevTools"} disabled={!previewLocation} onClick={() => { try { window.zevrinDesktop?.previewDevtools(previewContentsId()); } catch (error) { pushToast("Preview", errorMessage(error, "DevTools are not available."), "warning"); } }}><Glyph name="code" size={14}/>{previewIssues > 0 && <b>{previewIssues > 99 ? "99+" : previewIssues}</b>}</button>}
      <button type="button" aria-label="Open in browser" title="Open in your browser" disabled={!previewLocation} onClick={() => { if (window.zevrinDesktop) window.zevrinDesktop.openExternal(previewLocation); else window.open(previewLocation, "_blank"); }}>↗</button>
      </form>{previewLocation ? <PreviewFrame url={previewLocation} desktop={desktop} reloadKey={previewReloadKey} onNavigate={onPreviewNavigated} onConsole={onPreviewConsole} frameRef={previewFrameRef}/> : <div className="preview-empty"><div className="preview-orbit"><Glyph name="globe" size={28}/></div><h2>Preview your work</h2><p>Enter a local URL or open a project with a running dev server. Claude can read the page, its console and take screenshots from here.</p><button type="button" className="url-hint" onClick={() => navigatePreview("http://localhost:3000")}>http://localhost:3000</button></div>}</div>;
  }

  function renderCanvas() {
    const tools: Array<[CanvasTool, string, string]> = [["select", "↖", "Select and move"], ["pan", "✋", "Pan canvas"], ["note", "▤", "Add sticky note"], ["rectangle", "□", "Add card"], ["diamond", "◇", "Add diamond"], ["connector", "／", "Connect two items: select a start, then a destination"], ["text", "T", "Add text"]];
    return <div className="canvas-view"><div className="canvas-toolbar" role="toolbar" aria-label="Canvas tools">
      {tools.map(([tool, glyph, label]) => <button key={tool} className={canvasTool === tool ? "canvas-tool active" : "canvas-tool"} title={label} aria-label={label} aria-pressed={canvasTool === tool} onClick={() => { setConnectionStartId(null); setCanvasTool(tool); }}>{glyph}</button>)}
      {canvasTool === "connector" && <span className="canvas-mode-hint" role="status">{connectionStartId ? "Pick destination…" : "Pick start…"}</span>}
      {selectedCanvasId && <button className="canvas-tool canvas-delete" title="Delete selected item" aria-label="Delete selected item" onClick={() => removeCanvasItem(selectedCanvasId)}>⌫</button>}
      <span className="canvas-toolbar-spacer"/>
      <button className="canvas-tool" title="Zoom out" aria-label="Zoom out" onClick={() => zoomCanvas(-0.1)}>−</button><button className="canvas-zoom-label" title="Reset zoom" onClick={() => { setCanvasZoom(1); setCanvasPan({ x: 0, y: 0 }); }}>{Math.round(canvasZoom * 100)}%</button><button className="canvas-tool" title="Zoom in" aria-label="Zoom in" onClick={() => zoomCanvas(0.1)}>＋</button>
    </div><div className={"canvas-grid" + (canvasTool === "pan" ? " panning" : "")} onPointerDown={canvasTool === "pan" ? beginCanvasPan : addCanvasItem} onPointerMove={moveCanvasItem} onPointerUp={stopCanvasDrag} onPointerCancel={stopCanvasDrag} onWheel={event => { if (event.ctrlKey || event.metaKey) { event.preventDefault(); zoomCanvas(event.deltaY < 0 ? 0.1 : -0.1); } }}>
      <div className="canvas-stage" style={{ transform: "translate(" + canvasPan.x + "px, " + canvasPan.y + "px) scale(" + canvasZoom + ")" }}>{renderCanvasConnections()}{canvasItems.filter(item => item.type !== "connector" || (!item.from && !item.to)).map(item => <div key={item.id} className={"canvas-item canvas-" + item.type + (selectedCanvasId === item.id ? " selected" : "") + (connectionStartId === item.id ? " connecting" : "")} style={{ left: item.x, top: item.y }} onPointerDown={event => startCanvasDrag(event, item)} onDoubleClick={() => item.type !== "connector" && setEditingCanvasId(item.id)} title={item.type === "connector" ? "Connector" : "Double-click to edit"}>
        {item.type === "connector" ? <span className="canvas-connector-line"/> : editingCanvasId === item.id ? <textarea autoFocus aria-label="Canvas item text" value={item.text} onChange={event => updateCanvasText(item.id, event.target.value)} onBlur={() => setEditingCanvasId(null)} onKeyDown={event => { if (event.key === "Escape") event.currentTarget.blur(); }}/> : <span>{item.text}</span>}
      </div>)}</div>
      {canvasItems.length === 0 && <div className="canvas-empty"><span>✳</span><strong>{canvasTool === "select" ? "Make space for ideas" : canvasTool === "connector" ? "Connect two items" : "Click anywhere to add"}</strong><small>{canvasTool === "select" ? "Choose a tool, then click the canvas." : canvasTool === "connector" ? connectionStartId ? "Choose the destination item." : "Choose the first item." : canvasTool === "pan" ? "Drag the board to move around." : "Adding " + canvasTool + ". Press Escape to select."}</small></div>}
    </div></div>;
  }

  function renderTerminal(node: TileNode) {
    const status = terminalStatus[node.id] ?? "starting";
    return <div className="terminal-view">
      <div className="terminal-session-stack">{!desktop ? <div className="terminal-empty"><span>Open the desktop app to start a shell session.</span></div> : <TerminalPane workspacePath={node.cwd ?? active.path} session={{ id: node.id, name: tileTitle(node), assistant: node.assistant ?? null, status }} fontSize={settings.terminalFontSize} onStatus={updateTerminalStatus} onTerminalId={rememberTerminalId}/>}</div>
      <div className="terminal-status"><span><i className={"session-state " + status}/>{status === "exited" ? "Session ended" : status === "error" ? "Failed to start" : status === "starting" && desktop ? "Starting…" : "zsh"}</span><span className="terminal-path" title={active?.path}>{active?.path}</span><span>⌘ K to clear</span></div>
    </div>;
  }

  function renderTileBody(node: TileNode) {
    if (node.type === "terminal") return renderTerminal(node);
    if (node.type === "vscode") { const agent = node.assistant === "codex" || node.assistant === "gemini" ? node.assistant : "claude"; return <AgentExtension workspacePath={node.cwd ?? active.path} desktop={desktop} visible={visible} agent={agent} instance={node.id} onOpenCli={() => addTerminal(agent)}/>; }
    if (node.type === "agent" && node.assistant === "codex") return <CodexChat tileId={node.id} workspacePath={node.cwd ?? active.path} desktop={desktop} visible={visible} session={node.session} onSession={threadId => rememberAgentSession(node.id, threadId)} onStatus={status => rememberAgentStatus(node.id, status)} onOpenFile={file => { const root = node.cwd ?? active.path; openFilePath(file.startsWith(root + "/") ? file.slice(root.length + 1) : file); }}/>;
    if (node.type === "agent") return <AgentChat tileId={node.id} workspacePath={node.cwd ?? active.path} desktop={desktop} visible={visible} session={node.session} onSession={sessionId => rememberAgentSession(node.id, sessionId)} onStatus={status => rememberAgentStatus(node.id, status)} onWaiting={waiting => rememberAgentWaiting(node.id, waiting)} onOpenFile={file => { const root = node.cwd ?? active.path; openFilePath(file.startsWith(root + "/") ? file.slice(root.length + 1) : file); }}/>;
    if (node.type === "editor") return renderEditor();
    if (node.type === "files") return renderFiles();
    if (node.type === "git") return renderGit();
    if (node.type === "preview") return renderPreview();
    if (node.type === "devices") return <DevicesTile desktop={desktop} visible={visible} defaultUrl={previewLocation} onAskClaude={composeForClaude} onToast={pushToast} apiRef={devicesApiRef}/>;
    return renderCanvas();
  }

  function renderDivider(direction: SplitDirection, onRatio: (position: number) => void) {
    return <div className={"pane-divider " + direction} role="separator" aria-orientation={direction === "columns" ? "vertical" : "horizontal"} aria-label="Resize tiles" onPointerDown={event => event.currentTarget.setPointerCapture(event.pointerId)} onPointerMove={event => { if (!event.currentTarget.hasPointerCapture(event.pointerId)) return; const bounds = event.currentTarget.parentElement!.getBoundingClientRect(); onRatio(direction === "columns" ? (event.clientX - bounds.left) / bounds.width : (event.clientY - bounds.top) / bounds.height); }} onPointerUp={event => event.currentTarget.releasePointerCapture(event.pointerId)} />;
  }

  function renderNode(node: LayoutNode): import("react").ReactNode {
    if (node.kind === "split") {
      const tracks = node.direction === "columns" ? { gridTemplateColumns: `minmax(0, ${node.ratio}fr) 5px minmax(0, ${1 - node.ratio}fr)` } : { gridTemplateRows: `minmax(0, ${node.ratio}fr) 5px minmax(0, ${1 - node.ratio}fr)` };
      return <div className={"tile-split split-" + node.direction} key={node.id} style={tracks}><div className="tile-slot">{renderNode(node.children[0])}</div>{renderDivider(node.direction, position => setLayout(current => current ? updateRatio(current, node.id, position) : current))}<div className="tile-slot">{renderNode(node.children[1])}</div></div>;
    }
    const isDropTarget = dropTarget?.id === node.id;
    const status = node.type === "terminal" ? terminalStatus[node.id] ?? "starting" : node.type === "agent" ? (agentStatus[node.id] === "running" ? "ready" : agentStatus[node.id] === "error" ? "error" : agentStatus[node.id] === "auth" ? "starting" : "idle") : null;
    return <section key={node.id} className={"tile tile-" + node.type + (node.assistant ? " tile-agent" : "") + (focusedTileId === node.id ? " focused" : "") + (dragSource?.kind === "move" && dragSource.id === node.id ? " dragging" : "") + (closingIds.includes(node.id) ? " closing" : "")} data-tile={node.id} onPointerDownCapture={() => setFocusedTileId(node.id)} onDragOver={event => dragOverTile(event, node.id)} onDragLeave={dragLeaveTile} onDrop={event => dropOnTile(event, node.id)}>
      <header className="tile-head" draggable onDragStart={event => beginDrag(event, { kind: "move", id: node.id })} onDragEnd={endDrag} title="Drag to move this tile">
        <span className="tile-grip" aria-hidden="true"><Glyph name="grip" size={14}/></span>
        <span className="tile-icon"><Glyph name={node.assistant ? "chat" : tileGlyphs[node.type]} size={14}/></span>
        <span className="tile-title">{tileTitle(node)}</span>
        {status && <i className={"session-state " + status} title={status}/>}
        {node.type === "git" && git && git.changes.length > 0 && <span className="tile-badge">{git.changes.length}</span>}
        <span className="tile-spacer"/>
        <button title="Split right" aria-label={`Split ${tileTitle(node)} to the right`} onClick={() => splitTile(node.id, "columns")}>↔</button>
        <button title="Split down" aria-label={`Split ${tileTitle(node)} downwards`} onClick={() => splitTile(node.id, "rows")}>↕</button>
        <button className="tile-close" title="Close tile" aria-label={`Close ${tileTitle(node)}`} onClick={() => closeTile(node.id)}>×</button>
      </header>
      <div className="tile-body">{renderTileBody(node)}</div>
      {isDropTarget && dropTarget && <div className={"drop-hint drop-" + dropTarget.side} aria-hidden="true"/>}
    </section>;
  }

  function tileStatus(node: TileNode) {
    return node.type === "terminal" ? terminalStatus[node.id] ?? "starting" : node.type === "agent" ? (agentStatus[node.id] === "running" ? "ready" : agentStatus[node.id] === "error" ? "error" : agentStatus[node.id] === "auth" ? "starting" : "idle") : null;
  }

  function renderZoneResizer(zone: "left" | "right" | "bottom") {
    const vertical = zone !== "bottom";
    return <div className={"dock-resizer " + (vertical ? "vertical" : "horizontal")} role="separator" aria-orientation={vertical ? "vertical" : "horizontal"} aria-label={`Resize the ${zone} area`}
      onPointerDown={event => event.currentTarget.setPointerCapture(event.pointerId)}
      onPointerMove={event => {
        if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
        const box = (event.currentTarget.closest(".dock") as HTMLElement).getBoundingClientRect();
        setZoneSizes(current => zone === "left" ? { ...current, left: Math.max(180, Math.min(520, event.clientX - box.left)) }
          : zone === "right" ? { ...current, right: Math.max(300, Math.min(box.width * 0.6, box.right - event.clientX)) }
          : { ...current, bottom: Math.max(120, Math.min(box.height * 0.7, box.bottom - event.clientY)) });
      }}
      onPointerUp={event => event.currentTarget.releasePointerCapture(event.pointerId)}
      onDoubleClick={() => setZoneSizes(current => zone === "left" ? { ...current, left: 260 } : zone === "right" ? { ...current, right: 440 } : { ...current, bottom: 240 })}/>;
  }

  function renderZone(zone: Zone, items: TileNode[]) {
    const activeId = items.some(item => item.id === zoneActive[zone]) ? zoneActive[zone]! : items[items.length - 1]?.id;
    const acceptDrop = (event: import("react").DragEvent) => { if (dragSource) { event.preventDefault(); event.dataTransfer.dropEffect = "move"; } };
    const drop = (event: import("react").DragEvent) => {
      event.preventDefault();
      const source = dragSource; endDrag();
      if (!source) return;
      if (source.kind === "move") moveToZone(source.id, zone);
      else {
        const existing = source.type !== "terminal" && source.type !== "agent" ? findTile(layout, item => item.type === source.type && (source.type === "vscode" ? (item.assistant ?? "claude") === (source.assistant ?? "claude") : !item.assistant)) : null;
        const node = existing ?? (source.type === "terminal" ? tile("terminal", { assistant: source.assistant, name: nextTerminalName(layout, source.assistant ?? null) }) : source.type === "agent" ? tile("agent", { assistant: source.assistant === "codex" ? "codex" : "claude", name: nextTerminalName(layout, source.assistant === "codex" ? "codex" : "claude", "agent") }) : source.type === "vscode" && source.assistant && source.assistant !== "claude" ? tile("vscode", { assistant: source.assistant }) : tile(source.type));
        if (!existing) addTile(node);
        moveToZone(node.id, zone);
      }
    };
    return <section className={"dock-zone dock-" + zone + (dragSource ? " accepting" : "")} aria-label={`${zone} area`} onDragOver={acceptDrop} onDrop={drop} onPointerDownCapture={() => { if (activeId && focusedTileId !== activeId && !items.some(item => item.id === focusedTileId)) setFocusedTileId(activeId); }}>
      <div className="dock-tabs" role="tablist">
        {items.map(node => {
          const status = tileStatus(node);
          return <div key={node.id} role="tab" aria-selected={node.id === activeId} className={"dock-tab" + (node.id === activeId ? " active" : "") + (closingIds.includes(node.id) ? " closing" : "")} draggable onDragStart={event => beginDrag(event, { kind: "move", id: node.id })} onDragEnd={endDrag} onClick={() => { setZoneActive(current => ({ ...current, [zone]: node.id })); setFocusedTileId(node.id); }} onAuxClick={event => { if (event.button === 1) closeTile(node.id); }} onContextMenu={event => { event.preventDefault(); setTabMenu({ id: node.id, x: event.clientX, y: event.clientY }); }} title={node.cwd ? `${tileTitle(node)} — ${node.cwd}` : tileTitle(node)}>
            <Glyph name={node.type === "vscode" ? (node.assistant === "codex" ? "codex" : node.assistant === "gemini" ? "gemini" : "chat") : node.type === "agent" && node.assistant === "codex" ? "codex" : node.assistant && node.type === "terminal" ? "terminal" : tileGlyphs[node.type]} size={13}/>
            <span className="dock-tab-title">{tileTitle(node)}</span>
            {node.branch && node.type !== "vscode" && <span className="dock-tab-branch"><Glyph name="branch" size={11}/>{node.branch.split("/").pop()}</span>}
            {agentWaiting[node.id] ? <i className="tab-attention waiting" title="Waiting for your approval"/> : agentStatus[node.id] === "running" ? <i className="tab-attention running" title="Working"/> : agentUnseen[node.id] ? <i className="tab-attention unseen" title="Finished — not seen yet"/> : status && status !== "idle" && node.type === "terminal" && <i className={"session-state " + status} title={status}/>}
            {node.type === "git" && git && git.changes.length > 0 && <span className="tile-badge">{git.changes.length}</span>}
            <button className="dock-tab-close" aria-label={`Close ${tileTitle(node)}`} title="Close" onClick={event => { event.stopPropagation(); closeTile(node.id); }}>×</button>
          </div>;
        })}
        <span className="dock-tabs-spacer"/>
        {zone === "right" && <div className="dock-add-wrap">
          <button className="dock-add" title="New agent session" aria-label="New agent session" aria-expanded={agentMenuOpen} disabled={agentBusy} onClick={() => setAgentMenuOpen(open => !open)}>{agentBusy ? "…" : <Glyph name="plus" size={14}/>}</button>
          {agentMenuOpen && renderAgentMenu()}
        </div>}
        {zone === "bottom" && <button className="dock-add" title="New terminal" aria-label="New terminal" onClick={() => addTerminal(null)}><Glyph name="plus" size={14}/></button>}
      </div>
      <div className="dock-panes">
        {items.map(node => <div key={node.id} className={"dock-pane tile tile-" + node.type + (node.id === activeId ? " active" : "")} data-tile={node.id} aria-hidden={node.id !== activeId} onPointerDownCapture={() => setFocusedTileId(node.id)}>
          <div className="tile-body">{renderTileBody(node)}</div>
        </div>)}
      </div>
    </section>;
  }

  function renderAgentMenu() {
    return <div className="dock-menu" role="menu" onMouseLeave={() => setAgentMenuOpen(false)}>
      <button role="menuitem" onClick={() => newAgentSession("chat")}><Glyph name="claude" size={14}/><span>Claude Code<small>New session</small></span></button>
      <button role="menuitem" onClick={() => newAgentSession("codex-chat")}><Glyph name="codex" size={14}/><span>Codex<small>New thread</small></span></button>
      {aiTools.filter(tool => tool.available && tool.id !== "claude").map(tool => <button key={tool.id} role="menuitem" onClick={() => { setAgentMenuOpen(false); addTerminal(tool.id); }}><Glyph name="terminal" size={14}/><span>{tool.name}<small>Terminal agent</small></span></button>)}
      <div className="menu-separator"/>
      <div className="dock-menu-heading">VS Code extensions (experimental)</div>
      <button role="menuitem" onClick={() => newAgentSession("claude")}><Glyph name="chat" size={14}/><span>Claude Code extension<small>Hidden VS Code server</small></span></button>
      <button role="menuitem" onClick={() => newAgentSession("codex")}><Glyph name="codex" size={14}/><span>Codex extension<small>Hidden VS Code server</small></span></button>
      <button role="menuitem" onClick={() => newAgentSession("gemini")}><Glyph name="gemini" size={14}/><span>Gemini extension<small>Hidden VS Code server</small></span></button>
      <label className="dock-menu-option" title="Creates a Git worktree and branch for the new session, so agents working in parallel never edit the same files"><input type="checkbox" checked={isolateAgent} disabled={!git?.isRepo} onChange={event => setIsolateAgent(event.target.checked)}/><span>Run in its own worktree<small>{git?.isRepo ? "Separate branch and folder, no conflicts" : "Needs a Git repository"}</small></span></label>
    </div>;
  }

  function renderTabMenu() {
    if (!tabMenu) return null;
    const node = findTile(layout, item => item.id === tabMenu.id);
    if (!node) return null;
    const zone = zoneOf(node);
    const others = tiles(layout).filter(item => item.id !== node.id && zoneOf(item) === zone);
    const act = (work: () => void) => () => { setTabMenu(null); work(); };
    const zones: Array<[Zone, string]> = [["left", "Left"], ["center", "Centre"], ["right", "Right"], ["bottom", "Bottom"]];
    return <div className="scrim tab-menu-scrim" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) setTabMenu(null); }} onContextMenu={event => { event.preventDefault(); setTabMenu(null); }}>
      <div className="dock-menu tab-menu" role="menu" style={{ left: Math.min(tabMenu.x, window.innerWidth - 260), top: Math.min(tabMenu.y, window.innerHeight - 320) }}>
        {node.branch && <button role="menuitem" onClick={act(() => openReview(node))}><Glyph name="branch" size={14}/><span>Review changes<small>{node.branch}</small></span></button>}
        {node.cwd && <button role="menuitem" onClick={act(() => { const terminal = tile("terminal", { cwd: node.cwd, branch: node.branch, name: "Terminal · " + (node.branch ?? "worktree") }); addTile(terminal); })}><Glyph name="terminal" size={14}/><span>Terminal in this worktree<small>{node.cwd.split("/").slice(-2).join("/")}</small></span></button>}
        {node.cwd && <button role="menuitem" onClick={act(() => window.zevrinDesktop?.revealPath(node.cwd!, ""))}><Glyph name="folder" size={14}/><span>Show in Finder</span></button>}
        {(node.branch || node.cwd) && <div className="menu-separator"/>}
        {zones.filter(([id]) => id !== zone).map(([id, label]) => <button key={id} role="menuitem" onClick={act(() => moveToZone(node.id, id))}><span>Move to {label.toLowerCase()}</span></button>)}
        <div className="menu-separator"/>
        {others.length > 0 && <button role="menuitem" onClick={act(() => others.forEach(item => closeTile(item.id)))}><span>Close other tabs here</span></button>}
        <button role="menuitem" onClick={act(() => closeTile(node.id))}><span>Close</span></button>
      </div>
    </div>;
  }

  function renderReview() {
    if (!review || !reviewOpen) return null;
    const committed = review.changes?.filter(item => !item.uncommitted) ?? [];
    const pending = review.changes?.filter(item => item.uncommitted) ?? [];
    const row = (change: { status: string; path: string; uncommitted: boolean }) => <button key={(change.uncommitted ? "u:" : "c:") + change.path} className="review-row" onClick={() => openReviewFile(change)}>
      <span className={"change-status status-" + change.status}>{change.status}</span><span className="review-name">{change.path.split("/").pop()}</span><small>{change.path.includes("/") ? change.path.slice(0, change.path.lastIndexOf("/")) : ""}</small>
    </button>;
    return <div className="scrim" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) setReviewOpen(false); }}>
      <section className="dialog review-dialog" role="dialog" aria-modal="true" aria-labelledby="review-title">
        <h2 id="review-title">Changes on <code>{review.node.branch}</code></h2>
        <p>Since this agent's branch left <b>{git?.branch ?? "the current branch"}</b>. Click a file to see its diff.</p>
        {review.error && <div className="git-error" role="alert">{review.error}</div>}
        {!review.changes && !review.error && <div className="devices-note">Reading the branch…</div>}
        {review.changes && review.changes.length === 0 && <div className="devices-note">No changes yet.</div>}
        <div className="review-list">
          {committed.length > 0 && <><div className="review-heading">Committed<i>{committed.length}</i></div>{committed.map(row)}</>}
          {pending.length > 0 && <><div className="review-heading">Not committed yet<i>{pending.length}</i></div>{pending.map(row)}</>}
        </div>
        <div className="dialog-footer">
          <button className="subtle-button" onClick={() => composeForClaude({ text: `Review the work on branch \`${review.node.branch}\` (git diff ${git?.branch ?? "HEAD"}...${review.node.branch}) before I merge it. Point out bugs and anything unfinished.\n` })}>Ask Claude to review</button>
          <button className="subtle-button" onClick={() => setReviewOpen(false)}>Close</button>
          <button className="primary-button" onClick={() => { setReviewOpen(false); askFinishWorktree(review.node); }}>Finish this agent…</button>
        </div>
      </section>
    </div>;
  }

  function renderDocked() {
    const byZone: Record<Zone, TileNode[]> = { left: [], center: [], right: [], bottom: [] };
    for (const node of allTiles) byZone[zoneOf(node)].push(node);
    return <div className="dock" style={{ ["--dock-left" as string]: zoneSizes.left + "px", ["--dock-right" as string]: zoneSizes.right + "px", ["--dock-bottom" as string]: zoneSizes.bottom + "px" }}>
      {byZone.left.length > 0 && <>{renderZone("left", byZone.left)}{renderZoneResizer("left")}</>}
      <div className="dock-main">
        {byZone.center.length > 0 ? renderZone("center", byZone.center) : <section className={"dock-zone dock-center dock-empty" + (dragSource ? " accepting" : "")} onDragOver={event => { if (dragSource) event.preventDefault(); }} onDrop={event => { event.preventDefault(); const source = dragSource; endDrag(); if (source?.kind === "move") moveToZone(source.id, "center"); else if (source) { const node = source.type === "terminal" ? tile("terminal", { assistant: source.assistant }) : tile(source.type); addTile(node); moveToZone(node.id, "center"); } }}>
          <div className="dock-welcome"><h2>{active.name}</h2><p>Open a file, the preview or the canvas here. Agents open on the right, terminals at the bottom.</p><div className="tile-empty-actions"><button onClick={() => ensureTile("editor")}>Code</button><button onClick={() => ensureTile("preview")}>Preview</button><button onClick={() => { ensureTile("files"); }}>Files</button><button onClick={() => addTerminal(null)}>Terminal</button></div></div>
        </section>}
        {byZone.bottom.length > 0 && <>{renderZoneResizer("bottom")}{renderZone("bottom", byZone.bottom)}</>}
      </div>
      {byZone.right.length > 0 && <>{renderZoneResizer("right")}{renderZone("right", byZone.right)}</>}
    </div>;
  }

  function renderRailButton(options: { key: string; label: string; glyph: string; active?: boolean; badge?: number; working?: boolean; source: DragSource; onClick: () => void; title?: string; agent?: boolean; detail?: string; shortcut?: string }) {
    const tip = (options.title ?? options.label) + (options.shortcut ? ` (${options.shortcut})` : "");
    return <button key={options.key} className={"rail-button" + (options.active ? " active" : "") + (options.agent ? " rail-agent" : "") + (options.working ? " rail-working" : "")} data-tip={tip} aria-label={tip} aria-pressed={options.active} draggable onDragStart={event => beginDrag(event, options.source)} onDragEnd={endDrag} onClick={options.onClick}>
      <span className="rail-icon"><Glyph name={options.glyph} size={18}/>{options.badge ? <span className="rail-badge">{options.badge > 99 ? "99+" : options.badge}</span> : null}{options.working && <span className="rail-working-dot" title="Working"/>}</span>
      <span className="rail-text"><span className="rail-label">{options.label}</span>{options.detail && <span className="rail-detail">{options.detail}</span>}</span>
      {options.shortcut && <kbd className="rail-kbd">{options.shortcut}</kbd>}
    </button>;
  }

  function railGlyph(node: TileNode) {
    if (node.type === "vscode") return node.assistant === "codex" ? "codex" : node.assistant === "gemini" ? "gemini" : "chat";
    return node.type === "agent" ? "chat" : node.type === "editor" ? "code" : node.type === "files" ? "folder" : node.type === "preview" ? "globe" : node.type === "canvas" ? "canvas" : node.type === "git" ? "git" : node.type === "devices" ? "phone" : "terminal";
  }

  const claudeTiles = allTiles.filter(item => item.type === "agent" && item.assistant !== "codex");
  const agentRunning = claudeTiles.some(item => agentStatus[item.id] === "running");

  return (
    <div className={"workspace-view" + (dragSource ? " is-dragging" : "") + (isMac && desktop ? " is-mac" : "")} hidden={!visible}>
      <div className="ide-toolbar">
        <div className="toolbar-tabs">{props.tabs}</div>
        <button className="command-trigger" onClick={() => { setCommandOpen(true); setQuery(""); }}><span><Glyph name="search" size={14}/></span> Search files, tiles, and commands <kbd>⌘ P</kbd></button>
        <div className="toolbar-actions">
          {git?.branch && <button className="branch-chip" title="Source Control" onClick={() => ensureTile("git")}>⑂ {git.branch}{git.changes.length > 0 && <i className="branch-dot" title={`${git.changes.length} changed`}/>}</button>}
          <div className="mode-switch" role="group" aria-label="Layout mode"><button className={layoutMode === "docked" ? "active" : ""} aria-pressed={layoutMode === "docked"} title="Docked: fixed areas with tabs" onClick={() => setLayoutMode("docked")}>Docked</button><button className={layoutMode === "free" ? "active" : ""} aria-pressed={layoutMode === "free"} title="Free: split tiles anywhere" onClick={() => setLayoutMode("free")}>Free</button></div>
          {layoutMode === "free" && <select className="layout-preset" aria-label="Layout preset" title="Apply a layout preset" value="" onChange={event => { if (event.target.value) applyPreset(event.target.value); }}><option value="">Layout</option>{presetLabels.map(([name, label]) => <option key={name} value={name}>{label}</option>)}</select>}
          <button title="Flow Mode (⌘.)" aria-pressed={flowMode} className={flowMode ? "icon-button selected" : "icon-button"} onClick={props.onToggleFlow}>◉</button>
          <button title="Settings" className="icon-button" onClick={() => props.onOpenDialog("settings")}><Glyph name="settings" size={16}/></button>
        </div>
      </div>

      <div className="workspace-body">
        <aside className={"tile-rail" + (railExpanded ? " expanded" : "")} aria-label="Tiles">
          <div className="rail-section" aria-label="Tiles">
            {railExpanded && <span className="rail-heading">Workspace</span>}
            {renderRailButton({ key: "terminal", label: "Terminal", glyph: "terminal", active: terminalTiles.some(item => !item.assistant), badge: railExpanded ? undefined : terminalTiles.filter(item => !item.assistant).length || undefined, source: { kind: "new", type: "terminal" }, onClick: () => addTerminal(null), title: "New terminal · drag to place", detail: terminalTiles.filter(item => !item.assistant).length ? `${terminalTiles.filter(item => !item.assistant).length} open · click for a new one` : "Click for a new one", shortcut: "⌘2" })}
            {renderRailButton({ key: "editor", label: "Code", glyph: "code", active: hasTile(layout, "editor"), source: { kind: "new", type: "editor" }, onClick: () => toggleTile("editor"), title: "Code editor · click to show or hide, drag to place", detail: activeFile ? activeFile.path.split("/").pop() + (openFiles.length > 1 ? ` · ${openFiles.length} open` : "") + (openFiles.some(file => file.contents !== file.saved) ? " · unsaved" : "") : "Editor", shortcut: "⌘3" })}
            {renderRailButton({ key: "files", label: "Files", glyph: "folder", active: filesVisible, source: { kind: "new", type: "files" }, onClick: () => toggleTile("files"), title: "Files · click to show or hide, drag to place", detail: currentDirectory || active.name, shortcut: "⌘4" })}
            {renderRailButton({ key: "preview", label: "Preview", glyph: "globe", active: hasTile(layout, "preview"), badge: railExpanded ? undefined : previewIssues || undefined, source: { kind: "new", type: "preview" }, onClick: () => toggleTile("preview"), title: "Preview · click to show or hide, drag to place", detail: previewLocation ? previewLocation.replace(/^https?:\/\//, "") + (previewIssues ? ` · ${previewIssues} issue${previewIssues === 1 ? "" : "s"}` : "") : "Browser", shortcut: "⌘5" })}
            {renderRailButton({ key: "canvas", label: "Canvas", glyph: "canvas", active: canvasVisible, source: { kind: "new", type: "canvas" }, onClick: () => toggleTile("canvas"), title: "Canvas · click to show or hide, drag to place", detail: canvasItems.length ? `${canvasItems.length} item${canvasItems.length === 1 ? "" : "s"}` : "Whiteboard", shortcut: "⌘6" })}
            {renderRailButton({ key: "git", label: "Git", glyph: "git", active: gitVisible, badge: git?.changes.length, source: { kind: "new", type: "git" }, onClick: () => toggleTile("git"), title: "Source Control · click to show or hide, drag to place", detail: git ? git.branch + (git.changes.length ? ` · ${git.changes.length} change${git.changes.length === 1 ? "" : "s"}` : " · clean") : "Source control", shortcut: "⌘7" })}
            {renderRailButton({ key: "devices", label: "Devices", glyph: "phone", active: hasTile(layout, "devices"), source: { kind: "new", type: "devices" }, onClick: () => toggleTile("devices"), title: "iOS simulators and Android emulators · click to show or hide, drag to place", detail: "Simulators & emulators", shortcut: "⌘8" })}
          </div>
          <div className="rail-section rail-agents" aria-label="Other agents">
            <span className="rail-heading">Agents</span>
            {renderRailButton({ key: "claude", label: "Claude", glyph: "claude", agent: true, active: claudeTiles.length > 0, working: agentRunning, source: { kind: "new", type: "agent", assistant: "claude" }, onClick: () => focusOrAddClaude(), title: "Claude Code · click to open, click again for another session, drag to place", detail: agentRunning ? "Working…" : claudeTiles.length ? `${claudeTiles.length} open` : "Claude Code chat", shortcut: "⌘1" })}
            {renderRailButton({ key: "codex", label: "Codex", glyph: "codex", agent: true, active: tiles(layout).some(item => item.type === "agent" && item.assistant === "codex"), working: tiles(layout).some(item => item.assistant === "codex" && agentStatus[item.id] === "running"), source: { kind: "new", type: "agent", assistant: "codex" }, onClick: () => focusOrAddCodex(), title: "Codex · click to open, click again for another thread, drag to place", detail: "Codex chat" })}
            {aiTools.filter(tool => tool.available && tool.id !== "claude" && tool.id !== "codex").map(tool => renderRailButton({ key: "cli-" + tool.id, label: aiNames[tool.id], glyph: tool.id === "codex" ? "codex" : tool.id === "gemini" ? "gemini" : "terminal", agent: true, active: terminalTiles.some(item => item.assistant === tool.id), source: { kind: "new", type: "terminal", assistant: tool.id }, onClick: () => focusOrAddCli(tool.id), title: `${tool.name} · click to open, drag to place`, detail: "Terminal agent" }))}
          </div>
          {desktop && aiLoading && <span className="rail-note">Detecting agents…</span>}
          {aiError && <span className="rail-note" title={aiError}>Agent error</span>}
          {railExpanded && allTiles.length > 0 && <div className="rail-section rail-open" aria-label="Open tiles">
            <span className="rail-heading">Open tiles<i>{allTiles.length}</i></span>
            {allTiles.map(node => <div key={node.id} className={"rail-tile" + (focusedTileId === node.id ? " focused" : "") + (agentStatus[node.id] === "running" ? " working" : "")} draggable onDragStart={event => beginDrag(event, { kind: "move", id: node.id })} onDragEnd={endDrag}>
              <button className="rail-tile-focus" onClick={() => setFocusedTileId(node.id)} title="Focus this tile · drag to move it"><Glyph name={railGlyph(node)} size={13}/><span>{tileTitle(node)}</span>{agentStatus[node.id] === "running" && <em className="rail-tile-dot"/>}{terminalStatus[node.id] === "error" && <em className="rail-tile-dot error"/>}</button>
              <button className="rail-tile-close" aria-label={`Close ${tileTitle(node)}`} title="Close" onClick={() => closeTile(node.id)}>×</button>
            </div>)}
          </div>}
          <span className="rail-spacer"/>
          <div className="rail-section">
            <button className="rail-button" data-tip="Search (⌘P)" aria-label="Search (⌘P)" onClick={() => setCommandOpen(true)}><span className="rail-icon"><Glyph name="search" size={18}/></span><span className="rail-text"><span className="rail-label">Search</span></span><kbd className="rail-kbd">⌘P</kbd></button>
            <button className="rail-button" data-tip="Settings" aria-label="Settings" onClick={() => props.onOpenDialog("settings")}><span className="rail-icon"><Glyph name="settings" size={18}/></span><span className="rail-text"><span className="rail-label">Settings</span></span></button>
            <button className="rail-button rail-collapse" data-tip={railExpanded ? "Collapse sidebar (⌘B)" : "Expand sidebar (⌘B)"} aria-label={railExpanded ? "Collapse sidebar" : "Expand sidebar"} aria-expanded={railExpanded} onClick={() => setRailExpanded(value => !value)}><span className="rail-icon"><span className="rail-chevron">{railExpanded ? "«" : "»"}</span></span><span className="rail-text"><span className="rail-label">Collapse</span></span></button>
          </div>
        </aside>

        <div className="panel-area">
          {finishing && <div className="scrim" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget && !finishing.busy) setFinishing(null); }}>
            <section className="dialog finish-dialog" role="dialog" aria-modal="true" aria-labelledby="finish-title">
              <h2 id="finish-title">Close {tileTitle(finishing.node)}</h2>
              <p>This agent works on its own branch <code>{finishing.node.branch}</code>. What should happen to its work?</p>
              <div className="finish-summary">{finishing.summary ? <>
                <span><b>{finishing.summary.ahead}</b> commit{finishing.summary.ahead === 1 ? "" : "s"} ahead of <code>{finishing.summary.target}</code></span>
                {finishing.summary.stat && <span>{finishing.summary.stat}</span>}
                {finishing.summary.dirty > 0 && <span className="finish-warning">{finishing.summary.dirty} uncommitted file{finishing.summary.dirty === 1 ? "" : "s"} in the worktree</span>}
              </> : !finishing.error && <span>Reading the worktree…</span>}</div>
              {finishing.error && <div className="git-error" role="alert">{finishing.error}</div>}
              <button className="link-button finish-review" onClick={() => { const node = finishing.node; setFinishing(null); openReview(node); }}>Review the changes first</button>
              <div className="finish-actions">
                <button className="primary-button" disabled={finishing.busy || !finishing.summary || finishing.summary.dirty > 0 || finishing.summary.ahead === 0} onClick={() => finishWorktree("merge")}>Merge into {finishing.summary?.target ?? "current branch"}</button>
                <button className="subtle-button" disabled={finishing.busy || (finishing.summary?.dirty ?? 0) > 0} onClick={() => finishWorktree("remove")}>Keep branch, remove folder</button>
                <button className="subtle-button" disabled={finishing.busy} onClick={() => finishWorktree("keep")}>Just close the tab</button>
                <button className="subtle-button danger" disabled={finishing.busy} onClick={() => finishWorktree("discard")}>Discard everything</button>
              </div>
            </section>
          </div>}
          {renderTabMenu()}
          {renderReview()}
          {flowMode && <div className="flow-pill" aria-live="polite"><i/>Flow mode<kbd>⌘.</kbd> to leave</div>}
          {toasts.length > 0 && <div className="toast-stack" aria-live="polite">{toasts.map(toast => <div key={toast.id} className={"toast toast-" + toast.tone}><strong>{toast.title}</strong>{toast.body && <span>{toast.body}</span>}<button aria-label="Dismiss" onClick={() => setToasts(current => current.filter(item => item.id !== toast.id))}>×</button></div>)}</div>}
          <div className={"tile-canvas" + (layoutMode === "docked" ? " docked" : "") + (dropTarget && dropTarget.id === null ? " drop-root" : "")} onDragOver={event => { if (!layout && layoutMode === "free") dragOverTile(event, null); }} onDragLeave={dragLeaveTile} onDrop={event => { if (!layout && layoutMode === "free") dropOnTile(event, null); }}>
            {layoutMode === "docked" ? renderDocked() : layout ? renderNode(layout) : <div className="tile-empty"><div className="editor-logo brand"><ZevrinMark size={28}/></div><h2>Empty workspace</h2><p>Drag a tile from the sidebar, click one to add it, or pick a layout preset.</p><div className="tile-empty-actions"><button onClick={() => applyPreset("default")}>Default layout</button><button onClick={() => applyPreset("agent-code")}>Claude + Code</button></div></div>}
          </div>
          <div className="bottom-bar">
            <span><i className={"status-dot " + (desktop ? focusedTerminalStatus || "" : "")}/> {focusedTerminalStatus === "error" ? "Terminal error" : focusedTerminalStatus === "starting" && desktop ? "Starting…" : "Ready"}</span>
            {git?.branch && <button className="status-item" title="Source Control" onClick={() => ensureTile("git")}><Glyph name="branch" size={12}/>{git.branch}{git.changes.length > 0 && <em>{git.changes.length}</em>}</button>}
            {(() => { const working = allTiles.filter(item => agentStatus[item.id] === "running"); return working.length > 0 && <button className="status-item" title="Agents working" onClick={() => setFocusedTileId(working[0].id)}><i className="tab-attention running"/>{working.length} working</button>; })()}
            {(() => { const waiting = allTiles.filter(item => agentWaiting[item.id]); return waiting.length > 0 && <button className="status-item attention" title="Agents waiting for your approval" onClick={() => setFocusedTileId(waiting[0].id)}><i className="tab-attention waiting"/>{waiting.length} waiting for you</button>; })()}
            {activeFile && <span className="status-file">{activeFile.path}{activeFile.contents !== activeFile.saved ? " · unsaved" : ""}</span>}
            <span className="bottom-bar-end" title={active.path}>{active.path.replace(/^\/Users\/[^/]+/, "~")}</span>
          </div>
        </div>
      </div>

      {commandOpen && <div className="scrim command-scrim" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) setCommandOpen(false); }}><section className="command-box" role="dialog" aria-modal="true" aria-label="Command Center"><div className="command-input"><span>⌕</span><input autoFocus placeholder="Search files, tiles, and commands..." value={query} onChange={event => setQuery(event.target.value)} onKeyDown={onPaletteKeyDown} aria-activedescendant={paletteItems[paletteIndex] ? `palette-${paletteItems[paletteIndex].id}` : undefined} aria-controls="palette-results" role="combobox" aria-expanded="true"/><kbd>ESC</kbd></div><div className="command-results" id="palette-results" role="listbox" ref={paletteListRef}>{paletteItems.map((item, index) => <button key={item.id} id={`palette-${item.id}`} role="option" aria-selected={index === paletteIndex} data-index={index} className={index === paletteIndex ? "selected" : undefined} onMouseEnter={() => setPaletteIndex(index)} onClick={item.action}><span className="command-result-icon">{item.kind === "file" ? <Glyph name="file" size={14}/> : "⌘"}</span><span className="command-result-title">{item.title}{item.detail && <small>{item.detail}</small>}</span><span>↵</span></button>)}{paletteItems.length === 0 && <p>{fileSearching ? "Searching files…" : "No matching files or commands"}</p>}</div><div className="command-footer"><span>↑↓ to navigate</span><span>↵ to select</span><span>ESC to close</span>{fileSearching && <span className="command-footer-end">Searching…</span>}</div></section></div>}
    </div>
  );
}
