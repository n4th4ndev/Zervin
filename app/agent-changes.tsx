"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { CheckpointFileChange } from "../types/desktop";

// Checkpoints around agent turns: a snapshot of the project is taken when a message is sent, so what the agent then
// changed can be summed up, reviewed hunk by hunk (keep / undo) and rolled back ("Restore to here").

export type TurnCheckpoint = { id: string; at: number; userIndex: number; label: string; accepted?: boolean; summary?: { files: number; additions: number; deletions: number } };

function cleanError(error: unknown, fallback: string) {
  return (error instanceof Error ? error.message : "").replace(/^Error invoking remote method '[^']+': (Error: )?/, "") || fallback;
}

export function summarize(changes: CheckpointFileChange[]) {
  return { files: changes.length, additions: changes.reduce((sum, file) => sum + file.additions, 0), deletions: changes.reduce((sum, file) => sum + file.deletions, 0) };
}

// One list of checkpoints per chat. `begin` snapshots the project before a message goes out (waiting at most a few
// seconds so a huge project never blocks the chat); when the turn ends, `finish` sums up what changed since.
export function useTurnCheckpoints(root: string, desktop: boolean) {
  const [turns, setTurns] = useState<TurnCheckpoint[]>([]);
  const turnsRef = useRef(turns);
  useEffect(() => { turnsRef.current = turns; }, [turns]);

  const begin = useCallback(async (label: string, userIndex: number) => {
    const api = window.zevrinDesktop;
    if (!desktop || !api?.checkpointCreate || !root) return;
    const created = api.checkpointCreate(root, label).then(checkpoint => { setTurns(current => [...current, { id: checkpoint.id, at: checkpoint.at, userIndex, label }]); return true; }).catch(() => false);
    await Promise.race([created, new Promise(resolve => setTimeout(resolve, 4000))]);
  }, [desktop, root]);

  const refresh = useCallback(async (id?: string) => {
    const api = window.zevrinDesktop;
    const turn = id ? turnsRef.current.find(item => item.id === id) : turnsRef.current[turnsRef.current.length - 1];
    if (!api?.checkpointChanges || !turn) return null;
    try {
      const changes = await api.checkpointChanges(root, turn.id);
      const summary = summarize(changes);
      setTurns(current => current.map(item => item.id === turn.id ? { ...item, summary } : item));
      return changes;
    } catch { return null; }
  }, [root]);

  const restore = useCallback(async (id: string) => {
    const api = window.zevrinDesktop;
    if (!api?.checkpointRestore) return 0;
    const count = await api.checkpointRestore(root, id);
    await refresh();
    return count;
  }, [root, refresh]);

  const reset = useCallback(() => setTurns([]), []);
  // "Keep all": the turn's changes are accepted and its card goes away.
  const accept = useCallback((id: string) => setTurns(current => current.map(item => item.id === id ? { ...item, accepted: true } : item)), []);
  return { turns, begin, finish: refresh, refresh, restore, reset, accept };
}

// "3 files changed +42 −7 · Review · Undo" under the agent's last answer.
export function ChangesCard({ turn, onReview, onUndo }: { turn: TurnCheckpoint; onReview: () => void; onUndo: () => void }) {
  if (!turn.summary || turn.summary.files === 0 || turn.accepted) return null;
  const { files, additions, deletions } = turn.summary;
  return <div className="changes-card" role="status">
    <span className="changes-card-icon" aria-hidden="true">±</span>
    <span className="changes-card-text"><strong>{files} file{files === 1 ? "" : "s"} changed</strong><span className="changes-add">+{additions}</span><span className="changes-del">−{deletions}</span></span>
    <button type="button" className="changes-review" onClick={onReview}>Review</button>
    <button type="button" className="changes-undo" onClick={onUndo} title="Put every file back as it was before this turn">Undo</button>
  </div>;
}

// Small "Restore to here" action shown on a user message that has a checkpoint.
export function RestoreButton({ onRestore }: { onRestore: () => void }) {
  return <button type="button" className="restore-checkpoint" onClick={onRestore} title="Put the project back as it was before this message (undoes the agent's changes since)">↺ Restore to here</button>;
}

type ReviewProps = { root: string; checkpoint: TurnCheckpoint; title: string; onClose: () => void; onKeepAll?: () => void; onOpenFile?: (path: string) => void; onChanged?: () => void };

const hunkKey = (file: string, hunk: { header: string; lines: string[] }) => file + "\u0000" + hunk.header + "\u0000" + hunk.lines.join("\n");

// Full-window review of what an agent turn changed: files on the left, hunks on the right with Keep / Undo.
export function AgentReview({ root, checkpoint, title, onClose, onKeepAll, onOpenFile, onChanged }: ReviewProps) {
  const [changes, setChanges] = useState<CheckpointFileChange[] | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [kept, setKept] = useState<Set<string>>(() => new Set());
  const [selected, setSelected] = useState<string | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    const api = window.zevrinDesktop;
    if (!api?.checkpointChanges) return;
    try { const next = await api.checkpointChanges(root, checkpoint.id); setChanges(next); setError(""); }
    catch (reason) { setError(cleanError(reason, "The changes could not be read.")); }
  }, [root, checkpoint.id]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); }; window.addEventListener("keydown", onKey); return () => window.removeEventListener("keydown", onKey); }, [onClose]);

  const visible = useMemo(() => (changes ?? []).map(file => ({ ...file, hunks: file.hunks.map((hunk, index) => ({ ...hunk, index })).filter(hunk => !kept.has(hunkKey(file.path, hunk))) })).filter(file => file.hunks.length > 0 || (file.binary && !kept.has(file.path))), [changes, kept]);
  const total = summarize(changes ?? []);

  async function act(key: string, work: () => Promise<unknown>) {
    setBusy(key);
    try { await work(); await load(); onChanged?.(); }
    catch (reason) { setError(cleanError(reason, "That change could not be undone.")); }
    finally { setBusy(null); }
  }
  const api = () => window.zevrinDesktop!;
  const undoHunk = (file: string, index: number) => act(`${file}#${index}`, () => api().checkpointRevertHunk(root, checkpoint.id, file, index));
  const undoFile = (file: string) => act(file, () => api().checkpointRevertFile(root, checkpoint.id, file));
  const undoAll = () => act("all", () => api().checkpointRestore(root, checkpoint.id));
  const keepHunk = (file: string, hunk: { header: string; lines: string[] }) => setKept(current => new Set(current).add(hunkKey(file, hunk)));
  const keepFile = (file: CheckpointFileChange) => setKept(current => { const next = new Set(current); file.hunks.forEach(hunk => next.add(hunkKey(file.path, hunk))); next.add(file.path); return next; });
  const jump = (file: string) => { setSelected(file); bodyRef.current?.querySelector(`[data-review-file="${CSS.escape(file)}"]`)?.scrollIntoView({ behavior: "smooth", block: "start" }); };

  return createPortal(<div className="scrim review-scrim" role="dialog" aria-modal="true" aria-label="Review the agent's changes" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="review-sheet">
      <header className="review-head">
        <div className="review-title"><span className="review-kicker">Review changes</span><strong title={title}>{title || "Agent turn"}</strong></div>
        <span className="review-stats"><span>{total.files} file{total.files === 1 ? "" : "s"}</span><span className="changes-add">+{total.additions}</span><span className="changes-del">−{total.deletions}</span></span>
        <span className="chat-spacer"/>
        <button type="button" className="review-button danger" disabled={busy !== null || !changes?.length} onClick={undoAll}>Undo all</button>
        <button type="button" className="review-button primary" onClick={() => { onKeepAll?.(); onClose(); }}>{visible.length ? "Keep all" : "Done"}</button>
        <button type="button" className="review-close" aria-label="Close" onClick={onClose}>×</button>
      </header>
      {error && <div className="review-error">{error}</div>}
      <div className="review-main">
        <nav className="review-files" aria-label="Changed files">
          {(changes ?? []).map(file => {
            const pending = visible.some(item => item.path === file.path);
            return <button key={file.path} type="button" className={"review-file" + (selected === file.path ? " selected" : "") + (pending ? "" : " done")} onClick={() => jump(file.path)} title={file.path}>
              <span className={"review-status " + file.status}>{file.status === "added" ? "A" : file.status === "deleted" ? "D" : "M"}</span>
              <span className="review-file-name">{file.path.split("/").pop()}<small>{file.path.includes("/") ? file.path.slice(0, file.path.lastIndexOf("/")) : ""}</small></span>
              <span className="review-file-counts"><span className="changes-add">+{file.additions}</span><span className="changes-del">−{file.deletions}</span></span>
            </button>;
          })}
          {changes && changes.length === 0 && <p className="review-empty-note">Nothing changed since this checkpoint.</p>}
        </nav>
        <div className="review-body" ref={bodyRef}>
          {!changes && !error && <div className="review-empty">Reading the changes…</div>}
          {changes && visible.length === 0 && <div className="review-empty"><strong>{changes.length ? "All changes reviewed" : "No changes"}</strong><span>{changes.length ? "Everything left is kept." : "The agent did not change any file in this turn."}</span></div>}
          {visible.map(file => <section key={file.path} className="review-file-block" data-review-file={file.path}>
            <div className="review-file-head">
              <span className={"review-status " + file.status}>{file.status === "added" ? "A" : file.status === "deleted" ? "D" : "M"}</span>
              <button type="button" className="review-path" onClick={() => file.status !== "deleted" && onOpenFile?.(file.path)} title={file.status === "deleted" ? file.path : "Open in the editor"}>{file.path}</button>
              <span className="chat-spacer"/>
              <button type="button" className="review-button" disabled={busy !== null} onClick={() => keepFile(file)}>Keep file</button>
              <button type="button" className="review-button danger" disabled={busy !== null} onClick={() => undoFile(file.path)}>{file.status === "added" ? "Delete file" : file.status === "deleted" ? "Restore file" : "Undo file"}</button>
            </div>
            {file.binary && <div className="review-binary">Binary file changed.</div>}
            {file.hunks.map(hunk => {
              let oldLine = hunk.oldStart, newLine = hunk.newStart;
              return <div key={hunk.header + hunk.index} className={"review-hunk" + (busy === `${file.path}#${hunk.index}` ? " busy" : "")}>
                <div className="review-hunk-head"><code>{hunk.context || `Line ${hunk.newStart}`}</code><span className="chat-spacer"/>
                  <button type="button" className="review-chip keep" disabled={busy !== null} onClick={() => keepHunk(file.path, hunk)}>✓ Keep</button>
                  <button type="button" className="review-chip undo" disabled={busy !== null} onClick={() => undoHunk(file.path, hunk.index)}>↺ Undo</button>
                </div>
                <pre className="review-lines">{hunk.lines.filter(line => !line.startsWith("\\")).map((line, index) => {
                  const kind = line[0] === "+" ? "add" : line[0] === "-" ? "del" : "ctx";
                  const left = kind === "add" ? "" : String(oldLine++);
                  const right = kind === "del" ? "" : String(newLine++);
                  return <div key={index} className={"review-line " + kind}><span className="review-ln">{left}</span><span className="review-ln">{right}</span><span className="review-sign">{kind === "add" ? "+" : kind === "del" ? "−" : " "}</span><span className="review-code">{line.slice(1) || " "}</span></div>;
                })}</pre>
              </div>;
            })}
          </section>)}
        </div>
      </div>
    </div>
  </div>, document.body);
}
