// State of a Codex chat tile, built from the Codex SDK's thread events.
export type CodexItem =
  | { id: string; kind: "user"; text: string; images?: number }
  | { id: string; kind: "message"; text: string }
  | { id: string; kind: "reasoning"; text: string }
  | { id: string; kind: "command"; command: string; output: string; exitCode: number | null; status: string }
  | { id: string; kind: "files"; changes: Array<{ path: string; kind: string }>; status: string }
  | { id: string; kind: "mcp"; server: string; tool: string; status: string; error: string | null }
  | { id: string; kind: "search"; query: string }
  | { id: string; kind: "todos"; todos: Array<{ text: string; completed: boolean }> }
  | { id: string; kind: "notice"; text: string; tone: "error" | "info" };

export type CodexState = { threadId: string | null; status: "idle" | "running"; items: CodexItem[]; notice: string | null; usage: { input: number; output: number } };

type ThreadItem = { id: string; type: string; [key: string]: unknown };
export type CodexEvent = { type: string; [key: string]: unknown };

export function initialCodexState(threadId: string | null = null): CodexState {
  return { threadId, status: "idle", items: [], notice: null, usage: { input: 0, output: 0 } };
}

let counter = 0;
const localId = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${(counter += 1)}`;

export function addCodexUser(state: CodexState, text: string, images = 0): CodexState {
  return { ...state, status: "running", notice: null, items: [...state.items, { id: localId("user"), kind: "user", text, ...(images ? { images } : {}) }] };
}

export function toCodexItem(item: ThreadItem): CodexItem | null {
  const str = (value: unknown) => typeof value === "string" ? value : "";
  switch (item.type) {
    case "agent_message": return { id: item.id, kind: "message", text: str(item.text) };
    case "reasoning": return { id: item.id, kind: "reasoning", text: str(item.text) };
    case "command_execution": return { id: item.id, kind: "command", command: str(item.command), output: str(item.aggregated_output), exitCode: typeof item.exit_code === "number" ? item.exit_code : null, status: str(item.status) || "in_progress" };
    case "file_change": return { id: item.id, kind: "files", changes: Array.isArray(item.changes) ? (item.changes as Array<{ path: string; kind: string }>).map(change => ({ path: String(change.path), kind: String(change.kind) })) : [], status: str(item.status) || "completed" };
    case "mcp_tool_call": return { id: item.id, kind: "mcp", server: str(item.server), tool: str(item.tool), status: str(item.status) || "in_progress", error: item.error && typeof item.error === "object" ? str((item.error as { message?: unknown }).message) : null };
    case "web_search": return { id: item.id, kind: "search", query: str(item.query) };
    case "todo_list": return { id: item.id, kind: "todos", todos: Array.isArray(item.items) ? (item.items as Array<{ text: string; completed: boolean }>).map(todo => ({ text: String(todo.text), completed: Boolean(todo.completed) })) : [] };
    case "error": return { id: item.id, kind: "notice", text: str(item.message), tone: "error" };
    default: return null;
  }
}

function upsert(items: CodexItem[], next: CodexItem) {
  const index = items.findIndex(item => item.id === next.id);
  if (index < 0) return [...items, next];
  const copy = items.slice(); copy[index] = next; return copy;
}

export function applyCodexEvent(state: CodexState, event: CodexEvent): CodexState {
  switch (event.type) {
    case "zevrin.turn_started": case "turn.started": return { ...state, status: "running", notice: null };
    case "thread.started": return { ...state, threadId: typeof event.thread_id === "string" ? event.thread_id : state.threadId };
    case "item.started": case "item.updated": case "item.completed": {
      const item = event.item && typeof event.item === "object" ? toCodexItem(event.item as ThreadItem) : null;
      return item ? { ...state, notice: null, items: upsert(state.items, item) } : state;
    }
    case "turn.completed": {
      const usage = (event.usage ?? {}) as { input_tokens?: number; output_tokens?: number };
      return { ...state, status: "idle", notice: null, usage: { input: state.usage.input + (usage.input_tokens ?? 0), output: state.usage.output + (usage.output_tokens ?? 0) } };
    }
    case "turn.failed": {
      const message = event.error && typeof event.error === "object" ? String((event.error as { message?: unknown }).message ?? "") : "The turn failed.";
      return { ...state, status: "idle", notice: null, items: [...state.items, { id: localId("error"), kind: "notice", text: message, tone: "error" }] };
    }
    case "error": {
      const message = String(event.message ?? "");
      // Codex reports transient reconnections as errors; they are a status, not a failure.
      if (/^Reconnecting/i.test(message)) return { ...state, notice: message };
      return { ...state, items: [...state.items, { id: localId("error"), kind: "notice", text: message, tone: "error" }] };
    }
    case "zevrin.interrupted": return { ...state, status: "idle", notice: null, items: [...state.items, { id: localId("note"), kind: "notice", text: "Interrupted.", tone: "info" }] };
    case "zevrin.turn_finished": return { ...state, status: "idle", notice: null, threadId: typeof event.threadId === "string" ? event.threadId : state.threadId };
    default: return state;
  }
}

export function codexHistoryItems(messages: Array<{ role: string; text: string }>): CodexItem[] {
  return messages.map((message, index) => message.role === "user" ? { id: `h-${index}`, kind: "user", text: message.text } : { id: `h-${index}`, kind: "message", text: message.text });
}
