// "✨ Generate" in Source Control: writes a commit message from the changes about to be committed, in the style of the
// repository's recent commits. Claude (Agent SDK, one tool-less turn) or Codex (Codex SDK, read-only) does the writing.

const maxDiff = 40000;

function buildCommitPrompt({ branch, stat, diff, recent = [], staged }) {
  const shown = diff.length > maxDiff ? diff.slice(0, maxDiff) + "\n… (diff truncated)" : diff;
  return [
    "Write the git commit message for the changes below.",
    "Reply with the commit message only: no explanation, no quotes, no code fence.",
    "First line: a concise summary in the imperative mood, at most 72 characters. If the change needs it, add a blank line and a short body (wrapped at 72 characters) saying what changed and why.",
    recent.length ? "Match the style of the repository's recent commits (prefixes, casing, language):" : "Use a clear, conventional style.",
    ...recent.slice(0, 10).map(subject => "- " + subject),
    "",
    `Branch: ${branch || "unknown"}`,
    `Changes (${staged ? "staged" : "all uncommitted, nothing is staged yet"}):`,
    stat.trim(),
    "",
    "<diff>", shown, "</diff>",
  ].join("\n");
}

// The model's answer as a clean commit message.
function cleanMessage(text) {
  let message = String(text || "").trim();
  const fenced = /```[^\n]*\n([\s\S]*?)\n?```/.exec(message);
  if (fenced) message = fenced[1].trim();
  message = message.replace(/^(commit message|message)\s*:\s*/i, "").replace(/^["'`]+|["'`]+$/g, "").trim();
  const lines = message.split("\n").map(line => line.replace(/\s+$/, ""));
  while (lines.length && !lines[0].trim()) lines.shift();
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function textOf(message) {
  if (message?.type === "assistant") return (message.message?.content || []).filter(block => block.type === "text").map(block => block.text).join("");
  if (message?.type === "result" && typeof message.result === "string") return message.result;
  return "";
}

async function withClaude({ loadSdk, executableOptions = async () => ({}) }, cwd, prompt) {
  const sdk = await loadSdk();
  const executable = await executableOptions();
  const query = sdk.query({ prompt, options: { ...executable, cwd, maxTurns: 1, settingSources: [], allowedTools: [], canUseTool: async () => ({ behavior: "deny", message: "Answer with the commit message only." }) } });
  let assistant = "", result = "";
  for await (const message of query) {
    if (message?.type === "assistant") assistant += textOf(message);
    else if (message?.type === "result") result = textOf(message);
  }
  return assistant || result;
}

async function withCodex({ loadCodexSdk, findCodex }, cwd, prompt) {
  const { Codex } = await loadCodexSdk();
  const codexPath = await findCodex().catch(() => null);
  const codex = new Codex(codexPath ? { codexPathOverride: codexPath } : {});
  const thread = codex.startThread({ workingDirectory: cwd, sandboxMode: "read-only", approvalPolicy: "never", skipGitRepoCheck: true });
  const turn = await thread.run(prompt);
  return turn.finalResponse || "";
}

async function generateCommitMessage(provider, deps, cwd, context) {
  const prompt = buildCommitPrompt(context);
  const text = provider === "codex" ? await withCodex(deps, cwd, prompt) : await withClaude(deps, cwd, prompt);
  const message = cleanMessage(text);
  if (!message) throw new Error("No commit message came back; try again.");
  return message;
}

module.exports = { generateCommitMessage, buildCommitPrompt, cleanMessage };
