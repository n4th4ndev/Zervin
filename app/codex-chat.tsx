"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Markdown, readFileAsDataUrl, relativeTime } from "./agent-chat";
import { addCodexUser, applyCodexEvent, codexHistoryItems, initialCodexState, type CodexItem, type CodexState } from "./codex-model";
import { subscribeCompose } from "./compose-bus";
import { AgentReview, ChangesCard, RestoreButton, useTurnCheckpoints, type TurnCheckpoint } from "./agent-changes";

type Props = { tileId: string; workspacePath: string; desktop: boolean; visible: boolean; session?: string; onSession: (threadId: string | undefined) => void; onStatus?: (status: "idle" | "running") => void; onOpenFile?: (path: string) => void };
type Mode = "chat" | "agent" | "full";
const modes: Array<[Mode, string, string]> = [["chat", "Chat", "Read only: answers and plans, no changes"], ["agent", "Agent", "Edits files and runs commands in this workspace"], ["full", "Agent (full access)", "No sandbox: network and files outside the workspace"]];
const efforts = ["", "minimal", "low", "medium", "high", "xhigh"];
const imageTypes = ["image/png", "image/jpeg", "image/gif", "image/webp"];

function cleanError(error: unknown) {
  return (error instanceof Error ? error.message : String(error)).replace(/^Error invoking remote method '[^']+': (Error: )?/, "");
}

// Codex, native to Zevrin: the official Codex SDK in the main process, styled after the Codex IDE extension.
export function CodexChat({ tileId, workspacePath, desktop, visible, session, onSession, onStatus, onOpenFile }: Props) {
  const [state, setState] = useState<CodexState>(() => initialCodexState(session ?? null));
  const [input, setInput] = useState("");
  const [images, setImages] = useState<Array<{ id: string; name: string; mediaType: string; data: string; preview: string }>>([]);
  const [mode, setMode] = useState<Mode>("agent");
  const [model, setModel] = useState("");
  const [effort, setEffort] = useState("");
  const [menu, setMenu] = useState<"mode" | "model" | "history" | null>(null);
  const [threads, setThreads] = useState<Array<{ threadId: string; summary: string; lastModified: number }>>([]);
  const [error, setError] = useState("");
  const [started, setStarted] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const running = state.status === "running";
  const checkpoints = useTurnCheckpoints(workspacePath, desktop);
  const [review, setReview] = useState<TurnCheckpoint | null>(null);
  const wasRunning = useRef(false);
  useEffect(() => { if (wasRunning.current && !running) checkpoints.finish(); wasRunning.current = running; }, [running]); // eslint-disable-line react-hooks/exhaustive-deps

  // Start (or resume) the thread for this tile.
  const start = useCallback(async (threadId: string | null) => {
    const api = window.zevrinDesktop;
    if (!api) return;
    try { await api.codexStart(tileId, workspacePath, { threadId, mode, model: model || null, effort: effort || null }); setStarted(true); setError(""); }
    catch (caught) { setError(cleanError(caught)); }
  }, [tileId, workspacePath]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const api = window.zevrinDesktop;
    if (!desktop || !api) return;
    start(session ?? null);
    if (session) api.codexThreadMessages(workspacePath, session).then(messages => setState(current => current.items.length ? current : { ...current, items: codexHistoryItems(messages) })).catch(() => {});
    const remove = api.onCodexEvent((id, event) => { if (id === tileId) setState(current => applyCodexEvent(current, event)); });
    return () => { remove(); api.codexStop(tileId).catch(() => {}); };
  }, [desktop, tileId, workspacePath]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { onStatus?.(state.status); }, [state.status, onStatus]);
  useEffect(() => { if (state.threadId && state.threadId !== session) onSession(state.threadId); }, [state.threadId]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { const list = listRef.current; if (list) list.scrollTop = list.scrollHeight; }, [state.items, state.notice]);
  useEffect(() => { if (visible) inputRef.current?.focus(); }, [visible]);
  useEffect(() => subscribeCompose(tileId, payload => {
    setInput(current => (current && !current.endsWith("\n") ? current + "\n" : current) + payload.text);
    if (payload.images?.length) setImages(current => [...current, ...payload.images!.map((image, index) => ({ id: `${Date.now()}-${index}`, name: image.name, mediaType: image.mediaType, data: image.data, preview: `data:${image.mediaType};base64,${image.data}` }))].slice(0, 6));
    requestAnimationFrame(() => inputRef.current?.focus());
  }), [tileId]);

  async function configure(changes: { mode?: Mode; model?: string; effort?: string }) {
    if (changes.mode) setMode(changes.mode);
    if ("model" in changes) setModel(changes.model ?? "");
    if ("effort" in changes) setEffort(changes.effort ?? "");
    try { await window.zevrinDesktop?.codexConfigure(tileId, { ...(changes.mode ? { mode: changes.mode } : {}), ...("model" in changes ? { model: changes.model || null } : {}), ...("effort" in changes ? { effort: changes.effort || null } : {}) }); } catch { /* applied on the next start */ }
  }

  async function send() {
    const api = window.zevrinDesktop;
    const text = input.trim();
    if (!api || (!text && images.length === 0) || running) return;
    if (!started) await start(state.threadId);
    const userIndex = state.items.filter(item => item.kind === "user").length;
    setState(current => addCodexUser(current, text || "(image)", images.length));
    setInput(""); const attached = images; setImages([]);
    await checkpoints.begin(text.slice(0, 160) || "(image)", userIndex);
    try { await api.codexSend(tileId, text || "Look at the attached image.", attached.map(image => ({ mediaType: image.mediaType, data: image.data }))); }
    catch (caught) { setState(current => applyCodexEvent(current, { type: "turn.failed", error: { message: cleanError(caught) } })); }
  }

  async function restoreTo(turn: TurnCheckpoint) {
    if (!window.confirm(`Put the project back as it was before “${turn.label}”? The changes made since (by Codex or by you) are undone.`)) return;
    try { const count = await checkpoints.restore(turn.id); setError(""); setState(current => ({ ...current, notice: null, items: [...current.items, { id: `restore-${Date.now()}`, kind: "notice", tone: "info", text: count ? `Restored ${count} file${count === 1 ? "" : "s"} to before “${turn.label}”.` : "Nothing to restore: no file changed since then." }] })); }
    catch (caught) { setError(cleanError(caught)); }
  }

  async function newThread() {
    if (running) return;
    setState(initialCodexState()); onSession(undefined); checkpoints.reset();
    try { await window.zevrinDesktop?.codexConfigure(tileId, { threadId: null }); } catch { await start(null); }
    inputRef.current?.focus();
  }

  async function openHistory() {
    if (menu === "history") { setMenu(null); return; }
    setMenu("history");
    try { setThreads(await window.zevrinDesktop!.codexThreads(workspacePath)); } catch { setThreads([]); }
  }

  async function resume(threadId: string) {
    setMenu(null);
    const messages = await window.zevrinDesktop!.codexThreadMessages(workspacePath, threadId).catch(() => []);
    setState({ ...initialCodexState(threadId), items: codexHistoryItems(messages) });
    onSession(threadId);
    try { await window.zevrinDesktop!.codexConfigure(tileId, { threadId }); } catch { await start(threadId); }
  }

  async function addFiles(list: FileList | File[] | null) {
    if (!list) return;
    const files = Array.from(list).filter(file => imageTypes.includes(file.type)).slice(0, 6);
    const loaded = await Promise.all(files.map(async file => { const url = await readFileAsDataUrl(file); return { id: `${Date.now()}-${file.name}`, name: file.name, mediaType: file.type, data: url.split(",")[1] ?? "", preview: url }; }));
    setImages(current => [...current, ...loaded].slice(0, 6));
  }

  const title = state.items.find(item => item.kind === "user")?.["text" as keyof CodexItem] as string | undefined;

  if (!desktop) return <div className="codex-view"><div className="codex-welcome"><CodexMark/><p>Open the Zevrin desktop app to use Codex here.</p></div></div>;

  return <div className="codex-view" onDragOver={event => { if (event.dataTransfer.types.includes("Files")) event.preventDefault(); }} onDrop={event => { if (event.dataTransfer.files.length) { event.preventDefault(); addFiles(event.dataTransfer.files); } }}>
    {review && <AgentReview root={workspacePath} checkpoint={review} title={review.label} onClose={() => setReview(null)} onKeepAll={() => checkpoints.accept(review.id)} onOpenFile={onOpenFile} onChanged={() => checkpoints.refresh()}/>}
    <div className="codex-header">
      <strong className="codex-title">{title ? title.split("\n")[0].slice(0, 60) : "Codex"}</strong>
      {(state.usage.input + state.usage.output) > 0 && <span className="codex-usage" title="Tokens used in this tile">{Math.round((state.usage.input + state.usage.output) / 1000)}k tok</span>}
      <button type="button" className="codex-icon" title="Past threads" aria-label="Past threads" aria-expanded={menu === "history"} onClick={openHistory}>⟲</button>
      <button type="button" className="codex-icon" title="New thread" aria-label="New thread" onClick={newThread}>＋</button>
      {menu === "history" && <div className="codex-popover codex-history" role="listbox" onMouseLeave={() => setMenu(null)}>
        {threads.length === 0 && <span className="codex-muted">No Codex threads in this project yet.</span>}
        {threads.map(thread => <button key={thread.threadId} type="button" role="option" aria-selected={thread.threadId === state.threadId} onClick={() => resume(thread.threadId)}><span>{thread.summary}</span><small>{relativeTime(thread.lastModified)}</small></button>)}
      </div>}
    </div>
    <div className="codex-list" ref={listRef}>
      {state.items.length === 0 && <div className="codex-welcome"><CodexMark/><h2>Codex</h2><p>Ask Codex to build, fix or explain. It works in this project with your Codex sign-in and settings.</p></div>}
      {(() => { let ordinal = -1; return state.items.map(item => {
        if (item.kind !== "user") return <CodexRow key={item.id} item={item} onOpenFile={onOpenFile}/>;
        ordinal += 1;
        const turn = checkpoints.turns.find(entry => entry.userIndex === ordinal);
        return <div key={item.id} className="chat-turn-anchor"><CodexRow item={item} onOpenFile={onOpenFile}/>{turn && !running && <RestoreButton onRestore={() => restoreTo(turn)}/>}</div>;
      }); })()}
      {!running && checkpoints.turns.length > 0 && <ChangesCard turn={checkpoints.turns[checkpoints.turns.length - 1]} onReview={() => setReview(checkpoints.turns[checkpoints.turns.length - 1])} onUndo={() => restoreTo(checkpoints.turns[checkpoints.turns.length - 1])}/>}
      {running && <div className="codex-working"><span className="codex-spinner"/>{state.notice ?? "Working…"}</div>}
      {error && <div className="codex-notice error">{error}</div>}
    </div>
    <form className="codex-composer-wrap" onSubmit={event => { event.preventDefault(); send(); }}>
      {images.length > 0 && <div className="chat-attachments">{images.map(image => <span key={image.id} className="chat-attachment"><img src={image.preview} alt={image.name}/><button type="button" aria-label={`Remove ${image.name}`} onClick={() => setImages(current => current.filter(item => item.id !== image.id))}>×</button></span>)}</div>}
      <div className="codex-composer">
        <textarea ref={inputRef} aria-label="Message Codex" rows={1} placeholder={running ? "Codex is working…" : "Ask Codex to do anything"} value={input} onChange={event => setInput(event.target.value)} onKeyDown={event => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); send(); } }} onPaste={event => { const files = Array.from(event.clipboardData.files).filter(file => imageTypes.includes(file.type)); if (files.length) { event.preventDefault(); addFiles(files); } }}/>
        <input ref={fileRef} type="file" accept={imageTypes.join(",")} multiple className="visually-hidden" onChange={event => { addFiles(event.currentTarget.files); event.currentTarget.value = ""; }}/>
        <div className="codex-bar">
          <button type="button" className="codex-icon" title="Attach images" aria-label="Attach images" onClick={() => fileRef.current?.click()}>＋</button>
          <div className="codex-menu-wrap">
            <button type="button" className="codex-chip" aria-haspopup="menu" aria-expanded={menu === "mode"} onClick={() => setMenu(open => open === "mode" ? null : "mode")}>{modes.find(([id]) => id === mode)?.[1]} ▾</button>
            {menu === "mode" && <div className="codex-popover codex-up" role="menu" onMouseLeave={() => setMenu(null)}>{modes.map(([id, label, help]) => <button key={id} type="button" role="menuitemradio" aria-checked={id === mode} className={id === mode ? "selected" : undefined} onClick={() => { configure({ mode: id }); setMenu(null); }}><span>{label}</span><small>{help}</small></button>)}</div>}
          </div>
          <div className="codex-menu-wrap">
            <button type="button" className="codex-chip" aria-haspopup="menu" aria-expanded={menu === "model"} onClick={() => setMenu(open => open === "model" ? null : "model")}>{model || "Default model"}{effort ? ` · ${effort}` : ""} ▾</button>
            {menu === "model" && <div className="codex-popover codex-up codex-model-menu" role="menu">
              <label className="codex-field"><span>Model</span><input placeholder="Default from ~/.codex/config.toml" value={model} onChange={event => configure({ model: event.target.value.trim() })}/></label>
              <div className="codex-field"><span>Reasoning</span><div className="codex-efforts">{efforts.map(level => <button key={level || "default"} type="button" className={level === effort ? "selected" : undefined} onClick={() => configure({ effort: level })}>{level || "default"}</button>)}</div></div>
              <button type="button" className="codex-done" onClick={() => setMenu(null)}>Done</button>
            </div>}
          </div>
          <span className="chat-spacer"/>
          {running ? <button type="button" className="codex-send stop" aria-label="Stop" title="Stop" onClick={() => window.zevrinDesktop?.codexInterrupt(tileId)}>■</button>
            : <button type="submit" className="codex-send" aria-label="Send" title="Send (Enter)" disabled={!input.trim() && images.length === 0}>↑</button>}
        </div>
      </div>
    </form>
  </div>;
}

function CodexRow({ item, onOpenFile }: { item: CodexItem; onOpenFile?: (path: string) => void }) {
  if (item.kind === "user") return <div className="codex-user"><div>{item.images ? <small>🖼 {item.images} image{item.images > 1 ? "s" : ""}</small> : null}<Markdown text={item.text}/></div></div>;
  if (item.kind === "message") return <div className="codex-message"><Markdown text={item.text}/></div>;
  if (item.kind === "reasoning") return item.text ? <details className="codex-reasoning"><summary>Thinking</summary><Markdown text={item.text}/></details> : null;
  if (item.kind === "command") return <details className={"codex-card" + (item.status === "failed" || (item.exitCode ?? 0) !== 0 ? " failed" : "")}>
    <summary><span className="codex-card-kind">Ran</span><code>{item.command}</code><span className="codex-card-state">{item.status === "in_progress" ? "…" : item.exitCode === null ? "" : item.exitCode === 0 ? "✓" : `exit ${item.exitCode}`}</span></summary>
    {item.output && <pre>{item.output.slice(-6000)}</pre>}
  </details>;
  if (item.kind === "files") return <div className="codex-card files"><div className="codex-card-head"><span className="codex-card-kind">{item.status === "failed" ? "Failed to edit" : "Edited"}</span><span>{item.changes.length} file{item.changes.length === 1 ? "" : "s"}</span></div>{item.changes.map(change => <button key={change.path} type="button" className="codex-file" onClick={() => onOpenFile?.(change.path)}><span className={"codex-change " + change.kind}>{change.kind === "add" ? "A" : change.kind === "delete" ? "D" : "M"}</span>{change.path}</button>)}</div>;
  if (item.kind === "mcp") return <div className={"codex-card" + (item.error ? " failed" : "")}><div className="codex-card-head"><span className="codex-card-kind">Tool</span><code>{item.server}.{item.tool}</code><span className="codex-card-state">{item.status === "in_progress" ? "…" : item.error ? "failed" : "✓"}</span></div>{item.error && <pre>{item.error}</pre>}</div>;
  if (item.kind === "search") return <div className="codex-card"><div className="codex-card-head"><span className="codex-card-kind">Searched</span><span>{item.query}</span></div></div>;
  if (item.kind === "todos") return <div className="codex-card todos"><div className="codex-card-head"><span className="codex-card-kind">Plan</span><span>{item.todos.filter(todo => todo.completed).length}/{item.todos.length}</span></div><ul>{item.todos.map((todo, index) => <li key={index} className={todo.completed ? "done" : undefined}>{todo.text}</li>)}</ul></div>;
  return <div className={"codex-notice " + item.tone}>{item.text}</div>;
}

function CodexMark() {
  return <svg className="codex-mark" width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true"><path d="M8.5 9 11 12l-2.5 3M13 15h3"/><rect x="3" y="4" width="18" height="16" rx="4"/></svg>;
}
