import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../app/chat-only.ts", import.meta.url), "utf8");
const ts = (await import("typescript")).default;
const { chatOnlyDecision, layoutProbeScript, applyScript, describeLayout, forceChatOnlyScript, releaseChatOnlyScript } = await import("data:text/javascript;base64," + Buffer.from(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText).toString("base64"));

const base = { workbench: true, width: 1000, editorsOpen: false, editorWidth: 700, sidebarWidth: 0, auxWidth: 300, panelVisible: false, claudeIn: "auxiliarybar", maximizeButton: true };

test("chat-only decisions follow where the Claude view lives and what is open", () => {
  assert.equal(chatOnlyDecision(base), "chatOnly");
  assert.equal(chatOnlyDecision({ ...base, auxWidth: 900, editorWidth: 0 }), null);
  assert.equal(chatOnlyDecision({ ...base, auxWidth: 900, panelVisible: true }), "chatOnly");
  assert.equal(chatOnlyDecision({ ...base, editorsOpen: true }), null);
  assert.equal(chatOnlyDecision({ ...base, claudeIn: "sidebar", sidebarWidth: 300, auxWidth: 0 }), "widen");
  assert.equal(chatOnlyDecision({ ...base, claudeIn: "sidebar", sidebarWidth: 820, auxWidth: 0 }), null);
  assert.equal(chatOnlyDecision({ ...base, claudeIn: "none" }), "openClaude");
  assert.equal(chatOnlyDecision({ ...base, workbench: false }), null);
  assert.match(layoutProbeScript(), /monaco-workbench/);
  assert.match(layoutProbeScript(["codex", "chatgpt"]), /codex\|chatgpt/);
  assert.match(applyScript("openClaude", "codex"), /F7/);
  assert.equal(describeLayout(base, "chatOnly", "codex"), "Maximizing the Codex view…");
  assert.match(applyScript("chatOnly"), /maximize/i);
  assert.match(applyScript("widen"), /F11/);
  assert.equal(describeLayout(base, "chatOnly"), "Maximizing the Claude Code view…");
  assert.equal(describeLayout({ ...base, auxWidth: 900 }, null), "Chat only");
  assert.equal(describeLayout(null, null), "Reading the layout…");
  assert.match(forceChatOnlyScript(["claude"]), /zevrin-chat-only/);
  assert.match(forceChatOnlyScript(["codex", "chatgpt"]), /codex\|chatgpt/);
  assert.match(releaseChatOnlyScript, /released/);
});
