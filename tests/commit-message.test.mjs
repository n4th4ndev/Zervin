import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";

const { generateCommitMessage, buildCommitPrompt, cleanMessage } = createRequire(import.meta.url)("../electron/commit-message.cjs");
const context = { branch: "feature/login", stat: " src/auth.ts | 4 ++--", diff: "diff --git a/src/auth.ts b/src/auth.ts\n-old\n+new", recent: ["feat: add canvas", "fix: terminal resize"], staged: true };

test("the prompt carries the branch, the stat, the diff and the recent commit style", () => {
  const prompt = buildCommitPrompt(context);
  assert.match(prompt, /Branch: feature\/login/);
  assert.match(prompt, /- feat: add canvas/);
  assert.match(prompt, /Changes \(staged\)/);
  assert.match(prompt, /<diff>\ndiff --git/);
  assert.match(buildCommitPrompt({ ...context, staged: false, diff: "x".repeat(50000) }), /diff truncated/);
});

test("answers are cleaned into a plain commit message", () => {
  assert.equal(cleanMessage("```\nfix: refresh the token\n\nThe session expired early.\n```"), "fix: refresh the token\n\nThe session expired early.");
  assert.equal(cleanMessage('Commit message: "feat: add login"'), "feat: add login");
});

test("Claude writes it in one tool-less turn, Codex in a read-only thread", async () => {
  let claudeOptions = null, codexThreadOptions = null;
  const deps = {
    loadSdk: async () => ({ query: ({ options }) => { claudeOptions = options; return (async function* () { yield { type: "assistant", message: { content: [{ type: "text", text: "fix(auth): refresh the token before it expires" }] } }; yield { type: "result", result: "" }; })(); } }),
    executableOptions: async () => ({ pathToClaudeCodeExecutable: "/usr/local/bin/claude" }),
    loadCodexSdk: async () => ({ Codex: class { startThread(options) { codexThreadOptions = options; return { run: async () => ({ finalResponse: "feat: add login screen\n" }) }; } } }),
    findCodex: async () => "/usr/local/bin/codex",
  };
  assert.equal(await generateCommitMessage("claude", deps, "/repo", context), "fix(auth): refresh the token before it expires");
  assert.equal(claudeOptions.maxTurns, 1);
  assert.deepEqual(claudeOptions.allowedTools, []);
  assert.equal(claudeOptions.pathToClaudeCodeExecutable, "/usr/local/bin/claude");
  assert.equal(await generateCommitMessage("codex", deps, "/repo", context), "feat: add login screen");
  assert.equal(codexThreadOptions.sandboxMode, "read-only");
  assert.equal(codexThreadOptions.workingDirectory, "/repo");
});
