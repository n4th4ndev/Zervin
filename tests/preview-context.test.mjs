import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

// The module is TypeScript: transpile it with the project's TypeScript compiler before importing.
const source = readFileSync(new URL("../app/preview-context.ts", import.meta.url), "utf8");
const ts = (await import("typescript")).default;
const moduleUrl = "data:text/javascript;base64," + Buffer.from(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText).toString("base64");
const { formatPageContext, formatConsole, consoleLevel, snapshotScript } = await import(moduleUrl);

test("page context includes title, url, headings, and clips the text", () => {
  const page = { url: "http://localhost:3000/", title: "Home", selection: "", text: "x".repeat(8000), headings: ["h1 Welcome"], description: "Demo", forms: 0, links: 2 };
  const out = formatPageContext(page, { maxText: 100 });
  assert.match(out, /^Page: Home\nURL: http:\/\/localhost:3000\/\nDescription: Demo/);
  assert.match(out, /- h1 Welcome/);
  assert.match(out, /x{100}\n…/);
  assert.equal(formatPageContext({ ...page, selection: "picked" }, { selectionOnly: true }).includes("picked"), true);
  assert.equal(formatPageContext(page, { selectionOnly: true }).includes("(nothing selected)"), true);
});

test("console output filters errors and formats sources", () => {
  const entries = [{ level: "log", message: "hi", at: 1 }, { level: "error", message: "boom", source: "http://x/app.js", line: 12, at: 2 }];
  assert.equal(formatConsole(entries, { errorsOnly: true }), "[error] boom (app.js:12)");
  assert.equal(formatConsole([], { errorsOnly: true }), "No console errors or warnings.");
  assert.equal(formatConsole([]), "The console is empty.");
  assert.equal(consoleLevel(3), "error"); assert.equal(consoleLevel("warning"), "warning"); assert.equal(consoleLevel(0), "log");
  assert.match(snapshotScript, /location\.href/);
});

test("element context, snapshot, keyframes and network formatting", async () => {
  const { formatElementContext, formatSnapshot, pickKeyframes, formatNetwork, locateScript, pickerInstallScript, snapshotRefsScript, waitForScript } = await import(moduleUrl);
  const text = formatElementContext({ url: "http://localhost:3000/", selector: "#login > button", tag: "button", text: "Sign in", html: "<button>Sign in</button>", rect: { x: 10, y: 20, width: 120, height: 32 }, viewport: { width: 1280, height: 800 }, styles: { color: "rgb(0, 0, 0)" }, component: "LoginForm", source: "src/Login.tsx:42", attributes: {} });
  assert.match(text, /selector: `#login > button`/);
  assert.match(text, /component: LoginForm \(src\/Login.tsx:42\)/);
  assert.match(text, /```html\n<button>Sign in<\/button>\n```/);
  assert.match(formatSnapshot({ url: "u", title: "T", scroll: { y: 0, height: 2000, viewport: 800 }, headings: ["h1 Hi"], elements: ['e1 button "Go"'] }), /Scroll: 0 \/ 1200[\s\S]*e1 button "Go"/);
  assert.deepEqual(pickKeyframes([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 4), [1, 4, 7, 10]);
  assert.deepEqual(pickKeyframes([1, 2], 6), [1, 2]);
  assert.equal(formatNetwork([{ url: "/a", method: "GET", status: 200, failed: false, error: null, ms: 5 }, { url: "/b", method: "POST", status: 500, failed: false, error: null, ms: 9 }], { failuresOnly: true }), "500 POST /b 9ms");
  assert.match(locateScript({ ref: "e3" }), /data-bb-ref/);
  assert.match(pickerInstallScript, /__reactFiber\$/);
  assert.match(snapshotRefsScript, /data-bb-ref/);
  assert.match(waitForScript({ text: "Done" }), /innerText/);
});
