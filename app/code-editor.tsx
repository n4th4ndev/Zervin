"use client";

import { useEffect, useRef, useState } from "react";
import type { InlineEditRequest } from "../types/desktop";
import type * as Monaco from "monaco-editor";

type MonacoModule = typeof Monaco;
let monacoPromise: Promise<MonacoModule> | null = null;

// Loads Monaco once, with its web workers when the bundler can build them and a graceful fallback otherwise.
function loadMonaco(): Promise<MonacoModule> {
  if (!monacoPromise) {
    monacoPromise = (async () => {
      const environment = self as unknown as { MonacoEnvironment?: { getWorker?: (id: string, label: string) => Worker } };
      environment.MonacoEnvironment = {
        getWorker(_id: string, label: string) {
          try {
            if (label === "json") return new Worker(new URL("monaco-editor/language/json/json.worker.js", import.meta.url), { type: "module" });
            if (label === "css" || label === "scss" || label === "less") return new Worker(new URL("monaco-editor/language/css/css.worker.js", import.meta.url), { type: "module" });
            if (label === "html" || label === "handlebars" || label === "razor") return new Worker(new URL("monaco-editor/language/html/html.worker.js", import.meta.url), { type: "module" });
            if (label === "typescript" || label === "javascript") return new Worker(new URL("monaco-editor/language/typescript/ts.worker.js", import.meta.url), { type: "module" });
            return new Worker(new URL("monaco-editor/editor/editor.worker.start.js", import.meta.url), { type: "module" });
          } catch {
            // Without workers Monaco still highlights and edits; language services degrade to basic mode.
            return new Worker(URL.createObjectURL(new Blob(["self.onmessage=()=>{}"], { type: "text/javascript" })));
          }
        },
      };
      const monaco = await import("monaco-editor");
      monaco.editor.defineTheme("zevrin-dark", {
        base: "vs-dark", inherit: true,
        rules: [],
        colors: { "editor.background": "#101013", "editor.lineHighlightBackground": "#ffffff08", "editorLineNumber.foreground": "#4b4b53", "editorLineNumber.activeForeground": "#a1a1aa", "editorGutter.background": "#101013", "editor.selectionBackground": "#5969f544", "editorIndentGuide.background1": "#ffffff10", "scrollbarSlider.background": "#ffffff14", "minimap.background": "#0d0d10", "editorWidget.background": "#17171a", "input.background": "#0b0b0d" },
      });
      return monaco;
    })();
  }
  return monacoPromise;
}

export function languageForPath(monaco: MonacoModule, path: string) {
  const name = path.split("/").pop() || path;
  const extension = name.includes(".") ? "." + name.split(".").pop()!.toLowerCase() : "";
  for (const language of monaco.languages.getLanguages()) {
    if (language.filenames?.some(item => item.toLowerCase() === name.toLowerCase())) return language.id;
    if (extension && language.extensions?.some(item => item.toLowerCase() === extension)) return language.id;
  }
  return "plaintext";
}

export type EditorSelection = { text: string; startLine: number; endLine: number };
export type EditorApi = { selection: () => EditorSelection | null; lineCount: () => number; inlineEdit: () => void };
type EditorProps = { path: string; value: string; fontSize: number; revealLine?: number | null; onChange: (value: string) => void; onSave: () => void; onRevealed?: () => void; apiRef?: import("react").MutableRefObject<EditorApi | null>; onInlineEdit?: (request: InlineEditRequest) => Promise<{ code: string }>; onInlineEditCancel?: () => void };

// ⌘K session: the prompt box, then Claude's proposal applied in place (new lines in green, the replaced code shown
// struck through above them) until it is accepted or rejected.
type InlineSession = { phase: "prompt" | "loading" | "review"; instruction: string; error: string; range: Monaco.IRange; original: string; prefix: string; newRange?: Monaco.IRange; top: number; left: number };

export function CodeEditor({ path, value, fontSize, revealLine, onChange, onSave, onRevealed, apiRef, onInlineEdit, onInlineEditCancel }: EditorProps) {
  const [inline, setInline] = useState<InlineSession | null>(null);
  const inlineRef = useRef<InlineSession | null>(null);
  const inlineMarks = useRef<{ decorations: Monaco.editor.IEditorDecorationsCollection | null; zone: string | null }>({ decorations: null, zone: null });
  const promptRef = useRef<HTMLInputElement>(null);
  const acceptRef = useRef<HTMLButtonElement>(null);
  const onInlineEditRef = useRef(onInlineEdit);
  useEffect(() => { onInlineEditRef.current = onInlineEdit; inlineRef.current = inline; });
  const hostRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null);
  const monacoRef = useRef<MonacoModule | null>(null);
  const onChangeRef = useRef(onChange);
  const onSaveRef = useRef(onSave);
  const valueRef = useRef(value);
  useEffect(() => { onChangeRef.current = onChange; onSaveRef.current = onSave; });

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let disposed = false;
    let editor: Monaco.editor.IStandaloneCodeEditor | null = null;
    loadMonaco().then(monaco => {
      if (disposed) return;
      monacoRef.current = monaco;
      editor = monaco.editor.create(host, {
        value: valueRef.current, language: languageForPath(monaco, path), theme: "zevrin-dark", fontSize, fontFamily: "Geist Mono, SFMono-Regular, Menlo, monospace", fontLigatures: true,
        automaticLayout: true, minimap: { enabled: true, renderCharacters: false, scale: 1 }, scrollBeyondLastLine: false, smoothScrolling: true, cursorBlinking: "smooth", cursorSmoothCaretAnimation: "on",
        renderWhitespace: "selection", bracketPairColorization: { enabled: true }, guides: { bracketPairs: true, indentation: true }, padding: { top: 12, bottom: 12 }, tabSize: 2, wordWrap: "off", lineNumbersMinChars: 4, folding: true, linkedEditing: true, stickyScroll: { enabled: true },
      });
      editorRef.current = editor;
      editor.onDidChangeModelContent(() => { const next = editor!.getValue(); valueRef.current = next; onChangeRef.current(next); });
      editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => onSaveRef.current());
      editor.addAction({ id: "zevrin.inlineEdit", label: "Edit with Claude", keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyK], contextMenuGroupId: "1_zevrin", contextMenuOrder: 0, run: () => openInlineEdit() });
      editor.onDidScrollChange(() => { if (inlineRef.current) setInline(current => current ? { ...current, ...inlinePosition(current.newRange ?? current.range, current.phase === "review") } : current); });
      if (apiRef) apiRef.current = {
        selection: () => { const selection = editor!.getSelection(); const model = editor!.getModel(); if (!selection || !model || selection.isEmpty()) return null; return { text: model.getValueInRange(selection), startLine: selection.startLineNumber, endLine: selection.endLineNumber }; },
        lineCount: () => editor!.getModel()?.getLineCount() ?? 0,
        inlineEdit: () => { editor!.focus(); openInlineEdit(); },
      };
      editor.focus();
    }).catch(error => { host.textContent = "The code editor could not load: " + (error instanceof Error ? error.message : String(error)); });
    return () => { disposed = true; editor?.dispose(); editorRef.current = null; if (apiRef) apiRef.current = null; };
  }, [path]); // eslint-disable-line react-hooks/exhaustive-deps

  // External value changes (discard, checkout, reload) update the model without disturbing local edits.
  useEffect(() => {
    const editor = editorRef.current;
    if (!editor || value === valueRef.current) return;
    valueRef.current = value;
    const position = editor.getPosition();
    editor.setValue(value);
    if (position) editor.setPosition(position);
  }, [value]);

  useEffect(() => { editorRef.current?.updateOptions({ fontSize }); }, [fontSize]);

  // Where the ⌘K box goes: just above the first line of the range (below it when that line is at the top).
  function inlinePosition(range: Monaco.IRange, below = false) {
    const editor = editorRef.current;
    if (!editor) return { top: 8, left: 60 };
    const layout = editor.getLayoutInfo();
    const start = editor.getScrolledVisiblePosition({ lineNumber: range.startLineNumber, column: 1 });
    const end = editor.getScrolledVisiblePosition({ lineNumber: range.endLineNumber, column: 1 });
    const lineHeight = editor.getOption(monacoRef.current!.editor.EditorOption.lineHeight);
    const above = (start?.top ?? 0) - 46;
    const top = above >= 4 && !below ? above : (end?.top ?? 0) + lineHeight + 6;
    return { top: Math.max(4, Math.min(top, layout.height - 50)), left: Math.max(8, layout.contentLeft - 4) };
  }

  function openInlineEdit() {
    const editor = editorRef.current;
    const model = editor?.getModel();
    if (!editor || !model || !onInlineEditRef.current) return;
    if (inlineRef.current?.phase === "review") return;
    const selection = editor.getSelection() ?? { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 };
    // A selection is widened to whole lines so the answer never has to guess partial indentation.
    const empty = selection.startLineNumber === selection.endLineNumber && selection.startColumn === selection.endColumn;
    const line = selection.startLineNumber;
    const lastLine = model.getLineCount();
    let range: Monaco.IRange;
    let prefix = "";
    if (empty) {
      // No selection: fill a blank line, otherwise write on a new line below the cursor's line.
      if (!model.getLineContent(line).trim()) range = { startLineNumber: line, startColumn: 1, endLineNumber: line, endColumn: model.getLineMaxColumn(line) };
      else if (line < lastLine) range = { startLineNumber: line + 1, startColumn: 1, endLineNumber: line + 1, endColumn: 1 };
      else { range = { startLineNumber: line, startColumn: model.getLineMaxColumn(line), endLineNumber: line, endColumn: model.getLineMaxColumn(line) }; prefix = "\n"; }
    } else {
      range = { startLineNumber: selection.startLineNumber, startColumn: 1, endLineNumber: selection.endColumn === 1 && selection.endLineNumber > selection.startLineNumber ? selection.endLineNumber : selection.endLineNumber + 1, endColumn: 1 };
      if (range.endLineNumber > lastLine) range = { ...range, endLineNumber: lastLine, endColumn: model.getLineMaxColumn(lastLine) };
    }
    setInline({ phase: "prompt", instruction: inlineRef.current?.instruction ?? "", error: "", range, original: model.getValueInRange(range), prefix, ...inlinePosition(range) });
  }

  function clearInlineMarks() {
    const editor = editorRef.current;
    inlineMarks.current.decorations?.clear();
    if (editor && inlineMarks.current.zone) { const zone = inlineMarks.current.zone; editor.changeViewZones(accessor => accessor.removeZone(zone)); }
    inlineMarks.current = { decorations: null, zone: null };
  }

  async function submitInlineEdit() {
    const editor = editorRef.current;
    const model = editor?.getModel();
    const session = inlineRef.current;
    if (!editor || !model || !session || !session.instruction.trim() || !onInlineEditRef.current) return;
    setInline({ ...session, phase: "loading", error: "" });
    const full = model.getFullModelRange();
    try {
      const answer = await onInlineEditRef.current({
        path, language: model.getLanguageId(), instruction: session.instruction.trim(), selection: session.original,
        before: model.getValueInRange({ startLineNumber: 1, startColumn: 1, endLineNumber: session.range.startLineNumber, endColumn: session.range.startColumn }),
        after: model.getValueInRange({ startLineNumber: session.range.endLineNumber, startColumn: session.range.endColumn, endLineNumber: full.endLineNumber, endColumn: full.endColumn }),
      });
      if (inlineRef.current?.phase !== "loading" || editorRef.current !== editor) return;
      let code = session.prefix + answer.code;
      if (!session.original && !session.prefix && code && !code.endsWith("\n")) code += "\n";
      // Apply the proposal in place so it reads in context; the original text is kept to restore on reject.
      editor.pushUndoStop();
      editor.executeEdits("zevrin-inline", [{ range: session.range, text: code, forceMoveMarkers: true }]);
      editor.pushUndoStop();
      const lines = code.split("\n");
      const endLineNumber = session.range.startLineNumber + lines.length - 1;
      const endColumn = lines.length === 1 ? session.range.startColumn + lines[0].length : lines[lines.length - 1].length + 1;
      const newRange = { startLineNumber: session.range.startLineNumber, startColumn: session.range.startColumn, endLineNumber, endColumn };
      clearInlineMarks();
      const lastAdded = code.endsWith("\n") ? Math.max(session.range.startLineNumber, endLineNumber - 1) : endLineNumber;
      const firstAdded = session.prefix ? session.range.startLineNumber + 1 : session.range.startLineNumber;
      if (code.length) inlineMarks.current.decorations = editor.createDecorationsCollection([{ range: { startLineNumber: firstAdded, startColumn: 1, endLineNumber: lastAdded, endColumn: 1 }, options: { isWholeLine: true, className: "inline-edit-added", linesDecorationsClassName: "inline-edit-added-gutter" } }]);
      const removed = session.original.replace(/\n$/, "");
      if (removed) {
        const node = document.createElement("div");
        node.className = "inline-edit-removed";
        node.style.lineHeight = editor.getOption(monacoRef.current!.editor.EditorOption.lineHeight) + "px";
        node.style.fontSize = editor.getOption(monacoRef.current!.editor.EditorOption.fontSize) + "px";
        for (const line of removed.split("\n")) { const row = document.createElement("div"); row.textContent = line || " "; node.appendChild(row); }
        editor.changeViewZones(accessor => { inlineMarks.current.zone = accessor.addZone({ afterLineNumber: session.range.startLineNumber - 1, heightInLines: removed.split("\n").length, domNode: node }); });
      }
      editor.revealRangeInCenterIfOutsideViewport(newRange);
      setInline({ ...session, phase: "review", newRange, error: "", ...inlinePosition(newRange, true) });
    } catch (error) {
      if (inlineRef.current?.phase === "loading") setInline({ ...session, phase: "prompt", error: (error instanceof Error ? error.message : String(error)).replace(/^Error invoking remote method '[^']+': (Error: )?/, "") });
    }
  }

  // Keys while ⌘K is open, wherever the focus is: Esc cancels or rejects, ⌘⏎ accepts.
  useEffect(() => {
    if (!inline) return;
    if (inline.phase === "prompt") promptRef.current?.focus();
    if (inline.phase === "review") acceptRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); rejectInlineEdit(); }
      else if (inline.phase === "review" && event.key === "Enter" && (event.metaKey || event.ctrlKey)) { event.preventDefault(); event.stopPropagation(); acceptInlineEdit(); }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [inline?.phase]); // eslint-disable-line react-hooks/exhaustive-deps

  function acceptInlineEdit() { clearInlineMarks(); setInline(null); editorRef.current?.focus(); }
  function rejectInlineEdit() {
    const editor = editorRef.current;
    const session = inlineRef.current;
    if (editor && session?.phase === "review" && session.newRange) {
      editor.pushUndoStop();
      editor.executeEdits("zevrin-inline", [{ range: session.newRange, text: session.original, forceMoveMarkers: true }]);
      editor.pushUndoStop();
    }
    if (session?.phase === "loading") onInlineEditCancel?.();
    clearInlineMarks(); setInline(null); editor?.focus();
  }
  useEffect(() => () => { clearInlineMarks(); setInline(null); }, [path]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor || !revealLine) return;
    editor.revealLineInCenter(revealLine);
    editor.setPosition({ lineNumber: revealLine, column: 1 });
    editor.focus();
    onRevealed?.();
  }, [revealLine, onRevealed]);

  return <div className="code-editor-wrap">
    <div className="code-editor-host" ref={hostRef}/>
    {inline && <div className={"inline-edit inline-edit-" + inline.phase} style={{ top: inline.top, left: inline.left }}>
      <span className="inline-edit-mark" aria-hidden="true">⌘K</span>
      {inline.phase === "review"
        ? <><span className="inline-edit-label">Claude’s edit</span><button ref={acceptRef} type="button" className="inline-edit-accept" onClick={acceptInlineEdit}>Accept <kbd>⏎</kbd></button><button type="button" className="inline-edit-reject" onClick={rejectInlineEdit}>Reject <kbd>Esc</kbd></button></>
        : <><input ref={promptRef} aria-label="Edit instruction" placeholder={inline.original ? "Edit the selection… (e.g. add error handling)" : "Write code here… (e.g. a debounce helper)"} value={inline.instruction} disabled={inline.phase === "loading"} onChange={event => { const instruction = event.target.value; setInline(current => current ? { ...current, instruction } : current); }} onKeyDown={event => { if (event.key === "Enter") { event.preventDefault(); submitInlineEdit(); } }}/>
          {inline.phase === "loading" ? <span className="inline-edit-working"><i/>Claude is editing…</span> : <button type="button" className="inline-edit-go" disabled={!inline.instruction.trim()} onClick={submitInlineEdit}>Generate <kbd>⏎</kbd></button>}
          <button type="button" className="inline-edit-close" aria-label="Cancel" onClick={rejectInlineEdit}>×</button></>}
      {inline.error && <span className="inline-edit-error">{inline.error}</span>}
    </div>}
  </div>;
}

type DiffProps = { path: string; original: string; modified: string; fontSize: number };

export function CodeDiff({ path, original, modified, fontSize }: DiffProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let disposed = false;
    let editor: Monaco.editor.IStandaloneDiffEditor | null = null;
    let models: Monaco.editor.ITextModel[] = [];
    loadMonaco().then(monaco => {
      if (disposed) return;
      const language = languageForPath(monaco, path);
      models = [monaco.editor.createModel(original, language), monaco.editor.createModel(modified, language)];
      editor = monaco.editor.createDiffEditor(host, { theme: "zevrin-dark", fontSize, fontFamily: "Geist Mono, SFMono-Regular, Menlo, monospace", automaticLayout: true, readOnly: true, originalEditable: false, renderSideBySide: host.clientWidth > 900, minimap: { enabled: false }, scrollBeyondLastLine: false, renderOverviewRuler: false, padding: { top: 12, bottom: 12 }, useInlineViewWhenSpaceIsLimited: true });
      editor.setModel({ original: models[0], modified: models[1] });
    }).catch(error => { host.textContent = "The diff view could not load: " + (error instanceof Error ? error.message : String(error)); });
    return () => { disposed = true; editor?.dispose(); models.forEach(model => model.dispose()); };
  }, [path, original, modified, fontSize]);
  return <div className="code-editor-host" ref={hostRef}/>;
}
