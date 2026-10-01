import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import worktrees from "../electron/git-worktrees.cjs";

const { worktreeSummary, finishWorktree, branchChanges, branchFile, parsePorcelain } = worktrees;
const git = (cwd, args) => new Promise((resolve, reject) => execFile("git", args, { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } }, (error, stdout, stderr) => error ? reject(new Error(stderr || error.message)) : resolve(stdout)));

async function repo(t) {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), "zevrin-wt-")));
  t.after(() => rm(base, { recursive: true, force: true }));
  const cwd = path.join(base, "app");
  await git(base, ["init", "-q", "-b", "main", cwd]);
  await writeFile(path.join(cwd, "a.txt"), "one\n");
  await git(cwd, ["add", "."]); await git(cwd, ["commit", "-qm", "init"]);
  const tree = path.join(base, "app-worktrees", "agent", "chat-1");
  await git(cwd, ["worktree", "add", "-q", "-b", "agent/chat-1", tree]);
  return { cwd, tree };
}

test("merge brings the agent's commits into the current branch and removes the worktree", async t => {
  const { cwd, tree } = await repo(t);
  await writeFile(path.join(tree, "b.txt"), "agent work\n");
  let summary = await worktreeSummary(git, cwd, tree, "agent/chat-1");
  assert.equal(summary.dirty, 1); assert.equal(summary.ahead, 0); assert.equal(summary.target, "main");
  await assert.rejects(finishWorktree(git, cwd, tree, "agent/chat-1", "merge"), /uncommitted/);
  await git(tree, ["add", "."]); await git(tree, ["commit", "-qm", "agent"]);
  summary = await worktreeSummary(git, cwd, tree, "agent/chat-1");
  assert.equal(summary.dirty, 0); assert.equal(summary.ahead, 1); assert.match(summary.stat, /1 file changed/);
  await finishWorktree(git, cwd, tree, "agent/chat-1", "merge");
  assert.match(await git(cwd, ["log", "--oneline"]), /agent/);
  assert.doesNotMatch(await git(cwd, ["worktree", "list"]), /chat-1/);
  assert.doesNotMatch(await git(cwd, ["branch"]), /agent\/chat-1/);
});

test("remove keeps the branch, discard deletes branch and uncommitted work", async t => {
  const { cwd, tree } = await repo(t);
  await finishWorktree(git, cwd, tree, "agent/chat-1", "remove");
  assert.match(await git(cwd, ["branch"]), /agent\/chat-1/);
  const other = path.join(path.dirname(tree), "chat-2");
  await git(cwd, ["worktree", "add", "-q", "-b", "agent/chat-2", other]);
  await writeFile(path.join(other, "c.txt"), "draft\n");
  await finishWorktree(git, cwd, other, "agent/chat-2", "discard");
  assert.doesNotMatch(await git(cwd, ["branch"]), /agent\/chat-2/);
  await assert.rejects(finishWorktree(git, cwd, other, "agent/chat-2", "nope"), /Unknown action/);
});

test("branch review lists committed and uncommitted changes with both sides of each file", async t => {
  const { cwd, tree } = await repo(t);
  await writeFile(path.join(tree, "a.txt"), "one\ntwo\n");
  await git(tree, ["commit", "-qam", "edit a"]);
  await writeFile(path.join(tree, "draft.txt"), "wip\n");
  const changes = await branchChanges(git, cwd, "agent/chat-1", tree);
  assert.deepEqual(changes, [{ status: "M", path: "a.txt", uncommitted: false }, { status: "A", path: "draft.txt", uncommitted: true }]);
  const readFile = (dir, file) => import("node:fs/promises").then(fs => fs.readFile(path.join(dir, file), "utf8"));
  assert.deepEqual(await branchFile(git, cwd, "agent/chat-1", "a.txt", tree, false, readFile), { original: "one\n", modified: "one\ntwo\n" });
  assert.deepEqual(await branchFile(git, cwd, "agent/chat-1", "draft.txt", tree, true, readFile), { original: "", modified: "wip\n" });
  assert.deepEqual(parsePorcelain(" M src/x.ts\n?? new.ts\nR  old.ts -> renamed.ts\n"), [{ status: "M", path: "src/x.ts" }, { status: "A", path: "new.ts" }, { status: "M", path: "renamed.ts" }]);
});
