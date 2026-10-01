import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const { CheckpointStore, parseUnifiedDiff } = createRequire(import.meta.url)("../electron/checkpoints.cjs");

function project() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "zevrin-cp-"));
  const root = path.join(base, "app");
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.mkdirSync(path.join(root, "node_modules", "dep"), { recursive: true });
  fs.writeFileSync(path.join(root, "node_modules", "dep", "index.js"), "module.exports = 1;\n");
  const lines = Array.from({ length: 30 }, (_, index) => `line ${index + 1}`);
  fs.writeFileSync(path.join(root, "src", "main.ts"), lines.join("\n") + "\n");
  fs.writeFileSync(path.join(root, "README.md"), "# App\n");
  return { base, root, lines, store: new CheckpointStore({ dataDir: path.join(base, "data") }) };
}

test("the unified diff parser keeps files, statuses and hunks", () => {
  const files = parseUnifiedDiff("diff --git a/a.txt b/a.txt\nindex 1..2 100644\n--- a/a.txt\n+++ b/a.txt\n@@ -1,2 +1,2 @@ fn\n-x\n+y\n z\ndiff --git a/n.txt b/n.txt\nnew file mode 100644\n--- /dev/null\n+++ b/n.txt\n@@ -0,0 +1 @@\n+new\n");
  assert.deepEqual(files.map(file => [file.path, file.status, file.additions, file.deletions, file.hunks.length]), [["a.txt", "modified", 1, 1, 1], ["n.txt", "added", 1, 0, 1]]);
  assert.equal(files[0].hunks[0].context, "fn");
});

test("a checkpoint shows the agent's changes and undoes them hunk by hunk, file by file or all at once", async () => {
  const { root, lines, store } = project();
  const checkpoint = await store.create(root, "Fix the login");
  // The "agent" edits two far-apart places, creates a file, deletes one, and touches node_modules (excluded).
  const edited = [...lines]; edited[1] = "line 2 changed"; edited[27] = "line 28 changed";
  fs.writeFileSync(path.join(root, "src", "main.ts"), edited.join("\n") + "\n");
  fs.writeFileSync(path.join(root, "src", "new.ts"), "export const x = 1;\n");
  fs.rmSync(path.join(root, "README.md"));
  fs.writeFileSync(path.join(root, "node_modules", "dep", "index.js"), "module.exports = 2;\n");

  let changes = await store.changes(root, checkpoint.id);
  assert.deepEqual(changes.map(file => [file.path, file.status, file.hunks.length]), [["README.md", "deleted", 1], ["src/main.ts", "modified", 2], ["src/new.ts", "added", 1]]);

  // Undo only the second hunk of main.ts: the first edit stays.
  await store.revertHunk(root, checkpoint.id, "src/main.ts", 1);
  const main = fs.readFileSync(path.join(root, "src", "main.ts"), "utf8");
  assert.match(main, /line 2 changed/);
  assert.doesNotMatch(main, /line 28 changed/);

  // Undo a created file (deleted) and a deleted file (restored).
  await store.revertFile(root, checkpoint.id, "src/new.ts");
  assert.equal(fs.existsSync(path.join(root, "src", "new.ts")), false);
  await store.revertHunk(root, checkpoint.id, "README.md", 0);
  assert.equal(fs.readFileSync(path.join(root, "README.md"), "utf8"), "# App\n");

  changes = await store.changes(root, checkpoint.id);
  assert.deepEqual(changes.map(file => [file.path, file.hunks.length]), [["src/main.ts", 1]]);

  // Restore everything.
  const later = await store.create(root, "second");
  fs.writeFileSync(path.join(root, "src", "other.ts"), "x\n");
  assert.equal(await store.restore(root, checkpoint.id), 2);
  assert.equal(fs.readFileSync(path.join(root, "src", "main.ts"), "utf8"), lines.join("\n") + "\n");
  assert.equal(fs.existsSync(path.join(root, "src", "other.ts")), false);
  assert.ok(later.id && later.id !== checkpoint.id);
});
