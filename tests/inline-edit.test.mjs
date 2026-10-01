import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";

const { InlineEditor, buildPrompt, extractCode } = createRequire(import.meta.url)("../electron/inline-edit.cjs");

test("the prompt carries the file, the instruction and the code around the selection", () => {
  const prompt = buildPrompt({ path: "src/a.ts", language: "typescript", before: "const a = 1;\n", selection: "let b = 2;\n", after: "export {};\n", instruction: "make b const" });
  assert.match(prompt, /File: src\/a\.ts \(typescript\)/);
  assert.match(prompt, /Instruction: make b const/);
  assert.match(prompt, /<selected_code>\nlet b = 2;\n\n<\/selected_code>/);
  assert.match(buildPrompt({ path: "x.py", instruction: "add main", before: "", after: "" }), /<cursor\/>/);
});

test("the code is taken from the fenced block and keeps the selection's line endings", () => {
  assert.equal(extractCode("Here:\n```ts\nconst b = 2;\n```\nDone.", "let b = 2;\n"), "const b = 2;\n");
  assert.equal(extractCode("```\nx()\n```", "y()"), "x()");
  assert.equal(extractCode("  indented()\n", "old()"), "  indented()");
});

test("an edit runs one tool-less turn and returns the code", async () => {
  let options = null;
  const sdk = { query: ({ prompt, options: given }) => { options = given; return (async function* () {
    yield { type: "system", subtype: "init" };
    yield { type: "assistant", message: { content: [{ type: "text", text: "```js\nconst total = items.reduce((sum, item) => sum + item.price, 0);\n```" }] } };
    yield { type: "result", subtype: "success", result: "", is_error: false };
  })(); } };
  const editor = new InlineEditor({ loadSdk: async () => sdk });
  const { code } = await editor.edit("tile", "/project", { path: "cart.js", selection: "let total = 0;\nfor (const item of items) total += item.price;\n", before: "", after: "", instruction: "use reduce" });
  assert.equal(code, "const total = items.reduce((sum, item) => sum + item.price, 0);\n");
  assert.equal(options.maxTurns, 1);
  assert.deepEqual(options.allowedTools, []);
  assert.equal((await options.canUseTool("Bash", {})).behavior, "deny");
});
