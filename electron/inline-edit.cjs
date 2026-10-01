// ⌘K in the editor: one short Claude request (no tools, one turn) that rewrites the selected code, or writes code at
// the cursor, from an instruction. Uses the Claude Agent SDK with the user's Claude Code sign-in.

const maxBefore = 8000;
const maxAfter = 4000;

function buildPrompt({ path, language, before = "", selection = "", after = "", instruction }) {
  const head = before.length > maxBefore ? before.slice(-maxBefore) : before;
  const tail = after.length > maxAfter ? after.slice(0, maxAfter) : after;
  const task = selection
    ? "Rewrite the SELECTED code according to the instruction."
    : "Write the code to INSERT at the cursor according to the instruction.";
  return [
    "You are the inline editor of an IDE. " + task,
    "Reply with the replacement code only, in a single fenced code block, with no explanation before or after.",
    "Keep the file's indentation, style and conventions. Do not repeat the code before or after the selection.",
    "",
    `File: ${path || "untitled"}${language ? ` (${language})` : ""}`,
    `Instruction: ${instruction}`,
    "",
    "<code_before>", head, "</code_before>",
    selection ? "<selected_code>" : "<cursor/>",
    ...(selection ? [selection, "</selected_code>"] : []),
    "<code_after>", tail, "</code_after>",
  ].join("\n");
}

// The code inside the first fenced block (or the whole answer), with the selection's trailing newline convention.
function extractCode(text, selection = "") {
  const answer = String(text || "");
  const fenced = /```[^\n`]*\n([\s\S]*?)\n?```/.exec(answer);
  let code = fenced ? fenced[1] : answer.replace(/^\s*\n/, "").replace(/\s+$/, "");
  if (selection.endsWith("\n") && !code.endsWith("\n")) code += "\n";
  if (!selection.endsWith("\n") && selection && code.endsWith("\n")) code = code.replace(/\n+$/, "");
  return code;
}

function textOf(message) {
  if (!message) return "";
  if (message.type === "assistant") return (message.message?.content || []).filter(block => block.type === "text").map(block => block.text).join("");
  if (message.type === "result" && typeof message.result === "string") return message.result;
  return "";
}

class InlineEditor {
  constructor({ loadSdk, executableOptions = async () => ({}) }) { this.loadSdk = loadSdk; this.executableOptions = executableOptions; this.running = new Map(); }

  async edit(id, cwd, request) {
    this.cancel(id);
    const abortController = new AbortController();
    this.running.set(id, abortController);
    try {
      const sdk = await this.loadSdk();
      const executable = await this.executableOptions();
      const query = sdk.query({
        prompt: buildPrompt(request),
        options: {
          ...executable, cwd, abortController, maxTurns: 1, settingSources: [], allowedTools: [],
          canUseTool: async () => ({ behavior: "deny", message: "Inline edits answer with code only." }),
          ...(request.model ? { model: request.model } : {}),
        },
      });
      let assistant = "", result = "";
      for await (const message of query) {
        if (message?.type === "assistant") assistant += textOf(message);
        else if (message?.type === "result") { result = textOf(message); if (message.is_error && !assistant && !result) throw new Error(message.subtype === "error_max_turns" ? "Claude tried to use a tool; try a more precise instruction." : "Claude could not complete the edit."); }
      }
      if (abortController.signal.aborted) throw new Error("Cancelled.");
      const code = extractCode(assistant || result, request.selection || "");
      if (!code.trim() && !(request.selection || "").trim()) throw new Error("Claude returned no code.");
      return { code };
    } finally { if (this.running.get(id) === abortController) this.running.delete(id); }
  }

  cancel(id) { const controller = this.running.get(id); if (controller) { controller.abort(); this.running.delete(id); } return true; }
}

module.exports = { InlineEditor, buildPrompt, extractCode };
