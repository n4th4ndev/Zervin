"use client";

import { subscribeCompose } from "./compose-bus";
import { AgentReview, ChangesCard, RestoreButton, useTurnCheckpoints, type TurnCheckpoint } from "./agent-changes";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AgentEffort, AgentMessageContent, AgentPermissionMode, AgentSessionInfo, FileMatch } from "../types/desktop";
import { addSystemNote, addUserMessage, applyAgentEvent, applyHistoryMessage, describeToolCall, initialChatState, todoEntries } from "./chat-model";
import type { ChatBlock, ChatItem, ChatState } from "./chat-model";

type Props = {
  tileId: string;
  workspacePath: string;
  desktop: boolean;
  visible: boolean;
  session?: string;
  onSession: (sessionId: string | undefined) => void;
  onStatus?: (status: ChatState["status"]) => void;
  onWaiting?: (waiting: boolean) => void;
  onOpenFile?: (path: string) => void;
};

type Attachment = { id: string; name: string; mediaType: string; data: string; preview: string };
type Popover = { kind: "commands" | "files" | "history"; query: string; index: number } | null;

const modeLabels: Array<[AgentPermissionMode, string, string]> = [
  ["default", "Ask", "Ask before risky actions"],
  ["acceptEdits", "Auto-edit", "Accept file edits automatically, ask for the rest"],
  ["plan", "Plan", "Plan only, no changes until you approve"],
  ["auto", "Auto", "Let Claude decide what needs approval"],
  ["bypassPermissions", "Bypass", "Never ask (dangerous)"],
];
const effortLevels: AgentEffort[] = ["low", "medium", "high", "xhigh", "max"];
const toolGlyphs: Record<string, string> = { Bash: "$", Read: "≡", Write: "✎", Edit: "✎", MultiEdit: "✎", NotebookEdit: "✎", Glob: "⌕", Grep: "⌕", WebFetch: "⇣", WebSearch: "⌕", Task: "⋯", Agent: "⋯", TodoWrite: "☑", ExitPlanMode: "▤", AskUserQuestion: "?" };
const imageTypes = ["image/png", "image/jpeg", "image/gif", "image/webp"];

function cleanError(error: unknown, fallback: string) {
  return (error instanceof Error ? error.message : "").replace(/^Error invoking remote method '[^']+': (Error: )?/, "") || fallback;
}

function renderInline(text: string, keyPrefix: string) {
  const parts = text.split(/(`[^`]+`|\*\*[^*]+\*\*)/g).filter(Boolean);
  return parts.map((part, index) => {
    if (part.startsWith("`") && part.endsWith("`") && part.length > 1) return <code key={keyPrefix + index}>{part.slice(1, -1)}</code>;
    if (part.startsWith("**") && part.endsWith("**") && part.length > 4) return <strong key={keyPrefix + index}>{part.slice(2, -2)}</strong>;
    return <span key={keyPrefix + index}>{part}</span>;
  });
}

// Small Markdown subset: fenced code, headings, bullet and numbered lists, paragraphs, inline code and bold.
export function Markdown({ text }: { text: string }) {
  const nodes = useMemo(() => {
    const output: import("react").ReactNode[] = [];
    const segments = text.split(/(```[\s\S]*?```)/g);
    segments.forEach((segment, segmentIndex) => {
      if (segment.startsWith("```")) {
        const body = segment.slice(3, -3);
        const newline = body.indexOf("\n");
        const language = newline === -1 ? "" : body.slice(0, newline).trim();
        const code = newline === -1 ? body : body.slice(newline + 1);
        output.push(<pre key={`code-${segmentIndex}`} className="chat-code" data-language={language || undefined}><code>{code.replace(/\n$/, "")}</code></pre>);
        return;
      }
      const lines = segment.split("\n");
      let paragraph: string[] = [];
      let list: { ordered: boolean; items: string[] } | null = null;
      const flushParagraph = () => { if (paragraph.length) { output.push(<p key={`p-${segmentIndex}-${output.length}`}>{renderInline(paragraph.join(" "), `i-${output.length}-`)}</p>); paragraph = []; } };
      const flushList = () => { if (list) { const items = list.items.map((item, index) => <li key={index}>{renderInline(item, `l-${output.length}-${index}-`)}</li>); output.push(list.ordered ? <ol key={`ol-${segmentIndex}-${output.length}`}>{items}</ol> : <ul key={`ul-${segmentIndex}-${output.length}`}>{items}</ul>); list = null; } };
      for (const rawLine of lines) {
        const line = rawLine.replace(/\s+$/, "");
        const heading = line.match(/^(#{1,4})\s+(.*)$/);
        const bullet = line.match(/^\s*[-*•]\s+(.*)$/);
        const numbered = line.match(/^\s*\d+[.)]\s+(.*)$/);
        if (!line.trim()) { flushParagraph(); flushList(); continue; }
        if (heading) { flushParagraph(); flushList(); output.push(<h4 key={`h-${segmentIndex}-${output.length}`}>{renderInline(heading[2], `h-${output.length}-`)}</h4>); continue; }
        if (bullet || numbered) {
          flushParagraph();
          const ordered = Boolean(numbered);
          if (!list || list.ordered !== ordered) { flushList(); list = { ordered, items: [] }; }
          list.items.push((bullet ?? numbered)![1]);
          continue;
        }
        flushList();
        paragraph.push(line.trim());
      }
      flushParagraph(); flushList();
    });
    return output;
  }, [text]);
  return <div className="chat-markdown">{nodes}</div>;
}

function ToolCard({ block }: { block: Extract<ChatBlock, { type: "tool_use" }> }) {
  const [open, setOpen] = useState(false);
  const todos = block.name === "TodoWrite" ? todoEntries(block.input) : null;
  const plan = block.name === "ExitPlanMode" ? (block.input as { plan?: unknown })?.plan : null;
  const summary = describeToolCall(block.name, block.input);
  const status = block.result ? (block.result.isError ? "error" : "done") : "running";
  if (todos) {
    return <div className="chat-todos"><div className="chat-todos-head"><span className="chat-tool-glyph" aria-hidden="true">☑</span><span>Tasks</span><span className="chat-tool-summary">{summary}</span></div><ul>{todos.map((todo, index) => <li key={index} className={"todo-" + todo.status}><i aria-hidden="true">{todo.status === "completed" ? "✓" : todo.status === "in_progress" ? "›" : ""}</i>{todo.content}</li>)}</ul></div>;
  }
  if (typeof plan === "string" && plan.trim()) {
    return <div className="chat-plan"><div className="chat-todos-head"><span className="chat-tool-glyph" aria-hidden="true">▤</span><span>Plan</span><span className={"chat-tool-state " + status}>{status === "running" ? "…" : status === "error" ? "!" : "✓"}</span></div><Markdown text={plan}/></div>;
  }
  return <div className={"chat-tool chat-tool-" + status}>
    <button className="chat-tool-head" onClick={() => setOpen(value => !value)} aria-expanded={open}>
      <span className="chat-tool-glyph" aria-hidden="true">{toolGlyphs[block.name] ?? "⚙"}</span>
      <span className="chat-tool-name">{block.name.replace(/^mcp__zevrin__/, "Zevrin · ").replace(/^mcp__/, "")}</span>
      <span className="chat-tool-summary" title={summary}>{summary}</span>
      <span className={"chat-tool-state " + status} aria-label={status}>{status === "running" ? "…" : status === "error" ? "!" : "✓"}</span>
    </button>
    {open && <div className="chat-tool-body">
      <div className="chat-tool-section"><span>Input</span><pre>{typeof block.input === "string" ? block.input : JSON.stringify(block.input, null, 2)}</pre></div>
      {block.result && <div className="chat-tool-section"><span>{block.result.isError ? "Error" : "Result"}</span><pre>{block.result.text || "(empty)"}</pre></div>}
    </div>}
  </div>;
}

function ChatMessage({ item }: { item: ChatItem }) {
  if (item.role === "user") return <div className="chat-item chat-user"><div className="chat-bubble">{item.images ? <span className="chat-image-note">🖼 {item.images} image{item.images > 1 ? "s" : ""}</span> : null}<Markdown text={item.text}/></div></div>;
  if (item.role === "system") return <div className={"chat-item chat-system chat-" + item.tone}><span>{item.text}</span></div>;
  return <div className="chat-item chat-assistant">{item.blocks.map((block, index) => {
    if (block.type === "text") return <Markdown key={index} text={block.text}/>;
    if (block.type === "thinking") return <details key={index} className="chat-thinking"><summary>Thinking</summary><p>{block.text}</p></details>;
    return <ToolCard key={block.id} block={block}/>;
  })}</div>;
}

export function readFileAsDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(reader.error); reader.readAsDataURL(file); });
}

export function relativeTime(timestamp: number) {
  const minutes = Math.round((Date.now() - timestamp) / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  return days === 1 ? "yesterday" : `${days} days ago`;
}

export function AgentChat({ tileId, workspacePath, desktop, visible, session, onSession, onStatus, onWaiting, onOpenFile }: Props) {
  const [state, setState] = useState<ChatState>(() => initialChatState());
  const [input, setInput] = useState("");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [busy, setBusy] = useState(false);
  const [popover, setPopover] = useState<Popover>(null);
  const [fileMatches, setFileMatches] = useState<FileMatch[]>([]);
  const [sessions, setSessions] = useState<AgentSessionInfo[]>([]);
  const [showAccount, setShowAccount] = useState(false);
  const [modelMenu, setModelMenu] = useState(false);
  const [modeMenu, setModeMenu] = useState(false);
  const [tipIndex] = useState(() => Math.floor(Math.random() * 1000));
  const checkpoints = useTurnCheckpoints(workspacePath, desktop);
  const [review, setReview] = useState<TurnCheckpoint | null>(null);
  const wasRunning = useRef(false);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const stickToBottom = useRef(true);
  const sessionRef = useRef(session);
  const onSessionRef = useRef(onSession);
  const optionsRef = useRef<{ mode: AgentPermissionMode; effort: AgentEffort | null; model: string | null }>({ mode: "default", effort: null, model: null });
  useEffect(() => { onSessionRef.current = onSession; }, [onSession]);
  useEffect(() => { onStatus?.(state.status); }, [state.status, onStatus]);
  // When a turn ends, sum up what the agent changed since the message was sent.
  useEffect(() => {
    const running = state.status === "running";
    if (wasRunning.current && !running) checkpoints.finish();
    wasRunning.current = running;
  }, [state.status]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { onWaiting?.(Boolean(state.permission)); }, [state.permission, onWaiting]);
  useEffect(() => {
    if (state.sessionId && state.sessionId !== sessionRef.current) { sessionRef.current = state.sessionId; onSessionRef.current(state.sessionId); }
  }, [state.sessionId]);

  const start = useCallback(async (resume: string | undefined, options: { mode: AgentPermissionMode; effort: AgentEffort | null; model: string | null }, keepItems = false) => {
    const api = window.zevrinDesktop;
    if (!api) return;
    optionsRef.current = options;
    if (!keepItems) checkpoints.reset();
    setState(current => ({ ...initialChatState(options.mode), items: keepItems ? current.items : [], models: current.models, commands: current.commands, account: current.account, mcp: current.mcp, effort: options.effort }));
    if (resume && !keepItems) {
      try {
        const history = await api.agentHistory(workspacePath, resume);
        const seeded = history.reduce<ChatState>((next, message) => applyHistoryMessage(next, message), initialChatState(options.mode));
        setState(current => ({ ...current, items: seeded.items }));
      } catch { /* History is optional; the session still resumes. */ }
    }
    try { await api.agentStart(tileId, workspacePath, { permissionMode: options.mode, resume, effort: options.effort ?? undefined, model: options.model ?? undefined }); }
    catch (error) { setState(current => addSystemNote({ ...current, status: "error" }, cleanError(error, "Could not start Claude Code."), "error")); }
  }, [tileId, workspacePath]);

  useEffect(() => {
    const api = window.zevrinDesktop;
    if (!desktop || !api) return;
    const remove = api.onAgentEvent((id, event) => { if (id === tileId) setState(current => applyAgentEvent(current, event)); });
    start(sessionRef.current, optionsRef.current);
    return () => { remove(); api.agentStop(tileId); };
  }, [desktop, tileId, start]);

  useEffect(() => {
    const list = listRef.current;
    if (!list || !stickToBottom.current) return;
    list.scrollTop = list.scrollHeight;
  }, [state.items, state.draft, state.permission]);

  useEffect(() => { if (visible) inputRef.current?.focus(); }, [visible]);

  // Context handed over by other tiles (the browser's "Ask Claude", the editor…) lands in the composer.
  useEffect(() => subscribeCompose(tileId, payload => {
    setInput(current => (current && !current.endsWith("\n") ? current + "\n" : current) + payload.text);
    if (payload.images?.length) setAttachments(current => [...current, ...payload.images!.map(image => ({ id: `${Date.now()}-${Math.random().toString(16).slice(2)}`, name: image.name, mediaType: image.mediaType, data: image.data, preview: `data:${image.mediaType};base64,${image.data}` }))].slice(0, 6));
    requestAnimationFrame(() => { const element = inputRef.current; if (element) { element.focus(); element.selectionStart = element.selectionEnd = element.value.length; } });
  }), [tileId]);

  // "@" file mentions: search the workspace as the user types.
  useEffect(() => {
    const api = window.zevrinDesktop;
    if (!api || popover?.kind !== "files") return;
    let cancelled = false;
    const timer = setTimeout(() => { api.searchFiles(workspacePath, popover.query).then(matches => { if (!cancelled) setFileMatches(matches.slice(0, 8)); }).catch(() => { if (!cancelled) setFileMatches([]); }); }, 100);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [popover?.kind, popover?.query, workspacePath]);

  function onScroll() {
    const list = listRef.current;
    if (!list) return;
    stickToBottom.current = list.scrollHeight - list.scrollTop - list.clientHeight < 40;
  }

  const commandMatches = useMemo(() => {
    if (popover?.kind !== "commands") return [];
    const needle = popover.query.toLowerCase();
    return state.commands.filter(command => command.name.toLowerCase().includes(needle)).slice(0, 10);
  }, [popover, state.commands]);

  function updateInput(value: string, caret?: number) {
    setInput(value);
    const position = caret ?? value.length;
    const before = value.slice(0, position);
    if (/^\/[\w:-]*$/.test(before)) { setPopover({ kind: "commands", query: before.slice(1), index: 0 }); return; }
    const mention = before.match(/(?:^|\s)@([^\s@]*)$/);
    if (mention) { setPopover({ kind: "files", query: mention[1], index: 0 }); return; }
    if (popover && popover.kind !== "history") setPopover(null);
  }

  function pickCommand(name: string) {
    setInput(`/${name} `);
    setPopover(null);
    inputRef.current?.focus();
  }

  function pickFile(path: string) {
    const element = inputRef.current;
    const caret = element?.selectionStart ?? input.length;
    const before = input.slice(0, caret).replace(/@[^\s@]*$/, `@${path} `);
    const next = before + input.slice(caret);
    setInput(next);
    setPopover(null);
    requestAnimationFrame(() => { if (element) { element.focus(); element.selectionStart = element.selectionEnd = before.length; } });
  }

  async function addFiles(files: FileList | File[] | null) {
    if (!files) return;
    const accepted = Array.from(files).filter(file => imageTypes.includes(file.type)).slice(0, 6);
    const items = await Promise.all(accepted.map(async file => { const dataUrl = await readFileAsDataUrl(file); return { id: `${Date.now()}-${Math.random().toString(16).slice(2)}`, name: file.name || "image", mediaType: file.type, data: dataUrl.split(",")[1] ?? "", preview: dataUrl }; }));
    setAttachments(current => [...current, ...items].slice(0, 6));
  }

  async function send() {
    const api = window.zevrinDesktop;
    const text = input.trim();
    if (!api || (!text && attachments.length === 0) || busy) return;
    setBusy(true);
    setInput(""); setPopover(null);
    const images = attachments;
    setAttachments([]);
    stickToBottom.current = true;
    const content: AgentMessageContent = images.length ? [...images.map(image => ({ type: "image" as const, source: { type: "base64" as const, media_type: image.mediaType, data: image.data } })), ...(text ? [{ type: "text" as const, text }] : [])] : text;
    const userIndex = state.items.filter(item => item.role === "user").length;
    setState(current => addUserMessage(current, text || "(image)", images.length));
    await checkpoints.begin(text.slice(0, 160) || "(image)", userIndex);
    try { await api.agentSend(tileId, content); }
    catch (error) {
      const message = cleanError(error, "Could not send the message.");
      if (/not running|has ended/i.test(message)) {
        await start(sessionRef.current, optionsRef.current, true);
        await api.agentSend(tileId, content).catch(inner => setState(current => addSystemNote({ ...current, status: "error" }, cleanError(inner, message), "error")));
      } else setState(current => addSystemNote({ ...current, status: "error" }, message, "error"));
    } finally { setBusy(false); }
  }

  async function restoreTo(turn: TurnCheckpoint) {
    if (!window.confirm(`Put the project back as it was before “${turn.label}”? The changes made since (by the agent or by you) are undone.`)) return;
    try {
      const count = await checkpoints.restore(turn.id);
      setState(current => addSystemNote(current, count ? `Restored ${count} file${count === 1 ? "" : "s"} to before “${turn.label}”.` : "Nothing to restore: no file changed since then.", "info"));
    } catch (error) { setState(current => addSystemNote(current, cleanError(error, "The checkpoint could not be restored."), "error")); }
  }

  function respond(decision: "allow" | "allow_always" | "deny") {
    const api = window.zevrinDesktop;
    if (!api || !state.permission) return;
    api.agentRespond(tileId, state.permission.requestId, decision).catch(() => {});
    setState(current => ({ ...current, permission: null }));
  }

  function changeMode(mode: AgentPermissionMode) {
    const api = window.zevrinDesktop;
    if (!api) return;
    optionsRef.current = { ...optionsRef.current, mode };
    if (mode === "bypassPermissions") {
      if (!window.confirm("Bypass mode lets Claude run every tool without asking. Continue?")) return;
      start(sessionRef.current, optionsRef.current, true);
      return;
    }
    setState(current => ({ ...current, permissionMode: mode }));
    api.agentSetMode(tileId, mode).catch(() => {});
  }

  function changeModel(model: string) {
    const api = window.zevrinDesktop;
    if (!api) return;
    optionsRef.current = { ...optionsRef.current, model: model || null };
    setState(current => ({ ...current, model: model || current.model }));
    api.agentSetModel(tileId, model || null).catch(error => setState(current => addSystemNote(current, cleanError(error, "Could not change the model."), "error")));
  }

  function changeEffort(effort: string) {
    const level = effortLevels.includes(effort as AgentEffort) ? effort as AgentEffort : null;
    optionsRef.current = { ...optionsRef.current, effort: level };
    // Effort is a session option: restart on the same conversation.
    start(sessionRef.current, optionsRef.current, true);
  }

  function newSession() {
    sessionRef.current = undefined;
    onSessionRef.current(undefined);
    setPopover(null);
    start(undefined, optionsRef.current);
  }

  async function openHistory() {
    const api = window.zevrinDesktop;
    if (!api) return;
    if (popover?.kind === "history") { setPopover(null); return; }
    setPopover({ kind: "history", query: "", index: 0 });
    try { setSessions(await api.agentSessions(workspacePath)); } catch { setSessions([]); }
  }

  function resumeSession(sessionId: string) {
    setPopover(null);
    if (sessionId === sessionRef.current) return;
    sessionRef.current = sessionId;
    onSessionRef.current(sessionId);
    start(sessionId, optionsRef.current);
  }

  function onComposerKeyDown(event: import("react").KeyboardEvent<HTMLTextAreaElement>) {
    const items = popover?.kind === "commands" ? commandMatches.length : popover?.kind === "files" ? fileMatches.length : 0;
    if (popover && items > 0 && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
      event.preventDefault();
      setPopover(current => current ? { ...current, index: (current.index + (event.key === "ArrowDown" ? 1 : items - 1)) % items } : current);
      return;
    }
    if (popover && items > 0 && (event.key === "Tab" || (event.key === "Enter" && !event.shiftKey))) {
      event.preventDefault();
      if (popover.kind === "commands") pickCommand(commandMatches[popover.index].name); else pickFile(fileMatches[popover.index].path);
      return;
    }
    if (event.key === "Escape" && popover) { event.preventDefault(); setPopover(null); return; }
    if (event.key === "Tab" && event.shiftKey) { event.preventDefault(); const cycle: AgentPermissionMode[] = ["default", "acceptEdits", "plan"]; const index = cycle.indexOf(state.permissionMode as AgentPermissionMode); changeMode(cycle[(index + 1) % cycle.length]); return; }
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); send(); }
  }

  const running = state.status === "running";
  const firstUser = state.items.find(item => item.role === "user") as { text?: string } | undefined;
  const conversationTitle = sessions.find(item => item.sessionId === state.sessionId)?.summary || (firstUser?.text ? firstUser.text.split("\n")[0].slice(0, 60) : "Untitled");
  const permission = state.permission;
  const permissionSummary = permission ? describeToolCall(permission.toolName, permission.input) : "";
  const planText = permission?.toolName === "ExitPlanMode" ? (permission.input as { plan?: unknown }).plan : null;
  const currentModel = state.models.find(model => model.value === state.model || model.resolvedModel === state.model) ?? null;
  const modelValue = currentModel?.value ?? (state.model ? state.model : "");
  const mcpConnected = state.mcp.filter(server => server.status === "connected").length;
  const mcpFailed = state.mcp.filter(server => server.status === "failed" || server.status === "needs-auth");

  if (!desktop) {
    return <div className="chat-view"><div className="chat-empty"><div className="editor-logo">C</div><h2>Claude</h2><p>Open the Zevrin desktop app to chat with Claude Code in this workspace.</p></div></div>;
  }

  return <div className="chat-view" onDragOver={event => { if (event.dataTransfer.types.includes("Files")) event.preventDefault(); }} onDrop={event => { if (event.dataTransfer.files.length) { event.preventDefault(); addFiles(event.dataTransfer.files); } }}>
    {review && <AgentReview root={workspacePath} checkpoint={review} title={review.label} onClose={() => setReview(null)} onKeepAll={() => checkpoints.accept(review.id)} onOpenFile={onOpenFile} onChanged={() => checkpoints.refresh()}/>}
    <div className="chat-header">
      <strong className="chat-title" title={conversationTitle}>{conversationTitle}</strong>
      {state.costUsd > 0 && <span className="chat-cost" title={`${state.turns} turns`}>${state.costUsd.toFixed(2)}</span>}
      {state.mcp.length > 0 && mcpFailed.length > 0 && <span className="chat-mcp failed" title={mcpFailed.map(server => `${server.name}: ${server.status}${server.error ? " · " + server.error : ""}`).join("\n")}>MCP {mcpConnected}/{state.mcp.length}</span>}
      <button type="button" className="chat-icon-button" title="Past conversations" aria-label="Past conversations" aria-expanded={popover?.kind === "history"} onClick={openHistory}><ChatIcon name="history"/></button>
      <button type="button" className="chat-icon-button" title="New conversation" aria-label="New conversation" onClick={newSession}><ChatIcon name="new"/></button>
      <div className="chat-account-wrap">
        <button type="button" className="chat-icon-button" title="Account and session" aria-label="Account and session" aria-expanded={showAccount} onClick={() => setShowAccount(value => !value)}><ChatIcon name="more"/></button>
        {showAccount && <div className="chat-popover chat-account" onMouseLeave={() => setShowAccount(false)}>
          <strong>{state.account.email ?? "Not signed in yet"}</strong>
          {state.account.organization && <span>{state.account.organization}</span>}
          {state.account.subscriptionType && <span>{state.account.subscriptionType}</span>}
          {state.sessionId && <span className="chat-muted">Session {state.sessionId.slice(0, 8)}</span>}
          <span className="chat-muted">Tools: {state.tools.length} · MCP: {state.mcp.length ? state.mcp.map(server => `${server.name} (${server.status})`).join(", ") : "none"}</span>
        </div>}
      </div>
      {popover?.kind === "history" && <div className="chat-popover chat-history" role="listbox" aria-label="Past conversations">
        {sessions.length === 0 && <span className="chat-muted">No previous conversations in this project.</span>}
        {sessions.map(item => <button key={item.sessionId} type="button" role="option" aria-selected={item.sessionId === sessionRef.current} className={item.sessionId === sessionRef.current ? "selected" : undefined} onClick={() => resumeSession(item.sessionId)}><span>{item.summary || "Untitled conversation"}</span><small>{relativeTime(item.lastModified)}</small></button>)}
      </div>}
    </div>
    <div className="chat-list" ref={listRef} onScroll={onScroll}>
      {state.items.length === 0 && !state.draft && <div className="chat-welcome">
        <div className="chat-wordmark"><ClaudeMark size={22}/><span>Claude Code</span></div>
        <div className="chat-welcome-tip"><p>{chatTips[tipIndex % chatTips.length]}</p></div>
        <div className="chat-suggestions">{["Explain this project", "Find and fix failing tests", "Review my uncommitted changes"].map(suggestion => <button key={suggestion} type="button" onClick={() => { updateInput(suggestion); inputRef.current?.focus(); }}>{suggestion}</button>)}</div>
      </div>}
      {(() => { let ordinal = -1; return state.items.map(item => {
        if (item.role !== "user") return <ChatMessage key={item.id} item={item}/>;
        ordinal += 1;
        const turn = checkpoints.turns.find(entry => entry.userIndex === ordinal);
        return <div key={item.id} className="chat-turn-anchor"><ChatMessage item={item}/>{turn && !running && <RestoreButton onRestore={() => restoreTo(turn)}/>}</div>;
      }); })()}
      {!running && checkpoints.turns.length > 0 && <ChangesCard turn={checkpoints.turns[checkpoints.turns.length - 1]} onReview={() => setReview(checkpoints.turns[checkpoints.turns.length - 1])} onUndo={() => restoreTo(checkpoints.turns[checkpoints.turns.length - 1])}/>}
      {state.draft && (state.draft.text || state.draft.thinking) && <div className="chat-item chat-assistant chat-streaming">{state.draft.thinking && !state.draft.text && <details className="chat-thinking" open><summary>Thinking</summary><p>{state.draft.thinking}</p></details>}{state.draft.text && <Markdown text={state.draft.text}/>}</div>}
      {running && !state.draft?.text && !permission && <div className="chat-item chat-working" aria-live="polite"><span className="chat-dots"><i/><i/><i/></span>Working…</div>}
      {state.status === "auth" && <div className="chat-item chat-system chat-info"><strong>Sign in to Claude Code</strong>{state.authOutput.map((line, index) => <span key={index}>{line}</span>)}</div>}
      {permission && <div className={"chat-permission" + (planText ? " chat-permission-plan" : "")} role="alertdialog" aria-label="Permission request">
        <div className="chat-permission-head"><span className="chat-tool-glyph" aria-hidden="true">{toolGlyphs[permission.toolName] ?? "⚙"}</span><strong>{planText ? "Claude has a plan" : permission.toolName.replace(/^mcp__zevrin__/, "Zevrin · ").replace(/^mcp__/, "")}</strong><span>{planText ? "Approve it to start making changes" : "wants to run"}</span></div>
        {typeof planText === "string" ? <div className="chat-plan-body"><Markdown text={planText}/></div> : permissionSummary && <pre className="chat-permission-summary">{permissionSummary}</pre>}
        {!planText && <details className="chat-permission-details"><summary>Full input</summary><pre>{JSON.stringify(permission.input, null, 2)}</pre></details>}
        <div className="chat-permission-actions"><button className="primary-button" onClick={() => respond("allow")}>{planText ? "Approve plan" : "Allow"}</button>{permission.suggestions.length > 0 && !planText && <button className="subtle-button" onClick={() => respond("allow_always")}>Always allow</button>}<button className="subtle-button chat-deny" onClick={() => respond("deny")}>{planText ? "Keep planning" : "Deny"}</button></div>
      </div>}
    </div>
    <form className="chat-composer-wrap" onSubmit={event => { event.preventDefault(); send(); }}>
      {popover?.kind === "commands" && commandMatches.length > 0 && <div className="chat-popover chat-complete" role="listbox" aria-label="Slash commands">{commandMatches.map((command, index) => <button key={command.name} type="button" role="option" aria-selected={index === popover.index} className={index === popover.index ? "selected" : undefined} onMouseEnter={() => setPopover(current => current ? { ...current, index } : current)} onClick={() => pickCommand(command.name)}><span>/{command.name}<em>{command.argumentHint}</em></span><small>{command.description}</small></button>)}</div>}
      {popover?.kind === "files" && fileMatches.length > 0 && <div className="chat-popover chat-complete" role="listbox" aria-label="Files">{fileMatches.map((file, index) => <button key={file.path} type="button" role="option" aria-selected={index === popover.index} className={index === popover.index ? "selected" : undefined} onMouseEnter={() => setPopover(current => current ? { ...current, index } : current)} onClick={() => pickFile(file.path)}><span>{file.name}</span><small>{file.path}</small></button>)}</div>}
      {attachments.length > 0 && <div className="chat-attachments">{attachments.map(attachment => <span key={attachment.id} className="chat-attachment"><img src={attachment.preview} alt={attachment.name}/><button type="button" aria-label={`Remove ${attachment.name}`} onClick={() => setAttachments(current => current.filter(item => item.id !== attachment.id))}>×</button></span>)}</div>}
      <div className={"chat-composer" + (running ? " running" : "")}>
        <input ref={fileInputRef} type="file" accept={imageTypes.join(",")} multiple className="visually-hidden" onChange={event => { addFiles(event.currentTarget.files); event.currentTarget.value = ""; }}/>
        <textarea ref={inputRef} aria-label="Message Claude" placeholder={running ? "Claude is working… type to queue a message" : "Ask Claude to edit, explain or build…"} value={input} rows={1} onChange={event => updateInput(event.target.value, event.target.selectionStart)} onKeyDown={onComposerKeyDown} onPaste={event => { const files = Array.from(event.clipboardData.files).filter(file => imageTypes.includes(file.type)); if (files.length) { event.preventDefault(); addFiles(files); } }}/>
        <div className="chat-composer-bar">
          <button type="button" className="chat-bar-button" title="Attach images" aria-label="Attach images" onClick={() => fileInputRef.current?.click()}><ChatIcon name="plus"/></button>
          <button type="button" className="chat-bar-button" title="Slash commands" aria-label="Slash commands" onClick={() => { updateInput("/"); inputRef.current?.focus(); }}><ChatIcon name="slash"/></button>
          <div className="chat-mode-wrap">
            <button type="button" className={"chat-mode-button mode-" + state.permissionMode} title={(modeLabels.find(([mode]) => mode === state.permissionMode)?.[2] ?? "") + " · ⇧Tab to switch"} aria-haspopup="menu" aria-expanded={modeMenu} onClick={() => setModeMenu(open => !open)}><ChatIcon name={state.permissionMode === "plan" ? "plan" : state.permissionMode === "acceptEdits" ? "edit" : state.permissionMode === "bypassPermissions" ? "bolt" : "hand"}/><span>{modeLabels.find(([mode]) => mode === state.permissionMode)?.[1] ?? state.permissionMode}</span></button>
            {modeMenu && <div className="chat-popover chat-menu" role="menu" onMouseLeave={() => setModeMenu(false)}>{modeLabels.map(([mode, label, help]) => <button key={mode} type="button" role="menuitemradio" aria-checked={mode === state.permissionMode} className={mode === state.permissionMode ? "selected" : undefined} onClick={() => { changeMode(mode); setModeMenu(false); }}><span>{label}</span><small>{help}</small></button>)}</div>}
          </div>
          <span className="chat-spacer"/>
          {running ? <button type="button" className="chat-send stop" onClick={() => window.zevrinDesktop?.agentInterrupt(tileId)} title="Stop (Esc)" aria-label="Stop"><ChatIcon name="stop"/></button>
            : <button type="submit" className="chat-send" disabled={(!input.trim() && attachments.length === 0) || busy} title="Send (Enter)" aria-label="Send"><ChatIcon name="send"/></button>}
        </div>
      </div>
      <div className="chat-model-row">
        <div className="chat-model-wrap">
          <button type="button" className="chat-model-pill" aria-haspopup="menu" aria-expanded={modelMenu} onClick={() => setModelMenu(open => !open)} title={currentModel?.description ?? "Model and effort"}>{currentModel?.displayName ?? state.model ?? "Default model"}{(currentModel?.supportsEffort ?? true) && <em>{state.effort ? state.effort[0].toUpperCase() + state.effort.slice(1) : "Default"}</em>}</button>
          {modelMenu && <div className="chat-popover chat-menu chat-model-menu" role="menu" onMouseLeave={() => setModelMenu(false)}>
            <div className="chat-menu-heading">Model</div>
            {state.models.length === 0 && <span className="chat-muted">Models load with the first message.</span>}
            {state.models.map(model => <button key={model.value} type="button" role="menuitemradio" aria-checked={model.value === modelValue} className={model.value === modelValue ? "selected" : undefined} onClick={() => changeModel(model.value)}><span>{model.displayName}</span>{model.description && <small>{model.description}</small>}</button>)}
            {(currentModel?.supportsEffort ?? true) && <><div className="chat-menu-heading">Effort</div><div className="chat-effort-row">{["", ...effortLevels].map(level => <button key={level || "default"} type="button" className={(state.effort ?? "") === level ? "selected" : undefined} onClick={() => changeEffort(level)}>{level || "default"}</button>)}</div></>}
          </div>}
        </div>
        <span className="chat-hint-inline">⇧Tab mode · / commands · @ files</span>
      </div>
    </form>
  </div>;
}

const chatTips = [
  "Tired of repeating yourself? Tell Claude to remember it in CLAUDE.md.",
  "Press ⇧Tab to switch between Ask, Auto-edit and Plan.",
  "Type @ to mention a file, or paste a screenshot straight into the message.",
  "Use the Preview's element picker to send a piece of UI to Claude.",
  "Run several Claude sessions side by side, each in its own worktree, from the + of the agents area.",
];

function ClaudeMark({ size = 16 }: { size?: number }) {
  const rays = Array.from({ length: 12 }, (_, index) => index * 30);
  return <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">{rays.map(angle => <rect key={angle} x="11.1" y="1.5" width="1.8" height="8.6" rx=".9" fill="#d97757" transform={`rotate(${angle} 12 12)`}/>)}</svg>;
}

function ChatIcon({ name }: { name: string }) {
  const common = { width: 15, height: 15, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, "aria-hidden": true };
  if (name === "history") return <svg {...common}><circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/></svg>;
  if (name === "new") return <svg {...common}><path d="M5 5.5h14a1.5 1.5 0 0 1 1.5 1.5v8.5a1.5 1.5 0 0 1-1.5 1.5H10l-4 3.5V17H5a1.5 1.5 0 0 1-1.5-1.5V7A1.5 1.5 0 0 1 5 5.5z"/><path d="M12 8.5v5M9.5 11h5"/></svg>;
  if (name === "more") return <svg {...common}><circle cx="6" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="18" cy="12" r="1"/></svg>;
  if (name === "plus") return <svg {...common}><path d="M12 5v14M5 12h14"/></svg>;
  if (name === "slash") return <svg {...common}><rect x="3.5" y="3.5" width="17" height="17" rx="3"/><path d="m14.5 7-5 10"/></svg>;
  if (name === "plan") return <svg {...common}><path d="M8 6h11M8 12h11M8 18h11M4.5 6h.01M4.5 12h.01M4.5 18h.01"/></svg>;
  if (name === "edit") return <svg {...common}><path d="M4 20h4L19 9l-4-4L4 16z"/></svg>;
  if (name === "bolt") return <svg {...common}><path d="M13 3 5 14h6l-1 7 8-11h-6z"/></svg>;
  if (name === "hand") return <svg {...common}><path d="M8 13V6.5a1.5 1.5 0 0 1 3 0V12M11 11V5a1.5 1.5 0 0 1 3 0v6M14 11V6.5a1.5 1.5 0 0 1 3 0V14a6 6 0 0 1-6 6h-.5A5.5 5.5 0 0 1 5 15.5V12a1.5 1.5 0 0 1 3 0"/></svg>;
  if (name === "stop") return <svg {...common}><rect x="7" y="7" width="10" height="10" rx="1.5" fill="currentColor"/></svg>;
  return <svg {...common}><path d="M12 19V5M6 11l6-6 6 6"/></svg>;
}
