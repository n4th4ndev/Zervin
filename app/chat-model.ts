// Chat state for an agent tile, built from the events the Electron agent bridge forwards (Claude Agent SDK messages).
export type ChatBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown; result?: { text: string; isError: boolean } };
export type ChatItem =
  | { id: string; role: "user"; text: string; images?: number }
  | { id: string; role: "assistant"; blocks: ChatBlock[] }
  | { id: string; role: "system"; text: string; tone: "info" | "error" };
export type PermissionRequest = { requestId: string; toolName: string; input: Record<string, unknown>; suggestions: unknown[] };
export type ChatStatus = "idle" | "starting" | "running" | "auth" | "error";
export type ChatModel = { value: string; displayName: string; description: string; supportsEffort?: boolean; resolvedModel?: string };
export type ChatCommand = { name: string; description: string; argumentHint: string };
export type ChatMcpStatus = { name: string; status: string; error?: string };
export type ChatAccount = { email?: string; organization?: string; subscriptionType?: string; apiProvider?: string };
export type ChatState = {
  sessionId: string | null;
  model: string | null;
  models: ChatModel[];
  commands: ChatCommand[];
  mcp: ChatMcpStatus[];
  account: ChatAccount;
  effort: string | null;
  permissionMode: string;
  status: ChatStatus;
  items: ChatItem[];
  draft: { text: string; thinking: string } | null;
  permission: PermissionRequest | null;
  authOutput: string[];
  costUsd: number;
  turns: number;
  tools: string[];
};

export type AgentEvent =
  | { type: "started" }
  | { type: "message"; message: Record<string, unknown> }
  | { type: "permission"; requestId: string; toolName: string; input: Record<string, unknown>; suggestions?: unknown[] }
  | { type: "permission_resolved"; requestId: string }
  | { type: "info"; models: ChatModel[]; commands: ChatCommand[]; account: ChatAccount; mcp: ChatMcpStatus[]; effort: string | null }
  | { type: "error"; message: string }
  | { type: "closed"; reason?: string };

export function initialChatState(permissionMode = "default"): ChatState {
  return { sessionId: null, model: null, models: [], commands: [], mcp: [], account: {}, effort: null, permissionMode, status: "idle", items: [], draft: null, permission: null, authOutput: [], costUsd: 0, turns: 0, tools: [] };
}

let counter = 0;
export function chatItemId() {
  counter += 1;
  return `chat-${Date.now().toString(36)}-${counter}`;
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return content === undefined || content === null ? "" : JSON.stringify(content);
  return content.map(block => {
    if (!block || typeof block !== "object") return "";
    const item = block as { type?: string; text?: string };
    if (item.type === "text" && typeof item.text === "string") return item.text;
    if (item.type === "image") return "[image]";
    return "";
  }).filter(Boolean).join("\n");
}

function lastAssistant(items: ChatItem[]): Extract<ChatItem, { role: "assistant" }> | null {
  const last = items[items.length - 1];
  return last && last.role === "assistant" ? last : null;
}

function withLastAssistant(state: ChatState, update: (item: Extract<ChatItem, { role: "assistant" }>) => Extract<ChatItem, { role: "assistant" }>): ChatState {
  const current = lastAssistant(state.items);
  const target = current ?? { id: chatItemId(), role: "assistant" as const, blocks: [] };
  const items = current ? [...state.items.slice(0, -1), update(target)] : [...state.items, update(target)];
  return { ...state, items };
}

export function addUserMessage(state: ChatState, text: string, images = 0): ChatState {
  return { ...state, status: "running", draft: null, items: [...state.items, { id: chatItemId(), role: "user", text, ...(images ? { images } : {}) }] };
}

export function addSystemNote(state: ChatState, text: string, tone: "info" | "error" = "info"): ChatState {
  return { ...state, items: [...state.items, { id: chatItemId(), role: "system", text, tone }] };
}

function attachToolResult(state: ChatState, toolUseId: string, text: string, isError: boolean): ChatState {
  let found = false;
  const items = state.items.map(item => {
    if (item.role !== "assistant") return item;
    const blocks = item.blocks.map(block => {
      if (block.type === "tool_use" && block.id === toolUseId) { found = true; return { ...block, result: { text, isError } }; }
      return block;
    });
    return found ? { ...item, blocks } : item;
  });
  return found ? { ...state, items } : state;
}

export function applyAgentEvent(state: ChatState, event: AgentEvent): ChatState {
  if (event.type === "started") return { ...state, status: state.status === "running" ? "running" : "starting" };
  if (event.type === "error") return addSystemNote({ ...state, status: "error", draft: null, permission: null }, event.message, "error");
  if (event.type === "closed") return { ...state, status: state.status === "error" ? "error" : "idle", draft: null, permission: null };
  if (event.type === "permission") return { ...state, permission: { requestId: event.requestId, toolName: event.toolName, input: event.input, suggestions: event.suggestions ?? [] } };
  if (event.type === "permission_resolved") return state.permission?.requestId === event.requestId ? { ...state, permission: null } : state;
  if (event.type === "info") return { ...state, models: Array.isArray(event.models) ? event.models : state.models, commands: Array.isArray(event.commands) ? event.commands : state.commands, account: event.account ?? state.account, mcp: Array.isArray(event.mcp) ? event.mcp : state.mcp, effort: event.effort ?? state.effort };

  const message = event.message;
  const type = message.type;
  if (type === "system") {
    if (message.subtype === "init") {
      const tools = Array.isArray(message.tools) ? message.tools.filter((tool): tool is string => typeof tool === "string") : state.tools;
      return { ...state, sessionId: typeof message.session_id === "string" ? message.session_id : state.sessionId, model: typeof message.model === "string" ? message.model : state.model, permissionMode: typeof message.permissionMode === "string" ? message.permissionMode : state.permissionMode, tools, status: state.status === "starting" ? "idle" : state.status };
    }
    if (message.subtype === "status" && typeof message.permissionMode === "string") return { ...state, permissionMode: message.permissionMode };
    return state;
  }
  if (type === "auth_status") {
    const output = Array.isArray(message.output) ? message.output.filter((line): line is string => typeof line === "string") : [];
    if (message.isAuthenticating) return { ...state, status: "auth", authOutput: output };
    return { ...state, status: state.status === "auth" ? "idle" : state.status, authOutput: [] };
  }
  if (type === "stream_event") {
    const streamEvent = message.event as { type?: string; content_block?: { type?: string }; delta?: { type?: string; text?: string; thinking?: string } } | undefined;
    if (!streamEvent || message.parent_tool_use_id) return state;
    if (streamEvent.type === "content_block_start") {
      const blockType = streamEvent.content_block?.type;
      if (blockType === "text" || blockType === "thinking") return { ...state, status: "running", draft: { text: "", thinking: "" } };
      return state;
    }
    if (streamEvent.type === "content_block_delta" && state.draft) {
      if (streamEvent.delta?.type === "text_delta" && typeof streamEvent.delta.text === "string") return { ...state, draft: { ...state.draft, text: state.draft.text + streamEvent.delta.text } };
      if (streamEvent.delta?.type === "thinking_delta" && typeof streamEvent.delta.thinking === "string") return { ...state, draft: { ...state.draft, thinking: state.draft.thinking + streamEvent.delta.thinking } };
    }
    return state;
  }
  if (type === "assistant") {
    if (message.parent_tool_use_id) return state;
    const payload = message.message as { content?: unknown[] } | undefined;
    const content = Array.isArray(payload?.content) ? payload!.content : [];
    const blocks: ChatBlock[] = [];
    for (const raw of content) {
      const block = raw as { type?: string; text?: string; thinking?: string; id?: string; name?: string; input?: unknown };
      if (block.type === "text" && typeof block.text === "string" && block.text.trim()) blocks.push({ type: "text", text: block.text });
      else if (block.type === "thinking" && typeof block.thinking === "string" && block.thinking.trim()) blocks.push({ type: "thinking", text: block.thinking });
      else if (block.type === "tool_use" && typeof block.id === "string") blocks.push({ type: "tool_use", id: block.id, name: typeof block.name === "string" ? block.name : "tool", input: block.input ?? {} });
    }
    if (blocks.length === 0) return { ...state, draft: null };
    return withLastAssistant({ ...state, status: "running", draft: null }, item => ({ ...item, blocks: [...item.blocks, ...blocks.filter(block => block.type !== "tool_use" || !item.blocks.some(existing => existing.type === "tool_use" && existing.id === block.id))] }));
  }
  if (type === "user") {
    const payload = message.message as { content?: unknown } | undefined;
    if (!Array.isArray(payload?.content)) return state;
    let next = state;
    for (const raw of payload!.content) {
      const block = raw as { type?: string; tool_use_id?: string; content?: unknown; is_error?: boolean };
      if (block.type === "tool_result" && typeof block.tool_use_id === "string") next = attachToolResult(next, block.tool_use_id, contentText(block.content), block.is_error === true);
    }
    return next;
  }
  if (type === "result") {
    const cost = typeof message.total_cost_usd === "number" ? message.total_cost_usd : state.costUsd;
    const turns = typeof message.num_turns === "number" ? message.num_turns : state.turns;
    const base = { ...state, status: "idle" as ChatStatus, draft: null, permission: null, costUsd: cost, turns, sessionId: typeof message.session_id === "string" ? message.session_id : state.sessionId };
    if (message.is_error) {
      const text = typeof message.result === "string" && message.result.trim() ? message.result : Array.isArray(message.errors) ? message.errors.join("\n") : "The agent stopped with an error.";
      return addSystemNote({ ...base, status: "error" }, text, "error");
    }
    return base;
  }
  return state;
}

// Replays a message from a saved transcript (user text becomes a user item; tool results and assistant blocks as usual).
export function applyHistoryMessage(state: ChatState, message: Record<string, unknown>): ChatState {
  if (message.parent_tool_use_id) return state;
  if (message.type === "user") {
    const payload = message.message as { content?: unknown } | undefined;
    const content = payload?.content;
    if (typeof content === "string") return content.trim() ? { ...state, items: [...state.items, { id: chatItemId(), role: "user", text: content }] } : state;
    if (Array.isArray(content)) {
      const hasToolResult = content.some(block => (block as { type?: string })?.type === "tool_result");
      if (hasToolResult) return applyAgentEvent(state, { type: "message", message });
      const images = content.filter(block => (block as { type?: string })?.type === "image").length;
      const text = contentText(content);
      return text.trim() || images ? { ...state, items: [...state.items, { id: chatItemId(), role: "user", text, ...(images ? { images } : {}) }] } : state;
    }
    return state;
  }
  if (message.type === "assistant") return { ...applyAgentEvent(state, { type: "message", message }), status: state.status };
  return state;
}

export type TodoEntry = { content: string; status: "pending" | "in_progress" | "completed" };
export function todoEntries(input: unknown): TodoEntry[] | null {
  const todos = (input as { todos?: unknown })?.todos;
  if (!Array.isArray(todos)) return null;
  const entries = todos.map(todo => {
    const item = todo as { content?: unknown; status?: unknown };
    return typeof item?.content === "string" ? { content: item.content, status: item.status === "completed" || item.status === "in_progress" ? item.status : "pending" as const } : null;
  }).filter((entry): entry is TodoEntry => entry !== null);
  return entries.length ? entries : null;
}

// Human-friendly one-line summary of a tool call, used by tool cards and permission prompts.
export function describeToolCall(name: string, input: unknown): string {
  const params = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const first = (...keys: string[]) => { for (const key of keys) { const value = params[key]; if (typeof value === "string" && value.trim()) return value; } return ""; };
  if (name === "Bash") return first("command", "description");
  if (name === "Read" || name === "Write" || name === "Edit" || name === "MultiEdit" || name === "NotebookEdit") return first("file_path", "notebook_path", "path");
  if (name === "Glob" || name === "Grep") return [first("pattern"), first("path")].filter(Boolean).join("  in  ");
  if (name === "WebFetch" || name === "WebSearch") return first("url", "query");
  if (name === "Task" || name === "Agent") return first("description", "prompt");
  if (name === "TodoWrite") { const todos = todoEntries(params); return todos ? `${todos.filter(todo => todo.status === "completed").length}/${todos.length} done` : "Update task list"; }
  if (name === "ExitPlanMode") return "Plan ready for review";
  if (name === "AskUserQuestion") return first("question", "prompt");
  const fallback = Object.entries(params).find(([, value]) => typeof value === "string" && value.trim());
  return fallback ? `${fallback[0]}: ${String(fallback[1]).slice(0, 160)}` : "";
}
