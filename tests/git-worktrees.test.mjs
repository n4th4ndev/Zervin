import assert from "node:assert/strict";
import test from "node:test";
import gitWorktrees from "../electron/git-worktrees.cjs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, rm, access, realpath, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const execFileAsync = promisify(execFile);
async function git(cwd, ...args) {
  return execFileAsync("git", args, { cwd });
}

const { parseGitWorktrees } = gitWorktrees;

test("parses porcelain worktree entries and marks the active path", () => {
  const output = [
    "worktree /Users/me/Project",
    "HEAD abc123",
    "branch refs/heads/main",
    "",
    "worktree /Users/me/Project-worktrees/feature/ui",
    "HEAD def456",
    "branch refs/heads/feature/ui",
    "",
  ].join("\n");
  assert.deepEqual(parseGitWorktrees(output, "/Users/me/Project"), [
    { path: "/Users/me/Project", branch: "main", detached: false, bare: false, locked: false, prunable: false, current: true },
    { path: "/Users/me/Project-worktrees/feature/ui", branch: "feature/ui", detached: false, bare: false, locked: false, prunable: false, current: false },
  ]);
});

test("preserves paths with spaces and detached, locked, and prunable states", () => {
  const output = [
    "worktree /Users/me/Project copy",
    "HEAD abc123",
    "detached",
    "locked in use",
    "",
    "worktree /Users/me/stale tree",
    "HEAD def456",
    "prunable gitdir file points to non-existent location",
  ].join("\n");
  const worktrees = parseGitWorktrees(output, "");
  assert.equal(worktrees[0].path, "/Users/me/Project copy");
  assert.equal(worktrees[0].detached, true);
  assert.equal(worktrees[0].locked, true);
  assert.equal(worktrees[1].path, "/Users/me/stale tree");
  assert.equal(worktrees[1].prunable, true);
});

test("returns no worktrees for empty command output", () => {
  assert.deepEqual(parseGitWorktrees("", "/Users/me/Project"), []);
});

test("git worktree add creates a nested branch worktree at a path with spaces", async t => {
  const base = await mkdtemp(path.join(os.tmpdir(), "zevrin worktree test-"));
  const root = path.join(base, "Project");
  const destination = path.join(base, "Project-worktrees", "feature", "canvas");
  t.after(() => rm(base, { recursive: true, force: true }));
  await mkdir(root);

  await git(root, "init", "-q");
  await git(root, "config", "user.name", "Zevrin Test");
  await git(root, "config", "user.email", "zevrin-test@example.invalid");
  await writeFile(path.join(root, "README.md"), "worktree fixture\n");
  await git(root, "add", "README.md");
  await git(root, "commit", "-q", "-m", "fixture");

  await git(root, "worktree", "add", "-b", "feature/canvas", "--", destination, "HEAD");
  await access(path.join(destination, "README.md"));
  const rootBranch = (await git(root, "branch", "--show-current")).stdout.trim();
  const listed = parseGitWorktrees((await git(root, "worktree", "list", "--porcelain")).stdout, await realpath(root));
  assert.deepEqual(listed.map(worktree => [worktree.branch, worktree.current]), [[rootBranch, true], ["feature/canvas", false]]);
});
