import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import workspaceFiles from "../electron/workspace-files.cjs";

const { scoreFileMatch, walkWorkspace, searchWorkspaceFiles, searchWorkspaceText } = workspaceFiles;

test("ranks exact and prefix file name matches above path matches", () => {
  assert.ok(scoreFileMatch("page.tsx", "app/page.tsx") > scoreFileMatch("page", "app/page.tsx"));
  assert.ok(scoreFileMatch("page", "app/page.tsx") > scoreFileMatch("page", "docs/homepage.md"));
  assert.ok(scoreFileMatch("app", "src/app-shell.tsx") > scoreFileMatch("app", "src/components/wrapper.tsx"), "file name matches beat directory matches");
  assert.ok(scoreFileMatch("apt", "app/page.tsx") > 0, "subsequence matches still count");
  assert.equal(scoreFileMatch("zzz", "app/page.tsx"), 0);
  assert.equal(scoreFileMatch("", "anything"), 1);
});

test("walks a workspace while skipping dependency and build folders", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "zevrin-files-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "src", "components"), { recursive: true });
  await mkdir(path.join(root, "node_modules", "pkg"), { recursive: true });
  await mkdir(path.join(root, ".git"), { recursive: true });
  await writeFile(path.join(root, "src", "index.ts"), "");
  await writeFile(path.join(root, "src", "components", "Button.tsx"), "");
  await writeFile(path.join(root, "node_modules", "pkg", "index.js"), "");
  await writeFile(path.join(root, ".git", "HEAD"), "");
  await writeFile(path.join(root, "README.md"), "");

  const { files, truncated } = await walkWorkspace(root);
  assert.deepEqual(files.sort(), ["README.md", "src/components/Button.tsx", "src/index.ts"]);
  assert.equal(truncated, false);

  const results = await searchWorkspaceFiles(root, "button");
  assert.deepEqual(results, [{ path: "src/components/Button.tsx", name: "Button.tsx" }]);
  assert.deepEqual((await searchWorkspaceFiles(root, "", { limit: 2 })).length, 2);
  assert.equal((await walkWorkspace(root, { maxEntries: 2 })).truncated, true);

  await writeFile(path.join(root, "src", "index.ts"), "export const Button = 1;\nconst button = Button + 1; // button\n");
  await writeFile(path.join(root, "logo.png"), "Button");
  const text = await searchWorkspaceText(root, "button");
  assert.deepEqual(text.matches.map(match => [match.path, match.line, match.column]), [["src/index.ts", 1, 14], ["src/index.ts", 2, 7], ["src/index.ts", 2, 16], ["src/index.ts", 2, 31]]);
  assert.equal(text.truncated, false);
  assert.equal((await searchWorkspaceText(root, "Button", { caseSensitive: true })).matches.length, 2);
  assert.equal((await searchWorkspaceText(root, "button", { limit: 1 })).truncated, true);
  assert.deepEqual((await searchWorkspaceText(root, "")).matches, []);
});
